// backend/index.js
// Hot Health – sqlite3-only backend (login gate, uploads, transcription+translation, QR, reports)

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

// -------------------------
// Paths & basic setup
// -------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = Number(process.env.PORT || 10000);

// Login credentials (simple cookie session)
const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

// Public and uploads
const PUBLIC_DIR  = path.join(__dirname, 'public');
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// DB layer (sqlite3 only)
// -------------------------
import sqlite3pkg from 'sqlite3';
const sqlite3 = sqlite3pkg.verbose();

const DB_FILE = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(DB_FILE);

// promise helpers
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

async function initDB() {
  // best-effort WAL; ignore if not supported
  await dbRun(`PRAGMA journal_mode = WAL;`).catch(() => {});

  const createSql = `
    CREATE TABLE IF NOT EXISTS reports (
      id                     TEXT PRIMARY KEY,
      created_at             TEXT,
      name                   TEXT,
      email                  TEXT,
      blood_type             TEXT,
      emer_name              TEXT,
      emer_phone             TEXT,
      emer_email             TEXT,
      detected_lang          TEXT,
      target_lang            TEXT,
      transcript             TEXT,
      translated_transcript  TEXT,
      medications            TEXT,
      allergies              TEXT,
      conditions             TEXT,
      bp                     TEXT,
      weight                 TEXT,
      share_url              TEXT,
      qr_data_url            TEXT
    );
  `;
  await dbRun(createSql);
}

// -------------------------
// Middleware
// -------------------------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// -------------------------
// Helpers
// -------------------------
function uid(n = 22) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

function getBaseUrl(req) {
  // Prefer explicit env to avoid “localhost” leakage on Render.
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// quick, naive medical parser
function parseFacts(text) {
  const meds = [];
  const allergies = [];
  const conditions = [];

  // medications like "X 20 mg", "X — 20 mg", "X at 20 mg"
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:|\s)?\s*(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  const seen = new Set();
  let m;
  while ((m = medRx.exec(text)) !== null) {
    const name = m[1];
    const dose = `${m[2]} ${m[3]}`;
    const key  = `${name.toLowerCase()}|${dose.toLowerCase()}`;
    if (!seen.has(key)) { meds.push(`${name} — ${dose}`); seen.add(key); }
  }

  // allergies
  const aRx = /\ballerg(?:y|ies)|allergic to\b([^\.]+)/gi;
  let a;
  while ((a = aRx.exec(text)) !== null) {
    const tail = (a[1] || '').replace(/^(?:\s*to\s*)/i,'');
    const list = tail.split(/,|;| and /i).map(s => s.trim()).filter(Boolean);
    for (const item of list) if (item && !allergies.includes(item)) allergies.push(item);
  }

  // conditions
  const cRx = /\b(I have|I've|I’ve|diagnosed with|history of)\b([^\.]+)/gi;
  let c;
  while ((c = cRx.exec(text)) !== null) {
    const s = c[2]
      .replace(/\b(allerg(?:y|ies)|allergic|medications?|pills?)\b/ig, '')
      .trim();
    if (s) conditions.push(s);
  }

  // blood pressure
  let bp = null;
  const bpM = text.match(/\b(\d{2,3})\s*(?:\/|over|-)\s*(\d{2,3})\b/);
  if (bpM) bp = `${bpM[1]}/${bpM[2]}`;

  // weight
  let weight = null;
  const wM = text.match(/\b(\d{2,3})\s*(lbs?|pounds?|kg)\b/i);
  if (wM) weight = `${wM[1]} ${/kg/i.test(wM[2]) ? 'kg' : 'lbs'}`;

  return { medications: meds, allergies, conditions, bp, weight };
}

// -------------------------
// Auth
// -------------------------
function setSession(res, user) {
  res.cookie('hhsess', user, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
    // secure: true, // enable if you force HTTPS
    maxAge: 7 * 24 * 3600 * 1000
  });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

app.get('/login', (req, res) => {
  const p = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send(`<!doctype html><html><body>
    <h3>Sign in</h3>
    <form method="POST" action="/login">
      <input name="userId" placeholder="User ID"><br/>
      <input name="password" type="password" placeholder="Password"><br/>
      <button type="submit">Sign in</button>
    </form>
  </body></html>`);
});

app.post('/login', bodyParser.urlencoded({ extended: true }), (req, res) => {
  const { userId, password } = req.body || {};
  if (userId === USER_ID && password === USER_PASS) {
    setSession(res, userId);
    return res.redirect('/');
  }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});

app.post('/logout', (req, res) => { clearSession(res); res.redirect('/login'); });

// Protect app pages
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// Home (frontend)
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// -------------------------
// Uploads / transcription
// -------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${uid(8)}.webm`)
});
const upload = multer({ storage });

app.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });

    const {
      name = '', email = '', emer_name = '', emer_phone = '', emer_email = '',
      blood_type = '', lang = ''
    } = req.body || {};

    // 1) Transcribe
    let transcript = '';
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(req.file.path),
        model: 'gpt-4o-mini-transcribe'
      });
      transcript = tr.text?.trim() || '';
    } catch {
      // fallback whisper-1
      try {
        const tr2 = await openai.audio.transcriptions.create({
          file: fs.createReadStream(req.file.path),
          model: 'whisper-1'
        });
        transcript = tr2.text?.trim() || '';
      } catch {
        return res.status(500).json({ ok: false, error: 'Transcription failed' });
      }
    }

    const detected_lang = 'auto';
    const target_lang = (lang || '').trim();
    let translated = '';

    // 2) Optional translate transcript
    if (target_lang) {
      try {
        const prompt = `Translate this medical note to ${target_lang}. Return only the translated text.\n\n${transcript}`;
        const rsp = await openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2
        });
        translated = rsp.choices?.[0]?.message?.content?.trim() || '';
      } catch {
        translated = '';
      }
    }

    // 3) Parse facts from ORIGINAL transcript
    const facts = parseFacts(transcript);

    // 4) Save
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
      (facts.medications || []).join('; '),
      (facts.allergies || []).join('; '),
      (facts.conditions || []).join('; '),
      facts.bp || '', facts.weight || '',
      shareUrl, qr_data_url
    ]);

    // 5) Reply
    res.json({ ok: true, id, url: shareUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// -------------------------
// Reports list
// -------------------------
app.get('/reports', async (req, res) => {
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const baseUrl = getBaseUrl(req);
  const esc = (s = '') => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const items = rows.map(r => `
    <li class="report-item">
      <div class="title">Report for ${esc(r.name || 'Unknown')}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email || '')}</div>
      <div class="actions">
        <a class="btn" href="${baseUrl}/reports/${r.id}" target="_blank" rel="noopener">Open</a>
      </div>
    </li>
  `).join('');

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
app.get('/reports/:id', async (req, res) => {
  const row = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!row) return res.status(404).send('Not found');

  const esc = (s = '') => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const created = new Date(row.created_at).toLocaleString();
  const shareButton = `<a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener" title="Open share link">🔗 Link</a>`;

  // “dual block” transcript display
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
  .list { margin:6px 0; padding-left:18px; }
</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Hot Health — Report 
        ${row.detected_lang ? `<span class="tag">Original: ${esc(row.detected_lang)}</span>` : ''}
        ${row.target_lang   ? `<span class="tag">Target: ${esc(row.target_lang)}</span>` : ''}
      </h1>
      <div><b>Created:</b> ${esc(created)} ${shareButton}</div>
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
      <div><b>Name:</b> ${esc(row.name || '')}</div>
      <div><b>Email:</b> ${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : '—'}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type || '—')}</div>
      <div><b>Emergency Contact:</b> ${esc(row.emer_name || '')} ${row.emer_phone ? `(${esc(row.emer_phone)})` : ''} ${row.emer_email ? `<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>` : ''}</div>
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
          <h3>Original${row.detected_lang ? ` (${esc(row.detected_lang)})` : ''}</h3>
          <p>${esc(row.transcript || '')}</p>
        </div>
        <div class="block">
          <h3>${row.target_lang ? `Translated (${esc(row.target_lang)})` : 'Translated'}</h3>
          <p>${esc(row.translated_transcript || '(no translation)')}</p>
        </div>
      </div>
    </section>

    <footer style="text-align:center;color:#666;margin-top:20px;">Hot Health © 2025</footer>
  </div>
</body></html>`);
});

// -------------------------
// Start server
// -------------------------
await initDB();
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
