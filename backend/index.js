// backend/index.js
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

// ---- sqlite3 only (permanent fix) ----
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

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
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// -------------------------
// DB layer (sqlite3 only)
// -------------------------
let db;
async function initDB() {
  db = await open({
    filename: path.join(__dirname, 'data.sqlite'),
    driver: sqlite3.Database
  });

  await db.exec(
    "CREATE TABLE IF NOT EXISTS reports (" +
    " id TEXT PRIMARY KEY," +
    " created_at TEXT," +
    " name TEXT," +
    " email TEXT," +
    " blood_type TEXT," +
    " emer_name TEXT," +
    " emer_phone TEXT," +
    " emer_email TEXT," +
    " doctor_name TEXT," +
    " doctor_phone TEXT," +
    " doctor_email TEXT," +
    " doctor_fax TEXT," +
    " pharmacy_name TEXT," +
    " pharmacy_phone TEXT," +
    " pharmacy_fax TEXT," +
    " pharmacy_address TEXT," +
    " detected_lang TEXT," +
    " target_lang TEXT," +
    " transcript TEXT," +
    " translated_transcript TEXT," +
    " medications TEXT," +
    " allergies TEXT," +
    " conditions TEXT," +
    " bp TEXT," +
    " weight TEXT," +
    " share_url TEXT," +
    " qr_data_url TEXT" +
    ");"
  );
}

function dbRun(sql, params=[]) { return db.run(sql, params); }
function dbGet(sql, params=[]) { return db.get(sql, params); }
function dbAll(sql, params=[]) { return db.all(sql, params); }

// -------------------------
// Auth (cookie)
// -------------------------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function setSession(res, user) {
  res.cookie('hhsess', user, {
    httpOnly: true, signed: true, sameSite: 'lax',
    // secure: true // enable if HTTPS-only
  });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

// -------------------------
// Static
// -------------------------
app.use(express.static(PUBLIC_DIR));

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

function uid(n=22) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

// very simple parser; tune as needed
function parseFacts(text) {
  const t = String(text || '');

  const meds = [];
  const allergies = [];
  const conditions = [];

  // medications like "X 20 mg" or "X at 20 mg" or "X — 20 mg"
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d+)\s*(mg|mcg|g|ml)\b/gi;
  let mm;
  const seen = new Set();
  while ((mm = medRx.exec(t)) !== null) {
    const name = mm[1];
    const dose = mm[2] + ' ' + mm[3];
    const key = name.toLowerCase() + '|' + dose.toLowerCase();
    if (!seen.has(key)) { meds.push(`${name} — ${dose}`); seen.add(key); }
  }

  // allergies
  const aRx = /\b(allergy|allergies|allergic to)\b([^\.]+)/gi;
  let aa;
  while ((aa = aRx.exec(t)) !== null) {
    const list = aa[2].split(/[,;]|and/).map(s => s.trim()).filter(Boolean);
    for (const item of list) {
      const clean = item.replace(/^(to|of)\s+/i,'').trim();
      if (clean && !allergies.includes(clean)) allergies.push(clean);
    }
  }

  // conditions
  const condRx = /\b(I have|I’ve|I've|diagnosed with|history of)\b([^\.]+)/gi;
  let cc;
  while ((cc = condRx.exec(t)) !== null) {
    const s = cc[2]
      .replace(/\b(allergy|allergies|medications?|pills?|weight|weigh|pounds?|kg|blood pressure|bp)\b/ig,'')
      .replace(/\s+/g,' ')
      .trim();
    if (s) conditions.push(s);
  }

  // blood pressure
  let bp = null;
  const bpRx = /\b(\d{2,3})\s*(?:\/|over|-|\\)\s*(\d{2,3})\b/i;
  const bpM = t.match(bpRx);
  if (bpM) bp = `${bpM[1]}/${bpM[2]}`;

  // weight
  let weight = null;
  const wRx = /\b(\d{2,3})\s*(?:lbs?|pounds?|kg)\b/i;
  const wM = t.match(wRx);
  if (wM) weight = wM[1] + (wM[0].toLowerCase().includes('kg') ? ' kg' : ' lbs');

  return { medications: meds, allergies, conditions, bp, weight };
}

function escapeHtml(s='') {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

// -------------------------
// Multer (store webm)
// supports single `audio` or multiple `audios[]` blobs
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

app.post('/logout', (req,res) => {
  clearSession(res);
  res.redirect('/login');
});

// -------------------------
// Protect the app & reports
// -------------------------
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// Home (frontend)
app.get('/', (req,res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// -------------------------
// Upload → Transcribe(/merge parts) → Translate → Save → Respond
// -------------------------
const anyUpload = upload.any(); // to accept audio or audios[]

app.post('/upload', anyUpload, async (req,res) => {
  try {
    // Gather fields
    const {
      name='', email='', emer_name='', emer_phone='', emer_email='',
      blood_type='', lang='',
      doctor_name='', doctor_phone='', doctor_email='', doctor_fax='',
      pharmacy_name='', pharmacy_phone='', pharmacy_fax='', pharmacy_address='',
      typed_notes='' // <- NEW: typed text from UI
    } = req.body || {};

    // Collect files: single file field or multiple parts
    const files = [];
    for (const f of (req.files || [])) {
      if (f.fieldname === 'audio' || f.fieldname === 'audios[]' || f.mimetype === 'audio/webm') {
        files.push(f);
      }
    }
    if (files.length === 0 && !typed_notes) {
      return res.status(400).json({ ok:false, error:'No file' });
    }

    // If multiple parts, transcribe each and concatenate
    const transcripts = [];
    for (const f of files) {
      const stream = fs.createReadStream(f.path);
      let text = '';
      try {
        const tr = await openai.audio.transcriptions.create({
          file: stream,
          model: 'gpt-4o-mini-transcribe'
        });
        text = (tr.text || '').trim();
      } catch {
        // fallback whisper-1
        try {
          const s2 = fs.createReadStream(f.path);
          const tr2 = await openai.audio.transcriptions.create({
            file: s2,
            model: 'whisper-1'
          });
          text = (tr2.text || '').trim();
        } catch {
          text = '';
        }
      }
      if (text) transcripts.push(text);
    }

    // merge typed notes (so parser sees them)
    if (typed_notes && typed_notes.trim()) {
      transcripts.push(typed_notes.trim());
    }

    const transcript = transcripts.join('\n').trim();

    // Optional translate
    const detected_lang = 'auto';
    const target_lang = (lang || '').trim();
    let translated = '';
    if (target_lang) {
      try {
        const prompt =
          `Translate the following medical note to ${target_lang}. ` +
          `Return only the translated text.\n\n${transcript}`;
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

    // Parse facts from original transcript
    const facts = parseFacts(transcript);

    // Save row
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(shareUrl);

    const insertSql =
      "INSERT INTO reports (" +
      " id, created_at, name, email, blood_type, emer_name, emer_phone, emer_email," +
      " doctor_name, doctor_phone, doctor_email, doctor_fax," +
      " pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address," +
      " detected_lang, target_lang, transcript, translated_transcript," +
      " medications, allergies, conditions, bp, weight," +
      " share_url, qr_data_url" +
      " ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";

    await dbRun(insertSql, [
      id, created_at, name, email, blood_type, emer_name, emer_phone, emer_email,
      doctor_name, doctor_phone, doctor_email, doctor_fax,
      pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
      detected_lang, target_lang, transcript, translated,
      (facts.medications||[]).join('; '),
      (facts.allergies||[]).join('; '),
      (facts.conditions||[]).join('; '),
      facts.bp || '', facts.weight || '',
      shareUrl, qr_data_url
    ]);

    // Respond
    res.json({ ok:true, id, url: shareUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// -------------------------
// Reports list (cleaner formatting)
// -------------------------
app.get('/reports', async (req,res) => {
  const rows = await dbAll(
    "SELECT id, created_at, name, email, target_lang FROM reports ORDER BY datetime(created_at) DESC"
  );
  const baseUrl = getBaseUrl(req);
  const items = rows.map(r => {
    const title = `Report for ${r.name || 'Unknown'}`;
    const url = `${baseUrl}/reports/${r.id}`;
    const when = new Date(r.created_at).toLocaleString();
    return `
      <li class="report-item">
        <div class="title">${escapeHtml(title)}</div>
        <div class="meta">${escapeHtml(when)} • ${escapeHtml(r.email || '')}</div>
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
  .container { max-width: 960px; margin: 0 auto; padding: 16px; }
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
// Single report (dual blocks + actions)
// -------------------------
app.get('/reports/:id', async (req,res) => {
  const row = await dbGet("SELECT * FROM reports WHERE id=?", [req.params.id]);
  if (!row) return res.status(404).send('Not found');

  const esc = escapeHtml;
  const created = new Date(row.created_at).toLocaleString();
  const baseUrl = getBaseUrl(req);
  const share = row.share_url || `${baseUrl}/reports/${row.id}`;

  const gmailUrl =
    "https://mail.google.com/mail/?view=cm&fs=1" +
    "&to=" + encodeURIComponent(row.email || "") +
    "&su=" + encodeURIComponent("Your Hot Health Report") +
    "&body=" + encodeURIComponent(`Here is your Hot Health report: ${share}`);
  const outlookUrl =
    "https://outlook.office.com/mail/deeplink/compose" +
    "?subject=" + encodeURIComponent("Your Hot Health Report") +
    "&body=" + encodeURIComponent(`Here is your Hot Health report: ${share}`) +
    (row.email ? "&to=" + encodeURIComponent(row.email) : "");

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
  .block { flex:1; min-width:260px; background:#f8faff; border:1px solid #dbe7ff; border-radius:8px; padding:12px; }
  .qr { text-align:center; margin:8px 0; }
  .tag { display:inline-block; font-size:12px; color:#334; background:#eef4ff; border:1px solid #dbe7ff; padding:2px 6px; border-radius:12px; margin-left:6px; }
  .btnbar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:8px; }
  .btn { text-decoration:none; border:1px solid #dbe7ff; padding:8px 10px; border-radius:8px; background:#f0f5ff; color:#234; font-size:14px; }
  .meta-grid { display:grid; grid-template-columns: 1fr 1fr; gap:8px 20px; }
  .label { color:#334; font-weight:600; }
</style>
<script>
function copyLink(){
  const url = ${JSON.stringify(share)};
  navigator.clipboard.writeText(url).then(()=>alert('Link copied')).catch(()=>alert(url));
}
function doPrint(){ window.print(); }
</script>
</head>
<body>
  <div class="container">
    <header>
      <h1>Hot Health — Report 
        ${row.detected_lang ? `<span class="tag">Original: ${esc(row.detected_lang)}</span>`:''}
        ${row.target_lang ? `<span class="tag">Target: ${esc(row.target_lang)}</span>`:''}
      </h1>
      <div><b>Created:</b> ${esc(created)}</div>
      <div class="qr">
        <img src="${esc(row.qr_data_url)}" alt="QR Code" style="max-width:180px;"/>
        <div style="font-size:13px;color:#555">Scan on a phone, or use the actions below.</div>
      </div>
      <div class="btnbar">
        <a class="btn" href="${esc(share)}" target="_blank" rel="noopener" title="Open share link">🔗 Open</a>
        <a class="btn" href="${esc(gmailUrl)}" target="_blank" rel="noopener">📧 Gmail</a>
        <a class="btn" href="${esc(outlookUrl)}" target="_blank" rel="noopener">📮 Outlook</a>
        <button class="btn" onclick="copyLink()">🔗 Copy Link</button>
        <button class="btn" onclick="doPrint()">🖨️ Print</button>
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <a class="btn" href="/reports" rel="noopener">All Reports</a>
      </div>
    </header>

    <section class="section">
      <h2>Patient & Contacts</h2>
      <div class="meta-grid">
        <div><span class="label">Name:</span> ${esc(row.name||'')}</div>
        <div><span class="label">Email:</span> ${row.email ? `<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>` : ''}</div>
        <div><span class="label">Blood Type:</span> ${esc(row.blood_type||'')}</div>
        <div><span class="label">Emergency Contact:</span> ${esc(row.emer_name||'')}</div>
        <div><span class="label">Emergency Phone:</span> ${esc(row.emer_phone||'')}</div>
        <div><span class="label">Emergency Email:</span> ${row.emer_email ? `<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>` : ''}</div>
      </div>
    </section>

    ${(row.doctor_name||row.doctor_phone||row.doctor_email||row.doctor_fax) ? `
    <section class="section">
      <h2>Family Doctor</h2>
      <div class="meta-grid">
        <div><span class="label">Name:</span> ${esc(row.doctor_name||'N/A')}</div>
        <div><span class="label">Phone:</span> ${esc(row.doctor_phone||'N/A')}</div>
        <div><span class="label">Email:</span> ${row.doctor_email ? `<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>` : 'N/A'}</div>
        <div><span class="label">Fax:</span> ${esc(row.doctor_fax||'N/A')}</div>
      </div>
    </section>` : ''}

    ${(row.pharmacy_name||row.pharmacy_phone||row.pharmacy_fax||row.pharmacy_address) ? `
    <section class="section">
      <h2>Pharmacy</h2>
      <div class="meta-grid">
        <div><span class="label">Name:</span> ${esc(row.pharmacy_name||'N/A')}</div>
        <div><span class="label">Phone:</span> ${esc(row.pharmacy_phone||'N/A')}</div>
        <div><span class="label">Fax:</span> ${esc(row.pharmacy_fax||'N/A')}</div>
        <div><span class="label">Address:</span> ${esc(row.pharmacy_address||'N/A')}</div>
      </div>
    </section>` : ''}

    <section class="section">
      <h2>Summary</h2>
      <div class="dual">
        <div class="block">
          <h3>Original${row.detected_lang ? ` (${esc(row.detected_lang)})` : ''}</h3>
          <p><b>Medications:</b> ${esc(row.medications || 'None')}</p>
          <p><b>Allergies:</b> ${esc(row.allergies || 'None')}</p>
          <p><b>Conditions:</b> ${esc(row.conditions || 'None')}</p>
          <p><b>Blood Pressure:</b> ${esc(row.bp || '—')}</p>
          <p><b>Weight:</b> ${esc(row.weight || '—')}</p>
        </div>
        <div class="block">
          <h3>${row.target_lang ? esc(row.target_lang) : 'Translated'}</h3>
          <p>${esc(row.translated_transcript || '(no translation)')}</p>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original${row.detected_lang ? ` (${esc(row.detected_lang)})` : ''}</h3>
          <p>${esc(row.transcript || '')}</p>
        </div>
        <div class="block">
          <h3>${row.target_lang ? esc(row.target_lang) : 'Translated'}</h3>
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
