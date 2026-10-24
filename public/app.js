import { parseJson, captionChunks, wrapLines, buildTimeline, pickCaption } from './lib.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LANGS = {
  en: { label: 'English', name: 'English', f: 'en-US-AvaMultilingualNeural', m: 'en-US-BrianMultilingualNeural', words: '36 to 42' },
  ne: { label: 'नेपाली (Nepali)', name: 'Nepali (Devanagari script)', f: 'ne-NP-HemkalaNeural', m: 'ne-NP-SagarNeural', words: '28 to 34' },
  my: { label: 'မြန်မာ (Burmese)', name: 'Burmese (Myanmar script)', f: 'my-MM-NilarNeural', m: 'my-MM-ThihaNeural', words: '28 to 34' },
  th: { label: 'ไทย (Thai)', name: 'Thai', f: 'th-TH-PremwadeeNeural', m: 'th-TH-NiwatNeural', words: '28 to 34' },
  hi: { label: 'हिन्दी (Hindi)', name: 'Hindi (Devanagari script)', f: 'hi-IN-SwaraNeural', m: 'hi-IN-MadhurNeural', words: '30 to 36' }
};
const LENGTHS = [2, 3, 4, 5, 10];
const STEPS = [
  ['Writing the script', 'Waiting to start'],
  ['Recording the voice', 'Waiting to start'],
  ['Finding photos', 'Waiting to start'],
  ['Putting the video together', 'Waiting to start']
];
const MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

const S = { len: 2, shape: 'wide', job: null, abort: null, running: false, wake: null, recorder: null, stopRecording: null };

/* ---------- settings ---------- */
function getKey(n) { try { return localStorage.getItem('katha.' + n) || ''; } catch { return ''; } }
function setKey(n, v) { try { localStorage.setItem('katha.' + n, v); } catch {} }

/* ---------- screens ---------- */
function show(name) {
  for (const s of ['keys', 'create', 'progress', 'result']) $('s-' + s).hidden = s !== name;
  window.scrollTo(0, 0);
}

/* ---------- create form ---------- */
const lw = $('lengths');
LENGTHS.forEach(n => {
  const b = document.createElement('button');
  b.className = 'chip'; b.dataset.len = n; b.textContent = n + ' min';
  b.setAttribute('aria-pressed', n === S.len); lw.appendChild(b);
});
function est() { $('est').textContent = S.len * 4 + ' scenes, about ' + (S.len + 2) + ' minutes to build'; }
est();
lw.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.len = +b.dataset.len; [...lw.children].forEach(c => c.setAttribute('aria-pressed', c === b)); est();
});
$('shapes').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.shape = b.dataset.shape; [...$('shapes').children].forEach(c => c.setAttribute('aria-pressed', c === b));
});
for (const [k, v] of Object.entries(LANGS)) { const o = document.createElement('option'); o.value = k; o.textContent = v.label; $('lang').appendChild(o); }
$('gear').addEventListener('click', () => { $('k-gemini').value = getKey('gemini'); $('k-pexels').value = getKey('pexels'); show('keys'); });
$('save-keys').addEventListener('click', () => { setKey('gemini', $('k-gemini').value.trim()); setKey('pexels', $('k-pexels').value.trim()); show('create'); });

/* ---------- progress UI ---------- */
function renderSteps(states, details) {
  $('steps').innerHTML = STEPS.map((s, i) =>
    '<li class="step" data-s="' + (states[i] || 'wait') + '"><span class="dot"></span><div class="meta"><div class="t">' + s[0] +
    '</div><div class="d">' + (details[i] || s[1]).replace(/</g, '&lt;') + '</div></div></li>').join('');
}
const ui = { states: [], details: [], frac: [0, 0, 0, 0] };
function paint() {
  renderSteps(ui.states, ui.details);
  const weights = [0.12, 0.2, 0.13, 0.55];
  const pct = Math.round(ui.frac.reduce((n, f, i) => n + f * weights[i], 0) * 100);
  $('pfill').style.width = pct + '%'; $('pbarwrap').setAttribute('aria-valuenow', pct);
}
function setStep(i, state, detail, frac) {
  ui.states[i] = state; if (detail != null) ui.details[i] = detail; if (frac != null) ui.frac[i] = frac; paint();
}

/* ---------- Gemini ---------- */
async function gemini(prompt, signal) {
  const key = getKey('gemini');
  if (!key) throw new Error('Add your free Gemini key first (tap Keys at the top).');
  let lastErr;
  for (const m of MODELS) {
    for (let a = 0; a < 3; a++) {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + encodeURIComponent(key), {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.8 } })
      });
      if (r.status === 404) { lastErr = new Error('Model ' + m + ' not available'); break; }
      if (r.status === 429 || r.status >= 500) { lastErr = new Error('Gemini is busy or over its free limit (' + r.status + '). Wait a minute and try again.'); await sleep(2000 * (a + 1)); continue; }
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || 'Gemini error ' + r.status); }
      const j = await r.json();
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      const txt = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      try { return parseJson(txt); } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('Gemini did not answer.');
}

async function writeScript(job, signal) {
  const N = job.len * 4, L = LANGS[job.lang];
  setStep(0, 'active', 'Planning ' + N + ' scenes', 0.05);
  const outline = await gemini(
    'Plan a ' + job.len + '-minute narrated documentary video about: "' + job.idea + '".\n' +
    'Return JSON: {"title": string (in ' + L.name + ', under 60 characters), "scenes": [{"beat": string, "query": string}]} with exactly ' + N + ' scenes.\n' +
    '"beat" is one sentence in English saying what the scene covers. The first scene is a hook, the last scene wraps up. ' +
    '"query" is 2 to 4 English words for a stock photo search that shows the scene concretely (places, objects, people at work), never abstract ideas.', signal);
  let scenes = (outline.scenes || []).filter(s => s && s.beat);
  if (scenes.length < Math.ceil(N * 0.75)) throw new Error('The AI planned too few scenes. Try again.');
  scenes = scenes.slice(0, N);
  const narr = new Array(scenes.length);
  const CH = 8;
  for (let a = 0; a < scenes.length; a += CH) {
    const idx = scenes.map((_, i) => i).slice(a, a + CH);
    setStep(0, 'active', 'Writing scenes ' + (a + 1) + ' to ' + (a + idx.length) + ' of ' + scenes.length, 0.1 + 0.9 * (a / scenes.length));
    const prompt =
      'You are writing the voice-over for a documentary titled "' + outline.title + '" about "' + job.idea + '".\n' +
      'Full plan:\n' + scenes.map((s, i) => (i + 1) + '. ' + s.beat).join('\n') + '\n\n' +
      'Write the narration for scenes ' + (idx[0] + 1) + ' to ' + (idx[idx.length - 1] + 1) + ' in ' + L.name + '. ' +
      'Each scene is ' + L.words + ' words of natural, flowing spoken language that takes about 15 seconds to read aloud. ' +
      'Only plain sentences: no scene numbers, no stage directions, no markdown, no emojis. Keep facts accurate and avoid made-up statistics. ' +
      'The narration continues from one scene to the next without repeating itself.\n' +
      'Return JSON: {"narrations": [' + idx.length + ' strings, in order]}';
    let res, tries = 0;
    while (true) {
      res = await gemini(prompt, signal);
      if (Array.isArray(res.narrations) && res.narrations.length === idx.length) break;
      if (++tries >= 2) throw new Error('The AI returned the wrong number of scenes. Try again.');
    }
    res.narrations.forEach((t, k) => { narr[idx[k]] = String(t).replace(/[*_#`]/g, '').trim(); });
  }
  job.title = String(outline.title || job.idea).slice(0, 80);
  job.scenes = scenes.map((s, i) => ({ query: s.query || s.beat, text: narr[i] }));
  setStep(0, 'done', job.scenes.length + ' scenes written', 1);
}

/* ---------- voice ---------- */
async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
async function tts(text, voice, rate, signal) {
  let lastErr;
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch('/api/tts', { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, voice, rate }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Voice error ' + r.status); }
      return await r.arrayBuffer();
    } catch (e) { if (e.name === 'AbortError') throw e; lastErr = e; await sleep(1200 * (a + 1)); }
  }
  throw lastErr;
}
async function recordVoice(job, actx, signal) {
  const L = LANGS[job.lang], voice = L[job.voice];
  let done = 0;
  setStep(1, 'active', 'Scene 0 of ' + job.scenes.length, 0);
  job.buffers = await pool(job.scenes, 3, async sc => {
    const data = await tts(sc.text, voice, job.rate, signal);
    const buf = await actx.decodeAudioData(data.slice(0));
    done++; setStep(1, 'active', 'Scene ' + done + ' of ' + job.scenes.length, done / job.scenes.length);
    return buf;
  });
  const secs = job.buffers.reduce((n, b) => n + b.duration, 0);
  setStep(1, 'done', 'Voice ready, ' + (secs / 60).toFixed(1) + ' min', 1);
}

/* ---------- photos ---------- */
async function findPhoto(query, shape, used, signal) {
  const key = getKey('pexels');
  const enc = encodeURIComponent(query);
  if (key) {
    try {
      const r = await fetch('https://api.pexels.com/v1/search?query=' + enc + '&per_page=10&orientation=' + (shape === 'vert' ? 'portrait' : 'landscape'), { headers: { Authorization: key }, signal });
      if (r.ok) {
        const j = await r.json();
        const fresh = (j.photos || []).filter(p => !used.has(p.id));
        const pool_ = fresh.length ? fresh : (j.photos || []);
        const p = pool_[Math.floor(Math.random() * Math.min(3, pool_.length))];
        if (p) { used.add(p.id); return { url: p.src.large2x || p.src.large, credit: 'Photo by ' + p.photographer + ' on Pexels' }; }
      }
    } catch (e) { if (e.name === 'AbortError') throw e; }
  }
  try {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=' +
      encodeURIComponent(query + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=1280';
    const r = await fetch(u, { signal });
    if (r.ok) {
      const j = await r.json();
      const pages = Object.values((j.query && j.query.pages) || {}).filter(p => p.imageinfo && p.imageinfo[0] && p.imageinfo[0].mime === 'image/jpeg' && p.imageinfo[0].thumburl && !used.has(p.pageid));
      const p = pages[Math.floor(Math.random() * Math.min(3, pages.length))];
      if (p) {
        used.add(p.pageid);
        const art = p.imageinfo[0].extmetadata && p.imageinfo[0].extmetadata.Artist ? p.imageinfo[0].extmetadata.Artist.value.replace(/<[^>]*>/g, '').trim() : '';
        return { url: p.imageinfo[0].thumburl, credit: (art ? art + ' via ' : '') + 'Wikimedia Commons' };
      }
    }
  } catch (e) { if (e.name === 'AbortError') throw e; }
  return null;
}
async function findPhotos(job, signal) {
  const used = new Set(); let done = 0, fallback = 0;
  setStep(2, 'active', 'Photo 0 of ' + job.scenes.length, 0);
  job.images = await pool(job.scenes, 4, async sc => {
    let img = null, credit = '';
    try {
      let hit = await findPhoto(sc.query, job.shape, used, signal);
      if (!hit && sc.query.includes(' ')) hit = await findPhoto(sc.query.split(' ')[0], job.shape, used, signal);
      if (hit) {
        const r = await fetch(hit.url, { signal });
        if (r.ok) { img = await createImageBitmap(await r.blob()); credit = hit.credit; }
      }
    } catch (e) { if (e.name === 'AbortError') throw e; }
    if (!img) fallback++;
    done++; setStep(2, 'active', 'Photo ' + done + ' of ' + job.scenes.length, done / job.scenes.length);
    return img ? { img, credit } : null;
  });
  setStep(2, 'done', (job.scenes.length - fallback) + ' photos found' + (fallback ? ', ' + fallback + ' scenes use a color card' : ''), 1);
}

/* ---------- video ---------- */
function drawBackdrop(g, W, H, item, idx, p, query) {
  if (item) {
    const img = item.img, z = 1.06 + (idx % 2 === 0 ? 0.1 * p : 0.1 * (1 - p));
    const ir = img.width / img.height, cr = W / H;
    let dw, dh; if (ir > cr) { dh = H * z; dw = dh * ir; } else { dw = W * z; dh = dw / ir; }
    const px = ((idx % 3) - 1) * 0.025 * W * (p - 0.5) * 2, py = (((idx + 1) % 3) - 1) * 0.02 * H * (p - 0.5) * 2;
    g.drawImage(img, (W - dw) / 2 + px, (H - dh) / 2 + py, dw, dh);
  } else {
    const hue = (idx * 47 + 170) % 360;
    const gr = g.createLinearGradient(0, 0, W, H);
    gr.addColorStop(0, 'hsl(' + hue + ',45%,22%)'); gr.addColorStop(1, 'hsl(' + ((hue + 40) % 360) + ',55%,38%)');
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.85)'; g.textAlign = 'center'; g.font = '600 ' + Math.round(H * 0.06) + 'px system-ui, sans-serif';
    g.fillText(String(query || '').toUpperCase(), W / 2, H * 0.42);
  }
}
function drawCaption(g, W, H, text, lang, vert) {
  if (!text) return;
  const fs = Math.round(H * (vert ? 0.03 : 0.05));
  g.font = '600 ' + fs + 'px system-ui, "Noto Sans Myanmar", "Noto Sans Devanagari", "Noto Sans Thai", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  const lines = wrapLines(text, lang, W * 0.84, t => g.measureText(t).width).slice(0, 3);
  const lh = fs * 1.35, boxH = lines.length * lh + fs * 0.7;
  const bottom = H * (vert ? 0.8 : 0.93), top = bottom - boxH;
  const bw = Math.min(W * 0.92, Math.max(...lines.map(l => g.measureText(l).width)) + fs * 1.4);
  g.fillStyle = 'rgba(0,0,0,.62)';
  g.beginPath(); g.roundRect((W - bw) / 2, top, bw, boxH, fs * 0.4); g.fill();
  g.fillStyle = '#fff';
  lines.forEach((l, i) => g.fillText(l, W / 2, top + fs * 0.35 + lh * (i + 0.8)));
}

async function renderVideo(job, actx, signal) {
  const vert = job.shape === 'vert', W = vert ? 720 : 1280, H = vert ? 1280 : 720;
  const canvas = $('live'); canvas.width = W; canvas.height = H; canvas.hidden = false; canvas.className = 'live' + (vert ? ' vert' : '');
  const g = canvas.getContext('2d');
  const tl = buildTimeline(job.buffers.map(b => b.duration));
  const maxChars = vert ? 34 : 64;
  const chunks = job.scenes.map(s => captionChunks(s.text, job.lang, maxChars));

  const dest = actx.createMediaStreamDestination();
  const stream = canvas.captureStream(30);
  dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const mimes = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mime = mimes.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('This browser cannot record video. Open the app in Chrome on Android.');
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vert ? 2000000 : 3000000, audioBitsPerSecond: 128000 });
  const parts = []; rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
  const finished = new Promise(res => { rec.onstop = res; });

  const sources = job.buffers.map(b => { const s = actx.createBufferSource(); s.buffer = b; s.connect(dest); s.connect(actx.destination); return s; });
  await actx.resume();
  const t0 = actx.currentTime + 0.4;
  sources.forEach((s, i) => s.start(t0 + tl.items[i].start));
  rec.start(1000);
  S.recorder = rec;

  setStep(3, 'active', 'Recording 0:00 of ' + fmt(tl.total), 0);
  let stopped = false;
  S.stopRecording = () => { stopped = true; sources.forEach(s => { try { s.stop(); } catch {} }); if (rec.state !== 'inactive') rec.stop(); };
  signal.addEventListener('abort', () => S.stopRecording && S.stopRecording());

  await new Promise(resolve => {
    function frame() {
      if (stopped) return resolve();
      const now = actx.currentTime - t0;
      if (now >= tl.total) return resolve();
      let idx = 0;
      for (let i = 0; i < tl.items.length; i++) if (now >= tl.items[i].start - 0.2) idx = i;
      const it = tl.items[idx], t = Math.max(0, now - it.start), p = Math.min(1, t / it.dur);
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      drawBackdrop(g, W, H, job.images[idx], idx, p, job.scenes[idx].query);
      if (idx > 0 && t < 0.5) {   // cross-fade from the previous scene
        g.globalAlpha = 1 - t / 0.5; drawBackdrop(g, W, H, job.images[idx - 1], idx - 1, 1, job.scenes[idx - 1].query); g.globalAlpha = 1;
      }
      if (now < 0.6) { g.globalAlpha = 1 - now / 0.6; g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
      if (idx === 0 && now > 0.4 && now < 4) {  // title
        g.globalAlpha = Math.min(1, (now - 0.4) / 0.5, (4 - now) / 0.5);
        g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, H * (vert ? 0.2 : 0.3), W, H * (vert ? 0.14 : 0.2));
        g.fillStyle = '#fff'; g.textAlign = 'center';
        const fs = Math.round(H * (vert ? 0.035 : 0.06));
        g.font = '700 ' + fs + 'px system-ui, "Noto Sans Myanmar", "Noto Sans Devanagari", "Noto Sans Thai", sans-serif';
        const tlines = wrapLines(job.title, job.lang, W * 0.86, s => g.measureText(s).width).slice(0, 2);
        tlines.forEach((l, i) => g.fillText(l, W / 2, H * (vert ? 0.2 : 0.3) + H * (vert ? 0.14 : 0.2) / 2 + fs * (i - (tlines.length - 1) / 2) * 1.25 + fs * 0.35));
        g.globalAlpha = 1;
      }
      if (now > 0.5) drawCaption(g, W, H, pickCaption(chunks[idx], Math.min(0.999, t / it.audio)), job.lang, vert);
      setStep(3, 'active', 'Recording ' + fmt(Math.max(0, now)) + ' of ' + fmt(tl.total), Math.max(0, now) / tl.total);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  });
  if (rec.state !== 'inactive') rec.stop();
  await finished;
  sources.forEach(s => { try { s.stop(); } catch {} });
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  const blob = new Blob(parts, { type: mime.split(';')[0] });
  job.blob = blob; job.mime = mime.split(';')[0]; job.seconds = tl.total;
  setStep(3, 'done', 'Video recorded', 1);
}
function fmt(s) { s = Math.floor(s); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }

/* ---------- run ---------- */
async function acquireWake() { try { if (navigator.wakeLock) S.wake = await navigator.wakeLock.request('screen'); } catch {} }
function releaseWake() { try { if (S.wake) S.wake.release(); } catch {} S.wake = null; }

async function run(resume) {
  if (S.running) return;
  if (!resume) {
    S.job = {
      idea: $('idea').value.trim() || 'Interesting facts', len: S.len, shape: S.shape, lang: $('lang').value, voice: $('voice').value, rate: $('speed').value
    };
    ui.states = []; ui.details = []; ui.frac = [0, 0, 0, 0];
  }
  const job = S.job;
  S.running = true; S.abort = new AbortController();
  const signal = S.abort.signal;
  $('err').hidden = true; $('retry').hidden = true; $('cancel').hidden = false; $('cancel').textContent = 'Cancel';
  $('p-title').textContent = 'Building your video'; $('live').hidden = true;
  show('progress'); paint();
  const actx = job.actx || (job.actx = new (window.AudioContext || window.webkitAudioContext)());
  await actx.resume();
  await acquireWake();
  let stage = 0;
  try {
    stage = 0; if (!job.scenes) await writeScript(job, signal);
    stage = 1; if (!job.buffers) await recordVoice(job, actx, signal);
    stage = 2; if (!job.images) await findPhotos(job, signal);
    stage = 3; await renderVideo(job, actx, signal);
    showResult(job);
  } catch (e) {
    if (e.name === 'AbortError') { $('p-title').textContent = 'Cancelled'; S.job = null; setTimeout(() => show('create'), 600); }
    else {
      setStep(stage, 'fail', e.message || 'Something went wrong', null);
      $('err').textContent = e.message || 'Something went wrong.'; $('err').hidden = false;
      $('retry').hidden = false; $('cancel').textContent = 'Back'; $('p-title').textContent = 'Something stopped';
    }
  } finally { S.running = false; releaseWake(); }
}

function showResult(job) {
  const url = URL.createObjectURL(job.blob); job.url = url;
  $('player').src = url; $('r-title').textContent = job.title;
  $('r-meta').textContent = fmt(job.seconds) + ' · ' + (job.shape === 'vert' ? '9:16' : '16:9') + ' · ' + LANGS[job.lang].label + ' · ' + (job.blob.size / 1048576).toFixed(1) + ' MB';
  const credits = [...new Set(job.images.filter(Boolean).map(x => x.credit))];
  $('credits').textContent = credits.length ? 'Photos: ' + credits.slice(0, 12).join('; ') + (credits.length > 12 ? '; and more' : '') + '. Add these credits when you publish.' : '';
  $('share').hidden = !(navigator.canShare && navigator.share);
  show('result');
}
function fileName(job) { return (job.title || 'video').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) + (job.mime === 'video/mp4' ? '.mp4' : '.webm'); }
$('save').addEventListener('click', () => {
  const j = S.job; if (!j) return;
  const a = document.createElement('a'); a.href = j.url; a.download = fileName(j); document.body.appendChild(a); a.click(); a.remove();
});
$('share').addEventListener('click', async () => {
  const j = S.job; if (!j) return;
  const f = new File([j.blob], fileName(j), { type: j.mime });
  try { if (navigator.canShare({ files: [f] })) await navigator.share({ files: [f], title: j.title }); } catch {}
});
$('again').addEventListener('click', () => { if (S.job && S.job.url) URL.revokeObjectURL(S.job.url); $('player').removeAttribute('src'); S.job = null; show('create'); });
$('go').addEventListener('click', () => {
  if (!getKey('gemini')) { $('gear').click(); return; }
  run(false);
});
$('retry').addEventListener('click', () => run(true));
$('cancel').addEventListener('click', () => {
  if (S.running && S.abort) S.abort.abort(); else { show('create'); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.running) acquireWake(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
