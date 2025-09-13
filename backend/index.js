// backend/index.js
// Caregiver Card — Baseline 1 + single field mics + Journal (parsed) + auth + lang-detect
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

const app = express();
const PORT = Number(process.env.PORT || 10000);

const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- DB (sqlite3 only) ----------
sqlite3.verbose();
const db = new sqlite3.Database(path.join(__dirname, 'data.sqlite'));
const dbRun = (sql, p=[]) => new Promise((res, rej)=>db.run(sql, p, function(e){e?rej(e):res(this)}));
const dbGet = (sql, p=[]) => new Promise((res, rej)=>db.get(sql, p, (e, r)=>e?rej(e):res(r)));
const dbAll = (sql, p=[]) => new Promise((res, rej)=>db.all(sql, p, (e, r)=>e?rej(e):res(r)));

async function initDB(){
  await dbRun(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created_at TEXT,

      -- Patient & contacts
      name TEXT, email TEXT, blood_type TEXT,
      emer_name TEXT, emer_phone TEXT, emer_email TEXT,

      -- Doctor
      doctor_name TEXT, doctor_address TEXT, doctor_phone TEXT, doctor_fax TEXT, doctor_email TEXT,

      -- Pharmacy
      pharmacy_name TEXT, pharmacy_address TEXT, pharmacy_phone TEXT, pharmacy_fax TEXT,

      -- Languages
      detected_lang TEXT, target_lang TEXT,

      -- Text blocks
      transcript TEXT, translated_transcript TEXT,

      -- Summary (dual)
      medications TEXT, allergies TEXT, conditions TEXT, bp TEXT, weight TEXT,
      summary_text TEXT, translated_summary TEXT,

      -- Journal (raw)
      journal_text TEXT,

      -- Share
      share_url TEXT, qr_data_url TEXT
    )
  `);

  // Make sure “later” columns exist (safe ALTERs)
  const addCols = [
    ['journal_text','TEXT'], ['summary_text','TEXT'], ['translated_summary','TEXT']
  ];
  for (const [c, type] of addCols) {
    try { await dbRun(`ALTER TABLE reports ADD COLUMN ${c} ${type}`); } catch {}
  }
}

// ---------- Auth ----------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json({ limit:'6mb' }));
app.use(bodyParser.urlencoded({ extended:true, limit:'6mb' }));

function setSession(res, user){
  res.cookie('ccsess', user, { httpOnly:true, sameSite:'lax', signed:true /*, secure:true*/ });
}
function clearSession(res){ res.clearCookie('ccsess'); }
function requireAuth(req, res, next){
  const u = req.signedCookies?.ccsess;
  if (!u) return res.redirect('/login');
  next();
}

app.get('/login', (req,res)=>{
  const p = path.join(PUBLIC_DIR, 'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send(`<html><body><h3>Sign In</h3>
    <form method="POST" action="/login">
      <input name="userId" placeholder="User ID"><br/>
      <input name="password" type="password" placeholder="Password"><br/>
      <button>Sign In</button>
    </form></body></html>`);
});
app.post('/login', (req,res)=>{
  const { userId, password } = req.body || {};
  if (userId === USER_ID && password === USER_PASS){ setSession(res, userId); return res.redirect('/'); }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout', (req,res)=>{ clearSession(res); res.redirect('/login'); });

// Static + gate app & reports
app.use(express.static(PUBLIC_DIR));
app.use(['/', '/transcribe', '/detect-language-text', '/parse-free-speech', '/upload-multi', '/reports', '/reports/*'], requireAuth);

// ---------- Helpers ----------
function getBaseUrl(req){
  const env = (process.env.PUBLIC_BASE_URL||'').trim();
  if (env) return env.replace(/\/+$/,'');
  const proto = (req.headers['x-forwarded-proto']||'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
const LANG_NAMES = {
  en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano',
  ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ'
};
const nameOf = c => LANG_NAMES[c] || c || '—';
const uid = (n=20)=>crypto.randomBytes(n).toString('base64url').slice(0,n);

function parseFacts(text=''){
  const t = text.replace(/\s+/g,' ').trim();
  const meds=[], allergies=[], conditions=[];
  const medRx=/([A-Za-z][A-Za-z0-9\-]+)\s*(?:at|:|—|-)?\s*(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  let m, seen=new Set();
  while((m=medRx.exec(t))){ const key=(m[1]+'|'+m[2]+m[3]).toLowerCase(); if(!seen.has(key)){ meds.push(`${m[1]} — ${m[2]} ${m[3]}`); seen.add(key);} }
  const aHit=t.match(/\ballerg(?:y|ies)\b[^.?!]+/i);
  if (aHit){ aHit[0].split(/[,;]| and /i).map(s=>s.replace(/\ballerg(?:y|ies)\b/i,'').replace(/\bto\b/ig,'').trim()).filter(Boolean).forEach(x=>{if(!allergies.includes(x)) allergies.push(x);});}
  const cRx=/\b(I have|I've|I’ve|diagnosed with|history of)\b([^.!?]+)/ig;
  let c; while((c=cRx.exec(t))){ let phrase=c[2].replace(/\b(allerg(?:y|ies)|medications?|pills?)\b/ig,'').trim(); phrase=phrase.replace(/^[,:;.\s-]+/,''); if(phrase) conditions.push(phrase); }
  let bp=null; const bpM=t.match(/\b(\d{2,3})\s*(?:\/|over|-)\s*(\d{2,3})\b/); if(bpM) bp=`${bpM[1]}/${bpM[2]}`;
  let weight=null; const wM=t.match(/\b(\d{2,3})\s*(lbs?|pounds?|kg)\b/i); if(wM) weight=wM[1]+(wM[2].toLowerCase().includes('kg')?' kg':' lbs');
  return { medications:meds, allergies, conditions, bp, weight };
}
function summarizeFacts(f){
  const L=[];
  L.push(`Medications: ${f.medications?.length?f.medications.join('; '):'None mentioned'}`);
  L.push(`Allergies: ${f.allergies?.length?f.allergies.join('; '):'None mentioned'}`);
  L.push(`Conditions: ${f.conditions?.length?f.conditions.join('; '):'None mentioned'}`);
  L.push(`Blood Pressure: ${f.bp||'—'}`);
  L.push(`Weight: ${f.weight||'—'}`);
  return L.join('\n');
}

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination:(_,__,cb)=>cb(null,UPLOAD_DIR),
  filename:(_,file,cb)=>cb(null,`${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webm`)
});
const upload = multer({ storage });

// ---------- Home ----------
app.get('/', (req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));

// ---------- API: field/journal transcription ----------
app.post('/transcribe', upload.single('audio'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({ok:false, error:'No file'});
    const stream = fs.createReadStream(req.file.path);
    let text='';
    try{
      const r = await openai.audio.transcriptions.create({ file:stream, model:'gpt-4o-mini-transcribe' });
      text = r.text?.trim()||'';
    }catch{
      const s2=fs.createReadStream(req.file.path);
      const r2=await openai.audio.transcriptions.create({file:s2, model:'whisper-1'});
      text=r2.text?.trim()||'';
    }
    res.json({ok:true, text});
  }catch(e){
    console.error(e);
    res.status(500).json({ok:false, error:'Transcription failed'});
  }
});

// detect language from text (journal result)
app.post('/detect-language-text', async (req,res)=>{
  try{
    const { text='' } = req.body||{};
    if(!text.trim()) return res.json({ok:true, lang:'', name:''});
    const prompt = `Detect the language code (ISO 639-1 like "en","es","fr","he","sr","pa") of this text. Respond ONLY the code:\n\n${text}`;
    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages:[{role:'user', content:prompt}]
    });
    const code = (r.choices?.[0]?.message?.content||'').trim().toLowerCase().replace(/[^a-z]/g,'').slice(0,2);
    return res.json({ok:true, lang:code, name:nameOf(code)});
  }catch(e){ console.error(e); res.status(500).json({ok:false, error:'detect-failed'}); }
});

// parse free speech into fields and status
app.post('/parse-free-speech', async (req,res)=>{
  try{
    const { text='' } = req.body||{};
    if(!text.trim()) return res.json({ok:true, fields:{}, status:{}, journal:text});

    const sys = `You extract structured medical intake from free speech. Output strict JSON with:
{
 "fields": {
   "name": "", "email": "", "blood_type": "",
   "emer_name":"", "emer_phone":"", "emer_email":"",
   "doctor_name":"", "doctor_address":"", "doctor_phone":"", "doctor_fax":"", "doctor_email":"",
   "pharmacy_name":"", "pharmacy_address":"", "pharmacy_phone":"", "pharmacy_fax":""
 },
 "status": { "bp":"", "weight":"", "medications": [], "allergies": [], "conditions": [] },
 "notes": ""  // anything extra
}
Prefer exact emails (use '@' and '.'), numeric phones, and common blood type formats.`;

    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      messages:[
        { role:'system', content: sys },
        { role:'user', content: text }
      ]
    });

    let data = {};
    try{ data = JSON.parse(r.choices?.[0]?.message?.content||'{}'); }catch{}
    const fields = data.fields||{};
    const status = data.status||{};
    const notes  = data.notes||'';

    // backstop with regex summary
    const facts = parseFacts(text);
    // merge status smartly
    status.medications = status.medications?.length ? status.medications : facts.medications;
    status.allergies   = status.allergies?.length   ? status.allergies   : facts.allergies;
    status.conditions  = status.conditions?.length  ? status.conditions  : facts.conditions;
    status.bp          = status.bp || facts.bp || '';
    status.weight      = status.weight || facts.weight || '';

    res.json({ok:true, fields, status, journal:text, notes});
  }catch(e){ console.error(e); res.status(500).json({ok:false, error:'parse-failed'}); }
});

// ---------- Upload multi (generate report) ----------
app.post('/upload-multi', async (req,res)=>{
  try{
    const B = req.body||{};
    // required enough content?
    const anyContent = [
      B.name, B.email, B.emer_name, B.doctor_name, B.pharmacy_name,
      B.bp, B.weight, B.medications, B.allergies, B.conditions, B.journal_text
    ].some(v => (v||'').trim().length);
    if(!anyContent) return res.status(400).json({ok:false, error:'No content'});

    const patient = {
      name:(B.name||'').trim(), email:(B.email||'').trim(), blood_type:(B.blood_type||'').trim(),
      emer_name:(B.emer_name||'').trim(), emer_phone:(B.emer_phone||'').trim(), emer_email:(B.emer_email||'').trim(),
      doctor_name:(B.doctor_name||'').trim(), doctor_address:(B.doctor_address||'').trim(),
      doctor_phone:(B.doctor_phone||'').trim(), doctor_fax:(B.doctor_fax||'').trim(), doctor_email:(B.doctor_email||'').trim(),
      pharmacy_name:(B.pharmacy_name||'').trim(), pharmacy_address:(B.pharmacy_address||'').trim(),
      pharmacy_phone:(B.pharmacy_phone||'').trim(), pharmacy_fax:(B.pharmacy_fax||'').trim(),
    };
    const status = {
      bp:(B.bp||'').trim(), weight:(B.weight||'').trim(),
      medications:(B.medications||'').trim(), allergies:(B.allergies||'').trim(), conditions:(B.conditions||'').trim()
    };
    const transcript = (B.transcript||'').trim(); // optional consolidated text, not required
    const journal_text = (B.journal_text||'').trim();
    const detected_lang = (B.detected_lang||'').trim();
    const target_lang   = (B.target_lang||'').trim();

    // summary
    const facts = {
      medications: status.medications ? status.medications.split(/\s*;\s*/).filter(Boolean) : [],
      allergies:   status.allergies   ? status.allergies.split(/\s*;\s*/).filter(Boolean)   : [],
      conditions:  status.conditions  ? status.conditions.split(/\s*;\s*/).filter(Boolean)  : [],
      bp:          status.bp||'',
      weight:      status.weight||'',
    };
    const summary_text = summarizeFacts(facts);

    // translate transcript+summary if target selected
    let translated_transcript = '';
    let translated_summary = '';
    if (target_lang){
      const [t1, t2] = await Promise.all([
        openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages:[{role:'user', content:`Translate to ${target_lang}:\n\n${transcript || summary_text}`}]
        }),
        openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages:[{role:'user', content:`Translate to ${target_lang}:\n\n${summary_text}`}]
        })
      ]);
      translated_transcript = t1.choices?.[0]?.message?.content?.trim() || '';
      translated_summary    = t2.choices?.[0]?.message?.content?.trim() || '';
    }

    // share link + qr
    const id = uid();
    const created_at = new Date().toISOString();
    const base = getBaseUrl(req);
    const share_url  = `${base}/reports/${id}`;
    const qr_data_url= await QRCode.toDataURL(share_url);

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
        journal_text,
        share_url, qr_data_url
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [
      id, created_at,
      patient.name, patient.email, patient.blood_type,
      patient.emer_name, patient.emer_phone, patient.emer_email,
      patient.doctor_name, patient.doctor_address, patient.doctor_phone, patient.doctor_fax, patient.doctor_email,
      patient.pharmacy_name, patient.pharmacy_address, patient.pharmacy_phone, patient.pharmacy_fax,
      detected_lang, target_lang,
      transcript, translated_transcript,
      (facts.medications||[]).join('; '), (facts.allergies||[]).join('; '), (facts.conditions||[]).join('; '),
      facts.bp||'', facts.weight||'',
      summary_text, translated_summary,
      journal_text,
      share_url, qr_data_url
    ]);

    res.json({ok:true, id, url:share_url});
  }catch(e){
    console.error(e);
    res.status(500).json({ok:false, error:'Server error'});
  }
});

// ---------- Reports ----------
app.get('/reports', async (req,res)=>{
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const esc = s=>String(s||'').replace(/[&<>"]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
  const items = rows.map(r=>`
    <li class="report-item">
      <div class="title">Report for ${esc(r.name)||'Unknown'}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email)}</div>
      <div class="actions"><a class="btn" href="/reports/${esc(r.id)}" target="_blank" rel="noopener">Open</a></div>
    </li>`).join('') || '<li class="report-item">No reports yet.</li>';

  res.send(`<!doctype html>
<html><head><meta charset="utf-8"/><title>Caregiver Card — Reports</title><link rel="stylesheet" href="/styles.css"/></head>
<body><div class="container">
  <header class="head">
    <h1>Caregiver Card — Reports</h1>
    <nav>
      <a class="btn" href="/" rel="noopener">New Report</a>
      <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
    </nav>
  </header>
  <ul class="list">${items}</ul>
</div></body></html>`);
});

app.get('/reports/:id', async (req,res)=>{
  const row = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if(!row) return res.status(404).send('Not found');

  const esc = s=>String(s||'').replace(/[&<>"]/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));
  const created = new Date(row.created_at).toLocaleString();
  const det = nameOf(row.detected_lang);
  const tgt = nameOf(row.target_lang);

  const mailSubject = encodeURIComponent(`Caregiver Card — ${row.name||''}`);
  const bodyLines = [
    `Shareable link: ${row.share_url}`,
    ``,
    `Patient: ${row.name||''} • ${row.email||''} • Blood: ${row.blood_type||''}`,
    `Emergency: ${row.emer_name||''} (${row.emer_phone||''}) ${row.emer_email||''}`,
    `Doctor: ${row.doctor_name||''} • ${row.doctor_phone||''} • ${row.doctor_fax||''} • ${row.doctor_email||''}`,
    `Pharmacy: ${row.pharmacy_name||''} • ${row.pharmacy_phone||''} • ${row.pharmacy_fax||''}`,
    ``,
    `Summary:\n${row.summary_text||''}`
  ].join('\n');
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&su=${mailSubject}&body=${encodeURIComponent(bodyLines)}`;
  const outlook = `https://outlook.office.com/mail/deeplink/compose?subject=${mailSubject}&body=${encodeURIComponent(bodyLines)}`;

  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Caregiver Card — Report</title>
<link rel="stylesheet" href="/styles.css"/>
</head>
<body>
<div class="container">
  <header class="head">
    <h1>Caregiver Card — Report</h1>
    <div class="meta"><b>Created:</b> ${esc(created)}</div>
    <div class="pillrow">
      ${row.detected_lang?`<span class="pill">Original: ${esc(det)}</span>`:''}
      ${row.target_lang?`<span class="pill">Target: ${esc(tgt)}</span>`:''}
    </div>
  </header>

  <section class="card">
    <h2>Patient & Contacts</h2>
    <div class="grid2">
      <div><b>Name:</b> ${esc(row.name)}</div>
      <div><b>Email:</b> ${row.email?`<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>`:''}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type||'')}</div>
      <div><b>Emergency:</b> ${esc(row.emer_name||'')} ${row.emer_phone?`(${esc(row.emer_phone)})`:''} ${row.emer_email?`<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}</div>
      <div><b>Doctor:</b> ${esc(row.doctor_name||'')} • ${esc(row.doctor_phone||'')} • ${esc(row.doctor_fax||'')} • ${row.doctor_email?`<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>`:''}</div>
      <div><b>Pharmacy:</b> ${esc(row.pharmacy_name||'')} • ${esc(row.pharmacy_phone||'')} • ${esc(row.pharmacy_fax||'')}</div>
    </div>
  </section>

  <section class="card">
    <h2>Summary</h2>
    <div class="dual">
      <div class="block">
        <h3>${esc(det||'Original')}</h3>
        <pre class="pre">${esc(row.summary_text||'')}</pre>
      </div>
      <div class="block">
        <h3>${esc(tgt||'Target')}</h3>
        <pre class="pre">${esc(row.translated_summary||'(no translation)')}</pre>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Transcript</h2>
    <div class="dual">
      <div class="block">
        <h3>${esc(det||'Original')}</h3>
        <pre class="pre">${esc(row.transcript||'')}</pre>
      </div>
      <div class="block">
        <h3>${esc(tgt||'Target')}</h3>
        <pre class="pre">${esc(row.translated_transcript||'(no translation)')}</pre>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Share / Print</h2>
    <div class="sharebar">
      <a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener" title="Open link">🔗 Link</a>
      <a class="btn" href="${gmail}" target="_blank" rel="noopener">📧 Gmail</a>
      <a class="btn" href="${outlook}" target="_blank" rel="noopener">📨 Outlook</a>
      <button class="btn" onclick="window.print()">🖨️ Print</button>
    </div>
    <div class="qr">
      <img src="${esc(row.qr_data_url)}" alt="QR Code"/>
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

// ---------- Start ----------
await initDB();
app.listen(PORT, ()=>console.log(`✅ Backend listening on ${PORT}`));
