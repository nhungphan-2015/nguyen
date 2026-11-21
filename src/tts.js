// Vietnamese text-to-speech for the call board: returns an MP3 so Smart TVs
// without a Vietnamese speech voice can still play the announcement.
// - FPT_TTS_KEY set: FPT.AI voice (default "lannhi" = female, Southern accent)
// - otherwise / on failure: Google Translate's public TTS (free, unofficial, max ~200 chars)
const cache = new Map();
const MAX_CACHE = 300;

const FPT_VOICE = process.env.FPT_TTS_VOICE || 'lannhi';
const FPT_SPEED = process.env.FPT_TTS_SPEED || '-1'; // -3 (slowest) … 3

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fptTts(text) {
  const r = await fetch('https://api.fpt.ai/hmi/tts/v5', {
    method: 'POST',
    headers: { 'api-key': process.env.FPT_TTS_KEY, voice: FPT_VOICE, speed: FPT_SPEED },
    body: text,
  });
  const info = await r.json();
  if (!r.ok || info.error !== 0 || !info.async) throw new Error(info.message || `FPT ${r.status}`);
  // FPT returns a link that becomes downloadable a few seconds later
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const f = await fetch(info.async);
    if (f.ok) return Buffer.from(await f.arrayBuffer());
  }
  throw new Error('FPT audio not ready');
}

async function googleTts(text) {
  const url =
    'https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&ttsspeed=0.8&q=' +
    encodeURIComponent(text);
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`Google TTS ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export async function ttsHandler(req, res, next) {
  try {
    const text = String(req.query.text || '').trim().slice(0, 200);
    if (!text) return res.status(400).json({ error: 'Thiếu nội dung cần đọc' });

    let audio = cache.get(text);
    if (!audio) {
      if (process.env.FPT_TTS_KEY) {
        try {
          audio = await fptTts(text);
        } catch (err) {
          console.error('FPT TTS failed, using Google:', err.message);
        }
      }
      if (!audio) audio = await googleTts(text);
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(text, audio);
    }
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(audio);
  } catch (err) {
    next(err);
  }
}
