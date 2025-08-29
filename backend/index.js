// backend/index.js
// One-file backend with: login gate, sqlite3 DB, six-mini-recorder upload,
// OpenAI transcription+translation, parser, QR, dual-block report, email/print/link,
// reports list. (sqlite3 ONLY — no 'sqlite', no 'better-sqlite3').

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import express from 'express';
import bodyParser from 'body-parser';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import QRCode from 'qrcode';
import OpenAI from 'openai';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// -------------------------
// Config
// -------------------------
const app = express();

// PORT: Render injects PORT; local fallback 10000
const PORT = Number(process.env.PORT || 10000);

// Auth (simple)
const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';

// Cookie secret (any random string)
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

// Paths
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

// Middleware
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// -------------------------
// Utility helpers
// -------------------------
function getBaseUrl(req) {
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function uid(n = 22) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

function esc(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// -------------------------
// DB (sqlite3 only)
// -------------------------
sqlite3.verbose();
const DB_PATH = path.join(__dirname, 'data.sqlite');
const _db = new sqlite3.Database(DB_PATH);

// Promisified helpers
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => _db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); }));
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => _db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); }));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => _db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); }));

async function initDB() {
  const sql = `
    CREATE TABLE IF NOT EXISTS reports (
      id                      TEXT PRIMARY KEY,
      created_at              TEXT,
      name                    TEXT,
      email                   TEXT,
      blood_type              TEXT,
      emer_name               TEXT,
      emer_phone              TEXT,
      emer_email              TEXT,
      doctor_name             TEXT,
      doctor_phone            TEXT,
      doctor_fax              TEXT,
      doctor_email            TEXT,
      pharmacy_name           TEXT,
      pharmacy_phone          TEXT,
      pharmacy_fax            TEXT,
      pharmacy_address        TEXT,
      detected_lang           TEXT,
      target_lang             TEXT,
      // Combined note (all parts merged)
      transcript              TEXT,
      translated_transcript   TEXT,
      // Parsed
      medications             TEXT,
      allergies               TEXT,
      conditions              TEXT,
      bp                      TEXT,
      weight                  TEXT,
      // General note (free-form)
      general_note            TEXT,
      translated_general_note TEXT,
      // Links
      share_url               TEXT,
      qr_data_url             TEXT
    );
  `;
  // Remove JS comment token from SQL if any (safety in case of copy/paste)
  await dbRun(sql.replace(/\/\/.*$/gm, ''));
}

// -------------------------
// Auth
// -------------------------
function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly: true, signed: true, sameSite: 'lax' });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

app.get('/login', (req, res) => {
  const loginHtml = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(loginHtml)) return res.sendFile(loginHtml);
  res.send(`<!doctype html><meta charset="utf-8"><title>Sign in</title>
  <form method="POST" action="/login">
    <input name="userId" placeholder="User ID"><br/>
    <input name="password" type="password" placeholder="Password"><br/>
    <button type="submit">Sign in</button>
  </form>`);
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

// -------------------------
// Multer for six mini recorders OR single 'audio'
// -------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${uid(8)}${path.extname(file.originalname || '.webm') || '.webm'}`)
});
const upload = multer({ storage });

// We accept either single file ('audio') OR multiple parts below:
const partsFields = upload.fields([
  { name: 'bp_audio', maxCount: 1 },
  { name: 'meds_audio', maxCount: 1 },
  { name: 'allergies_audio', maxCount: 1 },
  { name: 'weight_audio', maxCount: 1 },
  { name: 'conditions_audio', maxCount: 1 },
  { name: 'note_audio', maxCount: 1 },
  { name: 'audio', maxCount: 1 } // fallback single recorder
]);

// -------------------------
// OpenAI helpers
// -------------------------
async function transcribeFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return '';
  // Try gpt-4o-mini-transcribe, fallback to whisper-1
  try {
    const tr = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: 'gpt-4o-mini-transcribe'
    });
    return tr.text?.trim() || '';
  } catch {
    try {
      const tr2 = await openai.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: 'whisper-1'
      });
      return tr2.text?.trim() || '';
    } catch {
      return '';
    }
  }
}

async function translateText(text, targetLang) {
  if (!text || !targetLang) return '';
  const prompt = `Translate the following medical note to ${targetLang}. Return only the translated text.\n\n${text}`;
  try {
    const rsp = await openai.chat.completions.create({
      model: TEXT_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    });
    return rsp.choices?.[0]?.message?.content?.trim() || '';
  } catch {
    return '';
  }
}

// -------------------------
// Parser (lightweight)
// -------------------------
function parseFacts(text) {
  const medications = [];
  const allergies = [];
  const conditions = [];

  // meds like "X at 10 mg" or "X — 10 mg"
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d+)\s*(mg|mcg|g|ml)/gi;
  let m; const seen = new Set();
  while ((m = medRx.exec(text)) !== null) {
    const name = m[1];
    const dose = `${m[2]} ${m[3]}`;
    const key = (name + '|' + dose).toLowerCase();
    if (!seen.has(key)) { medications.push(`${name} — ${dose}`); seen.add(key); }
  }
  // allergies
  const aRx = /\b(allergy|allergies|allergic to)\b([^\.]+)/gi;
  let a;
  while ((a = aRx.exec(text)) !== null) {
    const list = a[2].split(/[,;]|and/).map(s => s.trim()).filter(Boolean);
    for (const item of list) {
      const clean = item.replace(/^(to|of)\s+/i, '').trim();
      if (clean && !allergies.includes(clean)) allergies.push(clean);
    }
  }
  // conditions
  const cRx = /\b(I have|I've|I’ve|diagnosed with|history of)\b([^\.]+)/gi;
  let c;
  while ((c = cRx.exec(text)) !== null) {
    const s = c[2].replace(/\b(allergy|allergies|medications?|pills?)\b/ig, '').trim();
    if (s) conditions.push(s);
  }
  // BP
  let bp = null;
  const bpRx = /\b(\d{2,3})\s*(?:\/|over|-|\\)\s*(\d{2,3})\b/;
  const bpM = text.match(bpRx);
  if (bpM) bp = `${bpM[1]}/${bpM[2]}`;
  // weight
  let weight = null;
  const wRx = /\b(\d{2,3})\s*(?:lbs?|pounds?|kg)\b/i;
  const wM = text.match(wRx);
  if (wM) weight = wM[1] + (wM[0].toLowerCase().includes('kg') ? ' kg' : ' lbs');

  return { medications, allergies, conditions, bp, weight };
}

// -------------------------
// Home page (must exist in backend/public/index.html)
// -------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// -------------------------
// Upload endpoint (supports six mini recorders OR single audio)
// -------------------------
app.post('/upload', partsFields, async (req, res) => {
  try {
    // Patient/doctor/pharmacy + options
    const {
      name = '', email = '', blood_type = '',
      emer_name = '', emer_phone = '', emer_email = '',
      doctor_name = '', doctor_phone = '', doctor_fax = '', doctor_email = '',
      pharmacy_name = '', pharmacy_phone = '', pharmacy_fax = '', pharmacy_address = '',
      lang = '',

      // Optional typed texts next to recorders:
      bp_text = '', meds_text = '', allergies_text = '', weight_text = '', conditions_text = '', note_text = ''
    } = req.body || {};

    // Gather file paths (six recorders)
    const getPath = (field) => (req.files?.[field]?.[0]?.path) || null;

    const files = {
      bp:          getPath('bp_audio'),
      meds:        getPath('meds_audio'),
      allergies:   getPath('allergies_audio'),
      weight:      getPath('weight_audio'),
      conditions:  getPath('conditions_audio'),
      note:        getPath('note_audio'),
      // fallback: one big 'audio'
      single:      getPath('audio')
    };

    // Transcribe each present file
    const tr = {
      bp:         await transcribeFile(files.bp),
      meds:       await transcribeFile(files.meds),
      allergies:  await transcribeFile(files.allergies),
      weight:     await transcribeFile(files.weight),
      conditions: await transcribeFile(files.conditions),
      note:       await transcribeFile(files.note),
      single:     await transcribeFile(files.single)
    };

    // Merge typed text with transcripts
    const merge = (a, b) => [a, b].filter(Boolean).join(' ').trim();
    const bpFinal         = merge(tr.bp, bp_text);
    const medsFinal       = merge(tr.meds, meds_text);
    const allergiesFinal  = merge(tr.allergies, allergies_text);
    const weightFinal     = merge(tr.weight, weight_text);
    const conditionsFinal = merge(tr.conditions, conditions_text);
    const noteFinal       = merge(tr.note, note_text);

    // Combined transcript (if six-part UI is used, this is the stitched note;
    // if single recorder UI is used, it’s just that transcript)
    const combinedTranscript = [bpFinal, medsFinal, allergiesFinal, weightFinal, conditionsFinal, noteFinal, tr.single]
      .filter(Boolean)
      .join('\n');

    // Parse facts from combinedTranscript
    const facts = parseFacts(combinedTranscript);
    const detected_lang = 'auto';
    const target_lang   = (lang || '').trim();

    // Translate transcript and general note (if target_lang set)
    const translated_transcript   = target_lang ? (await translateText(combinedTranscript, target_lang)) : '';
    const translated_general_note = target_lang ? (await translateText(noteFinal, target_lang)) : '';

    // Persist
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(shareUrl);

    const insertSql = `
      INSERT INTO reports (
        id, created_at, name, email, blood_type,
        emer_name, emer_phone, emer_email,
        doctor_name, doctor_phone, doctor_fax, doctor_email,
        pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
        detected_lang, target_lang,
        transcript, translated_transcript,
        medications, allergies, conditions, bp, weight,
        general_note, translated_general_note,
        share_url, qr_data_url
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    await dbRun(insertSql, [
      id, created_at, name, email, blood_type,
      emer_name, emer_phone, emer_email,
      doctor_name, doctor_phone, doctor_fax, doctor_email,
      pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
      detected_lang, target_lang,
      combinedTranscript, translated_transcript,
      (facts.medications || []).join('; '),
      (facts.allergies   || []).join('; '),
      (facts.conditions  || []).join('; '),
      facts.bp || '', facts.weight || '',
      noteFinal || '', translated_general_note || '',
      shareUrl, qr_data_url
    ]);

    return res.json({ ok: true, id, url: shareUrl });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// -------------------------
// Reports list
// -------------------------
app.get('/reports', async (req, res) => {
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const items = rows.map(r => {
    const title = `Report for ${r.name || 'Unknown'}`;
    return `
      <li class="report-item">
        <div class="title">${esc(title)}</div>
        <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email || '')}</div>
        <div class="actions">
          <a class="btn" href="/reports/${r.id}" target="_blank" rel="noopener">Open</a>
        </div>
      </li>`;
  }).join('');

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Reports</title>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .container { max-width: 960px; margin: 0 auto; padding: 16px; }
  header { display:flex; justify-content:space-between; align-items:center; border-bottom:3px solid aquamarine; padding:12px 0; }
  h1 { color:#4b0082; margin:0; }
  ul { list-style:none; padding:0; margin:16px 0; }
  .report-item { background:#fff; border:1.5px solid #dbe7ff; border-radius:10px; padding:12px; margin:10px 0; display:grid; gap:6px; }
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
        <a class="btn" href="/" rel="noopener">+ New Report</a>
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
  const created = new Date(row.created_at).toLocaleString();

  // E-mail compose helpers (Gmail / Outlook) with share URL
  const subject = encodeURIComponent(`Hot Health Report for ${row.name || ''}`);
  const body    = encodeURIComponent(`Here is the shareable report link:\n${row.share_url}\n\n— Sent via Hot Health`);
  const gmailLink   = `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`;
  const outlookLink = `https://outlook.live.com/mail/0/deeplink/compose?subject=${subject}&body=${body}`;

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hot Health Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .container { max-width: 960px; margin: 0 auto; padding: 0 16px 24px; }
  header { border-bottom:3px solid aquamarine; margin-bottom:12px; padding:14px 0; }
  h1 { color:#4b0082; margin:0 0 6px; }
  .section { background:#fff; border:2px solid aquamarine; border-radius:12px; padding:16px; margin:16px 0; }
  .dual { display:flex; gap:12px; flex-wrap:wrap; }
  .block { flex:1; min-width:280px; background:#f8faff; border:1px solid #dbe7ff; border-radius:8px; padding:12px; }
  .qr { text-align:center; margin:8px 0; }
  .tag { display:inline-block; font-size:12px; color:#334; background:#eef4ff; border:1px solid #dbe7ff; padding:2px 6px; border-radius:12px; margin-left:6px; }
  .btnbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
  .btn { text-decoration:none; border:1px solid #dbe7ff; padding:8px 10px; border-radius:8px; background:#f0f5ff; color:#234; font-size:14px; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; }
  @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>
<script>
  function doPrint(){ window.print(); }
  async function copyLink(){
    try { await navigator.clipboard.writeText('${esc(row.share_url)}'); alert('Link copied'); }
    catch(e){ alert('Copy failed'); }
  }
</script>
</head>
<body>
  <div class="container">
    <header>
      <h1>Hot Health — Report
        ${row.detected_lang ? `<span class="tag">Original: ${esc(row.detected_lang)}</span>`:''}
        ${row.target_lang   ? `<span class="tag">Target: ${esc(row.target_lang)}</span>`:''}
      </h1>
      <div><b>Created:</b> ${esc(created)}</div>
      <div class="qr">
        <img src="${esc(row.qr_data_url)}" alt="QR Code" style="max-width:180px;"/>
        <div style="font-size:13px;color:#555">Scan on a phone, or use the buttons below.</div>
      </div>
      <div class="btnbar">
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <a class="btn" href="/reports" rel="noopener">All Reports</a>
        <a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener">Open Link</a>
        <button class="btn" onclick="copyLink()">Copy Link</button>
        <a class="btn" href="${gmailLink}" target="_blank" rel="noopener">Email (Gmail)</a>
        <a class="btn" href="${outlookLink}" target="_blank" rel="noopener">Email (Outlook)</a>
        <button class="btn" onclick="doPrint()">Print</button>
      </div>
    </header>

    <section class="section">
      <h2>Patient, Doctor & Pharmacy</h2>
      <div class="grid">
        <div><b>Patient:</b> ${esc(row.name||'')}</div>
        <div><b>Email:</b> ${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : '—'}</div>
        <div><b>Blood Type:</b> ${esc(row.blood_type||'')}</div>
        <div><b>Emergency:</b> ${esc(row.emer_name||'')} ${row.emer_phone?`(${esc(row.emer_phone)})`:''} ${row.emer_email?`<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}</div>
        <div><b>Doctor:</b> ${esc(row.doctor_name||'N/A')} ${row.doctor_phone?`(${esc(row.doctor_phone)})`:''} ${row.doctor_email?`<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>`:''} ${row.doctor_fax?`Fax: ${esc(row.doctor_fax)}`:''}</div>
        <div><b>Pharmacy:</b> ${esc(row.pharmacy_name||'N/A')} ${row.pharmacy_phone?`(${esc(row.pharmacy_phone)})`:''} ${row.pharmacy_fax?`Fax: ${esc(row.pharmacy_fax)}`:''} ${row.pharmacy_address?` — ${esc(row.pharmacy_address)}`:''}</div>
      </div>
    </section>

    <section class="section">
      <h2>Summary</h2>
      <div class="dual">
        <div class="block">
          <h3>Original ${row.detected_lang ? `(${esc(row.detected_lang)})`: ''}</h3>
          <p><b>Medications:</b> ${esc(row.medications || 'None')}</p>
          <p><b>Allergies:</b> ${esc(row.allergies || 'None')}</p>
          <p><b>Conditions:</b> ${esc(row.conditions || 'None')}</p>
          <p><b>Blood Pressure:</b> ${esc(row.bp || '—')}</p>
          <p><b>Weight:</b> ${esc(row.weight || '—')}</p>
          <p><b>General Note:</b> ${esc(row.general_note || '—')}</p>
        </div>
        <div class="block">
          <h3>${row.target_lang ? `Summary (${esc(row.target_lang)})` : 'Translated Summary'}</h3>
          <p><b>General Note:</b> ${esc(row.translated_general_note || '(no translation)')}</p>
          <p style="font-size:12px;color:#666">(Medications/Allergies/Conditions reflect the original parsing.)</p>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original ${row.detected_lang ? `(${esc(row.detected_lang)})`: ''}</h3>
          <pre style="white-space:pre-wrap;">${esc(row.transcript || '')}</pre>
        </div>
        <div class="block">
          <h3>${row.target_lang ? `Transcript (${esc(row.target_lang)})` : 'Translated'}</h3>
          <pre style="white-space:pre-wrap;">${esc(row.translated_transcript || '(no translation)')}</pre>
        </div>
      </div>
    </section>

    <footer style="text-align:center;color:#666;margin-top:20px;">Hot Health © 2025</footer>
  </div>
</body></html>`);
});

// -------------------------
// Boot
// -------------------------
await initDB();
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
