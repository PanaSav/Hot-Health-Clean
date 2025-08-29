// backend/index.js
// Hot Health — sqlite3-only backend with auth, rich patient/doctor/pharmacy,
// uploads, transcription + translation, parsed + translated summaries,
// QR share, reports list & single report.

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
import sqlite3pkg from 'sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = Number(process.env.PORT || 10000);

// -------- Auth config --------
const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

// -------- Paths --------
const PUBLIC_DIR  = path.join(__dirname, 'public');
const TPL_DIR     = path.join(__dirname, 'templates'); // optional (we inline HTML below)
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// -------- OpenAI --------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini';

// -------- DB: sqlite3 only --------
const sqlite3 = sqlite3pkg.verbose();
const DB_FILE = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(DB_FILE);
const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

async function initDB() {
  await dbRun(`PRAGMA journal_mode = WAL;`).catch(() => {});

  await dbRun(`
    CREATE TABLE IF NOT EXISTS reports (
      id                     TEXT PRIMARY KEY,
      created_at             TEXT,

      -- Patient
      name                   TEXT,
      email                  TEXT,
      blood_type             TEXT,

      -- Emergency contact
      emer_name              TEXT,
      emer_phone             TEXT,
      emer_email             TEXT,

      -- Doctor
      doctor_name            TEXT,
      doctor_phone           TEXT,
      doctor_fax             TEXT,
      doctor_email           TEXT,

      -- Pharmacy
      pharmacy_name          TEXT,
      pharmacy_phone         TEXT,
      pharmacy_fax           TEXT,
      pharmacy_address       TEXT,

      -- Langs
      detected_lang          TEXT,
      target_lang            TEXT,

      -- Text
      transcript             TEXT,
      translated_transcript  TEXT,

      -- Parsed summary (orig)
      medications            TEXT,
      allergies              TEXT,
      conditions             TEXT,
      bp                     TEXT,
      weight                 TEXT,
      general_note           TEXT,

      -- Parsed summary (translated)
      medications_t          TEXT,
      allergies_t            TEXT,
      conditions_t           TEXT,
      bp_t                   TEXT,
      weight_t               TEXT,
      general_note_t         TEXT,

      -- Share
      share_url              TEXT,
      qr_data_url            TEXT
    );
  `);

  // Add missing columns defensively (safe to run repeatedly)
  const need = [
    ['doctor_name','TEXT'],['doctor_phone','TEXT'],['doctor_fax','TEXT'],['doctor_email','TEXT'],
    ['pharmacy_name','TEXT'],['pharmacy_phone','TEXT'],['pharmacy_fax','TEXT'],['pharmacy_address','TEXT'],
    ['general_note','TEXT'],
    ['medications_t','TEXT'],['allergies_t','TEXT'],['conditions_t','TEXT'],['bp_t','TEXT'],['weight_t','TEXT'],['general_note_t','TEXT']
  ];
  const cols = await dbAll(`PRAGMA table_info(reports)`);
  const have = new Set(cols.map(c => c.name));
  for (const [name, type] of need) {
    if (!have.has(name)) {
      await dbRun(`ALTER TABLE reports ADD COLUMN ${name} ${type};`).catch(()=>{});
    }
  }
}

// -------- Utilities --------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

function uid(n=22){ return crypto.randomBytes(n).toString('base64url').slice(0,n); }
function getBaseUrl(req){
  const u = process.env.PUBLIC_BASE_URL;
  if (u && /^https?:\/\//i.test(u)) return u.replace(/\/+$/,'');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
const esc = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// quick parser (now with general note capture)
function parseFacts(text) {
  const meds = [];
  const allergies = [];
  const conditions = [];

  // meds
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:|\s)?\s*(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  const seen = new Set(); let m;
  while ((m = medRx.exec(text)) !== null) {
    const key = `${m[1].toLowerCase()}|${m[2]} ${m[3]}`;
    if (!seen.has(key)) { meds.push(`${m[1]} — ${m[2]} ${m[3]}`); seen.add(key); }
  }

  // allergies
  const aRx = /\ballerg(?:y|ies)|allergic to\b([^\.]+)/gi; let a;
  while ((a = aRx.exec(text)) !== null) {
    const tail = (a[1] || '').replace(/^\s*to\s*/i,'');
    const list = tail.split(/,|;| and /i).map(s => s.trim()).filter(Boolean);
    for (const item of list) if (item && !allergies.includes(item)) allergies.push(item);
  }

  // conditions
  const cRx = /\b(I have|I've|I’ve|diagnosed with|history of)\b([^\.]+)/gi; let c;
  while ((c = cRx.exec(text)) !== null) {
    const s = c[2].replace(/\b(allerg(?:y|ies)|allergic|medications?|pills?)\b/ig,'').trim();
    if (s) conditions.push(s);
  }

  // BP
  let bp = null; const bpM = text.match(/\b(\d{2,3})\s*(?:\/|over|-)\s*(\d{2,3})\b/);
  if (bpM) bp = `${bpM[1]}/${bpM[2]}`;

  // Weight
  let weight = null; const wM = text.match(/\b(\d{2,3})\s*(lbs?|pounds?|kg)\b/i);
  if (wM) weight = `${wM[1]} ${/kg/i.test(wM[2]) ? 'kg' : 'lbs'}`;

  // General note: try to extract “note …” or “overall …”
  let general = '';
  const gM = text.match(/\b(note|overall|summary):?\s*([^\.]+)\.?/i);
  if (gM) general = (gM[2] || '').trim();

  return { medications: meds, allergies, conditions, bp, weight, general_note: general };
}

async function translateIfNeeded(textOrArray, targetLang){
  if (!targetLang) return { ok:false, out:'' };
  const original = Array.isArray(textOrArray) ? textOrArray.join('\n') : String(textOrArray||'');
  if (!original.trim()) return { ok:true, out:'' };
  const prompt = `Translate to ${targetLang}. Keep bullets/lines.\n\n${original}`;
  try{
    const rsp = await openai.chat.completions.create({
      model: TEXT_MODEL,
      messages: [{ role:'user', content: prompt }],
      temperature: 0.2
    });
    const out = rsp.choices?.[0]?.message?.content?.trim() || '';
    return { ok:true, out };
  }catch{
    return { ok:false, out:'' };
  }
}

// -------- Auth routes --------
function setSession(res, user){
  res.cookie('hhsess', user, { httpOnly:true, signed:true, sameSite:'lax', maxAge:7*24*3600e3 });
}
function clearSession(res){ res.clearCookie('hhsess'); }
function requireAuth(req,res,next){
  if (!req.signedCookies?.hhsess) return res.redirect('/login');
  next();
}

app.get('/login', (req,res) => {
  const p = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send(`<!doctype html><html><body>
    <h3>Sign in</h3>
    <form method="POST" action="/login">
      <input name="userId" placeholder="User ID"><br/>
      <input name="password" type="password" placeholder="Password"><br/>
      <button type="submit">Sign in</button>
    </form></body></html>`);
});
app.post('/login', bodyParser.urlencoded({extended:true}), (req,res)=>{
  const { userId, password } = req.body||{};
  if (userId===USER_ID && password===USER_PASS){ setSession(res,userId); return res.redirect('/'); }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout', (req,res)=>{ clearSession(res); res.redirect('/login'); });

// Protect app + reports
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// Home
app.get('/', (req,res)=> res.sendFile(path.join(PUBLIC_DIR,'index.html')));

// -------- Uploads --------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomUUID().slice(0,8)}.webm`)
});
const upload = multer({ storage });

app.post('/upload', upload.single('audio'), async (req,res)=>{
  try{
    if (!req.file) return res.status(400).json({ ok:false, error:'No file' });

    const {
      name='', email='', blood_type='',
      emer_name='', emer_phone='', emer_email='',
      doctor_name='N/A', doctor_phone='N/A', doctor_fax='N/A', doctor_email='N/A',
      pharmacy_name='N/A', pharmacy_phone='N/A', pharmacy_fax='N/A', pharmacy_address='N/A',
      lang='',     // target language
      parts=''     // optional extra typed/voice chunks from UI (we’ll merge)
    } = req.body || {};

    // 1) Transcribe entire recording
    let transcript = '';
    try{
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(req.file.path),
        model: 'gpt-4o-mini-transcribe'
      });
      transcript = tr.text?.trim() || '';
    }catch{
      try{
        const tr2 = await openai.audio.transcriptions.create({
          file: fs.createReadStream(req.file.path),
          model: 'whisper-1'
        });
        transcript = tr2.text?.trim() || '';
      }catch{
        return res.status(500).json({ ok:false, error:'Transcription failed' });
      }
    }

    // Merge any “parts” text the frontend sends (line-separated)
    let merged = transcript;
    if (parts && String(parts).trim()) {
      merged = [transcript, String(parts).trim()].filter(Boolean).join('\n');
    }

    // 2) Translate transcript if requested
    const target_lang = (lang||'').trim();
    let translated_transcript = '';
    if (target_lang){
      const t = await translateIfNeeded(merged, target_lang);
      translated_transcript = t.out || '';
    }

    // 3) Parse facts from ORIGINAL transcript (not the translated one)
    const facts = parseFacts(merged);

    // 4) Build translated summary (per block) if requested
    let medications_t='', allergies_t='', conditions_t='', bp_t='', weight_t='', general_note_t='';
    if (target_lang){
      medications_t = (await translateIfNeeded(facts.medications, target_lang)).out;
      allergies_t   = (await translateIfNeeded(facts.allergies, target_lang)).out;
      conditions_t  = (await translateIfNeeded(facts.conditions, target_lang)).out;
      bp_t          = (await translateIfNeeded(facts.bp||'', target_lang)).out;
      weight_t      = (await translateIfNeeded(facts.weight||'', target_lang)).out;
      general_note_t= (await translateIfNeeded(facts.general_note||'', target_lang)).out;
    }

    // 5) Store
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(shareUrl);

    const insertSql = `
      INSERT INTO reports (
        id, created_at,
        name, email, blood_type,
        emer_name, emer_phone, emer_email,
        doctor_name, doctor_phone, doctor_fax, doctor_email,
        pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
        detected_lang, target_lang,
        transcript, translated_transcript,
        medications, allergies, conditions, bp, weight, general_note,
        medications_t, allergies_t, conditions_t, bp_t, weight_t, general_note_t,
        share_url, qr_data_url
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `;

    await dbRun(insertSql, [
      id, created_at,
      name, email, blood_type,
      emer_name, emer_phone, emer_email,
      doctor_name, doctor_phone, doctor_fax, doctor_email,
      pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
      'auto', target_lang,
      merged, translated_transcript,
      (facts.medications||[]).join('; '),
      (facts.allergies||[]).join('; '),
      (facts.conditions||[]).join('; '),
      facts.bp || '', facts.weight || '', facts.general_note || '',
      medications_t||'', allergies_t||'', conditions_t||'', bp_t||'', weight_t||'', general_note_t||'',
      shareUrl, qr_data_url
    ]);

    res.json({ ok:true, id, url: shareUrl });

  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// -------- Reports list --------
app.get('/reports', async (req,res)=>{
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const items = rows.map(r=>`
    <li class="report-item">
      <div class="title">Report for ${esc(r.name||'Unknown')}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email||'')}</div>
      <div class="actions">
        <a class="btn" href="/reports/${r.id}" target="_blank" rel="noopener">Open</a>
      </div>
    </li>
  `).join('');

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Reports</title>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .container { max-width: 980px; margin: 0 auto; padding: 16px; }
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

// -------- Single report (with email/share block & dual summaries) --------
app.get('/reports/:id', async (req,res)=>{
  const row = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!row) return res.status(404).send('Not found');

  const created = new Date(row.created_at).toLocaleString();

  // Email compose helpers
  const subj = encodeURIComponent(`Hot Health Report for ${row.name||''}`);
  const body = encodeURIComponent(
`Link: ${row.share_url}

Medications: ${row.medications||'None'}
Allergies: ${row.allergies||'None'}
Conditions: ${row.conditions||'None'}
BP: ${row.bp||'—'}   Weight: ${row.weight||'—'}`);

  const mailto = `mailto:${encodeURIComponent(row.email||'')}?subject=${subj}&body=${body}`;
  const gmail  = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(row.email||'')}&su=${subj}&body=${body}`;
  const outlook= `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(row.email||'')}&subject=${subj}&body=${body}`;

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hot Health — Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .wrap { max-width: 980px; margin: 0 auto; padding: 16px; }
  header { border-bottom:3px solid aquamarine; margin-bottom:12px; padding:14px 0; }
  h1 { color:#4b0082; margin:0 0 6px; }
  .section { background:#fff; border:2px solid aquamarine; border-radius:12px; padding:16px; margin:16px 0; }
  .row { display:flex; gap:12px; flex-wrap:wrap; align-items:center; }
  .dual { display:flex; gap:12px; flex-wrap:wrap; }
  .block { flex:1; min-width:280px; background:#f8faff; border:1px solid #dbe7ff; border-radius:8px; padding:12px; }
  .qr { text-align:center; margin:8px 0; }
  .btn { text-decoration:none; border:1px solid #dbe7ff; padding:8px 12px; border-radius:8px; background:#f0f5ff; color:#234; font-size:14px; }
  .tag { display:inline-block; font-size:12px; color:#334; background:#eef4ff; border:1px solid #dbe7ff; padding:2px 6px; border-radius:12px; margin-left:6px; }
  ul.clean { margin:0; padding-left:18px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Hot Health — Report
        ${row.detected_lang ? `<span class="tag">Original: ${esc(row.detected_lang)}</span>`:''}
        ${row.target_lang   ? `<span class="tag">Target: ${esc(row.target_lang)}</span>`:''}
      </h1>
      <div><b>Created:</b> ${esc(created)}</div>
    </header>

    <section class="section">
      <h2>Share & Email</h2>
      <div class="row">
        <a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener" title="Open share link">🔗 Open Link</a>
        <a class="btn" href="${mailto}">✉️ Email (default)</a>
        <a class="btn" href="${gmail}" target="_blank" rel="noopener">Gmail</a>
        <a class="btn" href="${outlook}" target="_blank" rel="noopener">Outlook</a>
      </div>
      <div class="qr">
        <img src="${esc(row.qr_data_url)}" alt="QR" style="max-width:180px;"/>
        <div style="font-size:13px;color:#555">Scan on a phone or use the link.</div>
      </div>
      <div class="row">
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <a class="btn" href="/reports" rel="noopener">All Reports</a>
      </div>
    </section>

    <section class="section">
      <h2>Patient Details</h2>
      <div><b>Name:</b> ${esc(row.name||'')}</div>
      <div><b>Email:</b> ${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : '—'}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type||'—')}</div>
      <div><b>Emergency Contact:</b> ${esc(row.emer_name||'')}
        ${row.emer_phone?` (${esc(row.emer_phone)})`:''}
        ${row.emer_email?` <a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}
      </div>
    </section>

    <section class="section">
      <h2>Doctor & Pharmacy</h2>
      <div><b>Doctor:</b> ${esc(row.doctor_name||'N/A')}, Tel: ${esc(row.doctor_phone||'N/A')}, Fax: ${esc(row.doctor_fax||'N/A')}, ${row.doctor_email?`<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>`:'N/A'}</div>
      <div><b>Pharmacy:</b> ${esc(row.pharmacy_name||'N/A')}, Tel: ${esc(row.pharmacy_phone||'N/A')}, Fax: ${esc(row.pharmacy_fax||'N/A')}, Addr: ${esc(row.pharmacy_address||'N/A')}</div>
    </section>

    <section class="section">
      <h2>Summary (Original)</h2>
      <div><b>Medications:</b> ${esc(row.medications||'None')}</div>
      <div><b>Allergies:</b> ${esc(row.allergies||'None')}</div>
      <div><b>Conditions:</b> ${esc(row.conditions||'None')}</div>
      <div><b>Blood Pressure:</b> ${esc(row.bp||'—')}</div>
      <div><b>Weight:</b> ${esc(row.weight||'—')}</div>
      ${row.general_note ? `<div><b>General Note:</b> ${esc(row.general_note)}</div>`:''}
    </section>

    ${row.target_lang ? `
    <section class="section">
      <h2>Summary (${esc(row.target_lang)})</h2>
      <div><b>Medications:</b><br>${(esc(row.medications_t||'')).replace(/\n/g,'<br>') || '—'}</div>
      <div><b>Allergies:</b><br>${(esc(row.allergies_t||'')).replace(/\n/g,'<br>') || '—'}</div>
      <div><b>Conditions:</b><br>${(esc(row.conditions_t||'')).replace(/\n/g,'<br>') || '—'}</div>
      <div><b>Blood Pressure:</b> ${esc(row.bp_t||'—')}</div>
      <div><b>Weight:</b> ${esc(row.weight_t||'—')}</div>
      ${row.general_note_t ? `<div><b>General Note:</b><br>${(esc(row.general_note_t)).replace(/\n/g,'<br>')}</div>`:''}
    </section>`: ''}

    <section class="section">
      <h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original${row.detected_lang ? ` (${esc(row.detected_lang)})` : ''}</h3>
          <p>${esc(row.transcript||'')}</p>
        </div>
        <div class="block">
          <h3>${row.target_lang ? esc(row.target_lang) : 'Translated'}</h3>
          <p>${esc(row.translated_transcript||'(no translation)')}</p>
        </div>
      </div>
    </section>

    <footer style="text-align:center;color:#666;margin-top:20px;">Hot Health © 2025</footer>
  </div>
</body></html>`);
});

// -------- Start --------
await initDB();
app.listen(PORT, ()=> console.log(`✅ Backend listening on ${PORT}`));
