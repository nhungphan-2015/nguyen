// Vietnamese text-to-speech for the call board: returns an MP3 so Smart TVs
// without a Vietnamese speech voice can still play the announcement.
// Uses Google Translate's public TTS endpoint (free, unofficial, max ~200 chars).
const cache = new Map();
const MAX_CACHE = 300;

export async function ttsHandler(req, res, next) {
  try {
    const text = String(req.query.text || '').trim().slice(0, 200);
    if (!text) return res.status(400).json({ error: 'Thiếu nội dung cần đọc' });

    let audio = cache.get(text);
    if (!audio) {
      const url =
        'https://translate.google.com/translate_tts?ie=UTF-8&tl=vi&client=tw-ob&ttsspeed=0.8&q=' +
        encodeURIComponent(text);
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return res.status(502).json({ error: `Không tạo được giọng đọc (${r.status})` });
      audio = Buffer.from(await r.arrayBuffer());
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
