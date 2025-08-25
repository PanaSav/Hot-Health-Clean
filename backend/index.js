// backend/index.js — sqlite3-only edition
import express from "express";
import multer from "multer";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import sqlite3 from "sqlite3";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config ---
const PORT = Number(process.env.PORT || 4000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";
const PUBLIC_BASE_URL =
  (process.env.RENDER_EXTERNAL_URL?.trim()) ||
  (process.env.PUBLIC_BASE_URL?.trim()) ||
  `http://localhost:${PORT}`;

// --- Express ---
const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "2mb" }));

// Serve static assets from backend/public (Render-safe)
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Ensure uploads dir
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// Multer storage
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) =>
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webm`)
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
});

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- SQLite3 (promisified) ---
sqlite3.verbose();
const dbPath = path.join(__dirname, "data.db");
const db = new sqlite3.Database(dbPath);

// Promisify ops we use
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbExec = promisify(db.exec.bind(db));

// Init DB
async function initDB() {
  await dbExec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created TEXT,
      patient_name TEXT,
      patient_email TEXT,
      emer_name TEXT,
      emer_phone TEXT,
      emer_email TEXT,
      blood_type TEXT,
      transcript TEXT,
      translation TEXT,
      lang_detected TEXT,
      lang_target TEXT,
      medications TEXT,
      allergies TEXT,
      conditions TEXT,
      bp TEXT,
      weight TEXT
    );
  `);

  // add-col helper (ignore if exists)
  async function addCol(name, def) {
    try {
      await dbExec(`ALTER TABLE reports ADD COLUMN ${name} ${def}`);
    } catch {}
  }
  await addCol("lang_detected", "TEXT");
  await addCol("lang_target", "TEXT");
  await addCol("translation", "TEXT");
  await addCol("bp", "TEXT");
  await addCol("weight", "TEXT");

  console.log("✅ DB ready:", dbPath);
}

// Helpers
function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function renderTemplate(tpl, data) {
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, key) =>
    key in data ? data[key] : ""
  );
}

// Heuristic parsing
function parseHealthInfo(textRaw = "") {
  const text = textRaw.trim();
  const lower = text.toLowerCase();

  // BP
  let bp = null;
  const bpSlash = lower.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  if (bpSlash) bp = `${bpSlash[1]}/${bpSlash[2]}`;
  if (!bp) {
    const bpOver = lower.match(/\b(\d{2,3})\s*(?:over)\s*(\d{2,3})\b/);
    if (bpOver) bp = `${bpOver[1]}/${bpOver[2]}`;
  }

  // Weight
  let weight = null;
  const w = lower.match(/\b(\d{2,3})\s*(pounds|lbs|kg)\b/);
  if (w) weight = `${w[1]} ${w[2]}`;

  // Allergies
  let allergies = [];
  const idx = lower.indexOf("allergic to");
  if (idx >= 0) {
    const after = lower.slice(idx + "allergic to".length);
    const end = after.split(/[.\n]/)[0];
    allergies = end.split(/,|and/).map(s => s.trim()).filter(Boolean);
  }

  // Conditions
  let conditions = [];
  const condRegexes = [
    /\bdiagnosed with ([a-z0-9 -]+)/i,
    /\bi have (a |an )?([a-z0-9 -]+)\b/i,
    /\b([a-z0-9 -]+) condition\b/i
  ];
  for (const rx of condRegexes) {
    const m = text.match(rx);
    if (m) {
      const cap = (m[2] || m[1] || "").trim();
      if (cap && cap.length > 2) conditions.push(cap);
    }
  }
  conditions = Array.from(new Set(conditions));

  // Meds (simple)
  const meds = [];
  const medRegex = /\b([A-Z][A-Za-z0-9-]{1,})\b[^.\n,;]*\b(\d{1,4})\s*(mg|mcg|g|ml|milligrams|micrograms|grams|milliliters)?\b/gi;
  let m;
  while ((m = medRegex.exec(text))) {
    const name = m[1];
    const dose = m[2];
    const unit = (m[3] || "mg").toLowerCase();
    if (!/^\w-\[bloodtype\]/i.test(name)) {
      meds.push(`${name} — ${dose} ${unit}`);
    }
  }

  return { meds, allergies, conditions, bp, weight };
}

// Upload
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file" });

    const filePath = req.file.path;
    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ ok: false, error: "Upload missing on disk" });
    }

    const meta = {
      name: req.body.name?.trim() || "",
      email: req.body.email?.trim() || "",
      emer_name: req.body.emer_name?.trim() || "",
      emer_phone: req.body.emer_phone?.trim() || "",
      emer_email: req.body.emer_email?.trim() || "",
      blood_type: req.body.blood_type?.trim() || "",
      lang_target: (req.body.lang || "").trim()
    };

    console.log("📥 Upload:", {
      path: filePath,
      original: req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size
    });

    // Transcribe
    let transcript = "";
    try {
      const stream = fs.createReadStream(filePath);
      const tr = await openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file: stream
      });
      transcript = (tr?.text || "").trim();
      console.log("🗣️ Transcribed chars:", transcript.length);
    } catch (e) {
      console.error("❌ Transcription error:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Transcription failed" });
    }

    const { meds, allergies, conditions, bp, weight } = parseHealthInfo(transcript);

    // Optional translation
    let translation = "";
    const target = meta.lang_target;
    if (target && target !== "en") {
      try {
        const comp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          temperature: 0.2,
          messages: [
            { role: "system", content: `Translate to ${target}. Respond with only the translated text.` },
            { role: "user", content: transcript }
          ]
        });
        translation = comp?.choices?.[0]?.message?.content?.trim() || "";
      } catch (e) {
        console.warn("⚠️ Translation failed:", e?.message || e);
      }
    }

    // Insert
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    await dbRun(
      `INSERT INTO reports
       (id, created, patient_name, patient_email, emer_name, emer_phone, emer_email, blood_type,
        transcript, translation, lang_detected, lang_target, medications, allergies, conditions, bp, weight)
       VALUES (?, datetime('now'), ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?)`,
      [
        id,
        meta.name,
        meta.email,
        meta.emer_name,
        meta.emer_phone,
        meta.emer_email,
        meta.blood_type,
        transcript,
        translation,
        "auto",
        target || "",
        JSON.stringify(meds),
        JSON.stringify(allergies),
        JSON.stringify(conditions),
        bp || "",
        weight || ""
      ]
    );

    const reportUrl = `${PUBLIC_BASE_URL}/reports/${id}`;
    const qrData = await QRCode.toDataURL(reportUrl);

    res.json({ ok: true, id, reportUrl, qrData });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Report render (template or fallback)
app.get("/reports/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const row = await dbGet("SELECT * FROM reports WHERE id = ?", id);
    if (!row) return res.status(404).send("Not found");

    const meds = JSON.parse(row.medications || "[]");
    const allergies = JSON.parse(row.allergies || "[]");
    const conditions = JSON.parse(row.conditions || "[]");

    const detectedLang = row.lang_detected || "en";
    const targetLang = row.lang_target || "";
    const translatedTranscript =
      row.translation && row.translation.trim() ? row.translation : row.transcript;
    const targetLangLabel = targetLang || detectedLang;

    const shareUrl = `${PUBLIC_BASE_URL}/reports/${id}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    const tplPath = path.join(__dirname, "templates", "report.html");
    let html;

    if (fs.existsSync(tplPath)) {
      const tpl = fs.readFileSync(tplPath, "utf8");

      const medsText = meds.length ? meds.join(", ") : "None mentioned";
      const allergiesText = allergies.length ? allergies.join(", ") : "None mentioned";
      const conditionsText = conditions.length ? conditions.join(", ") : "None mentioned";

      html = renderTemplate(tpl, {
        created: esc(row.created || ""),
        shareUrl: esc(shareUrl),
        qrDataUrl: esc(qrDataUrl),

        name: esc(row.patient_name || ""),
        email: esc(row.patient_email || ""),
        blood: esc(row.blood_type || ""),
        emer_name: esc(row.emer_name || ""),
        emer_phone: esc(row.emer_phone || ""),
        emer_email: esc(row.emer_email || ""),

        medications: esc(medsText),
        allergies: esc(allergiesText),
        conditions: esc(conditionsText),
        bp: esc(row.bp || "Not provided"),
        weight: esc(row.weight || "Not provided"),

        detectedLang: esc(detectedLang),
        targetLang: esc(targetLangLabel),
        transcript: esc(row.transcript || ""),
        translatedTranscript: esc(translatedTranscript || "")
      });
    } else {
      // fallback
      html = `
      <!doctype html><html><head>
        <meta charset="utf-8"/>
        <title>Report ${esc(id)}</title>
        <link rel="stylesheet" href="/styles.css"/>
      </head><body>
        <header><h1>Hot Health — Report</h1></header>
        <main class="wrap">
          <section class="card">
            <p><b>Share Link:</b> <a href="${esc(shareUrl)}">${esc(shareUrl)}</a></p>
            <img src="${esc(qrDataUrl)}" width="160" alt="QR"/>
          </section>
          <section class="card">
            <h2>Patient</h2>
            <p>${esc(row.patient_name || "")} — <a href="mailto:${esc(row.patient_email || "")}">${esc(row.patient_email || "")}</a></p>
            <p>EC: ${esc(row.emer_name || "")} ${esc(row.emer_phone || "")} — <a href="mailto:${esc(row.emer_email || "")}">${esc(row.emer_email || "")}</a></p>
            <p>Blood: ${esc(row.blood_type || "")}</p>
          </section>
          <section class="card">
            <h2>Summary</h2>
            <p><b>Medications:</b> ${meds.map(esc).join(", ") || "None"}</p>
            <p><b>Allergies:</b> ${allergies.map(esc).join(", ") || "None"}</p>
            <p><b>Conditions:</b> ${conditions.map(esc).join(", ") || "None"}</p>
            <p><b>BP:</b> ${esc(row.bp || "Not given")} — <b>Weight:</b> ${esc(row.weight || "Not given")}</p>
          </section>
          <section class="card">
            <h2>Transcript (Original: ${esc(detectedLang)})</h2>
            <pre>${esc(row.transcript || "")}</pre>
            <h2>Transcript (Translated: ${esc(targetLangLabel)})</h2>
            <pre>${esc(translatedTranscript || "")}</pre>
          </section>
        </main>
      </body></html>`;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("Report render error:", err);
    res.status(500).send("Server error rendering report.");
  }
});

// Health
app.get("/healthz", (req, res) => res.json({ ok: true }));

// Start
await initDB();
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
  console.log(`   Public base URL: ${PUBLIC_BASE_URL}`);
});
