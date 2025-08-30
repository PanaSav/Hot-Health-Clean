// One-file backend (sqlite3-only; no 'sqlite' or 'better-sqlite3')
// Features: login gate, uploads, transcription+translation, parsing, QR, reports list & single report

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
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ------------------ Config ------------------
const app = express();
const PORT = Number(process.env.PORT || 10000);

const USER_ID    = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS  = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------ DB (sqlite3 only) ------------------
sqlite3.verbose();
const DB_PATH = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(DB_PATH);

// promise helpers
const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
});
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
});

// schema
await dbRun(`
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
  )
`);

// ------------------ Middleware ------------------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ------------------ Auth ------------------
function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly: true, signed: true, sameSite: 'lax' });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

app.get('/login', (req,res) => {
  const p = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send(`
    <!doctype html><html><body>
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
    setSession(res, userId);
    return res.redirect('/');
  }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});

app.post('/logout', (req,res) => { clearSession(res); res.redirect('/login'); });

// protect app & reports
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// home page
app.get('/', (req,res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ------------------ Helpers ------------------
function getBaseUrl(req) {
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function uid(n=22) { return crypto.randomBytes(n).toString('base64url').slice(0, n); }

function parseFacts(text) {
  const meds = [];
  const allergies = [];
  const conditions = [];

  // medications: NAME — 20 mg
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d+)\s*(mg|mcg|g|ml)\b/gi;
  const seen = new Set();
  let m;
  while ((m = medRx.exec(text)) !== null) {
    const name = m[1]; const dose = `${m[2]} ${m[3]}`;
    const key = `${name.toLowerCase()}|${dose.toLowerCase()}`;
    if (!seen.has(key)) { meds.push(`${name} — ${dose}`); seen.add(key); }
  }

  // allergies
  const aRx = /\ballerg(?:y|ies)\b[^.:\n]*[:\-]?\s*([^.\n]+)/gi;
  let a;
  while ((a = aRx.exec(text)) !== null) {
    const list = a[1].split(/,|;| and /i).map(s => s.trim()).filter(Boolean);
    for (const item of list) if (!allergies.includes(item)) allergies.push(item);
  }

  // conditions
  const cRx = /\b(I have|I've|I’ve|diagnosed with|history of)\b([^.\n]+)/gi;
  let c;
  while ((c = cRx.exec(text)) !== null) {
    const cleaned = c[2].replace(/\b(allerg(?:y|ies)|medications?|pills?)\b/ig,'').trim();
    if (cleaned) conditions.push(cleaned);
  }

  // blood pressure
  let bp = null; { const mm = text.match(/\b(\d{2,3})\s*[/over\\-]\s*(\d{2,3})\b/i); if (mm) bp = `${mm[1]}/${mm[2]}`; }

  // weight
  let weight = null; {
    const wm = text.match(/\b(\d{2,3})\s*(?:lbs?|pounds?|kg)\b/i);
    if (wm) weight = wm[1] + (wm[0].toLowerCase().includes('kg') ? ' kg' : ' lbs');
  }

  return { medications: meds, allergies, conditions, bp, weight };
}

// ------------------ Multer ------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, __, cb) => cb(null, `${Date.now()}-${uid(8)}.webm`)
});
const upload = multer({ storage });

// ------------------ Upload -> Transcribe -> Translate -> Save ------------------
app.post('/upload', upload.single('audio'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'No file' });

    const {
      name='', email='', emer_name='', emer_phone='', emer_email='',
      blood_type='', lang=''
    } = req.body || {};

    // transcribe
    let transcript = '';
    try {
      const r = await openai.audio.transcriptions.create({
        file: fs.createReadStream(req.file.path),
        model: 'gpt-4o-mini-transcribe'
      });
      transcript = r.text?.trim() || '';
    } catch {
      try {
        const r2 = await openai.audio.transcriptions.create({
          file: fs.createReadStream(req.file.path),
          model: 'whisper-1'
        });
        transcript = r2.text?.trim() || '';
      } catch {
        return res.status(500).json({ ok:false, error:'Transcription failed' });
      }
    }

    const detected_lang = 'en'; // simple default; could detect via LLM if needed
    let target_lang = (lang || '').trim();
    let translated = '';

    if (target_lang) {
      try {
        const rsp = await openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          messages: [{ role:'user', content:`Translate to ${target_lang}:\n\n${transcript}` }],
          temperature: 0.2
        });
        translated = rsp.choices?.[0]?.message?.content?.trim() || '';
      } catch { translated = ''; }
    }

    const facts = parseFacts(transcript);

    // save
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/reports/${id}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    await dbRun(`
      INSERT INTO reports (
        id, created_at, name, email, blood_type, emer_name, emer_phone, emer_email,
        detected_lang, target_lang, transcript, translated_transcript,
        medications, allergies, conditions, bp, weight,
        share_url, qr_data_url
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      id, created_at, name, email, blood_type, emer_name, emer_phone, emer_email,
      detected_lang, target_lang, transcript, translated,
      (facts.medications||[]).join('; '),
      (facts.allergies||[]).join('; '),
      (facts.conditions||[]).join('; '),
      facts.bp || '', facts.weight || '',
      shareUrl, qrDataUrl
    ]);

    res.json({ ok:true, id, url: shareUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// ------------------ Reports list ------------------
app.get('/reports', async (req,res) => {
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const esc = s => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const items = rows.map(r => `
    <li class="report-item">
      <div class="title">Report for ${esc(r.name||'Unknown')}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email||'')}</div>
      <div class="actions"><a class="btn" href="/reports/${r.id}" target="_blank" rel="noopener">Open</a></div>
    </li>
  `).join('') || '<li class="report-item">No reports yet.</li>';

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/><title>Reports</title>
<link rel="stylesheet" href="/styles.css"/>
<style>
.container{max-width:900px;margin:0 auto;padding:16px;}
header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid aquamarine;padding:12px 0;}
h1{color:#4b0082;margin:0;}
ul{list-style:none;padding:0;margin:16px 0;}
.report-item{background:#fff;border:1px solid #dbe7ff;border-radius:10px;padding:12px;margin:10px 0;display:grid;gap:6px;}
.title{font-weight:600}
.meta{color:#555;font-size:13px}
.actions{display:flex;gap:8px}
.btn{text-decoration:none;border:1px solid #dbe7ff;padding:8px 10px;border-radius:8px;background:#f0f5ff;color:#234;font-size:14px}
</style>
</head><body>
<div class="container">
  <header>
    <h1>Hot Health — Reports</h1>
    <nav>
      <a class="btn" href="/" rel="noopener">New Report</a>
      <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
    </nav>
  </header>
  <ul>${items}</ul>
</div>
</body></html>`);
});

// ------------------ Single report ------------------
app.get('/reports/:id', async (req,res) => {
  const r = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).send('Not found');

  const esc = s => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const created = new Date(r.created_at).toLocaleString();
  const shareBtn = `<a class="btn" href="${esc(r.share_url)}" target="_blank" rel="noopener" title="Open share link">🔗 Link</a>`;

  // Email compose helpers
  const subj = encodeURIComponent(`Hot Health Report for ${r.name||''}`);
  const body = encodeURIComponent(`${r.share_url}\n\nSummary:\nMeds: ${r.medications}\nAllergies: ${r.allergies}\nConditions: ${r.conditions}`);
  const mailto = `mailto:${encodeURIComponent(r.email||'') || ''}?subject=${subj}&body=${body}`;
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&su=${subj}&body=${body}`;
  const outlook = `https://outlook.office.com/mail/deeplink/compose?subject=${subj}&body=${body}`;

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hot Health Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="/styles.css"/>
<style>
.container{max-width:900px;margin:0 auto;padding:0 16px 24px;}
header{border-bottom:3px solid aquamarine;margin-bottom:12px;padding:14px 0;}
h1{color:#4b0082;margin:0 0 6px;}
.section{background:#fff;border:2px solid aquamarine;border-radius:12px;padding:16px;margin:16px 0;}
.dual{display:flex;gap:12px;flex-wrap:wrap;}
.block{flex:1;min-width:260px;background:#f8faff;border:1px solid #dbe7ff;border-radius:8px;padding:12px;}
.qr{text-align:center;margin:8px 0;}
.tag{display:inline-block;font-size:12px;color:#334;background:#eef4ff;border:1px solid #dbe7ff;padding:2px 6px;border-radius:12px;margin-left:6px;}
.btnbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;}
.list{margin:6px 0;padding-left:18px;}
.actions{display:flex;gap:8px;flex-wrap:wrap}
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>Hot Health — Report
      ${r.detected_lang ? `<span class="tag">Original: ${esc(r.detected_lang)}</span>`:''}
      ${r.target_lang ? `<span class="tag">Target: ${esc(r.target_lang)}</span>`:''}
    </h1>
    <div><b>Created:</b> ${esc(created)} ${shareBtn}</div>
    <div class="qr">
      <img src="${esc(r.qr_data_url)}" alt="QR Code" style="max-width:180px;"/>
      <div style="font-size:13px;color:#555">Scan on a phone, or use the link button.</div>
    </div>
    <div class="btnbar">
      <a class="btn" href="/" rel="noopener">+ New Report</a>
      <a class="btn" href="/reports" rel="noopener">All Reports</a>
    </div>
  </header>

  <section class="section">
    <h2>Patient Details</h2>
    <div><b>Name:</b> ${esc(r.name||'')}</div>
    <div><b>Email:</b> ${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : ''}</div>
    <div><b>Blood Type:</b> ${esc(r.blood_type||'')}</div>
    <div><b>Emergency Contact:</b> ${esc(r.emer_name||'')} ${r.emer_phone?`(${esc(r.emer_phone)})`:''} ${r.emer_email?`<a href="mailto:${esc(r.emer_email)}">${esc(r.emer_email)}</a>`:''}</div>
  </section>

  <section class="section">
    <h2>Summary</h2>
    <div><b>Medications:</b> ${esc(r.medications || 'None')}</div>
    <div><b>Allergies:</b> ${esc(r.allergies || 'None')}</div>
    <div><b>Conditions:</b> ${esc(r.conditions || 'None')}</div>
    <div><b>Blood Pressure:</b> ${esc(r.bp || '—')}</div>
    <div><b>Weight:</b> ${esc(r.weight || '—')}</div>
  </section>

  <section class="section">
    <h2>Transcript</h2>
    <div class="dual">
      <div class="block">
        <h3>Original${r.detected_lang ? ` (${esc(r.detected_lang)})` : ''}</h3>
        <p>${esc(r.transcript || '')}</p>
      </div>
      <div class="block">
        <h3>${r.target_lang ? `Translated (${esc(r.target_lang)})` : 'Translated'}</h3>
        <p>${esc(r.translated_transcript || '(no translation)')}</p>
      </div>
    </div>
  </section>

  <section class="section">
    <h2>Share / Print</h2>
    <div class="actions">
      <a class="btn" href="${mailto}">✉️ Email (Default)</a>
      <a class="btn" href="${gmail}" target="_blank" rel="noopener">📧 Gmail</a>
      <a class="btn" href="${outlook}" target="_blank" rel="noopener">📮 Outlook</a>
      <a class="btn" href="${esc(r.share_url)}" target="_blank" rel="noopener">🔗 Get Link</a>
      <button class="btn" onclick="window.print()">🖨️ Print</button>
    </div>
  </section>

  <footer style="text-align:center;color:#666;margin-top:20px;">Hot Health © 2025</footer>
</div>
</body></html>`);
});

// ------------------ Start ------------------
app.listen(PORT, () => console.log(`✅ Backend listening on ${PORT}`));
