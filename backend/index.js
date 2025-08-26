// backend/index.js
import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import QRCode from 'qrcode';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';

// ----- Paths / env -----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Hotest';

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ----- App -----
const app = express();
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// Health/version
const APP_BUILD = process.env.RENDER_GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || 'local-dev';
app.get('/healthz', (_, res) => res.type('text').send('ok'));
app.get('/_version', (_, res) => res.json({ ok: true, build: APP_BUILD }));

// ----- Multer upload -----
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ts = Date.now();
    const rnd = Math.random().toString(36).slice(2, 8);
    const ext = path.extname(file?.originalname || '') || '.webm';
    cb(null, `${ts}-${rnd}${ext}`);
  },
});
const upload = multer({ storage });

// ----- Helpers -----
function esc(s = '') {
  return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}
function absoluteBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  return `${proto}://${host}`;
}
function safeJSON(s, d = []) { try { return JSON.parse(s); } catch { return d; } }

function parseFacts(transcript) {
  const meds = [];
  const allergies = [];
  const conditions = [];
  let bp = '';
  let weight = '';

  const mBP = transcript.match(/(\d{2,3})\s*over\s*(\d{2,3})/i);
  if (mBP) bp = `${mBP[1]}/${mBP[2]}`;

  const mW = transcript.match(/(\d{2,3})\s*(?:kg|kilograms|lb|lbs|pounds)/i);
  if (mW) weight = mW[1];

  const medRegex = /\b([A-Z][a-zA-Z\-]{2,})\s+(\d{1,4})\s*(mg|mcg|g|ml)\b/gi;
  let mm;
  while ((mm = medRegex.exec(transcript)) !== null) {
    meds.push(`${mm[1]} — ${mm[2]} ${mm[3]}`);
  }

  const allergyHints = ['dust', 'mold', 'peanut', 'pollen', 'shellfish'];
  for (const h of allergyHints) {
    if (new RegExp(`\\b${h}\\b`, 'i').test(transcript)) allergies.push(h);
  }

  if (/kidney/i.test(transcript)) conditions.push('kidney condition');

  return { medications: meds, allergies, conditions, bp, weight };
}

function renderReportHTML(row, shareUrl) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Hot Health — Report</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { --indigo:#4b0082; --aqua:#7fffd4; --blue:#0a84ff; --txt:#222; --bg:#f9fafc; }
  body { margin:0; background:var(--bg); color:var(--txt); font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif; }
  header { padding:16px 24px; border-bottom:3px solid var(--aqua); background:#fff; }
  main { max-width:860px; margin:24px auto; padding:0 16px; }
  h1 { color:var(--indigo); margin:0 0 4px; }
  .meta { font-size:14px; color:#555; display:flex; gap:16px; flex-wrap:wrap; align-items:center; }
  .card { background:#fff; border:2px solid var(--aqua); border-radius:12px; padding:16px; margin:16px 0; }
  .row { display:flex; gap:12px; flex-wrap:wrap; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .qr { text-align:center; }
  .pill { display:inline-flex; align-items:center; gap:8px; padding:4px 8px; border-radius:999px; background:#f0f5ff; border:1px solid #dbe7ff; font-size:12px; color:#234; }
  ul { margin:6px 0 0 18px; }
  a.link { color:var(--blue); text-decoration:none; }
  small.muted { color:#666; }
  .dual { display:grid; gap:16px; grid-template-columns:1fr 1fr; }
  @media (max-width:800px){ .dual { grid-template-columns:1fr; } }
</style>
</head>
<body>
<header>
  <h1>Hot Health — Report</h1>
  <div class="meta">
    <div><b>Created:</b> ${esc(row.created)}</div>
    <div class="pill">Share <a class="link" href="${esc(shareUrl)}" target="_blank" rel="noopener">link</a></div>
  </div>
</header>
<main>
  <section class="card">
    <div class="grid2">
      <div>
        <h2>Patient</h2>
        <div><b>Name:</b> ${esc(row.name)}</div>
        <div><b>Email:</b> <a class="link" href="mailto:${esc(row.email)}">${esc(row.email)}</a></div>
        <div><b>Blood:</b> ${esc(row.blood_type || 'N/A')}</div>
        <h3>Emergency Contact</h3>
        <div>${esc(row.emer_name || 'N/A')}</div>
        <div>${esc(row.emer_phone || 'N/A')}</div>
        <div><a class="link" href="mailto:${esc(row.emer_email || '')}">${esc(row.emer_email || '')}</a></div>
      </div>
      <div class="qr">
        ${row.qr_data ? `<img src="${esc(row.qr_data)}" alt="QR" />` : ''}
        <div><small class="muted">Scan on a phone or use the share link.</small></div>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Summary</h2>
    <div class="row">
      <div><b>BP:</b> ${esc(row.bp || '—')}</div>
      <div><b>Weight:</b> ${esc(row.weight || '—')}</div>
    </div>
    <div class="grid2">
      <div>
        <h3>Medications</h3>
        ${(() => {
          const meds = safeJSON(row.medications, []);
          return meds.length ? `<ul>${meds.map(m=>`<li>${esc(m)}</li>`).join('')}</ul>` : '<small class="muted">None</small>';
        })()}
        <h3>Allergies</h3>
        ${(() => {
          const a = safeJSON(row.allergies, []);
          return a.length ? `<ul>${a.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>` : '<small class="muted">None</small>';
        })()}
        <h3>Conditions</h3>
        ${(() => {
          const c = safeJSON(row.conditions, []);
          return c.length ? `<ul>${c.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>` : '<small class="muted">None</small>';
        })()}
      </div>
      <div>
        <h3>Transcript (Original${row.detected_lang ? `: ${esc(row.detected_lang)}`:''})</h3>
        <p>${esc(row.transcript || '')}</p>
        ${row.target_lang ? `
        <h3>Transcript (Translated: ${esc(row.target_lang)})</h3>
        <p>${esc(row.translated_transcript || '')}</p>` : ''}
      </div>
    </div>
  </section>
</main>
</body>
</html>`;
}

// ----- Dummy transcription (replace with OpenAI client if desired) -----
async function transcribe(filePath) {
  console.log('[AI] Dummy transcription for', path.basename(filePath));
  return {
    text: '120 over 75. Dexilant 100 mg. Candesartan 16 mg. Allergic to dust. I weigh 200 pounds.',
    lang: 'en',
  };
}

// ----- sqlite3 (no "sqlite" package) -----
let db;
function dbInit(dbFile) {
  return new Promise((resolve, reject) => {
    const handle = new sqlite3.Database(dbFile, (err) => {
      if (err) return reject(err);
      resolve(handle);
    });
  });
}
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, function (err, row) {
      if (err) return reject(err);
      resolve(row);
    });
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, function (err, rows) {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// ----- Start server (no top-level await) -----
async function start() {
  // DB init
  const dbPath = path.join(__dirname, 'data.sqlite');
  db = await dbInit(dbPath);

  // Schema
  await dbRun(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created TEXT,
      name TEXT,
      email TEXT,
      blood_type TEXT,
      emer_name TEXT,
      emer_phone TEXT,
      emer_email TEXT,
      detected_lang TEXT,
      target_lang TEXT,
      medications TEXT,
      allergies TEXT,
      conditions TEXT,
      bp TEXT,
      weight TEXT,
      transcript TEXT,
      translated_transcript TEXT,
      qr_data TEXT
    )
  `);

  // Routes that need DB

  app.get('/', (req, res) => {
    const idx = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(idx)) {
      return res.status(200).type('text').send('Backend running. Place frontend at backend/public/index.html');
    }
    res.sendFile(idx);
  });

  app.get('/reports', async (req, res) => {
    const pass = req.query.password || req.headers['x-admin-password'];
    if ((pass || '') !== ADMIN_PASSWORD) return res.status(401).type('text').send('Unauthorized — add ?password=');
    const rows = await dbAll(`SELECT id, created, name FROM reports ORDER BY created DESC LIMIT 200`);
    res.json({ ok: true, reports: rows });
  });

  app.get('/reports/:id', async (req, res) => {
    const row = await dbGet(`SELECT * FROM reports WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).type('text').send('Not found');

    const shareUrl = `${absoluteBaseUrl(req)}/reports/${row.id}`;
    if (!row.qr_data) {
      try {
        const qr = await QRCode.toDataURL(shareUrl, { margin: 1, scale: 4 });
        await dbRun(`UPDATE reports SET qr_data = ? WHERE id = ?`, [qr, row.id]);
        row.qr_data = qr;
      } catch (e) {
        console.warn('[QR] failed:', e.message);
      }
    }
    const html = renderReportHTML(row, shareUrl);
    res.type('html').send(html);
  });

  app.post('/upload', (req, res) => {
    upload.single('audio')(req, res, async (err) => {
      try {
        if (err) return res.status(400).json({ ok: false, error: 'Upload error' });
        if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });

        const name = (req.body.name || '').trim();
        const email = (req.body.email || '').trim();
        const blood = (req.body.blood_type || '').trim();
        const emer_name = (req.body.emer_name || '').trim();
        const emer_phone = (req.body.emer_phone || '').trim();
        const emer_email = (req.body.emer_email || '').trim();
        const targetLang = (req.body.lang || '').trim();

        const t = await transcribe(req.file.path);
        const transcript = t.text || '';
        const detected = t.lang || 'en';
        const facts = parseFacts(transcript);

        // Translate transcript (stub: if targetLang set, copy original)
        const translatedTranscript = targetLang ? transcript : '';

        const id = Math.random().toString(36).slice(2, 18);
        const created = new Date().toISOString();
        const shareUrl = `${absoluteBaseUrl(req)}/reports/${id}`;
        const qr = await QRCode.toDataURL(shareUrl, { margin: 1, scale: 4 });

        await dbRun(
          `INSERT INTO reports (
            id, created, name, email, blood_type,
            emer_name, emer_phone, emer_email,
            detected_lang, target_lang,
            medications, allergies, conditions, bp, weight,
            transcript, translated_transcript, qr_data
          ) VALUES (?,?,?,?, ?,?,?,?, ?,?, ?,?,?,?, ?,?,?,?)`,
          [
            id, created, name, email, blood,
            emer_name, emer_phone, emer_email,
            detected, targetLang,
            JSON.stringify(facts.medications || []),
            JSON.stringify(facts.allergies || []),
            JSON.stringify(facts.conditions || []),
            facts.bp || '', facts.weight || '',
            transcript, translatedTranscript, qr
          ]
        );

        res.json({ ok: true, id, url: shareUrl });
      } catch (e) {
        console.error('[UPLOAD] failed:', e);
        res.status(500).json({ ok: false, error: 'Internal Server Error' });
      }
    });
  });

  app.listen(PORT, () => {
    console.log(`✅ Backend listening on ${PORT} — build ${APP_BUILD}`);
  });
}

// kick off
start().catch(e => {
  console.error('[FATAL] start failed:', e);
  process.exit(1);
});
