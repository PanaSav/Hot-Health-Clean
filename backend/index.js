// One-file backend (login gate, uploads, transcription+translation, QR, reports)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import cookieParser from 'cookie-parser';
import QRCode from 'qrcode';
import OpenAI from 'openai';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// -------------------------
// Config
// -------------------------
const app = express();
const PORT = Number(process.env.PORT || 10000);

const USER_ID    = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS  = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// DB layer (better-sqlite3 preferred, sqlite3 fallback)
// -------------------------
let db = null;
let useBetter = false;

async function initDB() {
  try {
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    db = new BetterSqlite3(path.join(__dirname, 'data.sqlite'));
    useBetter = true;
  } catch {
    const { default: sqlite3 } = await import('sqlite3');
    const { open } = await import('sqlite');
    db = await open({
      filename: path.join(__dirname, 'data.sqlite'),
      driver: sqlite3.Database
    });
    useBetter = false;
  }

  const createSql = `
  CREATE TABLE IF NOT EXISTS reports (
    id            TEXT PRIMARY KEY,
    created_at    TEXT,
    name          TEXT,
    email         TEXT,
    blood_type    TEXT,
    emer_name     TEXT,
    emer_phone    TEXT,
    emer_email    TEXT,
    detected_lang TEXT,
    target_lang   TEXT,
    transcript    TEXT,
    translated_transcript TEXT,
    medications   TEXT,
    allergies     TEXT,
    conditions    TEXT,
    bp            TEXT,
    weight        TEXT,
    share_url     TEXT,
    qr_data_url   TEXT
  );`;

  if (useBetter) db.exec(createSql);
  else await db.exec(createSql);
}

function dbRun(sql, params=[]) {
  if (useBetter) { db.prepare(sql).run(params); return Promise.resolve(); }
  return db.run(sql, params);
}
function dbGet(sql, params=[]) {
  if (useBetter) return Promise.resolve(db.prepare(sql).get(params));
  return db.get(sql, params);
}
function dbAll(sql, params=[]) {
  if (useBetter) return Promise.resolve(db.prepare(sql).all(params));
  return db.all(sql, params);
}

// -------------------------
// Auth (cookie)
// -------------------------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function setSession(res, user, req) {
  // Use secure cookies when behind HTTPS (Render)
  const forwardedProto = (req?.headers['x-forwarded-proto'] || '').split(',')[0];
  const isHttps = forwardedProto === 'https';
  res.cookie('hhsess', user, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    secure: isHttps // true on Render; false locally
  });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) {
    // if expecting JSON (upload), return JSON 401; else redirect
    if (req.path === '/upload' || req.headers['accept']?.includes('application/json')) {
      return res.status(401).json({ ok:false, error:'AUTH_REQUIRED' });
    }
    return res.redirect('/login');
  }
  next();
}

// -------------------------
// Helpers
// -------------------------
function getBaseUrl(req) {
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function uid(n=22) { return crypto.randomBytes(n).toString('base64url').slice(0, n); }

// Lightweight parser
function parseFacts(text) {
  const meds = [];
  const allergies = [];
  const conditions = [];

  // medications
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d+)\s*(mg|mcg|g|ml)/gi;
  let mm; const seen = new Set();
  while ((mm = medRx.exec(text)) !== null) {
    const name = mm[1];
    const dose = mm[2] + ' ' + mm[3];
    const key = name.toLowerCase() + '|' + dose.toLowerCase();
    if (!seen.has(key)) { meds.push(`${name} — ${dose}`); seen.add(key); }
  }

  // allergies
  const aRx = /\b(allergy|allergies|allergic to)\b([^\.]+)/gi;
  let aa;
  while ((aa = aRx.exec(text)) !== null) {
    const list = aa[2].split(/[,;]|and/).map(s => s.trim()).filter(Boolean);
    for (const item of list) {
      const clean = item.replace(/^(to|of)\s+/i,'').trim();
      if (clean && !allergies.includes(clean)) allergies.push(clean);
    }
  }

  // conditions (strip known words)
  const condRx = /\b(I have|I’ve|I've|diagnosed with|history of)\b([^\.]+)/gi;
  let cc;
  while ((cc = condRx.exec(text)) !== null) {
    const s = cc[2].replace(/\b(allergy|allergies|medications?|pills?)\b/ig,'').trim();
    if (s) conditions.push(s);
  }

  // blood pressure
  let bp = null;
  const bpRx = /\b(\d{2,3})\s*[/over\\-]\s*(\d{2,3})\b/i;
  const bpM = text.match(bpRx);
  if (bpM) bp = `${bpM[1]}/${bpM[2]}`;

  // weight
  let weight = null;
  const wRx = /\b(\d{2,3})\s*(?:lbs?|pounds?|kg)\b/i;
  const wM = text.match(wRx);
  if (wM) weight = wM[1] + (wM[0].toLowerCase().includes('kg') ? ' kg' : ' lbs');

  return { medications: meds, allergies, conditions, bp, weight };
}

// -------------------------
// Multer (store webm)
// -------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${uid(8)}.webm`)
});
const upload = multer({ storage });

// -------------------------
// Login / Logout
// -------------------------
app.get('/login', (req,res) => {
  const p = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  // fallback
  res.send(`
    <html><body>
      <h3>Sign in</h3>
      <form method="POST" action="/login">
        <input name="userId" placeholder="User ID"><br/>
        <input name="password" type="password" placeholder="Password"><br/>
        <button type="submit">Sign in</button>
      </form>
    </body></html>
  `);
});

app.post('/login', bodyParser.urlencoded({extended:true}), (req,res) => {
  const { userId, password } = req.body || {};
  if (userId === USER_ID && password === USER_PASS) {
    setSession(res, userId, req);
    return res.redirect('/');
  }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});

app.post('/logout', (req,res) => {
  clearSession(res);
  res.redirect('/login');
});

// -------------------------
// Protect EVERYTHING in the app (including static files)
// -------------------------
app.use(['/','/upload','/reports','/reports/*'], requireAuth);
app.use(express.static(PUBLIC_DIR)); // served after auth

// Home page
app.get('/', (req,res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// -------------------------
// Upload → Transcribe → (optional) Translate → Save → Respond
// -------------------------
app.post('/upload', upload.single('audio'), async (req,res) => {
  // extra guard for JSON 401
  if (!req.signedCookies?.hhsess) {
    return res.status(401).json({ ok:false, error:'AUTH_REQUIRED' });
  }

  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'No file' });

    const {
      name='', email='', emer_name='', emer_phone='', emer_email='',
      blood_type='', lang=''
    } = req.body || {};

    // 1) transcribe
    const stream = fs.createReadStream(req.file.path);
    let transcript = '';
    try {
      const tr = await openai.audio.transcriptions.create({
        file: stream,
        model: 'gpt-4o-mini-transcribe'
      });
      transcript = tr.text?.trim() || '';
    } catch {
      try {
        const stream2 = fs.createReadStream(req.file.path);
        const tr2 = await openai.audio.transcriptions.create({
          file: stream2,
          model: 'whisper-1'
        });
        transcript = tr2.text?.trim() || '';
      } catch {
        return res.status(500).json({ ok:false, error:'Transcription failed' });
      }
    }

    const detected_lang = 'auto';
    let translated = '';
    const target_lang = (lang || '').trim();

    // 2) optional translate transcript
    if (target_lang) {
      try {
        const prompt = `Translate the following medical note to ${target_lang}. Return only the translated text.\n\n${transcript}`;
        const rsp = await openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          messages: [{ role:'user', content: prompt }],
          temperature: 0.2
        });
        translated = rsp.choices?.[0]?.message?.content?.trim() || '';
      } catch {
        translated = '';
      }
    }

    // 3) parse facts from original transcript
    const facts = parseFacts(transcript);

    // 4) save
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(shareUrl);

    const insertSql = `
      INSERT INTO reports (
        id, created_at, name, email, blood_type, emer_name, emer_phone, emer_email,
        detected_lang, target_lang, transcript, translated_transcript,
        medications, allergies, conditions, bp, weight,
        share_url, qr_data_url
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    await dbRun(insertSql, [
      id, created_at, name, email, blood_type, emer_name, emer_phone, emer_email,
      detected_lang, target_lang, transcript, translated || '',
      (facts.medications||[]).join('; '),
      (facts.allergies||[]).join('; '),
      (facts.conditions||[]).join('; '),
      facts.bp || '', facts.weight || '',
      shareUrl, qr_data_url
    ]);

    res.json({ ok:true, id, url: shareUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// -------------------------
// Reports list
// -------------------------
app.get('/reports', async (req,res) => {
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const baseUrl = getBaseUrl(req);
  const escape = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  const items = rows.map(r => {
    const title = `Report for ${r.name || 'Unknown'}`;
    const url = `${baseUrl}/reports/${r.id}`;
    return `
      <li class="report-item">
        <div class="title">${escape(title)}</div>
        <div class="meta">${new Date(r.created_at).toLocaleString()} • ${escape(r.email||'')}</div>
        <div class="actions">
          <a class="btn" href="${url}" target="_blank" rel="noopener">Open</a>
        </div>
      </li>
    `;
  }).join('');

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Reports</title>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .container { max-width: 900px; margin: 0 auto; padding: 16px; }
  header { display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid aquamarine; padding:12px 0; }
  h1 { color:#4b0082; margin:0; }
  ul { list-style:none; padding:0; margin:16px 0; }
  .report-item { background:#fff; border:1px solid #dbe7ff; border-radius:10px; padding:12px; margin:10px 0; display:grid; gap:6px; }
  .title { font-weight:600; }
  .meta { color:#555; font-size:13px; }
  .actions { display:flex; gap:8px; }
  .btn { text-decoration:none; border:1px solid #dbe7ff; padding:8px 10px; border-radius:8px; background:#f0f5ff; color:#234; font-size:14px; }
</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Hot Health — Reports</h1>
      <nav>
        <a class="btn" href="/" rel="noopener">New Report</a>
        <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
      </nav>
    </header>
    <ul>${items || '<li class="report-item">No reports yet.</li>'}</ul>
  </div>
</body></html>`);
});

// -------------------------
// Single report
// -------------------------
app.get('/reports/:id', async (req,res) => {
  const row = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!row) return res.status(404).send('Not found');

  const esc = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const created = new Date(row.created_at).toLocaleString();
  const shareLinkIcon = `<a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener" title="Open share link">🔗 Link</a>`;

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hot Health Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .container { max-width: 900px; margin: 0 auto; padding: 0 16px 24px; }
  header { border-bottom:3px solid aquamarine; margin-bottom:12px; padding:14px 0; }
  h1 { color:#4b0082; margin:0 0 6px; }
  .section { background:#fff; border:2px solid aquamarine; border-radius:12px; padding:16px; margin:16px 0; }
  .dual { display:flex; gap:12px; flex-wrap:wrap; }
  .block { flex:1; min-width:260px; background:#f8faff; border:1px solid #dbe7ff; border-radius:8px; padding:12px; }
  .qr { text-align:center; margin:8px 0; }
  .tag { display:inline-block; font-size:12px; color:#334; background:#eef4ff; border:1px solid #dbe7ff; padding:2px 6px; border-radius:12px; margin-left:6px; }
  .btnbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Hot Health — Report 
        ${row.detected_lang ? `<span class="tag">Original: ${esc(row.detected_lang)}</span>`:''}
        ${row.target_lang ? `<span class="tag">Target: ${esc(row.target_lang)}</span>`:''}
      </h1>
      <div><b>Created:</b> ${esc(created)} ${shareLinkIcon}</div>
      <div class="qr">
        <img src="${esc(row.qr_data_url)}" alt="QR Code" style="max-width:180px;"/>
        <div style="font-size:13px;color:#555">Scan on a phone, or use the link button.</div>
      </div>
      <div class="btnbar">
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <a class="btn" href="/reports" rel="noopener">All Reports</a>
      </div>
    </header>

    <section class="section">
      <h2>Patient Details</h2>
      <div><b>Name:</b> ${esc(row.name||'')}</div>
      <div><b>Email:</b> ${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : ''}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type||'')}</div>
      <div><b>Emergency Contact:</b> ${esc(row.emer_name||'')} ${row.emer_phone?`(${esc(row.emer_phone)})`:''} ${row.emer_email?`<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}</div>
    </section>

    <section class="section">
      <h2>Summary</h2>
      <div><b>Medications:</b> ${esc(row.medications || 'None')}</div>
      <div><b>Allergies:</b> ${esc(row.allergies || 'None')}</div>
      <div><b>Conditions:</b> ${esc(row.conditions || 'None')}</div>
      <div><b>Blood Pressure:</b> ${esc(row.bp || '—')}</div>
      <div><b>Weight:</b> ${esc(row.weight || '—')}</div>
    </section>

    <section class="section">
      <h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original</h3>
          <p>${esc(row.transcript || '')}</p>
        </div>
        <div class="block">
          <h3>Translated</h3>
          <p>${esc(row.translated_transcript || '(no translation)')}</p>
        </div>
      </div>
    </section>

    <footer style="text-align:center;color:#666;margin-top:20px;">Hot Health © 2025</footer>
  </div>
</body></html>`);
});

// -------------------------
// Start
// -------------------------
await initDB();
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
