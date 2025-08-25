// backend/index.js
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

const PORT = Number(process.env.PORT || 4000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";
const PUBLIC_BASE_URL =
  (process.env.RENDER_EXTERNAL_URL?.trim()) ||
  (process.env.PUBLIC_BASE_URL?.trim()) ||
  `http://localhost:${PORT}`;

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "2mb" }));

// Static frontend
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

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

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// SQLite3 (promisified)
sqlite3.verbose();
const dbPath = path.join(__dirname, "data.db");
const db = new sqlite3.Database(dbPath);
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
  console.log("✅ DB ready:", dbPath);
}

// Esc + template
function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function renderTemplate(tpl, data) {
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) => (k in data ? data[k] : ""));
}

// —— Parsing helpers ————————————————————————————————————————————
const NOT_CONDITION = new Set([
  "three medications","medications","medication","medicine","meds",
  "allergies","allergy","allergic","mold","dust"
]);
function splitList(s) {
  return s.split(/,| and |\band\b/gi).map(x => x.trim()).filter(Boolean);
}
function normalizeUnit(u) {
  if (!u) return "mg";
  u = u.toLowerCase();
  if (u === "milligrams") return "mg";
  if (u === "grams") return "g";
  if (u === "micrograms") return "mcg";
  if (u === "milliliters") return "ml";
  return u;
}

function parseHealthInfo(textRaw = "") {
  const text = textRaw.trim();
  const lower = text.toLowerCase();

  // BP: "120/75" or "120 over 75"
  let bp = null;
  const mSlash = lower.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/);
  const mOver  = lower.match(/\b(\d{2,3})\s*over\s*(\d{2,3})\b/);
  if (mSlash) bp = `${mSlash[1]}/${mSlash[2]}`;
  else if (mOver) bp = `${mOver[1]}/${mOver[2]}`;

  // Weight
  let weight = null;
  const mW = lower.match(/\b(\d{2,3})\s*(pounds|lbs|kg)\b/);
  if (mW) weight = `${mW[1]} ${mW[2]}`;

  // Allergies
  let allergies = [];
  const mAll = lower.match(/\ballerg(?:ic|y)\s+to\s+([^.\n]+)/);
  if (mAll) {
    const raw = mAll[1].replace(/\bi have\b.+/i,"");
    allergies = splitList(raw).filter(w => w && !/^(i|have|a|an)$/.test(w));
  }

  // Conditions
  let conditions = [];
  const candidates = [];
  const r1 = text.match(/\bdiagnosed with ([a-z0-9 \-]+?)([.,;]|$)/i);
  if (r1) candidates.push(r1[1].trim());
  const r2 = text.match(/\bi have (?:a |an )?([a-z0-9 \-]+?)(?: disease| condition| issue| problem|$|[.,;])/i);
  if (r2) candidates.push(r2[1].trim());
  const r3 = text.match(/\b([a-z0-9 \-]+) condition\b/i);
  if (r3) candidates.push(r3[1].trim());

  for (let c of candidates) {
    c = c.replace(/\b(my|the|a|an)\b/gi,"").trim();
    if (!c || c.length < 3) continue;
    if (NOT_CONDITION.has(c.toLowerCase())) continue;
    if (/\bmedications?\b/i.test(c)) continue;
    conditions.push(c);
  }
  conditions = Array.from(new Set(conditions));

  // Medications
  const meds = [];
  const medRegex = /\b([A-Z][A-Za-z0-9-]{2,})\b[^.\n,;]*?\b(\d{1,4})\s*(mg|mcg|g|ml|milligrams|micrograms|grams|milliliters)?\b/g;
  let m;
  while ((m = medRegex.exec(text))) {
    const name = m[1];
    const dose = m[2];
    const unit = normalizeUnit(m[3]);
    if (/^\w-\[bloodtype\]/i.test(name)) continue;
    meds.push(`${name} — ${dose} ${unit}`);
  }

  return { meds, allergies, conditions, bp, weight };
}

async function translateText(target, text) {
  if (!target || target === "en" || !text) return text;
  const comp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: `Translate to ${target}. Respond with only the translated text.` },
      { role: "user", content: text }
    ]
  });
  return comp?.choices?.[0]?.message?.content?.trim() || text;
}
// ———————————————————————————————————————————————————————————————

// Upload -> create report
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file" });

    const filePath = req.file.path;
    const meta = {
      name: req.body.name?.trim() || "",
      email: req.body.email?.trim() || "",
      emer_name: req.body.emer_name?.trim() || "",
      emer_phone: req.body.emer_phone?.trim() || "",
      emer_email: req.body.emer_email?.trim() || "",
      blood_type: req.body.blood_type?.trim() || "",
      lang_target: (req.body.lang || "").trim()
    };

    // Transcribe
    let transcript = "";
    try {
      const stream = fs.createReadStream(filePath);
      const tr = await openai.audio.transcriptions.create({
        model: "gpt-4o-mini-transcribe",
        file: stream
      });
      transcript = (tr?.text || "").trim();
    } catch (e) {
      console.error("Transcription failed:", e?.message || e);
      return res.status(500).json({ ok: false, error: "Transcription failed" });
    }

    const { meds, allergies, conditions, bp, weight } = parseHealthInfo(transcript);

    // Optional translation on upload
    let translation = "";
    const target = meta.lang_target;
    if (target && target !== "en") {
      try {
        translation = await translateText(target, transcript);
      } catch (e) {
        console.warn("Translation failed:", e?.message || e);
      }
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    await dbRun(
      `INSERT INTO reports
       (id, created, patient_name, patient_email, emer_name, emer_phone, emer_email, blood_type,
        transcript, translation, lang_detected, lang_target, medications, allergies, conditions, bp, weight)
       VALUES (?, datetime('now'), ?,?,?,?,?,?, ?,?,?,?, ?,?,?,?, ?)`,
      [
        id,
        meta.name, meta.email, meta.emer_name, meta.emer_phone, meta.emer_email, meta.blood_type,
        transcript, translation, "auto", target || "",
        JSON.stringify(meds), JSON.stringify(allergies), JSON.stringify(conditions),
        bp || "", weight || ""
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

// Minimal /reports list
app.get("/reports", async (req, res) => {
  try {
    const rows = await dbAll(
      "SELECT id, created, patient_name FROM reports ORDER BY created DESC LIMIT 100"
    );
    const items = rows.map(r => {
      const base = `${PUBLIC_BASE_URL}/reports/${r.id}`;
      return `<li>
        <a href="${esc(base)}" target="_blank">${esc(r.id)}</a>
        — <small>${esc(r.created)}${r.patient_name ? " • " + esc(r.patient_name) : ""}</small>
        <div class="small">
          Translate:
          <a href="${esc(base)}?lang=fr" target="_blank">FR</a> ·
          <a href="${esc(base)}?lang=es" target="_blank">ES</a> ·
          <a href="${esc(base)}?lang=pt" target="_blank">PT</a> ·
          <a href="${esc(base)}?lang=de" target="_blank">DE</a> ·
          <a href="${esc(base)}?lang=sr" target="_blank">SR</a> ·
          <a href="${esc(base)}?lang=pa" target="_blank">PA</a> ·
          <a href="${esc(base)}?lang=he" target="_blank">HE</a>
        </div>
      </li>`;
    }).join("");
    res.send(`<!doctype html><html><head><meta charset="utf-8"/>
      <title>Reports</title>
      <link rel="stylesheet" href="/styles.css"/>
      <style>.small{color:#666;margin-top:4px}</style>
    </head><body>
      <div class="header-shell"><header><h1>Reports</h1></header></div>
      <div class="shell"><main class="wrap"><ul>${items || "<li>No reports yet.</li>"}</ul></main></div>
    </body></html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error listing reports.");
  }
});

// Single report; ?lang=xx renders translated blocks (transcript + summary)
app.get("/reports/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const row = await dbGet("SELECT * FROM reports WHERE id = ?", id);
    if (!row) return res.status(404).send("Not found");

    const meds = JSON.parse(row.medications || "[]");
    const allergies = JSON.parse(row.allergies || "[]");
    const conditions = JSON.parse(row.conditions || "[]");

    const detectedLang = row.lang_detected || "en";
    let targetLang = (req.query.lang || row.lang_target || "").trim();

    // Build original summary strings
    const medsText = meds.length ? meds.join(", ") : "None mentioned";
    const allergiesText = allergies.length ? allergies.join(", ") : "None mentioned";
    const conditionsText = conditions.length ? conditions.join(", ") : "None mentioned";
    const bpText = row.bp || "Not provided";
    const weightText = row.weight || "Not provided";

    // Transcript
    let translatedTranscript =
      row.translation && row.translation.trim() ? row.translation : row.transcript;

    // Translated summary (on the fly if target differs)
    let medsTextTr = medsText, allergiesTextTr = allergiesText, conditionsTextTr = conditionsText;
    let bpTextTr = bpText, weightTextTr = weightText;

    if (targetLang && targetLang !== detectedLang) {
      try {
        const [a,b,c,d,e] = await Promise.all([
          translateText(targetLang, medsText),
          translateText(targetLang, allergiesText),
          translateText(targetLang, conditionsText),
          translateText(targetLang, bpText),
          translateText(targetLang, weightText),
        ]);
        medsTextTr = a; allergiesTextTr = b; conditionsTextTr = c;
        bpTextTr = d; weightTextTr = e;

        // Also translate transcript if not already
        if (!row.translation || detectedLang === targetLang) {
          translatedTranscript = await translateText(targetLang, row.transcript || "");
        }
      } catch (e) {
        console.warn("Translate (summary/view) failed:", e?.message || e);
        targetLang = detectedLang; // fall back
        medsTextTr = medsText; allergiesTextTr = allergiesText; conditionsTextTr = conditionsText;
        bpTextTr = bpText; weightTextTr = weightText;
        translatedTranscript = row.transcript || "";
      }
    } else {
      targetLang = detectedLang;
    }

    const shareUrl = `${PUBLIC_BASE_URL}/reports/${id}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    const tplPath = path.join(__dirname, "templates", "report.html");
    const tpl = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, "utf8") : null;

    const html = tpl
      ? renderTemplate(tpl, {
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
          bp: esc(bpText),
          weight: esc(weightText),

          medicationsT: esc(medsTextTr),
          allergiesT: esc(allergiesTextTr),
          conditionsT: esc(conditionsTextTr),
          bpT: esc(bpTextTr),
          weightT: esc(weightTextTr),

          detectedLang: esc(detectedLang),
          targetLang: esc(targetLang || detectedLang),
          transcript: esc(row.transcript || ""),
          translatedTranscript: esc(translatedTranscript || "")
        })
      : `<!doctype html><html><head><meta charset="utf-8"/>
         <title>Report ${esc(id)}</title>
         <link rel="stylesheet" href="/styles.css"/>
         <style>
           .toolbar{display:flex;gap:10px;align-items:center}
           @media print{.print-hide{display:none}}
         </style>
        </head><body>
         <div class="header-shell"><header><h1>Hot Health — Report</h1></header></div>
         <div class="shell"><main class="wrap">
           <div class="section print-hide">
             <div class="toolbar">
               <button onclick="window.print()">🖨️ Print</button>
               <a href="${esc(shareUrl)}" target="_blank">Open share link</a>
               <a href="/reports" target="_blank">Open All Reports</a>
             </div>
             <div><b>Created:</b> ${esc(row.created || "")}</div>
           </div>

           <div class="section"><h2>Patient</h2>
             <p>${esc(row.patient_name || "")} — <a href="mailto:${esc(row.patient_email || "")}">${esc(row.patient_email || "")}</a></p>
             <p>EC: ${esc(row.emer_name || "")} ${esc(row.emer_phone || "")} — <a href="mailto:${esc(row.emer_email || "")}">${esc(row.emer_email || "")}</a></p>
             <p>Blood: ${esc(row.blood_type || "")}</p>
           </div>

           <div class="section">
             <h2>Summary</h2>
             <div style="display:flex;gap:12px;flex-wrap:wrap">
               <div style="flex:1;min-width:280px">
                 <h3>Original (${esc(detectedLang)})</h3>
                 <p><b>Medications:</b> ${esc(medsText)}</p>
                 <p><b>Allergies:</b> ${esc(allergiesText)}</p>
                 <p><b>Conditions:</b> ${esc(conditionsText)}</p>
                 <p><b>Blood Pressure:</b> ${esc(bpText)}</p>
                 <p><b>Weight:</b> ${esc(weightText)}</p>
               </div>
               <div style="flex:1;min-width:280px">
                 <h3>Translated (${esc(targetLang)})</h3>
                 <p><b>Medications:</b> ${esc(medsTextTr)}</p>
                 <p><b>Allergies:</b> ${esc(allergiesTextTr)}</p>
                 <p><b>Conditions:</b> ${esc(conditionsTextTr)}</p>
                 <p><b>Blood Pressure:</b> ${esc(bpTextTr)}</p>
                 <p><b>Weight:</b> ${esc(weightTextTr)}</p>
               </div>
             </div>
           </div>

           <div class="section">
             <h2>Transcript</h2>
             <div style="display:flex; gap:12px; flex-wrap:wrap">
               <div style="flex:1; min-width:280px">
                 <h3>Original (${esc(detectedLang)})</h3>
                 <pre>${esc(row.transcript || "")}</pre>
               </div>
               <div style="flex:1; min-width:280px">
                 <h3>Translated (${esc(targetLang || detectedLang)})</h3>
                 <pre>${esc(translatedTranscript || "")}</pre>
               </div>
             </div>
           </div>

           <div class="section">
             <h2>QR</h2>
             <img src="${esc(qrDataUrl)}" width="180" alt="QR for this report"/>
             <p><a href="${esc(shareUrl)}">${esc(shareUrl)}</a></p>
           </div>
         </main></div>
        </body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("Report render error:", err);
    res.status(500).send("Server error rendering report.");
  }
});

// Health
app.get("/healthz", (req, res) => res.json({ ok: true }));

await initDB();
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
  console.log(`   Public base URL: ${PUBLIC_BASE_URL}`);
});
