// One-file backend (login gate, uploads, transcription+translation, summary dual blocks, QR, reports)

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// -------------------------
// DB: prefer better-sqlite3; fallback to sqlite3+sqlite
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
    doctor_name   TEXT,
    doctor_phone  TEXT,
    doctor_email  TEXT,
    doctor_fax    TEXT,
    pharmacy_name TEXT,
    pharmacy_phone TEXT,
    pharmacy_fax  TEXT,
    pharmacy_address TEXT,
    detected_lang TEXT,
    target_lang   TEXT,
    transcript    TEXT,
    translated_transcript TEXT,
    summary_original TEXT,
    summary_translated TEXT,
    medications   TEXT,
    allergies     TEXT,
    conditions    TEXT,
    bp            TEXT,
    weight        TEXT,
    share_url     TEXT,
    qr_data_url   TEXT
  );`;

  if (useBetter) db.exec(createSql); else await db.exec(createSql);

  // Add any missing columns safely (older DBs)
  const wantCols = [
    ['doctor_name','TEXT'],['doctor_phone','TEXT'],['doctor_email','TEXT'],['doctor_fax','TEXT'],
    ['pharmacy_name','TEXT'],['pharmacy_phone','TEXT'],['pharmacy_fax','TEXT'],['pharmacy_address','TEXT'],
    ['summary_original','TEXT'],['summary_translated','TEXT']
  ];
  const existing = await getColumns('reports');
  for (const [name,def] of wantCols) {
    if (!existing.includes(name)) {
      const sql = `ALTER TABLE reports ADD COLUMN ${name} ${def}`;
      if (useBetter) { try { db.exec(sql); } catch {} } else { try { await db.exec(sql); } catch {} }
    }
  }
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
async function getColumns(table) {
  if (useBetter) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.map(r => r.name);
  } else {
    const rows = await db.all(`PRAGMA table_info(${table})`);
    return rows.map(r => r.name);
  }
}

// -------------------------
// Auth
// -------------------------
function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly:true, signed:true, sameSite:'lax' });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req,res,next){
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

app.get('/login', (req,res) => {
  const p = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
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
app.post('/login', (req,res) => {
  const { userId, password } = req.body || {};
  if (userId === USER_ID && password === USER_PASS) { setSession(res, userId); return res.redirect('/'); }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout', (req,res) => { clearSession(res); res.redirect('/login'); });

// Protect app & reports
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// Home (frontend)
app.get('/', (req,res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

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
function uid(n=22){ return crypto.randomBytes(n).toString('base64url').slice(0,n); }

// Basic facts parser (tune as needed)
function parseFacts(text) {
  const meds=[], allergies=[], conditions=[];
  const medRx=/([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d+)\s*(mg|mcg|g|ml)/gi;
  let m; const seen=new Set();
  while((m=medRx.exec(text))){ const name=m[1], dose = m[2]+' '+m[3]; const k=(name+'|'+dose).toLowerCase(); if(!seen.has(k)){ meds.push(`${name} — ${dose}`); seen.add(k);} }
  const aRx=/\b(allergy|allergies|allergic to)\b([^\.]+)/gi; let a;
  while((a=aRx.exec(text))){ a[2].split(/[,;]|and/).map(s=>s.trim()).filter(Boolean).forEach(x=>{ const c=x.replace(/^(to|of)\s+/i,'').trim(); if(c && !allergies.includes(c)) allergies.push(c);}); }
  const cRx=/\b(I have|I’ve|I've|diagnosed with|history of)\b([^\.]+)/gi; let c;
  while((c=cRx.exec(text))){ const s=c[2].replace(/\b(allergy|allergies|medications?|pills?)\b/ig,'').trim(); if(s) conditions.push(s); }
  const bpM = text.match(/\b(\d{2,3})\s*[/over\\-]\s*(\d{2,3})\b/i);
  const wM  = text.match(/\b(\d{2,3})\s*(?:lbs?|pounds?|kg)\b/i);
  return {
    medications: meds,
    allergies,
    conditions,
    bp: bpM ? `${bpM[1]}/${bpM[2]}` : '',
    weight: wM ? (wM[1] + (wM[0].toLowerCase().includes('kg') ? ' kg' : ' lbs')) : ''
  };
}

// -------------------------
// Multer (store webm)
// -------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, __, cb) => cb(null, `${Date.now()}-${uid(8)}.webm`)
});
const upload = multer({ storage });

// -------------------------
// Upload → Transcribe → Summarize → (optional) Translate → Save
// -------------------------
app.post('/upload', upload.single('audio'), async (req,res) => {
  try {
    if (!req.file) return res.status(400).json({ ok:false, error:'No file' });

    const {
      name='', email='', blood_type='',
      emer_name='', emer_phone='', emer_email='',
      doctor_name='', doctor_phone='', doctor_email='', doctor_fax='',
      pharmacy_name='', pharmacy_phone='', pharmacy_fax='', pharmacy_address='',
      lang=''
    } = req.body || {};

    // 1) transcribe
    const stream = fs.createReadStream(req.file.path);
    let transcript='';
    try {
      const tr = await openai.audio.transcriptions.create({ file:stream, model:'gpt-4o-mini-transcribe' });
      transcript = tr.text?.trim() || '';
    } catch {
      const stream2 = fs.createReadStream(req.file.path);
      const tr2 = await openai.audio.transcriptions.create({ file:stream2, model:'whisper-1' });
      transcript = tr2.text?.trim() || '';
    }

    // 2) summarize (original language)
    let summary_original = '';
    try {
      const prompt = `Summarize this clinical self-report into a concise, clear paragraph (one or two sentences). Avoid inventing facts. Text:\n\n${transcript}`;
      const rsp = await openai.chat.completions.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
        messages: [{ role:'user', content: prompt }],
        temperature: 0.2
      });
      summary_original = rsp.choices?.[0]?.message?.content?.trim() || '';
    } catch { summary_original = ''; }

    // 3) optional translate both transcript & summary
    const target_lang = (lang||'').trim();
    const detected_lang = 'auto';
    let translated_transcript = '';
    let summary_translated = '';
    if (target_lang) {
      const tPrompt = `Translate the following medical note to ${target_lang}. Return only the translated text.\n\n${transcript}`;
      const sPrompt = `Translate the following summary to ${target_lang}. Return only the translated text.\n\n${summary_original}`;

      try {
        const [trA, trB] = await Promise.all([
          openai.chat.completions.create({
            model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
            messages: [{ role:'user', content: tPrompt }],
            temperature: 0.2
          }),
          openai.chat.completions.create({
            model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
            messages: [{ role:'user', content: sPrompt }],
            temperature: 0.2
          })
        ]);
        translated_transcript = trA.choices?.[0]?.message?.content?.trim() || '';
        summary_translated    = trB.choices?.[0]?.message?.content?.trim() || '';
      } catch {
        translated_transcript = '';
        summary_translated    = '';
      }
    }

    // 4) parse facts
    const facts = parseFacts(transcript);

    // 5) assemble row
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const share_url = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(share_url);

    const row = {
      id, created_at,
      name, email, blood_type,
      emer_name, emer_phone, emer_email,
      doctor_name, doctor_phone, doctor_email, doctor_fax,
      pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
      detected_lang, target_lang,
      transcript, translated_transcript,
      summary_original, summary_translated,
      medications: (facts.medications||[]).join('; '),
      allergies:   (facts.allergies||[]).join('; '),
      conditions:  (facts.conditions||[]).join('; '),
      bp: facts.bp || '', weight: facts.weight || '',
      share_url, qr_data_url
    };

    // 6) dynamic insert = never mismatched
    const cols = await getColumns('reports');
    const insertCols = Object.keys(row).filter(k => cols.includes(k));
    const placeholders = insertCols.map(()=>'?').join(',');
    const values = insertCols.map(k => row[k]);
    const sql = `INSERT INTO reports (${insertCols.join(',')}) VALUES (${placeholders})`;
    await dbRun(sql, values);

    res.json({ ok:true, id, url: share_url });
  } catch (e) {
    console.error('UPLOAD ERROR:', e);
    res.status(500).json({ ok:false, error: e.message || 'Server error' });
  }
});

// -------------------------
// Reports list
// -------------------------
app.get('/reports', async (req,res) => {
  const rows = await dbAll(`SELECT id, created_at, name, email, target_lang FROM reports ORDER BY created_at DESC`);
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
// Single report with dual Summary + dual Transcript
// -------------------------
app.get('/reports/:id', async (req,res) => {
  const r = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).send('Not found');

  const esc = (s='') => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const created = new Date(r.created_at).toLocaleString();
  const mailSubject = encodeURIComponent('Hot Health Report');
  const mailBody    = encodeURIComponent(`Link: ${r.share_url}\n\nSummary:\nMedications: ${r.medications}\nAllergies: ${r.allergies}\nConditions: ${r.conditions}`);

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hot Health Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .wrap { max-width: 900px; margin: 0 auto; padding: 16px; }
  header { border-bottom:3px solid aquamarine; margin-bottom:12px; padding:12px 0; }
  h1 { color:#4b0082; margin:0 0 6px; }
  .section { background:#fff; border:2px solid aquamarine; border-radius:12px; padding:16px; margin:16px 0; }
  .dual { display:flex; gap:12px; flex-wrap:wrap; }
  .block { flex:1; min-width:260px; background:#f8faff; border:1px solid #dbe7ff; border-radius:8px; padding:12px; }
  .btnbar{ display:flex; gap:8px; flex-wrap:wrap; }
  .btn{ text-decoration:none; border:1px solid #dbe7ff; padding:8px 10px; border-radius:8px; background:#f0f5ff; color:#234; font-size:14px; }
  .hint{ font-size:13px; color:#666; }
  .qr { text-align:center; margin:8px 0; }
  .list { margin:6px 0; padding-left:18px; }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Hot Health — Report
        ${r.detected_lang ? `<span style="font-size:12px; border:1px solid #dbe7ff; border-radius:12px; padding:2px 6px; margin-left:6px;">Original: ${esc(r.detected_lang)}</span>`:''}
        ${r.target_lang ? `<span style="font-size:12px; border:1px solid #dbe7ff; border-radius:12px; padding:2px 6px; margin-left:6px;">Target: ${esc(r.target_lang)}</span>`:''}
      </h1>
      <div><b>Created:</b> ${esc(created)}</div>
    </header>

    <section class="section">
      <div class="btnbar">
        <a class="btn" href="${esc(r.share_url)}" target="_blank" rel="noopener">🔗 Open Share Link</a>
        <a class="btn" href="mailto:?subject=${mailSubject}&body=${mailBody}">✉️ Email</a>
        <button class="btn" onclick="navigator.clipboard.writeText('${esc(r.share_url)}')">📋 Copy Link</button>
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <a class="btn" href="/reports" rel="noopener">All Reports</a>
      </div>
      <div class="qr">
        <img src="${esc(r.qr_data_url)}" alt="QR Code" style="max-width:180px;"/>
        <div class="hint">Scan on a phone or use the link.</div>
      </div>
    </section>

    <section class="section"><h2>Patient Details</h2>
      <div><b>Name:</b> ${esc(r.name||'')}</div>
      <div><b>Email:</b> ${r.email?`<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`:''}</div>
      <div><b>Blood Type:</b> ${esc(r.blood_type||'')}</div>
      <div><b>Emergency Contact:</b> ${esc(r.emer_name||'')} ${r.emer_phone?`(${esc(r.emer_phone)})`:''} ${r.emer_email?`<a href="mailto:${esc(r.emer_email)}">${esc(r.emer_email)}</a>`:''}</div>
      ${r.doctor_name || r.pharmacy_name ? `
      <div style="margin-top:8px;">
        ${r.doctor_name ? `<div><b>Doctor:</b> ${esc(r.doctor_name)} ${r.doctor_phone?`(${esc(r.doctor_phone)})`:''} ${r.doctor_email?`<a href="mailto:${esc(r.doctor_email)}">${esc(r.doctor_email)}</a>`:''} ${r.doctor_fax?`Fax: ${esc(r.doctor_fax)}`:''}</div>`:''}
        ${r.pharmacy_name ? `<div><b>Pharmacy:</b> ${esc(r.pharmacy_name)} ${r.pharmacy_phone?`(${esc(r.pharmacy_phone)})`:''} ${r.pharmacy_fax?`Fax: ${esc(r.pharmacy_fax)}`:''} ${r.pharmacy_address?`— ${esc(r.pharmacy_address)}`:''}</div>`:''}
      </div>`:''}
    </section>

    <section class="section"><h2>Summary</h2>
      <div class="dual">
        <div class="block">
          <h3>Original${r.detected_lang?` (${esc(r.detected_lang)})`:''}</h3>
          <p>${esc(r.summary_original || '(none)')}</p>
        </div>
        <div class="block">
          <h3>${r.target_lang?`Summary (${esc(r.target_lang)})`:'Summary (translated)'}</h3>
          <p>${esc(r.summary_translated || '(no translation)')}</p>
        </div>
      </div>
    </section>

    <section class="section"><h2>Parsed Facts</h2>
      <div><b>Medications:</b> ${esc(r.medications || 'None')}</div>
      <div><b>Allergies:</b> ${esc(r.allergies || 'None')}</div>
      <div><b>Conditions:</b> ${esc(r.conditions || 'None')}</div>
      <div><b>Blood Pressure:</b> ${esc(r.bp || '—')}</div>
      <div><b>Weight:</b> ${esc(r.weight || '—')}</div>
    </section>

    <section class="section"><h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original${r.detected_lang?` (${esc(r.detected_lang)})`:''}</h3>
          <p>${esc(r.transcript || '')}</p>
        </div>
        <div class="block">
          <h3>${r.target_lang?`Translated (${esc(r.target_lang)})`:'Translated'}</h3>
          <p>${esc(r.translated_transcript || '(no translation)')}</p>
        </div>
      </div>
    </section>
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
