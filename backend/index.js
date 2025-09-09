// backend/index.js
// Caregiver Card — backend (auth, uploads, parsing, free-speech → fields, QR, reports)

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
const SESSION_SECRET = process.env.SESSION_SECRET || 'caregiver-card-session';

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- DB (sqlite3 only) ----------
sqlite3.verbose();
const db = new sqlite3.Database(path.join(__dirname, 'data.sqlite'));

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function (e){ e?reject(e):resolve(this); }));
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (e,row)=> e?reject(e):resolve(row)));
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (e,rows)=> e?reject(e):resolve(rows)));
}

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
  for (const [c, def] of addCols) {
    try { await dbRun(`ALTER TABLE reports ADD COLUMN ${c} ${def}`); } catch {}
  }
}

// ---------- Middleware ----------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json({ limit:'5mb' }));
app.use(bodyParser.urlencoded({ extended:true, limit:'5mb' }));

// Always send JSON error for API routes
function jsonError(res, code, msg) {
  res.status(code).json({ ok:false, error: msg });
}

// Auth helpers
function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly:true, sameSite:'lax', signed:true /*, secure:true*/ });
}
function requireAuth(req,res,next) {
  if (!req.signedCookies?.hhsess) return res.redirect('/login');
  next();
}

// Static (login is public; everything else gated)
app.use(express.static(PUBLIC_DIR));

// ---------- Small utils ----------
const LANG_NAMES = {
  en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano',
  ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ'
};
const langName = c => LANG_NAMES[c] || c || '—';
const uid = (n=20) => crypto.randomBytes(n).toString('base64url').slice(0,n);

function getBaseUrl(req){
  const envUrl = (process.env.PUBLIC_BASE_URL||'').trim();
  if (envUrl) return envUrl.replace(/\/+$/,'');
  const proto = (req.headers['x-forwarded-proto']||'http').split(',')[0];
  const host  = req.headers['x-forwarded-host']||req.headers.host;
  return `${proto}://${host}`;
}

// Parsing helpers
function parsePatientFromText(t=''){
  const out = { name:'', email:'', emer_name:'', emer_phone:'', emer_email:'' };
  const s = ' ' + t.replace(/\s+/g,' ').trim() + ' ';

  // emails
  const emailRx = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/ig;
  const emails = [...s.matchAll(emailRx)].map(m=>m[1]);
  if (emails[0]) out.email = emails[0];
  if (emails[1]) out.emer_email = emails[1];

  // phones
  const phoneRx = /(\+?\d[\d\s\-().]{7,}\d)/g;
  const phones = [...s.matchAll(phoneRx)].map(m=>m[1].replace(/[^\d+]/g,''));
  if (phones[0]) out.emer_phone = phones[0];

  // names (very naive - look for “my name is …” or “patient …”)
  const nameRx = /(my name is|patient name is|patient)\s+([a-z][a-z .'-]{2,})/i;
  const nm = s.match(nameRx);
  if (nm) out.name = nm[2].trim();

  const emerRx = /(emergency contact(?: name)? is)\s+([a-z][a-z .'-]{2,})/i;
  const em = s.match(emerRx);
  if (em) out.emer_name = em[2].trim();

  return out;
}

function parseStatusFromText(text=''){
  const t = text.replace(/\s+/g,' ').trim();
  const meds=[], allergies=[], conditions=[];
  // meds: "Name 20 mg" etc
  const medRx = /([A-Za-z][A-Za-z0-9\-]+)\s*(?:at|—|-|:)?\s*(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  let m; const seen=new Set();
  while((m=medRx.exec(t))!==null){ const name=m[1], dose=`${m[2]} ${m[3]}`; const key=(name+'|'+dose).toLowerCase(); if(!seen.has(key)){ meds.push(`${name} — ${dose}`); seen.add(key);} }

  const aHit = t.match(/\ballerg(?:y|ies)\b[^.?!]+/i);
  if (aHit){
    aHit[0].split(/[,;]| and /i)
      .map(s=>s.replace(/\ballerg(?:y|ies)\b/i,'').replace(/\bto\b/ig,'').trim())
      .filter(Boolean).forEach(x=>{ if(!allergies.includes(x)) allergies.push(x); });
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

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webm`)
});
const upload = multer({ storage });

// ---------- Login / Auth ----------
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

// Gate everything except login & static
app.use(['/', '/upload', '/upload-multi', '/parse-free', '/detect-lang', '/reports', '/reports/*'], requireAuth);

// ---------- Detect language (for prompt UX) ----------
app.post('/detect-lang', async (req,res)=>{
  try{
    const text = (req.body?.text||'').slice(0,4000);
    if (!text) return jsonError(res,400,'No text');
    // Use a tiny chat call; ask only for BCP-47 code
    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
      temperature: 0,
      messages: [{ role:'user', content: `Detect the language of this text. Reply ONLY with a 2-letter ISO code if possible (e.g., en, es, fr). If unsure, reply "en".\n\n${text}` }]
    });
    const code = (r.choices?.[0]?.message?.content||'en').trim().toLowerCase().slice(0,5);
    res.json({ ok:true, code, name: langName(code) });
  }catch(e){ console.error(e); jsonError(res,500,'Language detection failed'); }
});

// ---------- Parse free-speech into fields ----------
app.post('/parse-free', async (req,res)=>{
  try{
    const text  = (req.body?.text||'').trim();
    const scope = (req.body?.scope||'status'); // 'patient' | 'status'
    if (!text) return jsonError(res,400,'No text');

    if (scope==='patient'){
      const p = parsePatientFromText(text);
      return res.json({ ok:true, fields:p });
    } else {
      const s = parseStatusFromText(text);
      return res.json({ ok:true, fields:s });
    }
  }catch(e){ console.error(e); jsonError(res,500,'Parse failed'); }
});

// ---------- Home ----------
app.get('/', (req,res)=> res.sendFile(path.join(PUBLIC_DIR,'index.html')));

// ---------- Upload: multi (typed or audio) ----------
const multiFields = upload.fields([
  { name:'audio_patient', maxCount:1 },
  { name:'audio_status',  maxCount:1 },
  { name:'audio_bp', maxCount:1 },
  { name:'audio_meds', maxCount:1 },
  { name:'audio_allergies', maxCount:1 },
  { name:'audio_weight', maxCount:1 },
  { name:'audio_conditions', maxCount:1 },
  { name:'audio_general', maxCount:1 }
]);

async function transcribeIf(file){
  if (!file) return '';
  const s = fs.createReadStream(file.path);
  try{
    const t1 = await openai.audio.transcriptions.create({ file:s, model:'gpt-4o-mini-transcribe' });
    return t1.text?.trim()||'';
  }catch{
    const s2 = fs.createReadStream(file.path);
    const t2 = await openai.audio.transcriptions.create({ file:s2, model:'whisper-1' });
    return t2.text?.trim()||'';
  }
}

app.post('/upload-multi', multiFields, async (req,res)=>{
  try{
    const B = req.body||{};
    // 1) Combine typed values directly into facts base
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

    // 2) Also merge any free-speech parses the client may have already done (they post them as hidden fields)
    const preParsed = {
      // from free-speech patient
      name_auto: (B.name_auto||'').trim(),
      email_auto: (B.email_auto||'').trim(),
      emer_name_auto: (B.emer_name_auto||'').trim(),
      emer_phone_auto: (B.emer_phone_auto||'').trim(),
      emer_email_auto: (B.emer_email_auto||'').trim(),
    };

    if (!patient.name && preParsed.name_auto) patient.name = preParsed.name_auto;
    if (!patient.email && preParsed.email_auto) patient.email = preParsed.email_auto;
    if (!patient.emer_name && preParsed.emer_name_auto) patient.emer_name = preParsed.emer_name_auto;
    if (!patient.emer_phone && preParsed.emer_phone_auto) patient.emer_phone = preParsed.emer_phone_auto;
    if (!patient.emer_email && preParsed.emer_email_auto) patient.emer_email = preParsed.emer_email_auto;

    // 3) Transcribe any audio parts present
    const f = req.files||{};
    const heardPatient = await transcribeIf(f.audio_patient?.[0]);
    const heardStatus  = await transcribeIf(f.audio_status?.[0]);

    // 4) Build a transcript from parts (typed + heard)
    const parts = [];

    // Patient sub-transcript (for audit / report context)
    const patBits = [];
    ['name','email','blood_type','emer_name','emer_phone','emer_email','doctor_name','doctor_address','doctor_phone','doctor_fax','doctor_email','pharmacy_name','pharmacy_address','pharmacy_phone','pharmacy_fax'].forEach(k=>{
      if (patient[k]) patBits.push(`${k.replace(/_/g,' ')}: ${patient[k]}`);
    });
    if (heardPatient) patBits.push(`(free-speech patient) ${heardPatient}`);
    if (patBits.length) parts.push('Patient & Contacts:\n' + patBits.join('\n'));

    // Status fields (typed)
    const statusTyped = {
      bp: (B.typed_bp||'').trim(),
      meds: (B.typed_meds||'').trim(),
      allergies: (B.typed_allergies||'').trim(),
      weight: (B.typed_weight||'').trim(),
      conditions: (B.typed_conditions||'').trim(),
      general: (B.typed_general||'').trim()
    };

    // Status from heardStatus → parse into fields
    const parsedStatus = parseStatusFromText([heardStatus, statusTyped.general].filter(Boolean).join(' '));

    // Merge typed into parsed (typed wins)
    if (statusTyped.bp) parsedStatus.bp = statusTyped.bp;
    if (statusTyped.weight) parsedStatus.weight = statusTyped.weight;
    if (statusTyped.meds) parsedStatus.medications = statusTyped.meds.split(/\s*;\s*|\s*,\s*/).filter(Boolean);
    if (statusTyped.allergies) parsedStatus.allergies = statusTyped.allergies.split(/\s*;\s*|\s*,\s*/).filter(Boolean);
    if (statusTyped.conditions) parsedStatus.conditions = statusTyped.conditions.split(/\s*;\s*|\s*,\s*/).filter(Boolean);

    // Build transcript lines
    if (parsedStatus.bp) parts.push(`Blood Pressure: ${parsedStatus.bp}`);
    if (parsedStatus.weight) parts.push(`Weight: ${parsedStatus.weight}`);
    if (parsedStatus.medications?.length) parts.push(`Medications: ${parsedStatus.medications.join('; ')}`);
    if (parsedStatus.allergies?.length) parts.push(`Allergies: ${parsedStatus.allergies.join('; ')}`);
    if (parsedStatus.conditions?.length) parts.push(`Conditions: ${parsedStatus.conditions.join('; ')}`);
    if (statusTyped.general || heardStatus) parts.push(`General Health Note: ${(statusTyped.general||'')}${statusTyped.general&&heardStatus?' ':''}${heardStatus||''}`);

    const transcript = parts.join('\n');

    // If literally nothing provided, error
    if (!transcript && !patient.name && !patient.email && !patient.emer_name && !patient.emer_phone && !patient.emer_email) {
      return jsonError(res,400,'No content');
    }

    const detected_lang = 'en'; // simple default
    const summaryFacts = parseStatusFromText(transcript);
    const summary_text = summarizeFacts(summaryFacts);

    let translated_transcript = '';
    let translated_summary = '';
    if (patient.target_lang) {
      const [t1,t2] = await Promise.all([
        openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages: [{ role:'user', content: `Translate to ${patient.target_lang}:\n\n${transcript}` }]
        }),
        openai.chat.completions.create({
          model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
          temperature: 0.2,
          messages: [{ role:'user', content: `Translate to ${patient.target_lang}:\n\n${summary_text}` }]
        })
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
      (summaryFacts.medications||[]).join('; '),
      (summaryFacts.allergies||[]).join('; '),
      (summaryFacts.conditions||[]).join('; '),
      summaryFacts.bp||'', summaryFacts.weight||'',
      summary_text, translated_summary,
      share_url, qr_data_url
    ]);

    res.json({ ok:true, id, url: share_url });
  }catch(e){
    console.error(e);
    jsonError(res,500,'Server error');
  }
});

// ---------- Reports ----------
app.get('/reports', async (req,res)=>{
  const rows = await dbAll(`SELECT id, created_at, name, email FROM reports ORDER BY created_at DESC`);
  const esc = s => String(s||'').replace(/[&<>"]/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
  const items = rows.map(r=>`
    <li class="report-item">
      <div class="title">Report for ${esc(r.name)||'Unknown'}</div>
      <div class="meta">${new Date(r.created_at).toLocaleString()} • ${esc(r.email||'')}</div>
      <div class="actions"><a class="btn" href="/reports/${esc(r.id)}" target="_blank">Open</a></div>
    </li>`).join('') || '<li class="report-item">No reports yet.</li>';

  res.send(`<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css">
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
  const det = langName(row.detected_lang);
  const tgt = langName(row.target_lang);
  const created = new Date(row.created_at).toLocaleString();

  const mailSubject = encodeURIComponent(`Caregiver Card — ${row.name||''}`);
  const body = [
    `Shareable link: ${row.share_url}`,
    ``,
    `Patient: ${row.name||''} • ${row.email||''} • Blood: ${row.blood_type||''}`,
    `Emergency: ${row.emer_name||''} (${row.emer_phone||''}) ${row.emer_email||''}`,
    `Doctor: ${row.doctor_name||''} • ${row.doctor_phone||''} • ${row.doctor_fax||''} • ${row.doctor_email||''}`,
    `Pharmacy: ${row.pharmacy_name||''} • ${row.pharmacy_phone||''} • ${row.pharmacy_fax||''}`,
    ``,
    `Summary:\n${row.summary_text||''}`
  ].join('\n');
  const gmail   = `https://mail.google.com/mail/?view=cm&fs=1&su=${mailSubject}&body=${encodeURIComponent(body)}`;
  const outlook = `https://outlook.office.com/mail/deeplink/compose?subject=${mailSubject}&body=${encodeURIComponent(body)}`;

  res.send(`<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="/styles.css">
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

// ---------- Start ----------
await initDB();
app.listen(PORT, ()=> console.log(`✅ Backend listening on ${PORT}`));
