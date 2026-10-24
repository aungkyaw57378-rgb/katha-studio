// Katha Studio server: serves the app and turns text into neural speech (Microsoft Edge voices).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

let EdgeTTS = null;
try { ({ EdgeTTS } = await import('edge-tts-universal')); }
catch (e) { console.error('edge-tts-universal is not installed: voice will not work.', e.message); }

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;
const RATE_RE = /^[+-]\d{1,2}%$/;
let busy = 0;
const MAX_BUSY = 4;

function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('voice service timed out')), ms))]);
}

async function synth(text, voice, rate) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tts = new EdgeTTS(text, voice, { rate, volume: '+0%', pitch: '+0Hz' });
      const result = await withTimeout(tts.synthesize(), 45000);
      const buf = Buffer.from(await result.audio.arrayBuffer());
      if (buf.length < 500) throw new Error('empty audio');
      return buf;
    } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 600 * (attempt + 1))); }
  }
  throw lastErr;
}

async function handleTts(req, res) {
  if (!EdgeTTS) return json(res, 503, { error: 'Voice engine is not installed on the server.' });
  if (busy >= MAX_BUSY) return json(res, 429, { error: 'Voice server is busy, try again in a moment.' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Bad request.' }); }
  const text = String(body.text || '').trim();
  const voice = String(body.voice || '');
  const rate = RATE_RE.test(String(body.rate || '')) ? body.rate : '+0%';
  if (!text || text.length > 3000) return json(res, 400, { error: 'Text must be 1 to 3000 characters.' });
  if (!VOICE_RE.test(voice)) return json(res, 400, { error: 'Unknown voice.' });
  busy++;
  try {
    const audio = await synth(text, voice, rate);
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
    res.end(audio);
  } catch (e) {
    console.error('tts failed', voice, e.message);
    json(res, 502, { error: 'The voice service did not answer: ' + e.message });
  } finally { busy--; }
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
  res.end(s);
}

async function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || p === '/sw.js' ? 'no-cache' : 'public, max-age=3600' });
    res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/tts') return await handleTts(req, res);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, voice: !!EdgeTTS });
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    res.writeHead(405); res.end('Method not allowed');
  } catch (e) { console.error(e); if (!res.headersSent) json(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => console.log('Katha Studio on port ' + PORT));
