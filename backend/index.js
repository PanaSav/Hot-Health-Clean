// backend/index.js
// Hot Health Backend (auth, multi-recorders, parsing, reports)

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

const USER_ID = process.env.APP_USER_ID || 'Pana123$';
const USER_PASS = process.env.APP_USER_PASS || 'GoGoPana$';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(16).toString('hex');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------------
// Database (sqlite3 only, permanent fix)
// -------------------------
let db;
async function initDB() {
  db = await open({
    filename: path.join(__dirname, 'data.sqlite'),
    driver: sqlite3.Database,
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
      doc_name TEXT,
      doc_phone TEXT,
      doc_fax TEXT,
      doc_email TEXT,
      ph_name TEXT,
      ph_phone TEXT,
      ph_fax TEXT,
      ph_email TEXT,
      ph_addr TEXT,
      detected_lang TEXT,
      target_lang TEXT,
      transcript TEXT,
      translated_transcript TEXT,
      medications TEXT,
      allergies TEXT,
      conditions TEXT,
      bp TEXT,
      weight TEXT,
      general TEXT,
      share_url TEXT,
      qr_data_url TEXT
    );
  `);
}

// -------------------------
// Auth (cookies)
// -------------------------
app.use(cookieParser(SESSION_SECRET));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function setSession(res, user) {
  res.cookie('hhsess', user, {
    httpOnly: true,
    signed: true,
    sameSite: 'lax',
  });
}
function clearSession(res) {
  res.clearCookie('hhsess');
}

// Login/logout routes
app.get('/login', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});
app.post('/login', (req, res) => {
  const { userId, password } = req.body || {};
  if (userId === USER_ID && password === USER_PASS) {
    setSession(res, userId);
    return res.redirect('/');
  }
  res.status(401).send('<p>Invalid credentials. <a href="/login">Try again</a></p>');
});
app.post('/logout', (req, res) => {
  clearSession(res);
  res.redirect('/login');
});

// Require auth for all except login
app.use((req, res, next) => {
  if (!req.signedCookies?.hhsess && req.path !== '/login') {
    return res.redirect('/login');
  }
  next();
});

// Static frontend
app.use(express.static(PUBLIC_DIR));

// -------------------------
// Multer upload
// -------------------------
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.webm`),
});
const upload = multer({ storage });

// -------------------------
// Helpers
// -------------------------
function getBaseUrl(req) {
  const envUrl = process.env.PUBLIC_BASE_URL;
  if (envUrl) return envUrl.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}
function uid(n = 22) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
}

// Simple parser
function parseFacts(text) {
  const meds = [];
  const allergies = [];
  const conditions = [];
  let bp = null;
  let weight = null;
  let general = '';

  const bpMatch = text.match(/\b(\d{2,3})\s*[/over-]\s*(\d{2,3})\b/i);
  if (bpMatch) bp = `${bpMatch[1]}/${bpMatch[2]}`;

  const wMatch = text.match(/\b(\d{2,3})\s*(lbs?|pounds?|kg)\b/i);
  if (wMatch)
    weight =
      wMatch[1] + (wMatch[0].toLowerCase().includes('kg') ? ' kg' : ' lbs');

  // crude splits
  if (/allerg/i.test(text)) allergies.push(text);
  if (/med/i.test(text)) meds.push(text);
  if (/condition/i.test(text)) conditions.push(text);
  if (!bp && !weight && !meds.length && !allergies.length && !conditions.length)
    general = text;

  return { medications: meds, allergies, conditions, bp, weight, general };
}

// -------------------------
// Upload route (multi-audio)
// -------------------------
app.post('/upload-multi', upload.any(), async (req, res) => {
  try {
    const f = req.body || {};
    const files = req.files || [];

    // merge transcripts
    let transcript = '';
    for (const file of files) {
      if (!file.filename.endsWith('.webm')) continue;
      const stream = fs.createReadStream(file.path);
      const tr = await openai.audio.transcriptions.create({
        file: stream,
        model: 'gpt-4o-mini-transcribe',
      });
      transcript += '\n' + (tr.text || '');
    }

    // optional translation
    let translated = '';
    if (f.lang) {
      const rsp = await openai.chat.completions.create({
        model: process.env.OPENAI_TEXT_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: `Translate into ${f.lang}:\n\n${transcript}`,
          },
        ],
        temperature: 0.2,
      });
      translated = rsp.choices?.[0]?.message?.content?.trim() || '';
    }

    const facts = parseFacts(transcript);
    const id = uid(20);
    const created_at = new Date().toISOString();
    const baseUrl = getBaseUrl(req);
    const shareUrl = `${baseUrl}/reports/${id}`;
    const qr_data_url = await QRCode.toDataURL(shareUrl);

    await db.run(
      `INSERT INTO reports 
      (id, created_at, name, email, blood_type,
       emer_name, emer_phone, emer_email,
       doc_name, doc_phone, doc_fax, doc_email,
       ph_name, ph_phone, ph_fax, ph_email, ph_addr,
       detected_lang, target_lang, transcript, translated_transcript,
       medications, allergies, conditions, bp, weight, general,
       share_url, qr_data_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        created_at,
        f.name,
        f.email,
        f.blood_type,
        f.emer_name,
        f.emer_phone,
        f.emer_email,
        f.doc_name,
        f.doc_phone,
        f.doc_fax,
        f.doc_email,
        f.ph_name,
        f.ph_phone,
        f.ph_fax,
        f.ph_email,
        f.ph_addr,
        'auto',
        f.lang || '',
        transcript,
        translated,
        facts.medications.join('; '),
        facts.allergies.join('; '),
        facts.conditions.join('; '),
        facts.bp || '',
        facts.weight || '',
        facts.general || '',
        shareUrl,
        qr_data_url,
      ]
    );

    res.json({ ok: true, url: shareUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------------
// Reports list
// -------------------------
app.get('/reports', async (req, res) => {
  const rows = await db.all(`SELECT id,created_at,name,email FROM reports ORDER BY created_at DESC`);
  const baseUrl = getBaseUrl(req);
  const items = rows
    .map(
      (r) => `
      <li><b>${r.name || 'Unknown'}</b> —
        ${new Date(r.created_at).toLocaleString()} —
        <a href="${baseUrl}/reports/${r.id}" target="_blank">Open</a>
      </li>`
    )
    .join('');
  res.send(`<h1>Reports</h1><ul>${items || '<li>No reports</li>'}</ul>`);
});

// -------------------------
// Single report
// -------------------------
app.get('/reports/:id', async (req, res) => {
  const r = await db.get(`SELECT * FROM reports WHERE id=?`, [req.params.id]);
  if (!r) return res.status(404).send('Not found');

  res.send(`
    <h1>Hot Health Report</h1>
    <p><b>Created:</b> ${new Date(r.created_at).toLocaleString()}</p>
    <div><img src="${r.qr_data_url}" width="150"/></div>
    <h2>Patient</h2>
    <p>${r.name} (${r.email})</p>
    <h2>Summary</h2>
    <div style="display:flex;gap:20px">
      <div><h3>Original</h3>
        <p>BP: ${r.bp}<br/>Weight: ${r.weight}<br/>
        Medications: ${r.medications}<br/>Allergies: ${r.allergies}<br/>
        Conditions: ${r.conditions}<br/>General: ${r.general}</p>
      </div>
      <div><h3>${r.target_lang || 'Translated'}</h3>
        <p>${r.translated_transcript || '(none)'}</p>
      </div>
    </div>
    <h2>Transcript</h2>
    <pre>${r.transcript}</pre>
    <div style="margin-top:20px">
      <a href="mailto:?subject=Hot%20Health%20Report&body=${encodeURIComponent(r.share_url)}">📧 Email</a>
      <a href="${r.share_url}" target="_blank">🔗 Link</a>
      <button onclick="window.print()">🖨 Print</button>
    </div>
  `);
});

// -------------------------
await initDB();
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
