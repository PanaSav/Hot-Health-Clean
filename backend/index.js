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
const PORT = process.env.PORT || 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o";       // summaries/translations
const JSON_MODEL = process.env.OPENAI_JSON_MODEL || "gpt-4o-mini";  // JSON extraction

// ---------- Middleware / static ----------
app.use(bodyParser.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), "public")));

// ---------- DB (sqlite3 only, with small promise wrappers) ----------
const dbFile = path.join(process.cwd(), "data.sqlite");
sqlite3.verbose();
const dbRaw = new sqlite3.Database(dbFile);

const db = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      dbRaw.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve(this); // has .lastID, .changes
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
  }
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

  async function addCol(name, def) { try { await db.exec(\`ALTER TABLE reports ADD COLUMN \${name} \${def}\`); } catch {} }
  await addCol("detected_lang", "TEXT");
  await addCol("translated_summary", "TEXT");
  await addCol("meds_json", "TEXT");
  await addCol("allergies_json", "TEXT");
  await addCol("conditions_json", "TEXT");
  await addCol("vitals_json", "TEXT");
}
await ensureSchema();

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribeWithOpenAI(filePath, filename = "audio.webm") {
  // Try gpt-4o-mini-transcribe first, fallback to whisper-1
  try {
    const r = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "gpt-4o-mini-transcribe"
    });
    return (r.text || "").trim();
  } catch {
    const r2 = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1"
    });
    return (r2.text || "").trim();
  }
}

async function callJSON(model, sys, user) {
  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user }
    ]
  });
  return JSON.parse(resp.choices[0].message.content || "{}");
}

async function translateText(text, targetLang) {
  if (!text || !targetLang) return "";
  const sys = "You are a careful medical translator. Translate faithfully without adding or removing facts.";
  const user = `Target language: ${targetLang}\n\nText:\n${text}`;
  const resp = await openai.chat.completions.create({
    model: TEXT_MODEL,
    temperature: 0.2,
    messages: [{ role: "system", content: sys }, { role: "user", content: user }]
  });
  return resp.choices[0].message.content?.trim() || "";
}

function safeParseJSON(s, d) { try { return JSON.parse(s || ""); } catch { return d; } }
function esc(s = "") { return String(s).replace(/</g, "&lt;"); }

function inferBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"]  || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}
function baseUrlFrom(req) {
  return process.env.PUBLIC_BASE_URL || inferBaseUrl(req);
}

// ---------- Upload storage ----------
const upload = multer({ dest: "uploads/" });

// ---------- Health ----------
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ---------- Home ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public/index.html"));
});

// ---------- Upload: record -> transcribe -> extract -> save -> link/QR ----------
app.post("/upload", upload.single("audio"), async (req, res) => {
  let tmpPathToDelete = null;
  try {
    const id = Math.random().toString(36).slice(2, 12);
    const {
      name, email, emer_name, emer_phone, emer_email,
      blood_type, lang: langFromForm,
      transcript: postedTranscript,
      debug_transcript
    } = req.body;

    // 1) transcript
    let transcript = (postedTranscript || debug_transcript || "").trim();
    if (!transcript) {
      if (!req.file || !req.file.path) {
        return res.status(400).json({ ok: false, error: "No audio or transcript provided." });
      }
      tmpPathToDelete = req.file.path;
      transcript = await transcribeWithOpenAI(req.file.path, req.file.originalname || "audio.webm");
    }

    // 2) target language (single declaration; no duplicates)
    const targetLangRaw = langFromForm || req.body.targetLang || "";
    const targetLang = targetLangRaw.trim();

    // 3) extract facts
    const sys =
      "Extract medical facts from the text. Output JSON with keys: detected_lang (ISO-639-1), meds (array of {name, dose?, unit?, freq?, notes?}), allergies (array of string), conditions (array of string), vitals { bp? {sys, dia}, weight? {value, unit} }, blood_type? (A+, A-, B+, B-, AB+, AB-, O+, O-). If uncertain, leave fields empty.";
    const user =
      `Text:\n${transcript}\n\nThe user may be Canadian English or French. Recognize expressions like "120 over 75" for blood pressure. Include generic/brand medication names; preserve unknown tokens as-is.`;

    let facts = {};
    try { facts = await callJSON(JSON_MODEL, sys, user); }
    catch { facts = {}; }

    // 4) fallback regex if meds missing
    function regexFallback() {
      const meds = [];
      const medRX = /\b([A-Za-z][A-Za-z0-9\-']{2,})\b(?:[^.\n]{0,40})?\b(\d+(?:\.\d+)?)\s?(iu|mcg|µg|mg|g|ml|mL|units?)\b/gi;
      let m;
      while ((m = medRX.exec(transcript))) {
        meds.push({ name: m[1], dose: m[2], unit: m[3] });
      }
      const allergyRX = /\ballergic to ([^.\n]+)/i;
      const a = allergyRX.exec(transcript);
      const allergies = a ? a[1].split(/,|\band\b/).map(s => s.trim()).filter(Boolean) : [];
      const bpRX = /\b(\d{2,3})\s*(?:over|\/)\s*(\d{2,3})\b/i;
      const bpMatch = bpRX.exec(transcript);
      const bp = bpMatch ? { sys: +bpMatch[1], dia: +bpMatch[2] } : undefined;
      const wtRX = /\b(\d{2,3})\s?(kg|kilograms|lbs|pounds)\b/i;
      const w = wtRX.exec(transcript);
      const weight = w ? { value: +w[1], unit: w[2].toLowerCase() } : undefined;
      return { meds, allergies, conditions: [], vitals: { bp, weight } };
    }

    if (!facts || typeof facts !== "object") facts = {};
    if (!Array.isArray(facts.meds) && !Array.isArray(facts.medications)) {
      const f = regexFallback();
      facts.meds = f.meds;
      facts.allergies = f.allergies;
      facts.conditions = f.conditions;
      facts.vitals = f.vitals;
    }

    // 5) normalize
    const meds = (facts.meds || facts.medications || []).map(x => ({
      name: x.name || x.drug || "",
      dose: x.dose || x.dosage || "",
      unit: (x.unit || x.units || "").replace(/^µg$/i, "mcg"),
      freq: x.freq || x.frequency || "",
      notes: x.notes || ""
    })).filter(x => x.name);

    const allergies = Array.isArray(facts.allergies) ? facts.allergies : [];
    const conditions = Array.isArray(facts.conditions) ? facts.conditions : [];
    const vitals = facts.vitals && typeof facts.vitals === "object" ? facts.vitals : {};
    const detected_lang = (facts.detected_lang || "").trim() || "und";

    const bloodTypeFinal = (facts.blood_type && typeof facts.blood_type === "string")
      ? facts.blood_type.toUpperCase()
      : (blood_type || "");

    // 6) original summary
    const lines = [];
    if (meds.length) {
      lines.push("Medications:");
      meds.forEach(m => {
        const parts = [m.name];
        if (m.dose) parts.push(m.dose + (m.unit ? ` ${m.unit}` : ""));
        if (m.freq) parts.push(`(${m.freq})`);
        if (m.notes) parts.push(`— ${m.notes}`);
        lines.push("• " + parts.join(" "));
      });
    } else {
      lines.push("Medications: none mentioned");
    }

    lines.push("");
    if (allergies.length) {
      lines.push("Allergies:");
      allergies.forEach(a => lines.push("• " + a));
    } else {
      lines.push("Allergies: none mentioned");
    }

    lines.push("");
    if (conditions.length) {
      lines.push("Conditions:");
      conditions.forEach(c => lines.push("• " + c));
    } else {
      lines.push("Conditions: none mentioned");
    }

    if (vitals?.bp?.sys && vitals?.bp?.dia) {
      lines.push("");
      lines.push(`Blood pressure: ${vitals.bp.sys}/${vitals.bp.dia}`);
    }
    if (vitals?.weight?.value) {
      lines.push(`Weight: ${vitals.weight.value} ${vitals.weight.unit || ""}`.trim());
    }

    const originalSummary = lines.join("\n");

    // 7) translate if requested
    let translatedTranscript = "";
    let translatedSummary = "";
    if (targetLang) {
      translatedTranscript = await translateText(transcript, targetLang);
      translatedSummary   = await translateText(originalSummary, targetLang);
    }

    // 8) save
    await db.run(
      `INSERT INTO reports
        (id, patient_name, patient_email, emer_name, emer_phone, emer_email, blood_type,
         transcript, summary, lang, translated, detected_lang, translated_summary,
         meds_json, allergies_json, conditions_json, vitals_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, name || "", email || "", emer_name || "", emer_phone || "", emer_email || "", bloodTypeFinal,
        transcript, originalSummary, targetLang || "", translatedTranscript,
        detected_lang, translatedSummary,
        JSON.stringify(meds), JSON.stringify(allergies), JSON.stringify(conditions), JSON.stringify(vitals)
      ]
    );

    // 9) link + QR
    const link = `${baseUrlFrom(req)}/reports/${id}`;
    const qr = await QRCode.toDataURL(link);
    res.json({ ok: true, id, link, qr });
  } catch (e) {
    console.error("❌ Upload error:", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    try { if (tmpPathToDelete) fs.unlink(tmpPathToDelete, () => {}); } catch {}
  }
});

// ---------- Translate existing report ----------
app.post("/reports/:id/translate", async (req, res) => {
  try {
    const id = req.params.id;
    const toRaw = (req.body.to || req.query.to || "");
    const to = toRaw.trim(); // single declaration
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

// ---------- List reports (admin) ----------
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

// ---------- View single report (dual blocks + translate UI) ----------
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
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
      @media (max-width:860px){ .grid{grid-template-columns:1fr} }
      .block h3{margin:10px 0 8px}
      .kvs p{margin:4px 0}
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
          <div class="report-card" style="width:100%">
            <div class="kvs">
              <p><b>Created:</b> ${esc(r.created)}</p>
              <p><b>Patient:</b> ${esc(r.patient_name)} ${r.blood_type ? `(${esc(r.blood_type)})` : ""}</p>
              <p><b>Email:</b> ${r.patient_email ? `<a href="mailto:${esc(r.patient_email)}">${esc(r.patient_email)}</a>` : ""}</p>
              <p><b>Emergency:</b> ${esc(r.emer_name || "")}${r.emer_phone ? " · "+esc(r.emer_phone) : ""}${r.emer_email ? ` · <a href="mailto:${esc(r.emer_email)}">${esc(r.emer_email)}</a>` : ""}</p>
            </div>
            <hr/>

            <div class="grid">
              <div class="block">
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
              </div>

              ${ (r.translated || r.translated_summary) ? `
              <div class="block">
                <h3>Summary (Translated${r.lang?`: ${esc(r.lang)}`:""})</h3>
                <pre>${esc(r.translated_summary || "")}</pre>

                <h3>Transcript (Translated)</h3>
                <pre>${esc(r.translated || "")}</pre>

                <h3>Medications (Translated)</h3>
                ${medsList}

                <h3>Allergies (Translated)</h3>
                ${allergiesList}

                <h3>Conditions (Translated)</h3>
                ${conditionsList}
              </div>` : "" }
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

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
