// backend/index.js
// Caregiver Card — backend (auth, uploads, parsing, reliable mic via /transcribe, QR, reports)

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

const app  = express();
const PORT = Number(process.env.PORT || 10000);

// ---- Auth config
const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || 'caregiver-card-session';

// ---- Paths
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---- OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---- DB (sqlite3 only)
sqlite3.verbose();
const db = new sqlite3.Database(path.join(__dirname, 'data.sqlite'));
const dbRun = (sql, params=[]) => new Promise((res,rej)=>db.run(sql, params, function(e){e?rej(e):res(this);}));
const dbGet = (sql, params=[]) => new Promise((res,rej)=>db.get(sql, params, (e,row)=>e?rej(e):res(row)));
const dbAll = (sql, params=[]) => new Promise((res,rej)=>db.all(sql, params, (e,rows)=>e?rej(e):res(rows)));

async function initDB() {
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

      -- Language
      detected_lang TEXT, target_lang TEXT,

      -- Text
      transcript TEXT, translated_transcript TEXT,

      -- Summary
      medications TEXT, allergies TEXT, conditions TEXT, bp TEXT, weight TEXT,
      summary_text TEXT, translated_summary TEXT,

      -- Share
      share_url TEXT, qr_data_url TEXT
    )
  `);

  const addCols = [
    ['summary_text','TEXT'],['translated_summary','TEXT'],
    ['doctor_name','TEXT'],['doctor_address','TEXT'],['doctor_phone','TEXT'],['doctor_fax','TEXT'],['doctor_email','TEXT'],
    ['pharmacy_name','TEXT'],['pharmacy_address','TEXT'],['pharmacy_phone','TEXT'],['pharmacy_fax','TEXT']
  ];
  for (const [col, def] of addCols) {
    try { await dbRun(`ALTER TABLE reports ADD COLUMN ${col} ${def}`); } catch {}
  }
}

// ---- Middleware
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json({ limit:'10mb' }));
app.use(bodyParser.urlencoded({ extended:true, limit:'10mb' }));
app.use(express.static(PUBLIC_DIR));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webm`)
});
const upload = multer({ storage });

const jsonError = (res, code, msg) => res.status(code).json({ ok:false, error:msg });

function setSession(res, user){ res.cookie('hhsess', user, { httpOnly:true, sameSite:'lax', signed:true /*, secure:true*/ }); }
function requireAuth(req,res,next){ if(!req.signedCookies?.hhsess) return res.redirect('/login'); next(); }

const LANG_NAMES = { en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano', ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ' };
const langName = c => LANG_NAMES[c] || c || '—';
const uid = (n=20)=> crypto.randomBytes(n).toString('base64url').slice(0,n);
function getBaseUrl(req){ const e=(process.env.PUBLIC_BASE_URL||'').trim(); if(e) return e.replace(/\/+$/,''); const p=(req.headers['x-forwarded-proto']||'http').split(',')[0]; const h=req.headers['x-forwarded-host']||req.headers.host; return `${p}://${h}`; }

// ---- Parsing utilities
function sanitizePhone(s){ return (s||'').replace(/[^\d+]/g,''); }

function parsePatientFromText(t=''){
  const out = { name:'', email:'', emer_name:'', emer_phone:'', emer_email:'' };
  const s = ' '+t.replace(/\s+/g,' ').trim()+' ';
  const emailRx = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/ig;
  const emails = [...s.matchAll(emailRx)].map(m=>m[1]);
  if (emails[0]) out.email = emails[0];
  if (emails[1]) out.emer_email = emails[1];

  const phoneRx = /(\+?\d[\d\s\-().]{7,}\d)/g;
  const phones = [...s.matchAll(phoneRx)].map(m=>sanitizePhone(m[1]));
  if (phones[0]) out.emer_phone = phones[0];

  const nameRx  = /(my name is|patient name is|patient)\s+([a-z][a-z .'-]{2,})/i;
  const nm = s.match(nameRx); if (nm) out.name = nm[2].trim();

  const emerRx = /(emergency contact(?: name)? is)\s+([a-z][a-z .'-]{2,})/i;
  const em = s.match(emerRx); if (em) out.emer_name = em[2].trim();

  return out;
}

function parseStatusFromText(text=''){
  const t = text.replace(/\s+/g,' ').trim();
  const meds=[], allergies=[], conditions=[];
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)\s*(?:at|—|-|:)?\s*(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  let m; const seen=new Set();
  while((m=medRx.exec(t))!==null){ const name=m[1], dose=`${m[2]} ${m[3]}`; const key=(name+'|'+dose).toLowerCase(); if(!seen.has(key)){ meds.push(`${name} — ${dose}`); seen.add(key);} }

  const aHit = t.match(/\ballerg(?:y|ies)\b[^.?!]+/i);
  if (aHit){
    aHit[0].split(/[,;]| and /i).map(s=>s.replace(/\ballerg(?:y|ies)\b/i,'').replace(/\bto\b/ig,'').trim()).filter(Boolean)
      .forEach(x=>{ if(!allergies.includes(x)) allergies.push(x); });
  }

  const cRx = /\b(I have|I've|I’ve|diagnosed with|history of)\b([^.!?]+)/ig;
  let c; while((c=cRx.exec(t))!==null){ let ph=c[2].replace(/\b(allerg(?:y|ies)|medications?|pills?)\b/ig,'').trim(); ph=ph.replace(/^[,:;.\s-]+/,''); if(ph) conditions.push(ph); }

  let bp=null; const bpM = t.match(/\b(\d{2,3})\s*(?:\/|over|-)\s*(\d{2,3})\b/); if (bpM) bp = `${bpM[1]}/${bpM[2]}`;
  let weight=null; const wM = t.match(/\b(\d{2,3})\s*(lbs?|pounds?|kg)\b/i); if (wM) weight = wM[1] + (wM[2].toLowerCase().includes('kg')?' kg':' lbs');

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

// ---- Login
app.get('/login', (req,res)=>{
  const p = path.join(PUBLIC_DIR,'login.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  res.send(`<!doctype html><meta charset="utf-8"><body>
    <h3>Sign in</h3>
    <form method="POST" action="/login">
      <input name="userId" placeholder="User ID"><br>
      <input name="password" type="password" placeholder="Password"><br>
      <button>Sign In</button>
    </form>
  </body>`);
});
app.post('/login', bodyParser.urlencoded({extended:true}), (req,res)=>{
  const { userId, password } = req.body||{};
  if (userId===USER_ID && password===USER_PASS){ setSession(res,userId); return res.redirect('/'); }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout', (req,res)=>{ res.clearCookie('hhsess'); res.redirect('/login'); });

// Gate the app
app.use(['/', '/upload-multi', '/parse-free', '/detect-lang', '/transcribe', '/reports', '/reports/*'], requireAuth);

// Home
app.get('/', (req,res)=> res.sendFile(path.join(PUBLIC_DIR,'index.html')));

// ---- Language detect
app.post('/detect-lang', async (req,res)=>{
  try{
    const text = (req.body?.text||'').slice(0,4000);
    if (!text) return jsonError(res,400,'No text');
    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role:'user', content:`Detect language code (2 letters). If unsure return "en". Text:\n\n${text}` }]
    });
    const code = (r.choices?.[0]?.message?.content||'en').trim().toLowerCase().slice(0,5);
    res.json({ ok:true, code, name: langName(code) });
  }catch(e){ console.error(e); jsonError(res,500,'Language detection failed'); }
});

// ---- NEW: /transcribe (reliable mic path)
app.post('/transcribe', upload.single('audio'), async (req,res)=>{
  try{
    if (!req.file) return jsonError(res,400,'No file');
    const stream = fs.createReadStream(req.file.path);
    let text = '';
    try{
      const t1 = await openai.audio.transcriptions.create({ file:stream, model:'gpt-4o-mini-transcribe' });
      text = t1.text?.trim()||'';
    }catch{
      const s2 = fs.createReadStream(req.file.path);
      const t2 = await openai.audio.transcriptions.create({ file:s2, model:'whisper-1' });
      text = t2.text?.trim()||'';
    }
    res.json({ ok:true, text });
  }catch(e){ console.error(e); jsonError(res,500,'Transcription failed'); }
});

// ---- Parse free text into fields
app.post('/parse-free', async (req,res)=>{
  try{
    const text  = (req.body?.text||'').trim();
    const scope = (req.body?.scope||'status');
    if (!text) return jsonError(res,400,'No text');
    if (scope==='patient') return res.json({ ok:true, fields: parsePatientFromText(text) });
    return res.json({ ok:true, fields: parseStatusFromText(text) });
  }catch(e){ console.error(e); jsonError(res,500,'Parse failed'); }
});

// ---- Upload multi (typed + any audio already parsed client-side)
app.post('/upload-multi', upload.none(), async (req,res)=>{
  try{
    const B = req.body||{};

    const patient = {
      name:(B.name||'').trim(),
      email:(B.email||'').trim(),
      blood_type:(B.blood_type||'').trim(),
      emer_name:(B.emer_name||'').trim(),
      emer_phone:(B.emer_phone||'').trim(),
      emer_email:(B.emer_email||'').trim(),
      doctor_name:(B.doctor_name||'').trim(),
      doctor_address:(B.doctor_address||'').trim(),
      doctor_phone:(B.doctor_phone||'').trim(),
      doctor_fax:(B.doctor_fax||'').trim(),
      doctor_email:(B.doctor_email||'').trim(),
      pharmacy_name:(B.pharmacy_name||'').trim(),
      pharmacy_address:(B.pharmacy_address||'').trim(),
      pharmacy_phone:(B.pharmacy_phone||'').trim(),
      pharmacy_fax:(B.pharmacy_fax||'').trim(),
      target_lang:(B.lang||'').trim()
    };

    // status typed
    const statusTyped = {
      bp:(B.typed_bp||'').trim(),
      meds:(B.typed_meds||'').trim(),
      allergies:(B.typed_allergies||'').trim(),
      weight:(B.typed_weight||'').trim(),
      conditions:(B.typed_conditions||'').trim(),
      general:(B.typed_general||'').trim()
    };

    // build transcript from typed info
    const parts = [];
    const patBits = [];
    ['name','email','blood_type','emer_name','emer_phone','emer_email','doctor_name','doctor_address','doctor_phone','doctor_fax','doctor_email','pharmacy_name','pharmacy_address','pharmacy_phone','pharmacy_fax'].forEach(k=>{
      if (patient[k]) patBits.push(`${k.replace(/_/g,' ')}: ${patient[k]}`);
    });
    if (patBits.length) parts.push('Patient & Contacts:\n'+patBits.join('\n'));

    if (statusTyped.bp) parts.push(`Blood Pressure: ${statusTyped.bp}`);
    if (statusTyped.weight) parts.push(`Weight: ${statusTyped.weight}`);
    if (statusTyped.meds) parts.push(`Medications: ${statusTyped.meds}`);
    if (statusTyped.allergies) parts.push(`Allergies: ${statusTyped.allergies}`);
    if (statusTyped.conditions) parts.push(`Conditions: ${statusTyped.conditions}`);
    if (statusTyped.general) parts.push(`General Health Note: ${statusTyped.general}`);
    const transcript = parts.join('\n');

    if (!transcript && !patient.name && !patient.email && !patient.emer_name && !patient.emer_phone && !patient.emer_email) {
      return jsonError(res,400,'No content');
    }

    const detected_lang = 'en';
    const facts = parseStatusFromText(transcript);
    const summary_text = summarizeFacts(facts);

    let translated_transcript = '';
    let translated_summary = '';
    if (patient.target_lang) {
      const [t1,t2] = await Promise.all([
        openai.chat.completions.create({ model: process.env.OPENAI_TEXT_MODEL||'gpt-4o-mini', temperature:0.2, messages:[{role:'user',content:`Translate to ${patient.target_lang}:\n\n${transcript}`}] }),
        openai.chat.completions.create({ model: process.env.OPENAI_TEXT_MODEL||'gpt-4o-mini', temperature:0.2, messages:[{role:'user',content:`Translate to ${patient.target_lang}:\n\n${summary_text}`}] })
      ]);
      translated_transcript = t1.choices?.[0]?.message?.content?.trim()||'';
      translated_summary    = t2.choices?.[0]?.message?.content?.trim()||'';
    }

    const id = uid();
    const created_at = new Date().toISOString();
    const share_url  = `${getBaseUrl(req)}/reports/${id}`;
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
      facts.bp||'', facts.weight||'',
      summary_text, translated_summary,
      share_url, qr_data_url
    ]);

    res.json({ ok:true, id, url: share_url });
  }catch(e){ console.error(e); jsonError(res,500,'Server error'); }
});

// ---- Reports
app.get('/reports', async (req,res)=>{
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  const items = rows.map(r=>`
    <li class="report-item">
      <div class="title">Report for ${esc(r.name)||'Unknown'}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email||'')}</div>
      <div class="actions"><a class="btn" href="/reports/${esc(r.id)}" target="_blank">Open</a></div>
    </li>`).join('') || '<li class="report-item">No reports yet.</li>';

  res.send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css">
<div class="container">
  <header class="head">
    <h1>Caregiver Card — Reports</h1>
    <nav>
      <a class="btn" href="/">New Report</a>
      <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
    </nav>
  </header>
  <ul class="list">${items}</ul>
</div>`);
});

app.get('/reports/:id', async (req,res)=>{
  const row = await dbGet(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!row) return res.status(404).send('Not found');
  const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  const det = langName(row.detected_lang), tgt = langName(row.target_lang);
  const created = new Date(row.created_at).toLocaleString();

  const mailSubject = encodeURIComponent(`Caregiver Card — ${row.name||''}`);
  const body = [
    `Shareable link: ${row.share_url}`, ``,
    `Patient: ${row.name||''} • ${row.email||''} • Blood: ${row.blood_type||''}`,
    `Emergency: ${row.emer_name||''} (${row.emer_phone||''}) ${row.emer_email||''}`,
    `Doctor: ${row.doctor_name||''} • ${row.doctor_phone||''} • ${row.doctor_fax||''} • ${row.doctor_email||''}`,
    `Pharmacy: ${row.pharmacy_name||''} • ${row.pharmacy_phone||''} • ${row.pharmacy_fax||''}`, ``,
    `Summary:\n${row.summary_text||''}`
  ].join('\n');
  const gmail   = `https://mail.google.com/mail/?view=cm&fs=1&su=${mailSubject}&body=${encodeURIComponent(body)}`;
  const outlook = `https://outlook.office.com/mail/deeplink/compose?subject=${mailSubject}&body=${encodeURIComponent(body)}`;

  res.send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css">
<div class="container">
  <header class="head">
    <h1>Caregiver Card — Report</h1>
    <div class="meta"><b>Created:</b> ${esc(created)}</div>
    <div class="pillrow">
      ${row.detected_lang ? `<span class="pill">Original: ${esc(det)}</span>`:''}
      ${row.target_lang   ? `<span class="pill">Target: ${esc(tgt)}</span>`:''}
    </div>
  </header>

  <section class="card">
    <h2>Patient Details</h2>
    <div class="grid2">
      <div><b>Name:</b> ${esc(row.name)}</div>
      <div><b>Email:</b> ${row.email?`<a href="mailto:${esc(row.email)}">${esc(row.email)}</a>`:''}</div>
      <div><b>Blood Type:</b> ${esc(row.blood_type||'')}</div>
      <div><b>Emergency Contact:</b> ${esc(row.emer_name||'')} ${row.emer_phone?`(${esc(row.emer_phone)})`:''} ${row.emer_email?`<a href="mailto:${esc(row.emer_email)}">${esc(row.emer_email)}</a>`:''}</div>
      <div><b>Doctor:</b> ${esc(row.doctor_name||'')} • ${esc(row.doctor_phone||'')} • ${esc(row.doctor_fax||'')} • ${row.doctor_email?`<a href="mailto:${esc(row.doctor_email)}">${esc(row.doctor_email)}</a>`:''}</div>
      <div><b>Pharmacy:</b> ${esc(row.pharmacy_name||'')} • ${esc(row.pharmacy_phone||'')} • ${esc(row.pharmacy_fax||'')}</div>
    </div>
  </section>

  <section class="card">
    <h2>Summary</h2>
    <div class="dual">
      <div class="block"><h3>${esc(det||'Original')}</h3><pre class="pre">${esc(row.summary_text||'')}</pre></div>
      <div class="block"><h3>${esc(tgt||'Target')}</h3><pre class="pre">${esc(row.translated_summary||'(no translation)')}</pre></div>
    </div>
  </section>

  <section class="card">
    <h2>Transcript</h2>
    <div class="dual">
      <div class="block"><h3>${esc(det||'Original')}</h3><pre class="pre">${esc(row.transcript||'')}</pre></div>
      <div class="block"><h3>${esc(tgt||'Target')}</h3><pre class="pre">${esc(row.translated_transcript||'(no translation)')}</pre></div>
    </div>
  </section>

  <section class="card">
    <h2>Share / Print</h2>
    <div class="sharebar">
      <a class="btn" href="${esc(row.share_url)}" target="_blank" rel="noopener">🔗 Link</a>
      <a class="btn" href="${gmail}" target="_blank" rel="noopener">📧 Gmail</a>
      <a class="btn" href="${outlook}" target="_blank" rel="noopener">📨 Outlook</a>
      <button class="btn" onclick="window.print()">🖨️ Print</button>
    </div>
    <div class="qr">
      <img src="${esc(row.qr_data_url)}" alt="QR">
      <div class="muted">Scan on a phone or use the link button.</div>
    </div>
  </section>

  <div class="bar">
    <a class="btn" href="/">+ New Report</a>
    <a class="btn" href="/reports">Open Reports</a>
    <form method="POST" action="/logout" style="display:inline"><button class="btn" type="submit">Log out</button></form>
  </div>
</div>`);
});

// ---- Start
await initDB();
app.listen(PORT, ()=> console.log(`✅ Backend listening on ${PORT}`));
