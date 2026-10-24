// Pure helpers (no DOM) so they can be tested in Node.
export function parseJson(text) {
  let t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('The AI reply was not valid JSON.');
}

export function segs(text, lang) {
  try { return Array.from(new Intl.Segmenter(lang, { granularity: 'word' }).segment(text), s => s.segment); }
  catch { return text.split(/(\s+)/).filter(Boolean); }
}

// Split narration into caption pieces that fit on screen, each with a share of the scene time.
export function captionChunks(text, lang, maxChars) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const sentences = clean.split(/(?<=[.!?।॥။…])\s*/u).filter(s => s.trim());
  const pieces = [];
  for (const s of sentences) {
    if (s.length <= maxChars) { pieces.push(s.trim()); continue; }
    const k = Math.ceil(s.length / maxChars), target = Math.ceil(s.length / k);
    let cur = '', made = 0;
    for (const g of segs(s, lang)) {
      if ((cur + g).length > target && cur.trim() && made < k - 1) { pieces.push(cur.trim()); made++; cur = g.trimStart(); }
      else cur += g;
    }
    if (cur.trim()) pieces.push(cur.trim());
  }
  const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
  let acc = 0;
  return pieces.map(p => { const from = acc / total; acc += p.length; return { text: p, from, to: acc / total }; });
}

export function wrapLines(text, lang, maxWidth, measure) {
  const lines = []; let line = '';
  for (const g of segs(text, lang)) {
    const test = line + g;
    if (measure(test) > maxWidth && line.trim()) { lines.push(line.trim()); line = g.trimStart(); }
    else line = test;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function buildTimeline(durations, lead = 0.8, gap = 0.35) {
  let t = lead; const out = [];
  for (const d of durations) { out.push({ start: t, audio: d, dur: d + gap }); t += d + gap; }
  return { items: out, total: t + 0.6 };
}

export function pickCaption(chunks, p) {
  if (!chunks.length) return '';
  for (const c of chunks) if (p >= c.from && p < c.to) return c.text;
  return chunks[chunks.length - 1].text;
}
