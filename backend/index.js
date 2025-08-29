// backend/index.js
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
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

const USER_ID   = process.env.APP_USER_ID   || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------- DB ----------------
let db;
async function initDB() {
  db = await open({ filename: path.join(__dirname, 'data.sqlite'), driver: sqlite3.Database });
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
      general_note TEXT,
      share_url TEXT,
      qr_data_url TEXT
    )
  `);
}

// --------------- Helpers ----------------
function uid(n=20){ return crypto.randomBytes(n).toString('base64url').slice(0,n); }
function getBaseUrl(req){
  const proto = (req.headers['x-forwarded-proto']||'http').split(',')[0];
  const host = req.headers['x-forwarded-host']||req.headers.host;
  return `${proto}://${host}`;
}
function parseFacts(text){
  const meds=[],allergies=[],conditions=[];
  const medRx=/([A-Za-z][A-Za-z0-9\-]+)[^\n]*?(?:\bat\b|—|-|:)?\s*(\d+)\s*(mg|mcg|g|ml)/gi;
  let mm; while((mm=medRx.exec(text))!==null) meds.push(`${mm[1]} — ${mm[2]} ${mm[3]}`);
  const aRx=/\ballerg(?:y|ies)|allergic to\s+([^\.]+)/gi; let aa;
  while((aa=aRx.exec(text))!==null) allergies.push(aa[1].trim());
  const cRx=/(?:condition|disease|diagnosed with|history of)\s+([^\.]+)/gi; let cc;
  while((cc=cRx.exec(text))!==null) conditions.push(cc[1].trim());
  return {medications:meds.join('; '),allergies:allergies.join('; '),conditions:conditions.join('; ')};
}

// -------------- Auth ----------------
app.use(cookieParser());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({extended:true}));

function requireAuth(req,res,next){
  if(req.cookies.user===USER_ID) return next();
  return res.redirect('/login');
}

app.get('/login',(req,res)=>{
  res.sendFile(path.join(PUBLIC_DIR,'login.html'));
});
app.post('/login',(req,res)=>{
  if(req.body.userId===USER_ID && req.body.password===USER_PASS){
    res.cookie('user',USER_ID,{httpOnly:true});
    return res.redirect('/');
  }
  res.status(401).send('Invalid credentials');
});
app.post('/logout',(req,res)=>{res.clearCookie('user');res.redirect('/login');});

// -------------- Static ----------------
app.use(express.static(PUBLIC_DIR));

// -------------- Upload ----------------
const storage = multer.diskStorage({
  destination: (_,__,cb)=>cb(null,UPLOAD_DIR),
  filename:(_,file,cb)=>cb(null,`${Date.now()}-${uid(6)}.webm`)
});
const upload=multer({storage});

app.post('/upload',requireAuth,upload.single('audio'),async(req,res)=>{
  try{
    const {name,email,blood_type,emer_name,emer_phone,emer_email,lang,
      bp_text,meds_text,allergies_text,weight_text,conditions_text,general_text} = req.body;

    let transcript=[bp_text,meds_text,allergies_text,weight_text,conditions_text,general_text]
      .filter(Boolean).join('. ');

    if(req.file){
      const stream=fs.createReadStream(req.file.path);
      const tr=await openai.audio.transcriptions.create({file:stream,model:'gpt-4o-mini-transcribe'});
      transcript=transcript+' '+(tr.text||'');
    }

    let translated='', target_lang=lang||'';
    if(target_lang){
      const rsp=await openai.chat.completions.create({
        model:'gpt-4o-mini',
        messages:[{role:'user',content:`Translate to ${target_lang}: ${transcript}`}]
      });
      translated=rsp.choices[0].message.content;
    }

    const facts=parseFacts(transcript);
    const id=uid(20),created=new Date().toISOString();
    const base=getBaseUrl(req);
    const share=`${base}/reports/${id}`;
    const qr=await QRCode.toDataURL(share);

    await db.run(`INSERT INTO reports VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[
      id,created,name,email,blood_type,emer_name,emer_phone,emer_email,
      'en',target_lang,transcript,translated||'',facts.medications,facts.allergies,facts.conditions,
      bp_text,weight_text,general_text,share,qr
    ]);

    res.json({ok:true,url:share});
  }catch(e){console.error(e);res.status(500).json({ok:false,error:'Server error'});}
});

// -------------- Reports ----------------
app.get('/',requireAuth,(req,res)=>res.sendFile(path.join(PUBLIC_DIR,'index.html')));
app.get('/reports',requireAuth,async(req,res)=>{
  const rows=await db.all('SELECT * FROM reports ORDER BY created_at DESC');
  res.send(`<html><body><h2>Reports</h2><ul>
    ${rows.map(r=>`<li><a href="/reports/${r.id}">Report for ${r.name||'Unknown'}</a></li>`).join('')}
  </ul></body></html>`);
});
app.get('/reports/:id',requireAuth,async(req,res)=>{
  const r=await db.get('SELECT * FROM reports WHERE id=?',[req.params.id]);
  if(!r) return res.status(404).send('Not found');
  res.send(`
  <html><body>
  <h1>Hot Health Report</h1>
  <p><b>Name:</b> ${r.name}</p>
  <p><b>Email:</b> ${r.email}</p>
  <h2>Summary</h2>
  <p><b>Medications:</b> ${r.medications}</p>
  <p><b>Allergies:</b> ${r.allergies}</p>
  <p><b>Conditions:</b> ${r.conditions}</p>
  <p><b>BP:</b> ${r.bp}</p>
  <p><b>Weight:</b> ${r.weight}</p>
  <h2>Transcript</h2>
  <div style="display:flex;gap:1em">
    <div><h3>Original</h3><p>${r.transcript}</p></div>
    <div><h3>${r.target_lang||'Translation'}</h3><p>${r.translated_transcript}</p></div>
  </div>
  <h2>Actions</h2>
  <a href="${r.share_url}" target="_blank">🔗 Open</a>
  <button onclick="navigator.clipboard.writeText('${r.share_url}')">📋 Copy</button>
  <a href="mailto:?subject=Hot Health Report&body=${encodeURIComponent(r.share_url)}">✉️ Email</a>
  <button onclick="window.print()">🖨️ Print</button>
  <div><img src="${r.qr_data_url}" style="max-width:150px"/></div>
  </body></html>`);
});

// -------------- Start ----------------
await initDB();
app.listen(PORT,()=>console.log('✅ Listening on',PORT));
