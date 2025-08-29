// backend/index.js
// Stable backend: auth, uploads (6 mini recorders + typed fields), parsing, dual summaries,
// transcript translation, QR, email/print/link actions, reports list.
// DB is locked to better-sqlite3 ONLY to stop sqlite errors on Render.

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
import BetterSqlite3 from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- Config ----------
const app  = express();
const PORT = Number(process.env.PORT || 10000);

const USER_ID    = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS  = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- DB (better-sqlite3 only) ----------
const dbFile = path.join(__dirname, 'data.sqlite');
const db = new BetterSqlite3(dbFile);
db.pragma('journal_mode = WAL');

// One canonical schema — keep column order and count in sync with inserts/updates
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id                      TEXT PRIMARY KEY,
  created_at              TEXT,
  name                    TEXT,
  email                   TEXT,
  phone                   TEXT,
  blood_type              TEXT,
  emer_name               TEXT,
  emer_phone              TEXT,
  emer_email              TEXT,
  doctor_name             TEXT,
  doctor_phone            TEXT,
  doctor_email            TEXT,
  doctor_fax              TEXT,
  pharmacy_name           TEXT,
  pharmacy_phone          TEXT,
  pharmacy_fax            TEXT,
  pharmacy_address        TEXT,
  detected_lang           TEXT,
  target_lang             TEXT,
  transcript              TEXT,
  translated_transcript   TEXT,
  summary_original        TEXT,
  summary_translated      TEXT,
  medications             TEXT,
  allergies               TEXT,
  conditions              TEXT,
  bp                      TEXT,
  weight                  TEXT,
  general_note            TEXT,
  share_url               TEXT,
  qr_data_url             TEXT
);
`);

// ---------- Middleware ----------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json({ limit: '5mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.static(PUBLIC_DIR));

// ---------- Helpers ----------
function uid(n = 22) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

function getBaseUrl(req) {
  // Prefer explicit override (Render will set x-forwarded-* under HTTPS)
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Very simple medical parser — tuned to be conservative
function parseFacts(text) {
  const meds = [];
  const allergies = [];
  const conditions = [];

  // Try to find meds like "X 10 mg", "X 20mcg", "X — 5 mg"
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  let m; const seen = new Set();
  while ((m = medRx.exec(text)) !== null) {
    const name = m[1];
    const dose = `${m[2]} ${m[3]}`.trim();
    const key  = `${name.toLowerCase()}|${dose.toLowerCase()}`;
    if (!seen.has(key)) { meds.push(`${name} — ${dose}`); seen.add(key); }
  }

  // Allergies: look for “allergic to …” fragments
  const aRx = /\ballergic to\b([^\.]+)/gi;
  let a;
  while ((a = aRx.exec(text)) !== null) {
    const list = a[1].split(/,|;|and/).map(s => s.trim()).filter(Boolean);
    for (const item of list) {
      const clean = item.replace(/^(to|of)\s+/i,'').trim();
      if (clean && !allergies.includes(clean)) allergies.push(clean);
    }
  }

  // Conditions: “I have … / diagnosed with … / history of …”
  const cRx = /\b(I have|I've|I’ve|diagnosed with|history of)\b([^\.]+)/gi;
  let c;
  while ((c = cRx.exec(text)) !== null) {
    const s = c[2].replace(/\b(allergy|allergies|medications?|pills?)\b/ig,'').trim();
    if (s) conditions.push(s);
  }

  // Blood pressure: “120/75”, “120 over 75”
  let bp = null;
  const bpRx = /\b(\d{2,3})\s*(?:\/|over|-)\s*(\d{2,3})\b/i;
  const bpm = text.match(bpRx);
  if (bpm) bp = `${bpm[1]}/${bpm[2]}`;

  // Weight: “215 pounds”, “90 kg”
  let weight = null;
  const wRx = /\b(\d{2,3})\s*(?:lbs?|pounds?|kg)\b/i;
  const wm = text.match(wRx);
  if (wm) weight = wm[1] + (wm[0].toLowerCase().includes('kg') ? ' kg' : ' lbs');

  return { medications: meds, allergies, conditions, bp, weight };
}

async function transcribeFile(filePath, originalName) {
  // Primary: gpt-4o-mini-transcribe → Fallback: whisper-1
  try {
    const stream = fs.createReadStream(filePath);
    const r = await openai.audio.transcriptions.create({
      file: stream,
      model: 'gpt-4o-mini-transcribe'
    });
    return (r.text || '').trim();
  } catch {
    try {
      const stream2 = fs.createReadStream(filePath);
      const r2 = await openai.audio.transcriptions.create({
        file: stream2,
        model: 'whisper-1'
      });
      return (r2.text || '').trim();
    } catch {
      return '';
    }
  }
}

async function translateText(text, targetLang) {
  if (!text || !targetLang) return '';
  const rsp = await openai.chat.completions.create({
    model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a precise medical translator. Return only the translated text.' },
      { role: 'user', content: `Translate to ${targetLang}:\n\n${text}` }
    ],
    temperature: 0.2
  });
  return rsp.choices?.[0]?.message?.content?.trim() || '';
}

function summarizeFactsOriginal(f) {
  const lines = [];
  lines.push(`Medications: ${f.medications?.length ? f.medications.join(', ') : 'None mentioned'}`);
  lines.push(`Allergies: ${f.allergies?.length ? f.allergies.join(', ') : 'None mentioned'}`);
  lines.push(`Conditions: ${f.conditions?.length ? f.conditions.join(', ') : 'None mentioned'}`);
  lines.push(`Blood Pressure: ${f.bp || '—'}`);
  lines.push(`Weight: ${f.weight || '—'}`);
  return lines.join('\n');
}

// ---------- Auth ----------
function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly: true, signed: true, sameSite: 'lax' /*, secure: true*/ });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

app.get('/login', (req, res) => {
  const file = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(file)) return res.sendFile(file);
  res.send(`<!doctype html><html><body>
    <h3>Sign in</h3>
    <form method="POST" action="/login">
      <input name="userId" placeholder="User ID" />
      <input name="password" type="password" placeholder="Password" />
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

// Protect app & reports
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// ---------- Static Home ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- Upload (supports up to 6 mini recorders + typed notes) ----------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${uid(6)}.webm`)
});
const upload = multer({ storage });

app.post('/upload', upload.any(), async (req, res) => {
  try {
    // Collect audio parts (any field, keep audio/webm)
    const audioFiles = (req.files || []).filter(f => (f.mimetype || '').startsWith('audio/'));
    if (!audioFiles.length) return res.status(400).json({ ok: false, error: 'No audio files found' });

    // Patient & contact profile
    const {
      name = '', email = '', phone = '', blood_type = '',
      emer_name = '', emer_phone = '', emer_email = '',
      doctor_name = '', doctor_phone = '', doctor_email = '', doctor_fax = '',
      pharmacy_name = '', pharmacy_phone = '', pharmacy_fax = '', pharmacy_address = '',
      // typed notes for each mini recorder
      bp_note = '', meds_note = '', allergies_note = '', weight_note = '',
      conditions_note = '', general_note = '',
      // target language
      lang = ''
    } = req.body || {};

    // Transcribe each audio file, concatenate
    let combinedTranscript = '';
    for (const f of audioFiles) {
      const t = await transcribeFile(f.path, f.originalname || 'part.webm');
      if (t) combinedTranscript += (combinedTranscript ? '\n' : '') + t;
    }

    // Merge with typed notes so parsing sees everything
    const fusedText = [
      combinedTranscript,
      bp_note, meds_note, allergies_note, weight_note, conditions_note, general_note
    ].filter(Boolean).join('\n');

    // Parse structured facts
    const facts = parseFacts(fusedText);

    // Compose an “original summary” block (dual-block #1)
    const summary_original = summarizeFactsOriginal({
      medications: facts.medications,
      allergies: facts.allergies,
      conditions: facts.conditions,
      bp: facts.bp || bp_note || '',
      weight: facts.weight || weight_note || ''
    });

    // Translate transcript and summary if target language selected
    const target_lang = (lang || '').trim();
    const detected_lang = 'auto'; // placeholder; can wire real detection later if needed
    const translated_transcript = target_lang ? await translateText(combinedTranscript, target_lang) : '';
    const summary_translated   = target_lang ? await translateText(summary_original, target_lang) : '';

    // Persist
    const id         = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl    = getBaseUrl(req);
    const share_url  = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(share_url);

    const insert = db.prepare(`
      INSERT INTO reports (
        id, created_at,
        name, email, phone, blood_type,
        emer_name, emer_phone, emer_email,
        doctor_name, doctor_phone, doctor_email, doctor_fax,
        pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
        detected_lang, target_lang,
        transcript, translated_transcript,
        summary_original, summary_translated,
        medications, allergies, conditions, bp, weight, general_note,
        share_url, qr_data_url
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    insert.run(
      id, created_at,
      name, email, phone, blood_type,
      emer_name, emer_phone, emer_email,
      doctor_name, doctor_phone, doctor_email, doctor_fax,
      pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
      detected_lang, target_lang,
      combinedTranscript, translated_transcript,
      summary_original, summary_translated,
      (facts.medications || []).join('; '),
      (facts.allergies   || []).join('; '),
      (facts.conditions  || []).join('; '),
      facts.bp || bp_note || '',
      facts.weight || weight_note || '',
      general_note || '',
      share_url, qr_data_url
    );

    return res.json({ ok: true, id, url: share_url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ---------- Reports list ----------
app.get('/reports', (req, res) => {
  const rows = db.prepare(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`).all();
  const baseUrl = getBaseUrl(req);
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

  const items = rows.map(r => `
    <li class="report-item">
      <div class="title">Report for ${esc(r.name || 'Unknown')}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email || '')}</div>
      <div class="actions"><a class="btn" href="${baseUrl}/reports/${r.id}" target="_blank" rel="noopener">Open</a></div>
    </li>
  `).join('') || '<li class="report-item">No reports yet.</li>';

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Reports</title>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .container{max-width:960px;margin:0 auto;padding:16px;}
  header{display:flex;justify-content:space-between;align-items:center;border-bottom:3px solid aquamarine;padding:12px 0;}
  h1{color:#4b0082;margin:0;}
  ul{list-style:none;padding:0;margin:16px 0;}
  .report-item{background:#fff;border:1px solid #dbe7ff;border-radius:10px;padding:12px;margin:10px 0;display:grid;gap:6px}
  .title{font-weight:600}
  .meta{color:#555;font-size:13px}
  .btn{border:1px solid #dbe7ff;padding:8px 10px;border-radius:8px;background:#f0f5ff;color:#234;text-decoration:none}
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
    <ul>${items}</ul>
  </div>
</body></html>`);
});

// ---------- Single report (dual blocks + actions + QR) ----------
app.get('/reports/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM reports WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).send('Not found');

  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const created = new Date(row.created_at).toLocaleString();

  const gmailHref = `https://mail.google.com/mail/?view=cm&fs=1&tf=1&to=${encodeURIComponent(row.email||'')}&su=${encodeURIComponent('Hot Health Report')}&body=${encodeURIComponent(row.share_url||'')}`;
  const outlookHref = `https://outlook.live.com/mail/0/deeplink/compose?to=${encodeURIComponent(row.email||'')}&subject=${encodeURIComponent('Hot Health Report')}&body=${encodeURIComponent(row.share_url||'')}`;

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Hot Health — Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="/styles.css"/>
<style>
  .container{max-width:960px;margin:0 auto;padding:0 16px 32px;}
  header{border-bottom:3px solid aquamarine;margin-bottom:12px;padding:16px 0}
  h1{color:#4b0082;margin:0 0 6px}
  .section{background:#fff;border:2px solid aquamarine;border-radius:12px;padding:16px;margin:16px 0}
  .dual{display:flex;gap:12px;flex-wrap:wrap}
  .block{flex:1;min-width:280px;background:#f8faff;border:1px solid #dbe7ff;border-radius:8px;padding:12px}
  .qr{ text-align:center;margin:10px 0 }
  .tag{display:inline-block;font-size:12px;color:#334;background:#eef4ff;border:1px solid #dbe7ff;padding:2px 6px;border-radius:12px;margin-left:6px}
  .btnbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
  .btn{border:1px solid #dbe7ff;padding:8px 10px;border-radius:8px;background:#f0f5ff;color:#234;text-decoration:none}
</style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Hot Health — Report
        ${row.detected_lang ? `<span class="tag">Original: ${esc(row.detected_lang)}</span>` : ''}
        ${row.target_lang ? `<span class="tag">Target: ${esc(row.target_lang)}</span>` : ''}
      </h1>
      <div><b>Created:</b> ${esc(created)}</div>
      <div class="btnbar">
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <a class="btn" href="/reports" rel="noopener">All Reports</a>
        <a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener" title="Open share link">🔗 Link</a>
        <a class="btn" href="${gmailHref}" target="_blank" rel="noopener" title="Email via Gmail">📧 Gmail</a>
        <a class="btn" href="${outlookHref}" target="_blank" rel="noopener" title="Email via Outlook">📮 Outlook</a>
        <button class="btn" onclick="window.print()">🖨️ Print</button>
      </div>
      <div class="qr">
        <img src="${esc(row.qr_data_url)}" alt="QR Code" style="max-width:180px"/>
        <div style="font-size:13px;color:#555">Scan on a phone, or use the Link button.</div>
      </div>
    </header>

    <section class="section">
      <h2>Patient Details</h2>
      <div><b>Name:</b> ${esc(row.name||'')}</div>
      <div><b>Email:</b> ${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : ''}</div>
      <div><b>Phone:</b> ${esc(row.phone||'')}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type||'')}</div>
      <div><b>Emergency Contact:</b> ${esc(row.emer_name||'')} ${row.emer_phone?`(${esc(row.emer_phone)})`:''} ${row.emer_email?`<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}</div>
      <div style="margin-top:8px"><b>Family Doctor:</b> ${esc(row.doctor_name||'N/A')} ${row.doctor_phone?`(${esc(row.doctor_phone)})`:''} ${row.doctor_email?`<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>`:''} ${row.doctor_fax?`Fax: ${esc(row.doctor_fax)}`:''}</div>
      <div><b>Pharmacy:</b> ${esc(row.pharmacy_name||'N/A')} ${row.pharmacy_phone?`(${esc(row.pharmacy_phone)})`:''} ${row.pharmacy_fax?`Fax: ${esc(row.pharmacy_fax)}`:''} ${row.pharmacy_address?` • ${esc(row.pharmacy_address)}`:''}</div>
    </section>

    <section class="section">
      <h2>Summary</h2>
      <div class="dual">
        <div class="block">
          <h3>Original ${row.detected_lang ? `(${esc(row.detected_lang)})` : ''}</h3>
          <pre style="white-space:pre-wrap;margin:0">${esc(row.summary_original || '—')}</pre>
        </div>
        <div class="block">
          <h3>${row.target_lang ? esc(row.target_lang) : 'Translated'}</h3>
          <pre style="white-space:pre-wrap;margin:0">${esc(row.summary_translated || '(no translation)')}</pre>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original ${row.detected_lang ? `(${esc(row.detected_lang)})` : ''}</h3>
          <pre style="white-space:pre-wrap;margin:0">${esc(row.transcript || '')}</pre>
        </div>
        <div class="block">
          <h3>${row.target_lang ? esc(row.target_lang) : 'Translated'}</h3>
          <pre style="white-space:pre-wrap;margin:0">${esc(row.translated_transcript || '(no translation)')}</pre>
        </div>
      </div>
    </section>

    <footer style="text-align:center;color:#666;margin-top:20px">Hot Health © 2025</footer>
  </div>
</body></html>`);
});

// ---------- Health ----------
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
