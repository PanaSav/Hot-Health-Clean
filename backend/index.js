// backend/index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import bodyParser from "body-parser";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";

app.use(bodyParser.json());
app.use(express.static(path.join(process.cwd(), "public")));

// ---- DB ----
const db = await open({
  filename: path.join(process.cwd(), "data.sqlite"),
  driver: sqlite3.Database
});

await db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  created DATETIME DEFAULT CURRENT_TIMESTAMP,
  patient_name TEXT,
  patient_email TEXT,
  emer_name TEXT,
  emer_phone TEXT,
  emer_email TEXT,
  blood_type TEXT,
  transcript TEXT,
  summary TEXT,
  lang TEXT,
  translated TEXT
)`);

// ---- Utils ----
function inferBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}
function buildBaseUrl(req) {
  return process.env.PUBLIC_BASE_URL || inferBaseUrl(req);
}

// ---- Upload storage ----
const upload = multer({ dest: "uploads/" });

// ---- Routes ----

// Home page
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public/index.html"));
});

// Handle uploads
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    const id = Math.random().toString(36).slice(2, 12);
    const {
      name,
      email,
      emer_name,
      emer_phone,
      emer_email,
      blood_type,
      lang
    } = req.body;

    // Simulated transcription (replace with OpenAI API call in real build)
    const transcript = "Simulated transcript for testing.";
    const summary = "Parsed summary (medications, allergies, etc).";

    await db.run(
      `INSERT INTO reports (id, patient_name, patient_email, emer_name, emer_phone, emer_email, blood_type, transcript, summary, lang, translated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, email, emer_name, emer_phone, emer_email, blood_type, transcript, summary, lang, null]
    );

    const baseUrl = buildBaseUrl(req);
    const link = `${baseUrl}/reports/${id}`;
    const qr = await QRCode.toDataURL(link);

    res.json({ ok: true, id, link, qr });
  } catch (e) {
    console.error("❌ Upload error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// View a report
app.get("/reports/:id", async (req, res) => {
  const r = await db.get("SELECT * FROM reports WHERE id = ?", [req.params.id]);
  if (!r) return res.status(404).send("Report not found");

  // Build canonical URL (for Copy Link)
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"]  || req.headers.host || "").split(",")[0].trim();
  const base  = `${proto}://${host}`;
  const selfUrl = `${base}${req.originalUrl.split("?")[0]}`;

  // If admin password is present, build a back link that preserves it
  const pw = (req.query.password || "").trim();
  const backHref = pw ? `${base}/reports?password=${encodeURIComponent(pw)}` : "";

  res.send(`
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Hot Health — Report</title>
    <link rel="stylesheet" href="/styles.css"/>
    <style>
      .toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:10px 0 18px}
      .btn{padding:10px 14px;border-radius:10px;border:0;cursor:pointer;font-weight:700}
      .btn-print{background:#111;color:#fff}
      .btn-copy{background:#00d1d1;color:#073b3b}
      .btn-back{background:#6b46c1;color:#fff}
      .linkbox{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;padding:6px 8px;border-radius:8px;border:1px solid rgba(0,0,0,.1);background:#f7fafc;word-break:break-all}
      @media print {.toolbar{display:none}}
    </style>
  </head>
  <body>
    <header><h1>Hot Health — Report</h1></header>
    <main class="wrap">
      <section class="card">
        <h2>Report</h2>
        <div class="row">
          <div class="toolbar">
            ${ backHref ? `<a class="btn btn-back" href="${backHref}">↩︎ Back to All Reports</a>` : "" }
            <button class="btn btn-print" onclick="window.print()">🖨️ Print Report</button>
            <button class="btn btn-copy" id="copyBtn">📋 Copy Link</button>
          </div>
          <div class="linkbox" id="linkBox">${selfUrl}</div>
        </div>

        <div class="row">
          <div class="report-card" style="width:100%">
            <h3 style="margin-top:0">Patient</h3>
            <p><b>Name:</b> ${r.patient_name || ""}</p>
            <p><b>Email:</b> ${r.patient_email ? `<a href="mailto:${r.patient_email}">${r.patient_email}</a>` : ""}</p>
            <p><b>Emergency:</b> ${r.emer_name || ""}${r.emer_phone ? " · "+r.emer_phone : ""}${r.emer_email ? ` · <a href="mailto:${r.emer_email}">${r.emer_email}</a>` : ""}</p>
            <p><b>Blood Type:</b> ${r.blood_type || ""}</p>
            <p><b>Created:</b> ${r.created}</p>

            <hr/>

            <h3>Summary</h3>
            <pre>${(r.summary || "").replace(/</g,"&lt;")}</pre>

            <h3>Transcript</h3>
            <pre>${(r.transcript || "").replace(/</g,"&lt;")}</pre>

            ${
              r.translated
                ? `
                  <hr/>
                  <h3>Translated (${r.lang || ""})</h3>
                  <pre>${(r.translated || "").replace(/</g,"&lt;")}</pre>
                `
                : ""
            }
          </div>
        </div>
      </section>
    </main>

    <script>
      (function(){
        const btn = document.getElementById('copyBtn');
        const box = document.getElementById('linkBox');
        btn?.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(box.textContent.trim());
            btn.textContent = '✅ Copied!';
            setTimeout(()=> btn.textContent='📋 Copy Link', 1200);
          } catch {
            btn.textContent = '❌ Copy failed';
            setTimeout(()=> btn.textContent='📋 Copy Link', 1200);
          }
        });
      })();
    </script>
  </body>
  </html>
  `);
});


// Admin list
app.get("/reports", async (req, res) => {
  if ((req.query.password || "") !== ADMIN_PASSWORD) {
    return res.status(401).send("Unauthorized — add ?password=...");
  }
  const rows = await db.all("SELECT id, created, patient_name FROM reports ORDER BY created DESC");
  const links = rows.map(r => `<li><a href="/reports/${r.id}?password=${ADMIN_PASSWORD}">${r.created} — ${r.patient_name || "(anon)"}</a></li>`).join("");
  res.send(`<h1>Reports</h1><ul>${links}</ul>`);
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
