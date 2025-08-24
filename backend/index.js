// backend/index.js
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import sqlite3 from "sqlite3";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o";
const JSON_MODEL = process.env.OPENAI_JSON_MODEL || "gpt-4o-mini";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Static/public root resolution (backend/public -> public -> frontend/public)
function resolvePublicDir() {
  const candidates = [
    path.join(process.cwd(), "backend", "public"),
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "frontend", "public"),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return path.join(process.cwd(), "public");
}
const PUBLIC_DIR = resolvePublicDir();

// ---------- Uploads dir (Render-friendly)
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
try {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  console.log("📁 Upload dir ready:", UPLOAD_DIR);
} catch (e) {
  console.error("❌ Could not create uploads dir:", e);
}

// ---------- Express plumbing
app.use(bodyParser.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// ---------- SQLite (sqlite3 with Promise helpers)
const dbFile = path.join(process.cwd(), "data.sqlite");
sqlite3.verbose();
const dbRaw = new sqlite3.Database(dbFile);
const db = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbRaw.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this);
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbRaw.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbRaw.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  },
  exec(sql) {
    return new Promise((resolve, reject) => {
      dbRaw.exec(sql, (err) => (err ? reject(err) : resolve()));
    });
  },
};

async function ensureSchema() {
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
    );
  `);
  // NOTE: make sure these migrations use NORMAL backticks (no escapes)
  async function addCol(name, def) {
    try {
      await db.exec(`ALTER TABLE reports ADD COLUMN ${name} ${def}`);
    } catch {
      // ignore duplicate column errors
    }
  }
  await addCol("detected_lang", "TEXT");
  await addCol("translated_summary", "TEXT");
  await addCol("meds_json", "TEXT");
  await addCol("allergies_json", "TEXT");
  await addCol("conditions_json", "TEXT");
  await addCol("vitals_json", "TEXT");
}
await ensureSchema();

// ---------- Helpers
function inferBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"]  || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}
function baseUrlFrom(req) {
  return process.env.PUBLIC_BASE_URL || inferBaseUrl(req);
}
function safeParseJSON(s, d) { try { return JSON.parse(s || ""); } catch { return d; } }
function esc(s = "") { return String(s).replace(/</g, "&lt;"); }

// ---------- OpenAI Pipelines
async function transcribeWithOpenAI(filePath, filename = "audio.webm") {
  // Try 4o-mini-transcribe then whisper-1
  try {
    console.log("🗣️ Transcribing via gpt-4o-mini-transcribe …", filename);
    const r = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-mini-transcribe",
    });
    const text = (r.text || "").trim();
    console.log("✅ Transcribed (gpt-4o-mini-transcribe) chars:", text.length);
    return text;
  } catch (err1) {
    console.warn("⚠️ gpt-4o-mini-transcribe failed; trying whisper-1. Details:", err1?.response?.data || err1?.message || err1);
    const r2 = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
    });
    const text2 = (r2.text || "").trim();
    console.log("✅ Transcribed (whisper-1) chars:", text2.length);
    return text2;
  }
}

async function callJSON(model, sys, user) {
  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
  });
  const content = resp.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(content); } catch { return {}; }
}

async function translateText(text, targetLang) {
  if (!text || !targetLang) return "";
  const sys = "You are a careful medical translator. Translate faithfully without adding or removing facts.";
  const user = `Target language: ${targetLang}\n\nText:\n${text}`;
  const resp = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.2,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }],
  });
  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// ---------- Multer storage (preserve extension)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".webm";
    const name = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  },
});
const upload = multer({ storage });

// ---------- Health / Home
app.get("/healthz", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// ---------- Upload: audio -> transcript -> extract -> persist -> link + QR
app.post("/upload", upload.single("audio"), async (req, res) => {
  let tmpFile = null;
  try {
    const id = Math.random().toString(36).slice(2, 12);
    console.log("📥 Upload received:", {
      hasFile: !!req.file,
      filePath: req.file?.path,
      originalName: req.file?.originalname,
      mime: req.file?.mimetype,
      size: req.file?.size,
    });

    const {
      name, email, emer_name, emer_phone, emer_email,
      blood_type, lang: langFromForm,
      transcript: postedTranscript, debug_transcript,
    } = req.body;

    // Accept either file or transcript (for testing)
    let transcript = (postedTranscript || debug_transcript || "").trim();
    if (!transcript) {
      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "No audio file or transcript provided. Field name must be 'audio'.",
        });
      }
      tmpFile = req.file.path;
      transcript = await transcribeWithOpenAI(req.file.path, req.file.originalname || "audio.webm");
    }

    const targetLang = (langFromForm || req.body.targetLang || "").trim();

    // Extract facts with JSON model
    const sys =
      "Extract medical facts from the text. Output JSON with keys: detected_lang (ISO-639-1), meds (array of {name, dose?, unit?, freq?, notes?}), allergies (array of string), conditions (array of string), vitals { bp? {sys, dia}, weight? {value, unit} }, blood_type? (A+, A-, B+, B-, AB+, AB-, O+, O-). If uncertain, leave fields empty.";
    const user = `Text:\n${transcript}\n\nCanadian English or French is possible. Interpret “120 over 75” as blood pressure. Preserve unknown drug tokens.`;
    let facts = await callJSON(JSON_MODEL, sys, user);
    if (!facts || typeof facts !== "object") facts = {};

    // Regex fallback (dose units, allergies, BP, weight)
    function regexFallback() {
      const meds = [];
      const medRX = /\b([A-Za-z][A-Za-z0-9\-']{2,})\b(?:[^.\n]{0,40})?\b(\d+(?:\.\d+)?)\s?(iu|mcg|µg|mg|g|ml|mL|units?)\b/gi;
      let m;
      while ((m = medRX.exec(transcript))) meds.push({ name: m[1], dose: m[2], unit: m[3] });
      const allergyRX = /\ballergic to ([^.\n]+)/i;
      const a = allergyRX.exec(transcript);
      const allergies = a ? a[1].split(/,|\band\b/).map(s => s.trim()).filter(Boolean) : [];
      const bpRX = /\b(\d{2,3})\s*(?:over|\/)\s*(\d{2,3})\b/i;
      const bpMatch = bpRX.exec(transcript);
      const bp = bpMatch ? { sys: +bpMatch[1], dia: +bpMatch[2] } : undefined;
      const wtRX = /\b(\d{2,3})\s?(kg|kilograms|kgs|lb|lbs|pounds)\b/i;
      const w = wtRX.exec(transcript);
      const weight = w ? { value: +w[1], unit: w[2].toLowerCase() } : undefined;
      return { meds, allergies, conditions: [], vitals: { bp, weight } };
    }

    if (!Array.isArray(facts.meds) && !Array.isArray(facts.medications)) {
      const f = regexFallback();
      facts.meds = f.meds;
      facts.allergies = f.allergies;
      facts.conditions = f.conditions;
      facts.vitals = f.vitals;
    }

    // Normalize
    const meds = (facts.meds || facts.medications || []).map(x => ({
      name: x.name || x.drug || "",
      dose: x.dose || x.dosage || "",
      unit: (x.unit || x.units || "").replace(/^µg$/i, "mcg"),
      freq: x.freq || x.frequency || "",
      notes: x.notes || "",
    })).filter(x => x.name);

    const allergies = Array.isArray(facts.allergies) ? facts.allergies : [];
    const conditions = Array.isArray(facts.conditions) ? facts.conditions : [];
    const vitals = facts.vitals && typeof facts.vitals === "object" ? facts.vitals : {};
    const detected_lang = (facts.detected_lang || "").trim() || "und";
    const bloodTypeFinal = (facts.blood_type && typeof facts.blood_type === "string")
      ? facts.blood_type.toUpperCase()
      : (blood_type || "");

    // Original summary (dual block source)
    const parts = [];
    if (meds.length) {
      parts.push("Medications:");
      meds.forEach(m => {
        const p = [m.name];
        if (m.dose) p.push(m.dose + (m.unit ? ` ${m.unit}` : ""));
        if (m.freq) p.push(`(${m.freq})`);
        if (m.notes) p.push(`— ${m.notes}`);
        parts.push("• " + p.join(" "));
      });
    } else {
      parts.push("Medications: none mentioned");
    }
    parts.push("");
    if (allergies.length) {
      parts.push("Allergies:");
      allergies.forEach(a => parts.push("• " + a));
    } else {
      parts.push("Allergies: none mentioned");
    }
    parts.push("");
    if (conditions.length) {
      parts.push("Conditions:");
      conditions.forEach(c => parts.push("• " + c));
    } else {
      parts.push("Conditions: none mentioned");
    }
    if (vitals?.bp?.sys && vitals?.bp?.dia) parts.push("", `Blood pressure: ${vitals.bp.sys}/${vitals.bp.dia}`);
    if (vitals?.weight?.value) parts.push(`Weight: ${vitals.weight.value} ${vitals.weight.unit || ""}`.trim());
    const originalSummary = parts.join("\n");

    // Translate if requested at creation
    let translatedTranscript = "";
    let translatedSummary = "";
    if (targetLang) {
      translatedTranscript = await translateText(transcript, targetLang);
      translatedSummary   = await translateText(originalSummary, targetLang);
    }

    // Persist
    const saveId = Math.random().toString(36).slice(2, 12);
    await db.run(
      `INSERT INTO reports
        (id, patient_name, patient_email, emer_name, emer_phone, emer_email, blood_type,
         transcript, summary, lang, translated, detected_lang, translated_summary,
         meds_json, allergies_json, conditions_json, vitals_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        saveId, name || "", email || "", emer_name || "", emer_phone || "", emer_email || "", bloodTypeFinal,
        transcript, originalSummary, targetLang || "", translatedTranscript,
        detected_lang, translatedSummary,
        JSON.stringify(meds), JSON.stringify(allergies), JSON.stringify(conditions), JSON.stringify(vitals),
      ]
    );

    const link = `${baseUrlFrom(req)}/reports/${saveId}`;
    let qr = "";
    try { qr = await QRCode.toDataURL(link); } catch (e) { console.warn("QR dataURL fallback failed:", e.message); }

    res.json({ ok: true, id: saveId, link, qr });
  } catch (e) {
    console.error("❌ Upload error:", e?.response?.data || e);
    res.status(500).json({ ok: false, error: String(e?.message || e || "Unknown server error") });
  } finally {
    // If you want to remove uploaded files immediately (you currently keep them during request)
    // try { if (tmpFile) fs.unlink(tmpFile, () => {}); } catch {}
  }
});

// ---------- QR PNG endpoint (robust QR in report)
app.get("/reports/:id/qrcode.png", async (req, res) => {
  try {
    const { id } = req.params;
    const row = await db.get("SELECT id FROM reports WHERE id = ?", [id]);
    if (!row) return res.status(404).send("Not found");
    const link = `${baseUrlFrom(req)}/reports/${id}`;
    const buf = await QRCode.toBuffer(link, { type: "png", margin: 1, width: 512 });
    res.setHeader("Content-Type", "image/png");
    res.send(buf);
  } catch (e) {
    console.error("❌ QR endpoint error:", e);
    res.status(500).send("QR generation failed");
  }
});

// ---------- Translate existing report
app.post("/reports/:id/translate", async (req, res) => {
  try {
    const id = req.params.id;
    const to = (req.body.to || req.query.to || "").trim();
    const pw = (req.body.password || req.query.password || "").trim();

    const r = await db.get("SELECT * FROM reports WHERE id = ?", [id]);
    if (!r) return res.status(404).send("Report not found");
    if (!to) return res.status(400).send("Missing target language 'to'");

    const translatedSummary = await translateText(r.summary || "", to);
    const translatedTranscript = await translateText(r.transcript || "", to);

    await db.run(
      "UPDATE reports SET lang = ?, translated = ?, translated_summary = ? WHERE id = ?",
      [to, translatedTranscript, translatedSummary, id]
    );

    const suffix = pw ? `?password=${encodeURIComponent(pw)}` : "";
    res.redirect(`/reports/${id}${suffix}`);
  } catch (e) {
    console.error("❌ Translate error:", e);
    res.status(500).send("Translation failed");
  }
});

// ---------- Admin list
app.get("/reports", async (req, res) => {
  if ((req.query.password || "") !== ADMIN_PASSWORD) {
    return res.status(401).send("Unauthorized — add ?password=...");
  }
  const rows = await db.all("SELECT id, created, patient_name FROM reports ORDER BY created DESC");
  const items = rows.map(r =>
    `<li><a href="/reports/${r.id}?password=${encodeURIComponent(ADMIN_PASSWORD)}">${esc(r.created)} — ${esc(r.patient_name || "(anon)")}</a></li>`
  ).join("");
  res.send(`
    <!doctype html><html><head>
      <meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Reports</title><link rel="stylesheet" href="/styles.css"/>
    </head><body>
      <header><h1>All Reports</h1></header>
      <main class="wrap">
        <section class="card"><h2>Reports</h2><div class="row"><ul>${items || "<li>(none yet)</li>"}</ul></div></section>
      </main>
    </body></html>
  `);
});

// ---------- View single report (dual blocks + QR)
app.get("/reports/:id", async (req, res) => {
  const r = await db.get("SELECT * FROM reports WHERE id = ?", [req.params.id]);
  if (!r) return res.status(404).send("Report not found");

  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"]  || req.headers.host || "").split(",")[0].trim();
  const base  = `${proto}://${host}`;
  const selfUrl = `${base}${req.originalUrl.split("?")[0]}`;
  const pw = (req.query.password || "").trim();
  const backHref = pw ? `${base}/reports?password=${encodeURIComponent(pw)}` : "";

  const meds = safeParseJSON(r.meds_json, []);
  const allergies = safeParseJSON(r.allergies_json, []);
  const conditions = safeParseJSON(r.conditions_json, []);
  const vitals = safeParseJSON(r.vitals_json, {});

  const medsList = meds.length
    ? `<ul>${meds.map(m =>
        `<li>${esc(m.name)}${m.dose?` — ${esc(m.dose)} ${esc(m.unit||"")}`:""}${m.freq?` (${esc(m.freq)})`:""}${m.notes?` — ${esc(m.notes)}`:""}</li>`
      ).join("")}</ul>`
    : `<div class="muted">None mentioned</div>`;

  const allergiesList = allergies.length
    ? `<ul>${allergies.map(a => `<li>${esc(a)}</li>`).join("")}</ul>`
    : `<div class="muted">None mentioned</div>`;

  const conditionsList = conditions.length
    ? `<ul>${conditions.map(c => `<li>${esc(c)}</li>`).join("")}</ul>`
    : `<div class="muted">None mentioned</div>`;

  const vitalsBlock = `
    ${vitals?.bp?.sys && vitals?.bp?.dia ? `<div><b>Blood Pressure:</b> ${vitals.bp.sys}/${vitals.bp.dia}</div>` : ""}
    ${vitals?.weight?.value ? `<div><b>Weight:</b> ${vitals.weight.value} ${vitals.weight.unit || ""}</div>` : ""}
  `;

  const translatePicker = `
    <form method="post" action="/reports/${r.id}/translate" style="display:flex;gap:8px;align-items:center;margin:8px 0;">
      <input type="hidden" name="password" value="${esc(pw)}"/>
      <label for="to" class="muted">Translate to:</label>
      <select id="to" name="to">
        <option value="fr">Français</option>
        <option value="es">Español</option>
        <option value="pt">Português</option>
        <option value="de">Deutsch</option>
        <option value="it">Italiano</option>
        <option value="ar">العربية</option>
        <option value="hi">हिन्दी</option>
        <option value="zh">中文</option>
        <option value="ja">日本語</option>
        <option value="ko">한국어</option>
      </select>
      <button class="btn btn-copy" type="submit">🌍 Translate this report</button>
    </form>`;

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
      .grid{display:grid;grid-template-columns:2fr 1fr;gap:16px}
      @media (max-width:980px){ .grid{grid-template-columns:1fr} }
      .block h3{margin:10px 0 8px}
      .kvs p{margin:4px 0}
      .qrbox{display:flex;justify-content:center;align-items:center;border:1px dashed #a0aec0;border-radius:12px;padding:12px;background:#f7fafc}
      .qrbox img{max-width:100%;height:auto}
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

        ${ (r.translated || r.translated_summary) ? "" : `<div class="row">${translatePicker}</div>` }

        <div class="row">
          <div class="grid" style="width:100%">
            <div class="block">
              <div class="kvs">
                <p><b>Created:</b> ${esc(r.created)}</p>
                <p><b>Patient:</b> ${esc(r.patient_name)} ${r.blood_type ? `(${esc(r.blood_type)})` : ""}</p>
                <p><b>Email:</b> ${r.patient_email ? `<a href="mailto:${esc(r.patient_email)}">${esc(r.patient_email)}</a>` : ""}</p>
                <p><b>Emergency:</b> ${esc(r.emer_name || "")}${r.emer_phone ? " · "+esc(r.emer_phone) : ""}${r.emer_email ? ` · <a href="mailto:${esc(r.emer_email)}">${esc(r.emer_email)}</a>` : ""}</p>
              </div>
              <hr/>

              <h3>Summary (Original${r.detected_lang?`: ${esc(r.detected_lang)}`:""})</h3>
              <pre>${esc(r.summary || "")}</pre>

              <h3>Transcript (Original)</h3>
              <pre>${esc(r.transcript || "")}</pre>

              <h3>Medications</h3>
              ${medsList}

              <h3>Allergies</h3>
              ${allergiesList}

              <h3>Conditions</h3>
              ${conditionsList}

              ${vitalsBlock}

              ${(r.translated || r.translated_summary) ? `
                <hr/>
                <h3>Summary (Translated${r.lang?`: ${esc(r.lang)}`:""})</h3>
                <pre>${esc(r.translated_summary || "")}</pre>

                <h3>Transcript (Translated)</h3>
                <pre>${esc(r.translated || "")}</pre>
              ` : ""}
            </div>

            <div class="block">
              <h3>QR Code</h3>
              <div class="qrbox">
                <img alt="QR to this report" src="/reports/${r.id}/qrcode.png"/>
              </div>
              <p class="muted" style="margin-top:8px">Scan with a phone to open this exact report.</p>
            </div>
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

// ---------- Start server
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
