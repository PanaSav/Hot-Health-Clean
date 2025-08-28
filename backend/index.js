// backend/index.js
// Backend: login/auth, upload, transcription+translation, QR, reports

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

// -------------------------
// Setup
// -------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 10000);

const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// Database (sqlite3 only, simpler)
// -------------------------
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const db = await open({
  filename: path.join(__dirname, 'data.sqlite'),
  driver: sqlite3.Database
});

await db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created_at TEXT,
  name TEXT,
  email TEXT,
  blood_type TEXT,
  emer_name TEXT,
  emer_phone TEXT,
  emer_email TEXT,
  detected_lang TEXT,
  target_lang TEXT,
  transcript TEXT,
  translated_transcript TEXT,
  medications TEXT,
  allergies TEXT,
  conditions TEXT,
  bp TEXT,
  weight TEXT,
  share_url TEXT,
  qr_data_url TEXT
)`);

// -------------------------
// Middleware
// -------------------------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

function setSession(res, user) {
  res.cookie('hhsess', user, { httpOnly: true, signed: true, sameSite: 'lax' });
}
function requireAuth(req,res,next) {
  if (!req.signedCookies?.hhsess) return res.redirect('/login');
  next();
}

// -------------------------
// Helpers
// -------------------------
function getBaseUrl(req) {
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl && /^https?:\/\//i.test(envUrl)) return envUrl.replace(/\/+$/,'');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}
function uid(n=22) { return crypto.randomBytes(n).toString('base64url').slice(0,n); }

// -------------------------
// Multer
// -------------------------
const storage = multer.diskStorage({
  destination: (_,__,cb)=>cb(null,UPLOAD_DIR),
  filename: (_,file,cb)=>cb(null,`${Date.now()}-${uid(6)}.webm`)
});
const upload = multer({ storage });

// -------------------------
// Login
// -------------------------
app.get('/login',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'login.html')));
app.post('/login',bodyParser.urlencoded({extended:true}),(req,res)=>{
  const { userId,password } = req.body||{};
  if (userId===USER_ID && password===USER_PASS){ setSession(res,userId); return res.redirect('/'); }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout',(req,res)=>{ res.clearCookie('hhsess'); res.redirect('/login'); });

// -------------------------
// Routes
// -------------------------
app.use(['/', '/upload', '/reports', '/reports/*'], requireAuth);

// Home
app.get('/',(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));

// Upload → Transcribe → Save
app.post('/upload',upload.single('audio'),async(req,res)=>{
  try {
    if (!req.file) return res.status(400).json({ok:false,error:'No file'});
    const { name='', email='', emer_name='', emer_phone='', emer_email='', blood_type='', lang='' } = req.body||{};

    // Transcribe
    const stream = fs.createReadStream(req.file.path);
    let transcript='';
    try {
      const tr = await openai.audio.transcriptions.create({ file:stream, model:'gpt-4o-mini-transcribe' });
      transcript = tr.text?.trim() || '';
    } catch(e) { transcript=''; }

    const detected_lang='EN';
    let translated='', target_lang=(lang||'').trim();
    if(target_lang){
      const rsp=await openai.chat.completions.create({
        model:'gpt-4o-mini',
        messages:[{role:'user',content:`Translate this to ${target_lang}: ${transcript}`}]
      });
      translated=rsp.choices?.[0]?.message?.content?.trim()||'';
    }

    const id=uid(18), created_at=new Date().toISOString();
    const baseUrl=getBaseUrl(req), shareUrl=`${baseUrl}/reports/${id}`;
    const qr=await QRCode.toDataURL(shareUrl);

    await db.run(`
      INSERT INTO reports (id,created_at,name,email,blood_type,emer_name,emer_phone,emer_email,
        detected_lang,target_lang,transcript,translated_transcript,medications,allergies,conditions,bp,weight,share_url,qr_data_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,created_at,name,email,blood_type,emer_name,emer_phone,emer_email,
      detected_lang,target_lang,transcript,translated,'','','','','',shareUrl,qr]);

    res.json({ok:true,url:shareUrl});
  } catch(err){ console.error(err); res.status(500).json({ok:false,error:'Server error'}); }
});

// Reports list
app.get('/reports',async(req,res)=>{
  const rows=await db.all(`SELECT id,created_at,name,email FROM reports ORDER BY created_at DESC`);
  const baseUrl=getBaseUrl(req);
  res.send(`<html><body><h1>Reports</h1><ul>${
    rows.map(r=>`<li>${r.name||'Unknown'} — <a href="${baseUrl}/reports/${r.id}" target="_blank">Open</a></li>`).join('')
  }</ul><a href="/">+ New Report</a></body></html>`);
});

// Single report
app.get('/reports/:id',async(req,res)=>{
  const row=await db.get(`SELECT * FROM reports WHERE id=?`,[req.params.id]);
  if(!row) return res.status(404).send('Not found');
  res.send(`<html><body><h1>Report for ${row.name||'Unknown'}</h1>
    <p><b>Email:</b> ${row.email||''}</p>
    <p><b>Transcript:</b> ${row.transcript||''}</p>
    <p><b>${row.target_lang||'Translated'}:</b> ${row.translated_transcript||''}</p>
    <div><img src="${row.qr_data_url}" width="120"/></div>
    <a href="/">New</a> | <a href="/reports">All</a></body></html>`);
});

// -------------------------
// Start
// -------------------------
app.listen(PORT,()=>console.log(`✅ Backend listening on ${PORT}`));
