// Hot Health — consolidated backend (auth, uploads, multi-part recorders, parsing, translation, QR, reports)
// SQLite3-only to avoid prior module loops

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
const app  = express();
const PORT = Number(process.env.PORT || 10000);

const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || 'hot-health-session';

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// SQLite3 (only)
// -------------------------
sqlite3.verbose();
const dbPath = path.join(__dirname, 'data.sqlite');
const db = new sqlite3.Database(dbPath);

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

async function initDB() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created_at TEXT,

      -- Patient
      name TEXT, email TEXT, blood_type TEXT,
      emer_name TEXT, emer_phone TEXT, emer_email TEXT,

      -- Doctor
      doctor_name TEXT, doctor_address TEXT, doctor_phone TEXT, doctor_fax TEXT, doctor_email TEXT,

      -- Pharmacy
      pharmacy_name TEXT, pharmacy_address TEXT, pharmacy_phone TEXT, pharmacy_fax TEXT,

      -- Lang
      detected_lang TEXT, target_lang TEXT,

      -- Text
      transcript TEXT, translated_transcript TEXT,

      -- Summary pieces
      medications TEXT, allergies TEXT, conditions TEXT, bp TEXT, weight TEXT,
      summary_text TEXT, translated_summary TEXT,

      -- Share/QR
      share_url TEXT, qr_data_url TEXT
    )
  `);

  // Add missing columns if an old DB exists
  const maybeAdd = async (name, def) => {
    try { await dbRun(`ALTER TABLE reports ADD COLUMN ${name} ${def}`); } catch { /* already exists */ }
  };
  await maybeAdd('doctor_name','TEXT'); await maybeAdd('doctor_address','TEXT');
  await maybeAdd('doctor_phone','TEXT'); await maybeAdd('doctor_fax','TEXT'); await maybeAdd('doctor_email','TEXT');
  await maybeAdd('pharmacy_name','TEXT'); await maybeAdd('pharmacy_address','TEXT');
  await maybeAdd('pharmacy_phone','TEXT'); await maybeAdd('pharmacy_fax','TEXT');
  await maybeAdd('summary_text','TEXT'); await maybeAdd('translated_summary','TEXT');
}

const LANG_NAMES = {
  en: 'English', fr: 'Français', es: 'Español', pt: 'Português', de: 'Deutsch', it: 'Italiano',
  ar: 'العربية', hi: 'हिन्दी', zh: '中文', ja: '日本語', ko: '한국어', he: 'עברית', sr: 'Srpski', pa: 'ਪੰਜਾਬੀ'
};
const langName = c => LANG_NAMES[c] || c || '—';
const uid = (n=20) => crypto.randomBytes(n).toString('base64url').slice(0, n);

function getBaseUrl(req) {
  const envUrl = (process.env.PUBLIC_BASE_URL || '').trim();
  if (envUrl) return envUrl.replace(/\/+$/,'');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// -------------------------
// Parsing helpers
// -------------------------
function parseFacts(text='') {
  const t = text.replace(/\s+/g,' ').trim();
  const meds = [];
  const allergies = [];
  const conditions = [];

  // meds
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)\s*(?:at|:|—|-)?\s*(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  let m; const seen = new Set();
  while ((m = medRx.exec(t)) !== null) {
    const name = m[1]; const dose = `${m[2]} ${m[3]}`;
    const key = `${name.toLowerCase()}|${dose.toLowerCase()}`;
    if (!seen.has(key)) { meds.push(`${name} — ${dose}`); seen.add(key); }
  }

  // allergies
  const aHit = t.match(/\ballerg(?:y|ies)\b[^.?!]+/i);
  if (aHit) {
    const list = aHit[0]
      .replace(/\ballerg(?:y|ies)\b/i,'')
      .replace(/\bto\b/ig,'')
      .split(/[,;]| and /i)
      .map(s=>s.trim()).filter(Boolean);
    for (const x of list) if (!allergies.includes(x)) allergies.push(x);
  }

  // conditions
  const cRx = /\b(I have|I've|I’ve|diagnosed with|history of)\b([^.!?]+)/ig;
  let c;
  while ((c = cRx.exec(t)) !== null) {
    let phrase = c[2].replace(/\b(allerg(?:y|ies)|medications?|pills?)\b/ig,'').trim();
    phrase = phrase.replace(/^[,:;.\s-]+/, '');
    if (phrase) conditions.push(phrase);
  }

  // BP
  let bp = null;
  const bpM = t.match(/\b(\d{2,3})\s*(?:\/|over|-)\s*(\d{2,3})\b/);
  if (bpM) bp = `${bpM[1]}/${bpM[2]}`;

  // Weight
  let weight = null;
  const wM = t.match(/\b(\d{2,3})\s*(lbs?|pounds?|kg)\b/i);
  if (wM) weight = wM[1] + (wM[2].toLowerCase().includes('kg') ? ' kg' : ' lbs');

  return { medications: meds, allergies, conditions, bp, weight };
}
function summarizeFacts(f) {
  const L = [];
  L.push(`Medications: ${f.medications?.length ? f.medications.join('; ') : 'None mentioned'}`);
  L.push(`Allergies: ${f.allergies?.length ? f.allergies.join('; ') : 'None mentioned'}`);
  L.push(`Conditions: ${f.conditions?.length ? f.conditions.join('; ') : 'None mentioned'}`);
  L.push(`Blood Pressure: ${f.bp || '—'}`);
  L.push(`Weight: ${f.weight || '—'}`);
  return L.join('\n');
}

// -------------------------
// Middleware
// -------------------------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

// Auth helpers
function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly: true, sameSite: 'lax', signed: true /*, secure: true*/ });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

// -------------------------
// Auth routes
// -------------------------
app.get('/login', (req,res) => {
  const p = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send(`<!doctype html><html><body>
    <h3>Sign in</h3>
    <form method="POST" action="/login">
      <input name="userId" placeholder="User ID"><br/>
      <input name="password" type="password" placeholder="Password"><br/>
      <button>Sign in</button>
    </form>
  </body></html>`);
});
app.post('/login', bodyParser.urlencoded({extended:true}), (req,res) => {
  const { userId, password } = req.body || {};
  if (userId === USER_ID && password === USER_PASS) { setSession(res, userId); return res.redirect('/'); }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout', (req,res)=>{ clearSession(res); res.redirect('/login'); });

// Gate the app & reports
app.use(['/', '/detect-language', '/upload-multi', '/reports', '/reports/*'], requireAuth);

// -------------------------
// Home
// -------------------------
app.get('/', (req,res)=> res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// -------------------------
// Language detection endpoint (server-side, safe)
// -------------------------
app.post('/detect-language', async (req,res) => {
  try {
    const text = (req.body?.text || '').toString().trim();
    if (!text) return res.json({ ok:true, code:'', name:'' });

    const prompt = `Detect the predominant human language of this text and answer ONLY the ISO 639-1 code (e.g., en, es, fr, pt, de, it, ar, hi, zh, ja, ko, he, sr, pa). Text:\n\n${text}`;
    const rsp = await openai.chat.completions.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role:'user', content: prompt }]
    });
    const code = (rsp.choices?.[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z]/g,'').slice(0,2);
    return res.json({ ok:true, code, name: langName(code) });
  } catch (e) {
    console.error('detect-language error', e);
    res.json({ ok:true, code:'', name:'' });
  }
});

// -------------------------
// Multer storage — six mini recorders
// -------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webm`)
});
const upload = multer({ storage });

const multiFields = upload.fields([
  { name:'audio_bp', maxCount:1 },
  { name:'audio_meds', maxCount:1 },
  { name:'audio_allergies', maxCount:1 },
  { name:'audio_weight', maxCount:1 },
  { name:'audio_conditions', maxCount:1 },
  { name:'audio_general', maxCount:1 }
]);

async function transcribeFile(fpath) {
  const s = fs.createReadStream(fpath);
  try {
    const tr = await openai.audio.transcriptions.create({ file: s, model: 'gpt-4o-mini-transcribe' });
    return (tr.text || '').trim();
  } catch {
    const s2 = fs.createReadStream(fpath);
    const tr2 = await openai.audio.transcriptions.create({ file: s2, model: 'whisper-1' });
    return (tr2.text || '').trim();
  }
}

// -------------------------
// Upload — multi-part only (classic removed)
// -------------------------
app.post('/upload-multi', multiFields, async (req,res) => {
  try {
    const B = req.body || {};

    const patient = {
      name: (B.name||'').trim(),
      email: (B.email||'').trim(),
      blood_type: (B.blood_type||'').trim(),

      emer_name: (B.emer_name||'').trim(),
      emer_phone: (B.emer_phone||'').trim(),
      emer_email: (B.emer_email||'').trim(),

      doctor_name: (B.doctor_name||'').trim(),
      doctor_address: (B.doctor_address||'').trim(),
      doctor_phone: (B.doctor_phone||'').trim(),
      doctor_fax: (B.doctor_fax||'').trim(),
      doctor_email: (B.doctor_email||'').trim(),

      pharmacy_name: (B.pharmacy_name||'').trim(),
      pharmacy_address: (B.pharmacy_address||'').trim(),
      pharmacy_phone: (B.pharmacy_phone||'').trim(),
      pharmacy_fax: (B.pharmacy_fax||'').trim(),

      target_lang: (B.lang||'').trim()
    };

    const fields = [
      { key:'bp',         label:'Blood Pressure',   file:'audio_bp' },
      { key:'meds',       label:'Medications & Dose', file:'audio_meds' },
      { key:'allergies',  label:'Allergies',        file:'audio_allergies' },
      { key:'weight',     label:'Weight',           file:'audio_weight' },
      { key:'conditions', label:'Conditions',       file:'audio_conditions' },
      { key:'general',    label:'General Health Note', file:'audio_general' }
    ];

    const lines = [];
    for (const f of fields) {
      const typed = (B[`typed_${f.key}`] || '').trim();
      let heard = '';
      const af = req.files?.[f.file]?.[0];
      if (af && af.path) heard = await transcribeFile(af.path);

      const combined = [typed, heard].filter(Boolean).join(' ');
      if (combined) lines.push(`${f.label}: ${combined}`);
    }

    if (!lines.length) return res.status(400).json({ ok:false, error:'No content' });

    const transcript = lines.join('\n');

    // Detect language (server-side) from transcript
    let detected_lang = 'en';
    try {
      const prompt = `Detect the predominant human language of this text and answer ONLY the ISO 639-1 code.\n\n${transcript}`;
      const rsp = await openai.chat.completions.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
        temperature: 0,
        messages: [{ role:'user', content: prompt }]
      });
      const code = (rsp.choices?.[0]?.message?.content || '').trim().toLowerCase().replace(/[^a-z]/g,'').slice(0,2);
      if (code) detected_lang = code;
    } catch {}

    const facts = parseFacts(transcript);
    const summary_text = summarizeFacts(facts);

    // Translate transcript AND summary if target selected
    let translated_transcript = '';
    let translated_summary = '';
    if (patient.target_lang) {
      const [t1, t2] = await Promise.all([
        openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages: [{ role:'user', content: `Translate this to ${patient.target_lang}:\n\n${transcript}` }]
        }),
        openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages: [{ role:'user', content: `Translate this to ${patient.target_lang}:\n\n${summary_text}` }]
        })
      ]);
      translated_transcript = t1.choices?.[0]?.message?.content?.trim() || '';
      translated_summary    = t2.choices?.[0]?.message?.content?.trim() || '';
    }

    const id = uid();
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const share_url = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(share_url);

    await dbRun(`
      INSERT INTO reports (
        id, created_at,
        name, email, blood_type,
        emer_name, emer_phone, emer_email,
        doctor_name, doctor_address, doctor_phone, doctor_fax, doctor_email,
        pharmacy_name, pharmacy_address, pharmacy_phone, pharmacy_fax,
        detected_lang, target_lang,
        transcript, translated_transcript,
        medications, allergies, conditions, bp, weight,
        summary_text, translated_summary,
        share_url, qr_data_url
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      id, created_at,
      patient.name, patient.email, patient.blood_type,
      patient.emer_name, patient.emer_phone, patient.emer_email,
      patient.doctor_name, patient.doctor_address, patient.doctor_phone, patient.doctor_fax, patient.doctor_email,
      patient.pharmacy_name, patient.pharmacy_address, patient.pharmacy_phone, patient.pharmacy_fax,
      detected_lang, patient.target_lang,
      transcript, translated_transcript,
      (facts.medications||[]).join('; '),
      (facts.allergies||[]).join('; '),
      (facts.conditions||[]).join('; '),
      facts.bp || '', facts.weight || '',
      summary_text, translated_summary,
      share_url, qr_data_url
    ]);

    res.json({ ok:true, id, url: share_url, detected_lang });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// -------------------------
// Reports list
// -------------------------
app.get('/reports', async (req,res) => {
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const items = rows.map(r=>`
    <li class="report-item">
      <div class="title">Report for ${esc(r.name)||'Unknown'}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email||'')}</div>
      <div class="actions">
        <a class="btn" href="/reports/${esc(r.id)}" target="_blank" rel="noopener">Open</a>
      </div>
    </li>`).join('') || '<li class="report-item">No reports yet.</li>';

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Reports</title><link rel="stylesheet" href="/styles.css"/></head>
<body>
  <div class="container">
    <header class="head">
      <h1>Hot Health — Reports</h1>
      <nav>
        <a class="btn" href="/" rel="noopener">New Report</a>
        <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
      </nav>
    </header>
    <ul class="list">${items}</ul>
  </div>
</body></html>`);
});

// -------------------------
// Single report page (dual summaries + dual transcripts + actions)
// -------------------------
app.get('/reports/:id', async (req,res) => {
  const row = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!row) return res.status(404).send('Not found');

  const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const created = new Date(row.created_at).toLocaleString();
  const detName = langName(row.detected_lang);
  const tgtName = langName(row.target_lang);

  const mailSubject = encodeURIComponent(`Hot Health Report — ${row.name || ''}`);
  const bodyLines = [
    `Shareable link: ${row.share_url}`,
    ``,
    `Patient: ${row.name || ''} • ${row.email || ''} • Blood: ${row.blood_type || ''}`,
    `Emergency: ${row.emer_name || ''} (${row.emer_phone || ''}) ${row.emer_email || ''}`,
    `Doctor: ${row.doctor_name || ''} • ${row.doctor_phone || ''} • ${row.doctor_fax || ''} • ${row.doctor_email || ''}`,
    `Pharmacy: ${row.pharmacy_name || ''} • ${row.pharmacy_phone || ''} • ${row.pharmacy_fax || ''}`,
    ``,
    `Summary:\n${row.summary_text || ''}`
  ].join('\n');
  const gmail   = `https://mail.google.com/mail/?view=cm&fs=1&su=${mailSubject}&body=${encodeURIComponent(bodyLines)}`;
  const outlook = `https://outlook.office.com/mail/deeplink/compose?subject=${mailSubject}&body=${encodeURIComponent(bodyLines)}`;

  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Hot Health — Report</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body>
<div class="container">
  <header class="head">
    <h1>Hot Health — Report</h1>
    <div class="meta"><b>Created:</b> ${esc(created)}</div>
    <div class="pillrow">
      ${row.detected_lang ? `<span class="pill">Original: ${esc(detName)}</span>`:''}
      ${row.target_lang   ? `<span class="pill">Target: ${esc(tgtName)}</span>`:''}
    </div>
  </header>

  <section class="card">
    <h2>Patient Details</h2>
    <div class="grid2">
      <div><b>Name:</b> ${esc(row.name)}</div>
      <div><b>Email:</b> ${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : ''}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type || '')}</div>
      <div><b>Emergency Contact:</b> ${esc(row.emer_name||'')} ${row.emer_phone?`(${esc(row.emer_phone)})`:''} ${row.emer_email?`<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}</div>
      <div><b>Doctor:</b> ${esc(row.doctor_name||'')} • ${esc(row.doctor_phone||'')} • ${esc(row.doctor_fax||'')} • ${row.doctor_email?`<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>`:''}</div>
      <div><b>Pharmacy:</b> ${esc(row.pharmacy_name||'')} • ${esc(row.pharmacy_phone||'')} • ${esc(row.pharmacy_fax||'')}</div>
    </div>
  </section>

  <section class="card">
    <h2>Summary</h2>
    <div class="dual">
      <div class="block">
        <h3>${esc(detName||'Original')}</h3>
        <pre class="pre">${esc(row.summary_text || '')}</pre>
      </div>
      <div class="block">
        <h3>${esc(tgtName||'Target')}</h3>
        <pre class="pre">${esc(row.translated_summary || '(no translation)')}</pre>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Transcript</h2>
    <div class="dual">
      <div class="block">
        <h3>${esc(detName||'Original')}</h3>
        <pre class="pre">${esc(row.transcript || '')}</pre>
      </div>
      <div class="block">
        <h3>${esc(tgtName||'Target')}</h3>
        <pre class="pre">${esc(row.translated_transcript || '(no translation)')}</pre>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Share / Print</h2>
    <div class="sharebar">
      <a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener" title="Open share link">🔗 Link</a>
      <a class="btn" href="${gmail}" target="_blank" rel="noopener">📧 Gmail</a>
      <a class="btn" href="${outlook}" target="_blank" rel="noopener">📨 Outlook</a>
      <button class="btn" onclick="window.print()">🖨️ Print</button>
    </div>
    <div class="qr">
      <img src="${esc(row.qr_data_url)}" alt="QR Code" />
      <div class="muted">Scan on a phone or use the link button.</div>
    </div>
  </section>

  <div class="bar">
    <a class="btn" href="/" rel="noopener">+ New Report</a>
    <a class="btn" href="/reports" rel="noopener">Open Reports</a>
    <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
  </div>
</div>
</body>
</html>`);
});

// -------------------------
// Start
// -------------------------
await initDB();
app.listen(PORT, () => console.log(`✅ Backend listening on ${PORT}`));
