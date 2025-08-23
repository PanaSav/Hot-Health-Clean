// backend/index.js — minimal stable server using only sqlite3 (no `sqlite` pkg)
import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import sqlite3 from 'sqlite3';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

// ---- Paths / app ----
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 4000;
const BASE = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Hotest';

// ---- Middleware ----
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure folders
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ---- Multer (store raw uploads) ----
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /audio|video|webm|ogg|mp4|mpeg|wav|m4a|mp3/i.test(file.mimetype)
      || /\.(webm|ogg|mp4|m4a|mp3|wav)$/i.test(file.originalname);
    cb(ok ? null : new Error(`Unsupported file: ${file.mimetype} (${file.originalname})`), ok);
  }
});

// ---- DB (sqlite3 only) ----
const dbPath = path.join(__dirname, 'hot_health.db');
const db = new sqlite3.Database(dbPath);
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      name TEXT,
      email TEXT,
      emer_name TEXT,
      emer_phone TEXT,
      emer_email TEXT,
      blood_type TEXT,
      transcript TEXT NOT NULL,
      summary TEXT,
      medications TEXT,
      allergies TEXT,
      conditions TEXT,
      detected_lang TEXT,
      target_lang TEXT,
      share_code TEXT NOT NULL
    )
  `);
});

// ---- Helpers ----
function uid(n = 22) {
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
}
function escapeHtml(s = '') {
  return s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function styles() {
  return `
  <style>
    :root{--bg:#0f1020;--fg:#f8f9ff;--muted:#a7b0c0;--card:#1a1c2c;--accent:#6ee7ff;--bord:#5ab0ff}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,Segoe UI,Roboto,Helvetica,Arial}
    a{color:var(--accent)}.wrap{max-width:960px;margin:32px auto;padding:0 16px}
    header{padding:16px 0;text-align:center;border-bottom:2px solid var(--bord)}
    h1{margin:0;font-size:24px}.muted{color:var(--muted)}
    .card{background:var(--card);border:2px solid var(--bord);border-radius:12px;padding:16px;margin:16px 0}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#222;border:1px solid var(--bord);margin-right:6px}
    pre{white-space:pre-wrap;background:#0b0c18;border:1px solid #2a2d47;padding:8px;border-radius:8px}
    .btn{background:transparent;border:1px solid var(--bord);color:var(--fg);padding:6px 10px;border-radius:8px;cursor:pointer}
  </style>`;
}
function reportHtml(r, qrDataUrl) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <title>Report ${escapeHtml(r.id)}</title><meta name="viewport" content="width=device-width,initial-scale=1">${styles()}
  </head><body><header><h1>Hot Health — Report</h1></header>
  <div class="wrap">
    <div class="card">
      <div>
        <span class="badge">${escapeHtml(new Date(r.created_at).toLocaleString())}</span>
        <span class="badge">${escapeHtml(r.blood_type || 'Blood: n/a')}</span>
        <span class="badge">${escapeHtml(r.detected_lang || 'en')}${r.target_lang ? ' → ' + escapeHtml(r.target_lang) : ''}</span>
      </div>
      <div class="muted" style="margin-top:8px">
        <strong>${escapeHtml(r.name || '')}</strong>
        &lt;<a href="mailto:${escapeHtml(r.email || '')}">${escapeHtml(r.email || '')}</a>&gt;
        ${r.emer_name ? ` • Emergency: ${escapeHtml(r.emer_name)} &lt;<a href="mailto:${escapeHtml(r.emer_email || '')}">${escapeHtml(r.emer_email || '')}</a>&gt; ${escapeHtml(r.emer_phone || '')}` : ''}
      </div>
    </div>
    <div class="card">
      <h3>Summary</h3>
      <p>${escapeHtml(r.summary || '(none)')}</p>
      <h4>Medications</h4>
      ${r.medications ? `<ul>${JSON.parse(r.medications).map(m=>`<li>${escapeHtml(m)}</li>`).join('')}</ul>` : '<p class="muted">None</p>'}
      <h4>Allergies</h4>
      ${r.allergies ? `<ul>${JSON.parse(r.allergies).map(a=>`<li>${escapeHtml(a)}</li>`).join('')}</ul>` : '<p class="muted">None</p>'}
      <h4>Conditions</h4>
      ${r.conditions ? `<ul>${JSON.parse(r.conditions).map(c=>`<li>${escapeHtml(c)}</li>`).join('')}</ul>` : '<p class="muted">None</p>'}
      <h4>Original Transcript</h4>
      <pre>${escapeHtml(r.transcript)}</pre>
      <div style="margin-top:12px">
        <a class="btn" href="${BASE}/reports?password=${encodeURIComponent(ADMIN_PASSWORD)}">Admin List</a>
        <a class="btn" href="${BASE}/reports/${r.id}/delete?password=${encodeURIComponent(ADMIN_PASSWORD)}" onclick="return confirm('Delete?')">Delete</a>
        <button class="btn" onclick="window.print()">Print</button>
      </div>
    </div>
    <div class="card">
      <h3>Share</h3>
      <p><a href="${BASE}/reports/${r.id}">${BASE}/reports/${r.id}</a></p>
      ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}" alt="QR" width="160" height="160">` : ''}
    </div>
  </div></body></html>`;
}

// ---- Basic front page (if you have public/index.html it will serve that instead) ----
app.get('/', (_req, res) => {
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  res.send(`<!doctype html><meta charset="utf-8"><title>Hot Health</title>${styles()}
  <div class="wrap"><header><h1>Hot Health — Backend</h1></header>
  <div class="card">Server running. Use your frontend to record and POST to <code>/upload</code>.</div></div>`);
});

// ---- Upload (no OpenAI here yet; stores a placeholder so app runs) ----
app.post('/upload', upload.single('audio'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded (field "audio").' });

    const id = uid(20);
    const created_at = new Date().toISOString();
    const name = req.body.name || '';
    const email = req.body.email || '';
    const emer_name = req.body.emer_name || '';
    const emer_phone = req.body.emer_phone || '';
    const emer_email = req.body.emer_email || '';
    const blood_type = req.body.blood_type || '';

    // Placeholder transcript while we stabilize runtime; replace with real STT later
    const transcript = 'Audio received (placeholder transcript).';
    const summary = '';
    const medications = JSON.stringify([]);
    const allergies = JSON.stringify([]);
    const conditions = JSON.stringify([]);
    const detected_lang = (req.body.lang || 'en');
    const target_lang = req.body.target_lang || '';
    const share_code = uid(26);

    db.run(
      `INSERT INTO reports
       (id, created_at, name, email, emer_name, emer_phone, emer_email, blood_type,
        transcript, summary, medications, allergies, conditions, detected_lang, target_lang, share_code)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, created_at, name, email, emer_name, emer_phone, emer_email, blood_type,
       transcript, summary, medications, allergies, conditions, detected_lang, target_lang, share_code],
      (err) => {
        // remove temp upload regardless
        try { if (req.file?.path) fs.unlink(req.file.path, ()=>{}); } catch {}
        if (err) {
          console.error('DB insert error:', err);
          return res.status(500).json({ ok: false, error: 'DB insert failed' });
        }
        const link = `${BASE}/reports/${id}`;
        QRCode.toDataURL(link).then(qrDataUrl => {
          res.json({ ok: true, id, link, qrDataUrl });
        }).catch(e => {
          console.warn('QR generation failed:', e?.message);
          res.json({ ok: true, id, link });
        });
      }
    );
  } catch (e) {
    console.error('UPLOAD error:', e);
    res.status(500).json({ ok: false, error: 'Upload failed' });
  }
});

// ---- Report page (HTML) ----
app.get('/reports/:id', (req, res) => {
  db.get(`SELECT * FROM reports WHERE id=?`, [req.params.id], async (err, row) => {
    if (err) return res.status(500).send('DB error');
    if (!row) return res.status(404).send('Not found');
    try {
      const link = `${BASE}/reports/${row.id}`;
      const qrDataUrl = await QRCode.toDataURL(link);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(reportHtml(row, qrDataUrl));
    } catch (e) {
      console.error('Report render error:', e);
      res.status(500).send('Render error');
    }
  });
});

// ---- Admin list (HTML) ----
app.get('/reports', (req, res) => {
  if ((req.query.password || '') !== ADMIN_PASSWORD) {
    return res.status(401).send('Unauthorized — add ?password=');
  }
  db.all(`SELECT id, created_at, name, email, blood_type, detected_lang, target_lang FROM reports ORDER BY created_at DESC LIMIT 500`, [], (err, rows) => {
    if (err) return res.status(500).send('DB error');
    const items = rows.map(r => `
      <tr>
        <td>${escapeHtml(new Date(r.created_at).toLocaleString())}</td>
        <td><a href="${BASE}/reports/${r.id}">${escapeHtml(r.id)}</a></td>
        <td>${escapeHtml(r.name || '')}</td>
        <td>${escapeHtml(r.email || '')}</td>
        <td>${escapeHtml(r.blood_type || '')}</td>
        <td>${escapeHtml(r.detected_lang || '')}</td>
        <td>${escapeHtml(r.target_lang || '')}</td>
        <td>
          <a href="${BASE}/reports/${r.id}/delete?password=${encodeURIComponent(ADMIN_PASSWORD)}" onclick="return confirm('Delete?')">Delete</a>
        </td>
      </tr>
    `).join('');
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Reports</title>${styles()}</head>
      <body><div class="wrap"><h2>Reports</h2>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">Created</th>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">ID</th>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">Name</th>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">Email</th>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">Blood</th>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">Detected</th>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">Target</th>
          <th style="text-align:left;border-bottom:1px solid #4a4a6a">Actions</th>
        </tr></thead>
        <tbody>${items || '<tr><td colspan="8" class="muted">No reports yet.</td></tr>'}</tbody>
      </table></div></body></html>`);
  });
});

// ---- Delete ----
app.get('/reports/:id/delete', (req, res) => {
  if ((req.query.password || '') !== ADMIN_PASSWORD) {
    return res.status(401).send('Unauthorized — add ?password=');
  }
  db.run(`DELETE FROM reports WHERE id=?`, [req.params.id], (err) => {
    if (err) return res.status(500).send('DB delete error');
    res.redirect(`${BASE}/reports?password=${encodeURIComponent(ADMIN_PASSWORD)}`);
  });
});

// ---- Health ----
app.get('/healthz', (_req,res)=>res.json({ ok:true }));

// ---- Start ----
app.listen(PORT, () => {
  console.log(`Backend listening on ${PORT} • Base: ${BASE}`);
});
