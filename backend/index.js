// backend/index.js
import express from "express";
import multer from "multer";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// ✅ Serve static frontend assets from backend/public
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// === DB setup ===
const db = await open({
  filename: path.join(__dirname, "data.db"),
  driver: sqlite3.Database
});

// auto-create reports table
await db.exec(`
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
)`);

// === Middleware ===
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ✅ FIXED: Serve public files (works on Render and local)
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// === Multer setup ===
const upload = multer({ dest: path.join(__dirname, "../uploads") });

// === Helpers ===
function parseHealthInfo(text) {
  let meds = [];
  let allergies = [];
  let conditions = [];
  let bp = null;
  let weight = null;

  const lower = text.toLowerCase();

  const bpMatch = lower.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (bpMatch) bp = `${bpMatch[1]}/${bpMatch[2]}`;

  const weightMatch = lower.match(/(\d{2,3})\s*(pounds|lbs|kg)/);
  if (weightMatch) weight = `${weightMatch[1]} ${weightMatch[2]}`;

  if (lower.includes("allergic to")) {
    const part = lower.split("allergic to")[1];
    if (part) allergies = part.split(/,|and/).map(s => s.trim()).filter(Boolean);
  }
  if (lower.includes("condition")) {
    conditions.push("Condition mentioned");
  }

  const medRegex = /\b([A-Za-z][A-Za-z0-9-]*)\b[^.,\n]*\b(\d+)\s*(mg|milligrams)?/g;
  let m;
  while ((m = medRegex.exec(text))) {
    meds.push(`${m[1]} — ${m[2]} ${m[3] || "mg"}`);
  }

  return { meds, allergies, conditions, bp, weight };
}

// === Upload endpoint ===
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file" });

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const filePath = req.file.path;
    const fileStream = fs.createReadStream(filePath);

    const transcriptResp = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      file: fileStream
    });
    const transcript = transcriptResp.text;

    const { meds, allergies, conditions, bp, weight } = parseHealthInfo(transcript);

    const targetLang = req.body.lang || "";
    let translation = "";
    if (targetLang && targetLang !== "en") {
      const translateResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: `Translate this to ${targetLang}.` },
          { role: "user", content: transcript }
        ]
      });
      translation = translateResp.choices[0].message.content;
    }

    await db.run(
      `INSERT INTO reports 
      (id, created, patient_name, patient_email, emer_name, emer_phone, emer_email, blood_type, transcript, translation, lang_detected, lang_target, medications, allergies, conditions, bp, weight) 
      VALUES (?, datetime('now'), ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        req.body.name || "",
        req.body.email || "",
        req.body.emer_name || "",
        req.body.emer_phone || "",
        req.body.emer_email || "",
        req.body.blood_type || "",
        transcript,
        translation,
        "en",
        targetLang,
        JSON.stringify(meds),
        JSON.stringify(allergies),
        JSON.stringify(conditions),
        bp,
        weight
      ]
    );

    const reportUrl = `${PUBLIC_BASE_URL}/reports/${id}`;
    const qrData = await QRCode.toDataURL(reportUrl);

    res.json({ ok: true, id, reportUrl, qrData });
  } catch (err) {
    console.error("Upload error", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// === Reports page ===
app.get("/reports/:id", async (req, res) => {
  const id = req.params.id;
  const row = await db.get("SELECT * FROM reports WHERE id = ?", id);
  if (!row) return res.status(404).send("Not found");

  const meds = JSON.parse(row.medications || "[]");
  const allergies = JSON.parse(row.allergies || "[]");
  const conditions = JSON.parse(row.conditions || "[]");

  const html = `
  <html>
    <head>
      <title>Report ${id}</title>
      <link rel="stylesheet" href="/styles.css">
    </head>
    <body>
      <h1>Health Report</h1>
      <p><strong>Share Link:</strong> <a href="${PUBLIC_BASE_URL}/reports/${id}">${PUBLIC_BASE_URL}/reports/${id}</a></p>
      <img src="${await QRCode.toDataURL(`${PUBLIC_BASE_URL}/reports/${id}`)}" width="200"/>
      <h2>Patient</h2>
      <p>${row.patient_name} (${row.patient_email})</p>
      <p>Emergency: ${row.emer_name} ${row.emer_phone} (${row.emer_email})</p>
      <p>Blood: ${row.blood_type}</p>
      <h2>Summary</h2>
      <p><strong>Medications:</strong> ${meds.join(", ") || "None"}</p>
      <p><strong>Allergies:</strong> ${allergies.join(", ") || "None"}</p>
      <p><strong>Conditions:</strong> ${conditions.join(", ") || "None"}</p>
      <p><strong>BP:</strong> ${row.bp || "Not given"} | <strong>Weight:</strong> ${row.weight || "Not given"}</p>
      <h2>Transcript (Original)</h2>
      <pre>${row.transcript}</pre>
      ${
        row.translation
          ? `<h2>Translated (${row.lang_target})</h2><pre>${row.translation}</pre>`
          : ""
      }
    </body>
  </html>
  `;

  res.send(html);
});

// === Start server ===
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
