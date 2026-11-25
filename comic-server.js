// ---------------------------------------------------------------------
// COMIC STUDIO BACKEND  (mounted from server.js with one line)
//
// What it does:
//   • Login: one password, set in Railway's Variables as COMIC_PASSWORD.
//     Logging in gives the browser a cookie that lasts 60 days.
//   • AI: the page never sees an API key. It asks this server, and the
//     server calls OpenAI or Google with the key from Railway's Variables.
//   • Saving: characters, places, pages, pictures and settings are saved on the
//     Railway Volume (DATA_DIR, normally /data) in /data/comic/, so they
//     survive every redeploy. Pictures are saved as image files.
//
// Railway Variables it reads:
//   COMIC_PASSWORD      - REQUIRED. The password for mylucent.co/comic.
//   OPENAI_API_KEY      - your OpenAI key (platform.openai.com/api-keys).
//   GEMINI_API_KEY      - (optional) a Google AI Studio key, if you'd rather
//                         use Google's image model. If both keys are set,
//                         OpenAI is used unless COMIC_AI=gemini.
//   COMIC_AI            - (optional) "openai" or "gemini".
//   COMIC_IMAGE_MODEL   - (optional) image model. Defaults: gpt-image-2 /
//                         gemini-3.1-flash-image.
//   COMIC_TEXT_MODEL    - (optional) model for "AI understood", Polish and
//                         Ideas. Defaults: gpt-6-luna / gemini-flash-latest.
// ---------------------------------------------------------------------
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

module.exports = function mountComicStudio(app, { express, dataDir }) {
  const ROOT = path.join(dataDir, 'comic');
  const IMG_DIR = path.join(ROOT, 'img');
  const STORES = ['chars', 'places', 'pages', 'meta'];
  fs.mkdirSync(IMG_DIR, { recursive: true });
  STORES.forEach((s) => fs.mkdirSync(path.join(ROOT, s), { recursive: true }));

  const env = (k) => (process.env[k] || '').trim();
  const provider = () => {
    const pick = env('COMIC_AI').toLowerCase();
    if (pick === 'gemini' && geminiKey()) return 'gemini';
    if (pick === 'openai' && env('OPENAI_API_KEY')) return 'openai';
    if (env('OPENAI_API_KEY')) return 'openai';
    if (geminiKey()) return 'gemini';
    return null;
  };
  const geminiKey = () => env('GEMINI_API_KEY') || env('GOOGLE_API_KEY');
  const imageModel = () => env('COMIC_IMAGE_MODEL') || (provider() === 'gemini' ? 'gemini-3.1-flash-image' : 'gpt-image-2');
  const textModel = () => env('COMIC_TEXT_MODEL') || (provider() === 'gemini' ? 'gemini-flash-latest' : 'gpt-6-luna');

  // ---------- login ----------
  const COOKIE = 'comic_session';
  const sign = (v) => crypto.createHmac('sha256', 'comic-studio:' + env('COMIC_PASSWORD')).update(v).digest('hex');
  function makeToken() { const exp = String(Date.now() + 60 * 24 * 3600 * 1000); return exp + '.' + sign(exp); }
  function readCookie(req) {
    const raw = req.headers.cookie || '';
    const m = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(COOKIE + '='));
    return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : '';
  }
  function loggedIn(req) {
    if (!env('COMIC_PASSWORD')) return false;
    const [exp, sig] = readCookie(req).split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const good = sign(exp);
    return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
  }
  const needLogin = (req, res, next) => (loggedIn(req) ? next() : res.status(401).json({ error: 'Please log in.', login: true }));

  // slow down password guessing: 10 wrong tries per 15 minutes per address
  const tries = new Map();
  const small = express.json({ limit: '50kb' });
  app.post('/api/comic/login', small, (req, res) => {
    if (!env('COMIC_PASSWORD')) return res.status(503).json({ error: 'No password is set yet. Add COMIC_PASSWORD in Railway → Variables, then redeploy.' });
    const ip = req.ip || 'x', now = Date.now(), t = (tries.get(ip) || []).filter((x) => now - x < 15 * 60 * 1000);
    if (t.length >= 10) return res.status(429).json({ error: 'Too many wrong tries. Wait 15 minutes and try again.' });
    const given = String((req.body && req.body.password) || '');
    const a = crypto.createHash('sha256').update(given).digest(), b = crypto.createHash('sha256').update(env('COMIC_PASSWORD')).digest();
    if (!crypto.timingSafeEqual(a, b)) { t.push(now); tries.set(ip, t); return res.status(401).json({ error: 'Wrong password.' }); }
    tries.delete(ip);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 24 * 3600}${secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });
  app.post('/api/comic/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });
  app.get('/api/comic/status', (req, res) => {
    const p = provider();
    res.json({ loggedIn: loggedIn(req), passwordSet: !!env('COMIC_PASSWORD'), ready: !!p, provider: p || 'openai',
      imageModel: p ? imageModel() : null, textModel: p ? textModel() : null });
  });

  // Nice address: mylucent.co/comic
  app.get(['/comic', '/comic/'], (req, res) => res.sendFile(path.join(__dirname, 'comic-studio.html')));

  // ---------- pictures on the volume ----------
  const IMG_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;
  function saveImageBuffer(buf, ext) {
    const name = crypto.createHash('sha1').update(buf).digest('hex') + '.' + (ext === 'jpeg' ? 'jpg' : ext);
    const file = path.join(IMG_DIR, name);
    if (!fs.existsSync(file)) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file); }
    return '/api/comic/img/' + name;
  }
  function saveDataUrl(dataUrl) {
    const m = IMG_RE.exec(String(dataUrl || ''));
    if (!m) throw new Error('That is not a picture this app can save.');
    return saveImageBuffer(Buffer.from(m[2], 'base64'), m[1]);
  }
  // Turns a saved-picture address or a data: picture into {mime, buf}
  function readPicture(ref) {
    ref = String(ref || '');
    const m = IMG_RE.exec(ref);
    if (m) return { mime: 'image/' + (m[1] === 'jpg' ? 'jpeg' : m[1]), buf: Buffer.from(m[2], 'base64') };
    const n = /^\/api\/comic\/img\/([a-f0-9]{40}\.(png|jpg|webp|gif))$/.exec(ref.split('?')[0]);
    if (!n) throw new Error('A reference picture could not be found.');
    const file = path.join(IMG_DIR, n[1]);
    if (!fs.existsSync(file)) throw new Error('A reference picture is missing on the server.');
    return { mime: 'image/' + (n[2] === 'jpg' ? 'jpeg' : n[2]), buf: fs.readFileSync(file) };
  }
  app.get('/api/comic/img/:name', needLogin, (req, res) => {
    if (!/^[a-f0-9]{40}\.(png|jpg|webp|gif)$/.test(req.params.name)) return res.status(404).end();
    const file = path.join(IMG_DIR, req.params.name);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(file);
  });
  const big = express.json({ limit: '60mb' });
  app.post('/api/comic/img', needLogin, big, (req, res) => {
    try { res.json({ url: saveDataUrl(req.body && req.body.data) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ---------- saved documents (characters, pages, book settings) ----------
  const okId = (id) => /^[\w-]{1,80}$/.test(String(id || ''));
  function docFile(store, id) { return path.join(ROOT, store, id + '.json'); }
  app.get('/api/comic/all', needLogin, (req, res) => {
    const out = {};
    for (const s of STORES) {
      out[s] = [];
      for (const f of fs.readdirSync(path.join(ROOT, s))) {
        if (!f.endsWith('.json')) continue;
        try { out[s].push(JSON.parse(fs.readFileSync(path.join(ROOT, s, f), 'utf8'))); } catch (e) { console.error('Comic: could not read', s, f, e.message); }
      }
    }
    res.json(out);
  });
  app.put('/api/comic/doc/:store/:id', needLogin, big, (req, res) => {
    const { store, id } = req.params, doc = req.body;
    if (!STORES.includes(store) || !okId(id) || !doc || typeof doc !== 'object' || String(doc.id) !== id) return res.status(400).json({ error: 'Bad save request.' });
    try {
      // any picture still embedded in the document is moved into its own file
      const walk = (o) => { for (const k of Object.keys(o)) { const v = o[k];
        if (typeof v === 'string' && v.startsWith('data:image/')) { try { o[k] = saveDataUrl(v); } catch (e) {} }
        else if (v && typeof v === 'object') walk(v); } };
      walk(doc);
      const file = docFile(store, id), tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc)); fs.renameSync(tmp, file);
      res.json({ ok: true });
    } catch (e) { console.error('Comic: save failed', e.message); res.status(500).json({ error: 'The server could not save. ' + e.message }); }
  });
  app.delete('/api/comic/doc/:store/:id', needLogin, (req, res) => {
    const { store, id } = req.params;
    if (!STORES.includes(store) || !okId(id)) return res.status(400).json({ error: 'Bad request.' });
    try { fs.rmSync(docFile(store, id), { force: true }); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ---------- AI ----------
  const noKey = () => ({ status: 503, error: 'No AI key on the server yet. Add OPENAI_API_KEY (or GEMINI_API_KEY) in Railway → Variables, then redeploy.' });
  async function readJson(r) { try { return await r.json(); } catch (e) { return {}; } }

  app.post('/api/comic/ai/image', needLogin, big, async (req, res) => {
    const p = provider(); if (!p) { const e = noKey(); return res.status(e.status).json({ error: e.error }); }
    try {
      const { text, aspect } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Nothing to draw.' });
      const refs = (Array.isArray(req.body.refs) ? req.body.refs : []).slice(0, 13).map((r) => Object.assign({ label: String(r.label || '') }, readPicture(r.data)));
      // "Keep the room exactly": a fixed background picture, plus a mask of where the AI may paint
      const base = req.body.base ? readPicture(req.body.base) : null;
      const mask = base && req.body.mask ? readPicture(req.body.mask) : null;
      const hint = base && req.body.hint ? readPicture(req.body.hint) : null;
      if (base) refs.unshift(Object.assign({ label: 'THE FIXED BACKGROUND to paint into (only the masked area may change)' }, base));
      const [aw, ah] = String(aspect || '1:1').split(':').map(Number), ratio = aw / ah || 1;
      let buf, ext = 'png';
      if (p === 'openai') {
        const size = ratio > 1.05 ? '1536x1024' : ratio < 0.95 ? '1024x1536' : '1024x1024';
        let r;
        if (refs.length) {
          const fd = new FormData();
          refs.forEach((x, i) => fd.append('image[]', new Blob([x.buf], { type: x.mime }), `ref${i + 1}.${x.mime.split('/')[1]}`));
          if (mask) fd.append('mask', new Blob([mask.buf], { type: 'image/png' }), 'mask.png');
          fd.append('model', imageModel());
          fd.append('prompt', text + '\n\nThe attached images, in order: ' + refs.map((x, i) => `image ${i + 1} = ${x.label}`).join('; '));
          fd.append('size', size); fd.append('n', '1');
          r = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY') }, body: fd });
        } else {
          r = await fetch('https://api.openai.com/v1/images/generations', { method: 'POST', headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY'), 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: imageModel(), prompt: text, size, n: 1 }) });
        }
        const j = await readJson(r);
        if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'OpenAI returned error ' + r.status });
        const d = j.data && j.data[0];
        if (!d || !d.b64_json) return res.status(502).json({ error: 'No image came back. Try rewording.' });
        buf = Buffer.from(d.b64_json, 'base64');
      } else {
        const parts = [{ text }];
        refs.forEach((x, i) => { parts.push({ text: x.label }); parts.push({ inline_data: { mime_type: x.mime, data: x.buf.toString('base64') } });
          if (i === 0 && hint) { parts.push({ text: 'The same background with the area to paint into marked in red. Paint only there; keep everything else identical.' }); parts.push({ inline_data: { mime_type: hint.mime, data: hint.buf.toString('base64') } }); } });
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(imageModel())}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: aspect || '1:1' } } }) });
        const j = await readJson(r);
        if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'Google returned error ' + r.status });
        const ps = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        const out = ps.find((x) => x.inlineData || x.inline_data);
        if (!out) { const why = (j.candidates && j.candidates[0] && j.candidates[0].finishReason) || (j.promptFeedback && j.promptFeedback.blockReason);
          return res.status(502).json({ error: 'No image came back' + (why ? ' (' + why + ')' : '') + '. Try rewording.' }); }
        const d = out.inlineData || out.inline_data;
        buf = Buffer.from(d.data, 'base64'); ext = /jpe?g/.test(d.mimeType || d.mime_type || '') ? 'jpg' : 'png';
      }
      res.json({ url: saveImageBuffer(buf, ext) });
    } catch (e) { console.error('Comic image error:', e.message); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/comic/ai/text', needLogin, small, async (req, res) => {
    const p = provider(); if (!p) { const e = noKey(); return res.status(e.status).json({ error: e.error }); }
    try {
      const { system, user, json } = req.body || {};
      let text = '';
      if (p === 'openai') {
        const r = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + env('OPENAI_API_KEY'), 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: textModel(), instructions: String(system || ''), input: json ? String(user || '') + '\n\nReply with a JSON object only.' : String(user || ''), ...(json ? { text: { format: { type: 'json_object' } } } : {}) }) });
        const j = await readJson(r);
        if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'OpenAI returned error ' + r.status });
        text = j.output_text || (j.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
      } else {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(textModel())}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey() },
          body: JSON.stringify({ systemInstruction: { parts: [{ text: String(system || '') }] }, contents: [{ role: 'user', parts: [{ text: String(user || '') }] }], generationConfig: json ? { responseMimeType: 'application/json' } : {} }) });
        const j = await readJson(r);
        if (!r.ok) return res.status(502).json({ error: (j.error && j.error.message) || 'Google returned error ' + r.status });
        text = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((x) => x.text || '').join('');
      }
      res.json({ text });
    } catch (e) { console.error('Comic text error:', e.message); res.status(500).json({ error: e.message }); }
  });

  console.log('Comic Studio: saving to', ROOT, '| AI:', provider() || 'no key set', '| password', env('COMIC_PASSWORD') ? 'set' : 'NOT set');
};
