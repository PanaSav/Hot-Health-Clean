// Hot Health — one-file backend (auth, upload, DB, QR, reports, email/print/link)
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
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = Number(process.env.PORT || 10000);

// --- Auth (simple cookie login) ---
const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// --- OpenAI ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --- Storage ---
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Multer for webm uploads
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.webm`)
});
const upload = multer({ storage });

// --- DB (better-sqlite3 only; Node 20 recommended) ---
const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    created_at TEXT,
    name TEXT,
    email TEXT,
    blood_type TEXT,
    emer_name TEXT,
    emer_phone TEXT,
    emer_email TEXT,
    doctor_name TEXT,
    doctor_phone TEXT,
    doctor_fax TEXT,
    doctor_email TEXT,
    pharmacy_name TEXT,
    pharmacy_phone TEXT,
    pharmacy_fax TEXT,
    pharmacy_address TEXT,

    detected_lang TEXT,
    target_lang TEXT,

    transcript TEXT,
    translated_transcript TEXT,

    medications TEXT,
    allergies TEXT,
    conditions TEXT,
    general_note TEXT,
    bp TEXT,
    weight TEXT,

    share_url TEXT,
    qr_data_url TEXT
  );
`);

// --- Helpers ---
function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly: true, signed: true, sameSite: 'lax' });
}
function clearSession(res) { res.clearCookie('hhsess'); }
function requireAuth(req, res, next) {
  const u = req.signedCookies?.hhsess;
  if (!u) return res.redirect('/login');
  next();
}

function getBaseUrl(req) {
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function esc(s='') {
  return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
const uid = (n=22)=>crypto.randomBytes(n).toString('base64url').slice(0,n);

// Simple parser — keeps it naive but useful
function parseFacts(text) {
  const meds=[], allergies=[], conditions=[];
  // meds: "Name ... 20 mg"
  const medRx=/([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d+)\s*(mg|mcg|g|ml)/gi;
  let m, seen=new Set();
  while((m=medRx.exec(text))!==null){
    const name=m[1], dose=m[2]+' '+m[3], key=name.toLowerCase()+'|'+dose.toLowerCase();
    if(!seen.has(key)){ meds.push(`${name} — ${dose}`); seen.add(key); }
  }
  // allergies: "allergic to X, Y"
  const aRx=/\b(allergy|allergies|allergic to)\b([^\.]+)/gi;
  let a; 
  while((a=aRx.exec(text))!==null){
    const list=a[2].split(/[,;]|and/).map(s=>s.trim()).filter(Boolean);
    for (const item of list) {
      const clean = item.replace(/^(to|of)\s+/i,'').trim();
      if (clean && !allergies.includes(clean)) allergies.push(clean);
    }
  }
  // conditions: "I have ...", "diagnosed with ..."
  const cRx=/\b(I have|I’ve|I've|diagnosed with|history of)\b([^\.]+)/gi;
  let c;
  while((c=cRx.exec(text))!==null){
    const s=c[2].replace(/\b(allergy|allergies|medications?|pills?)\b/ig,'').trim();
    if (s) conditions.push(s);
  }
  // bp
  let bp=null; const bpM=text.match(/\b(\d{2,3})\s*[/over\\-]\s*(\d{2,3})\b/i); if(bpM) bp=`${bpM[1]}/${bpM[2]}`;
  // weight
  let weight=null; const wM=text.match(/\b(\d{2,3})\s*(?:lbs?|pounds?|kg)\b/i); 
  if(wM) weight = wM[1] + (wM[0].toLowerCase().includes('kg')?' kg':' lbs');
  return { medications:meds, allergies, conditions, bp, weight };
}

// --- Static + Login ---
app.use(express.static(PUBLIC_DIR));

// Login pages
app.get('/login', (req,res)=>{
  const p=path.join(PUBLIC_DIR,'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send(`<!doctype html><html><body><form method="POST"><input name="userId"/><input name="password" type="password"/><button>Sign in</button></form></body></html>`);
});
app.post('/login', bodyParser.urlencoded({extended:true}), (req,res)=>{
  const { userId, password } = req.body || {};
  if (userId===USER_ID && password===USER_PASS){ setSession(res,userId); return res.redirect('/'); }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout', (req,res)=>{ clearSession(res); res.redirect('/login'); });

// Guard the app
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// Home
app.get('/', (req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));

// Upload: single combined audio (from 6 mini recorders merged) + JSON sections
app.post('/upload', upload.single('audio'), async (req,res)=>{
  try{
    const {
      name='', email='', blood_type='',
      emer_name='', emer_phone='', emer_email='',
      doctor_name='', doctor_phone='', doctor_fax='', doctor_email='',
      pharmacy_name='', pharmacy_phone='', pharmacy_fax='', pharmacy_address='',
      target_lang=''
    } = req.body || {};

    let transcript = '';
    // If audio present, transcribe
    if (req.file) {
      const stream = fs.createReadStream(req.file.path);
      try {
        const tr = await openai.audio.transcriptions.create({
          file: stream,
          model: 'gpt-4o-mini-transcribe'
        });
        transcript = tr.text?.trim() || '';
      } catch {
        // fallback whisper
        const stream2 = fs.createReadStream(req.file.path);
        const tr2 = await openai.audio.transcriptions.create({
          file: stream2,
          model: 'whisper-1'
        });
        transcript = tr2.text?.trim() || '';
      }
    }

    // Merge the typed texts for each section into the transcript (if provided)
    // Frontend sends JSON string 'sections' with keys matching the six blocks.
    let mergedNote = transcript;
    if (req.body.sections) {
      try {
        const sec = JSON.parse(req.body.sections);
        const lines = [];
        if (sec.bp)           lines.push(`Blood Pressure: ${sec.bp}`);
        if (sec.meds)         lines.push(`Medications & Dose: ${sec.meds}`);
        if (sec.allergies)    lines.push(`Allergies: ${sec.allergies}`);
        if (sec.weight)       lines.push(`Weight: ${sec.weight}`);
        if (sec.conditions)   lines.push(`Conditions: ${sec.conditions}`);
        if (sec.general)      lines.push(`General Health Note: ${sec.general}`);
        const typedBlock = lines.join('\n');
        if (typedBlock) mergedNote = (mergedNote ? (mergedNote + '\n\n') : '') + typedBlock;
      } catch {}
    }

    // Parse facts from the merged text (prefer meds/conditions/allergies, plus bp/weight)
    const facts = parseFacts(mergedNote);

    // Optional translate (transcript)
    const detected_lang = 'auto'; // placeholder
    let translated_transcript = '';
    let target = (target_lang || '').trim();
    if (target) {
      const prompt = `Translate to ${target} (medical context). Return only translated text:\n\n${mergedNote}`;
      try{
        const rsp = await openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          messages: [{ role:'user', content: prompt }],
          temperature: 0.2
        });
        translated_transcript = rsp.choices?.[0]?.message?.content?.trim() || '';
      }catch{ translated_transcript=''; }
    }

    // Build a bilingual summary block (simple). We just reuse parsed facts.
    const summaryOriginal = [
      `Medications:\n${(facts.medications||[]).join('\n') || 'None'}`,
      `Allergies:\n${(facts.allergies||[]).join('\n') || 'None'}`,
      `Conditions:\n${(facts.conditions||[]).join('\n') || 'None'}`,
      `Blood Pressure:\n${facts.bp || '—'}`,
      `Weight:\n${facts.weight || '—'}`
    ].join('\n\n');

    let summaryTranslated = '';
    if (target) {
      const sPrompt = `Translate this summary to ${target}. Keep headings and list formatting:\n\n${summaryOriginal}`;
      try{
        const sRsp = await openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          messages: [{ role:'user', content: sPrompt }],
          temperature: 0.2
        });
        summaryTranslated = sRsp.choices?.[0]?.message?.content?.trim() || '';
      }catch{ summaryTranslated=''; }
    }

    // Store
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const share_url = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(share_url);

    const stmt = db.prepare(`
      INSERT INTO reports (
        id, created_at, name, email, blood_type,
        emer_name, emer_phone, emer_email,
        doctor_name, doctor_phone, doctor_fax, doctor_email,
        pharmacy_name, pharmacy_phone, pharmacy_fax, pharmacy_address,
        detected_lang, target_lang,
        transcript, translated_transcript,
        medications, allergies, conditions, general_note, bp, weight,
        share_url, qr_data_url
      )
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    stmt.run(
      id, created_at, name, email, blood_type,
      emer_name, emer_phone, emer_email,
      doctor_name || 'N/A', doctor_phone || 'N/A', doctor_fax || 'N/A', doctor_email || 'N/A',
      pharmacy_name || 'N/A', pharmacy_phone || 'N/A', pharmacy_fax || 'N/A', pharmacy_address || 'N/A',
      detected_lang, target,
      mergedNote, translated_transcript,
      (facts.medications||[]).join('; '),
      (facts.allergies||[]).join('; '),
      (facts.conditions||[]).join('; '),
      (req.body.sections ? (JSON.parse(req.body.sections).general||'') : ''),
      facts.bp || '', facts.weight || '',
      share_url, qr_data_url
    );

    res.json({ ok:true, id, url: share_url });
  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:'Server error' });
  }
});

// Reports list
app.get('/reports', (req,res)=>{
  const rows = db.prepare(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`).all();
  const items = rows.map(r=>{
    return `
      <li class="report-item">
        <div class="title">Report for ${esc(r.name||'Unknown')}</div>
        <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email||'')}</div>
        <div class="actions">
          <a class="btn" href="/reports/${r.id}" target="_blank" rel="noopener">Open</a>
        </div>
      </li>
    `;
  }).join('');
  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<title>Reports</title>
<link rel="stylesheet" href="/styles.css"/>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>Hot Health — Reports</h1>
      <nav>
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
      </nav>
    </header>
    <ul class="list-reset">${items || '<li class="report-item">No reports yet.</li>'}</ul>
  </div>
</body></html>`);
});

// Single report
app.get('/reports/:id', (req,res)=>{
  const row = db.prepare(`SELECT * FROM reports WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).send('Not found');
  const created = new Date(row.created_at).toLocaleString();
  const shareIcon = `<a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener" title="Open share link">🔗 Link</a>`;
  const mailTo = (to, subject, body)=>`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const subject = `Hot Health Report — ${row.name||''}`;
  const body = `${row.share_url}\n\n${row.transcript||''}`;

  res.send(`<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Hot Health — Report</title>
<link rel="stylesheet" href="/styles.css"/>
</head>
<body>
  <div class="container">
    <header class="header">
      <h1>Hot Health — Report
        ${row.detected_lang ? `<span class="tag">Original: ${esc(row.detected_lang)}</span>`:''}
        ${row.target_lang ? `<span class="tag">Target: ${esc(row.target_lang)}</span>`:''}
      </h1>
      <div><b>Created:</b> ${esc(created)} ${shareIcon}</div>
      <div class="qr">
        <img src="${esc(row.qr_data_url)}" alt="QR" style="max-width:180px"/>
        <div class="muted">Scan on a phone, or use the link button.</div>
      </div>
      <div class="btnbar">
        <a class="btn" href="/" rel="noopener">+ New Report</a>
        <a class="btn" href="/reports" rel="noopener">All Reports</a>
        ${row.email ? `<a class="btn" href="${mailTo(row.email, subject, body)}">✉️ Email Patient</a>`:''}
        ${row.emer_email ? `<a class="btn" href="${mailTo(row.emer_email, subject, body)}">✉️ Email Emergency</a>`:''}
        <button class="btn" onclick="window.print()">🖨️ Print</button>
      </div>
    </header>

    <section class="section">
      <h2>Patient Details</h2>
      <div><b>Name:</b> ${esc(row.name||'')}</div>
      <div><b>Email:</b> ${row.email?`<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>`:'—'}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type||'')}</div>
      <div><b>Emergency Contact:</b> ${esc(row.emer_name||'')} ${row.emer_phone?`(${esc(row.emer_phone)})`:''} ${row.emer_email?`<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}</div>
      <div class="grid2">
        <div><b>Doctor:</b> ${esc(row.doctor_name||'N/A')} ${row.doctor_phone?`(${esc(row.doctor_phone)})`:''} ${row.doctor_email?`<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>`:''} ${row.doctor_fax?`Fax: ${esc(row.doctor_fax)}`:''}</div>
        <div><b>Pharmacy:</b> ${esc(row.pharmacy_name||'N/A')}, ${esc(row.pharmacy_address||'N/A')} ${row.pharmacy_phone?`(${esc(row.pharmacy_phone)})`:''} ${row.pharmacy_fax?`Fax: ${esc(row.pharmacy_fax)}`:''}</div>
      </div>
    </section>

    <section class="section">
      <h2>Summary</h2>
      <div class="dual">
        <div class="block">
          <h3>Original (summary)</h3>
          <pre class="pre">${esc(
            `Medications:\n${row.medications || 'None'}\n\nAllergies:\n${row.allergies || 'None'}\n\nConditions:\n${row.conditions || 'None'}\n\nBlood Pressure:\n${row.bp || '—'}\n\nWeight:\n${row.weight || '—'}`
          )}</pre>
        </div>
        <div class="block">
          <h3>${row.target_lang ? esc(row.target_lang.toUpperCase()) : 'Translated'}</h3>
          <pre class="pre">${esc(row.target_lang ? ( // reuse translated transcript for richness if summary translation not stored
            (row.translated_transcript || '').trim() || '(no translation)'
          ) : '(no translation)')}</pre>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original</h3>
          <pre class="pre">${esc(row.transcript || '')}</pre>
        </div>
        <div class="block">
          <h3>${row.target_lang ? esc(row.target_lang.toUpperCase()) : 'Translated'}</h3>
          <pre class="pre">${esc(row.translated_transcript || '(no translation)')}</pre>
        </div>
      </div>
    </section>

    <footer class="footer">Hot Health © 2025</footer>
  </div>
</body></html>`);
});

// Start
app.listen(PORT, ()=>console.log(`✅ Backend listening on ${PORT}`));
