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

// static
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// uploads
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// multer
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

// sqlite3 (promisified)
sqlite3.verbose();
const dbPath = path.join(__dirname, "data.db");
const db = new sqlite3.Database(dbPath);
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbExec = promisify(db.exec.bind(db));

// init db
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

// helpers
function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
function renderTemplate(tpl, data) {
  return tpl.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_, k) =>
    (k in data ? data[k] : "")
  );
}

// ——— Parsing ————————————————————————————————
const STOPWORDS = /\b(?:i|have|a|an|the|my|to|of|and|with|for)\b/gi;

function titlecase(s) {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}
function cleanConditionPhrase(s) {
  if (!s) return "";
  let t = s.toLowerCase().trim();

  // remove leading "i have (a|an|the)"
  t = t.replace(/^i\s+have\s+(?:a|an|the)\s+/i, "");
  t = t.replace(/^i\s+have\s+/i, "");

  // remove trailing generic words
  t = t.replace(/\b(?:disease|condition|issue|problem)\b\.?$/i, "").trim();

  // kill commas introduced by weird matches
  t = t.replace(/\s*,\s*/g, " ");

  // remove lone stopwords
  t = t.replace(STOPWORDS, " ").replace(/\s+/g, " ").trim();

  // too short? skip
  if (t.length < 2) return "";

  return titlecase(t);
}

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

  // BP
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
    allergies = splitList(raw).filter(w => w && !/^(i|have|a|an|the)$/.test(w));
  }

  // Conditions (collect multiple phrases)
  const candidates = [];

  // i have (a|an|the) X (disease|condition|issue|problem)?
  const reHave = /\bi have(?:\s+(?:a|an|the))?\s+([a-z0-9 \-]+?)(?:\s+(?:disease|condition|issue|problem))?(?=[.,;]|$)/gi;
  let m;
  while ((m = reHave.exec(lower))) {
    candidates.push(m[1]);
  }

  // diagnosed with X
  const reDx = /\bdiagnosed with\s+([a-z0-9 \-]+?)(?=[.,;]|$)/gi;
  while ((m = reDx.exec(lower))) {
    candidates.push(m[1]);
  }

  // X condition
  const reCond = /\b([a-z0-9 \-]+)\s+condition\b/gi;
  while ((m = reCond.exec(lower))) {
    candidates.push(m[1]);
  }

  let conditions = candidates
    .map(cleanConditionPhrase)
    .filter(Boolean);

  // dedupe
  conditions = Array.from(new Set(conditions));

  // Medications: ProperName — dose unit
  const meds = [];
  const medRegex = /\b([A-Z][A-Za-z0-9-]{2,})\b[^.\n,;]*?\b(\d{1,4})\s*(mg|mcg|g|ml|milligrams|micrograms|grams|milliliters)?\b/g;
  let mm;
  while ((mm = medRegex.exec(text))) {
    const name = mm[1];
    const dose = mm[2];
    const unit = normalizeUnit(mm[3]);
    if (/^\w-\[bloodtype\]/i.test(name)) continue;
    meds.push(`${name} — ${dose} ${unit}`);
  }

  return { meds, allergies, conditions, bp, weight };
}
// ————————————————————————————————————————

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

// upload -> create report
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

    // transcribe
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

    // optional first-shot translation (stored)
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
        transcript, translation, "en", target || "",
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

// reports list: Patient name first, translate dropdown
app.get("/reports", async (req, res) => {
  try {
    const rows = await dbAll(
      "SELECT id, created, patient_name FROM reports ORDER BY created DESC LIMIT 200"
    );

    const langOptions = [
      ["", "— Select —"], ["en","English"],["fr","Français"],["es","Español"],
      ["pt","Português"],["de","Deutsch"],["it","Italiano"],["ar","العربية"],
      ["hi","हिन्दी"],["zh","中文"],["ja","日本語"],["ko","한국어"],
      ["sr","Srpski"],["pa","ਪੰਜਾਬੀ"],["he","עברית"]
    ];

    const items = rows.map(r => {
      const base = `${PUBLIC_BASE_URL}/reports/${r.id}`;
      const name = r.patient_name?.trim() || "Unknown patient";
      const select = `<select onchange="if(this.value){location.href='${esc(base)}?lang='+this.value;this.selectedIndex=0;}">
        ${langOptions.map(([v,l])=>`<option value="${esc(v)}">${esc(l)}</option>`).join("")}
      </select>`;

      return `<li class="item">
        <div class="left">
          <a class="rid" href="${esc(base)}" target="_blank">Report for ${esc(name)}</a>
          <div class="meta">${esc(r.created)}</div>
        </div>
        <div class="langs">
          <label>Translate:</label>
          ${select}
        </div>
      </li>`;
    }).join("");

    res.send(`<!doctype html><html><head><meta charset="utf-8"/>
      <title>Reports</title>
      <link rel="stylesheet" href="/styles.css"/>
      <style>
        body{background:#f7fbff;font-family:system-ui,Segoe UI,Inter,Arial,sans-serif}
        .header-shell{display:flex;justify-content:center;background:#fff;border-bottom:3px solid #00e5c0}
        header{width:100%;max-width:980px;padding:16px 20px}
        h1{color:#4b0082;margin:0}
        .shell{display:flex;justify-content:center;padding:18px}
        .wrap{width:100%;max-width:980px;border:2px solid #00e5c0;border-radius:14px;background:#fff;padding:18px}
        ul{list-style:none;margin:0;padding:0}
        .item{display:flex;justify-content:space-between;align-items:center;padding:12px;border-bottom:1px solid #eee;gap:12px}
        .rid{font-weight:700;color:#4b0082}
        .meta{color:#666;font-size:12px;margin-top:2px}
        .langs label{margin-right:6px;color:#333;font-size:14px}
        select{padding:6px 8px;border:1px solid #ddd;border-radius:8px}
      </style>
    </head><body>
      <div class="header-shell"><header><h1>Reports</h1></header></div>
      <div class="shell"><main class="wrap">
        <ul>${items || "<li>No reports yet.</li>"}</ul>
      </main></div>
    </body></html>`);
  } catch (e) {
    console.error(e);
    res.status(500).send("Server error listing reports.");
  }
});

// single report with dual blocks + email share + qr instructions
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

    // ALWAYS translate from the ORIGINAL transcript each time
    const fromTranscript = row.transcript || "";

    let translatedTranscript = fromTranscript;
    let medsTextTr = medsText, allergiesTextTr = allergiesText, conditionsTextTr = conditionsText;
    let bpTextTr = bpText, weightTextTr = weightText;

    if (targetLang && targetLang !== detectedLang) {
      try {
        const [tt, a,b,c,d,e] = await Promise.all([
          translateText(targetLang, fromTranscript),
          translateText(targetLang, medsText),
          translateText(targetLang, allergiesText),
          translateText(targetLang, conditionsText),
          translateText(targetLang, bpText),
          translateText(targetLang, weightText),
        ]);
        translatedTranscript = tt;
        medsTextTr = a; allergiesTextTr = b; conditionsTextTr = c;
        bpTextTr = d; weightTextTr = e;
      } catch (e) {
        console.warn("Translate (view) failed:", e?.message || e);
        targetLang = detectedLang;
      }
    } else {
      targetLang = detectedLang;
    }

    const shareUrl = `${PUBLIC_BASE_URL}/reports/${id}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    // Email share links
    const subject = encodeURIComponent("Shared Hot Health Report");
    const body = encodeURIComponent(`Here is the patient's report:\n\n${shareUrl}`);
    const mailto = `mailto:?subject=${subject}&body=${body}`;
    const gmail = `https://mail.google.com/mail/?view=cm&fs=1&su=${subject}&body=${body}`;
    const outlook = `https://outlook.office.com/mail/deeplink/compose?subject=${subject}&body=${body}`;

    // “Translate to” dropdown
    const translateOptions = [
      ["", "— Select language —"],
      ["en","English"],["fr","Français"],["es","Español"],["pt","Português"],
      ["de","Deutsch"],["it","Italiano"],["ar","العربية"],["hi","हिन्दी"],
      ["zh","中文"],["ja","日本語"],["ko","한국어"],["sr","Srpski"],
      ["pa","ਪੰਜਾਬੀ"],["he","עברית"]
    ].map(([val,label]) =>
      `<option value="${esc(val)}"${val===targetLang?' selected':''}>${esc(label)}</option>`
    ).join("");

    // load template if present
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
          targetLang: esc(targetLang),
          transcript: esc(fromTranscript),
          translatedTranscript: esc(translatedTranscript),

          translateSelect: `<form class="print-hide" method="GET" style="margin:8px 0">
            <label for="tlang"><b>Translate to:</b></label>
            <select id="tlang" name="lang" onchange="this.form.submit()">
              ${translateOptions}
            </select>
          </form>`,

          // email share links
          mailto: esc(mailto),
          gmail: esc(gmail),
          outlook: esc(outlook)
        })
      : `<!doctype html><html><head><meta charset="utf-8"/>
          <title>Report</title>
          <link rel="stylesheet" href="/styles.css"/>
          <style>
            .ec-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
            .label{color:#555}
            .btn{padding:8px 12px;border-radius:8px;background:#4b0082;color:#fff;text-decoration:none}
          </style>
        </head><body>
          <div class="header-shell"><header><h1>Hot Health — Report</h1></header></div>
          <div class="shell"><main class="wrap">
            <section class="section print-hide">
              <div class="toolbar" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
                <a class="btn" href="javascript:window.print()">🖨️ Print</a>
                <div>
                  <b>Email link:</b>
                  <a class="btn" href="${esc(mailto)}">Mail</a>
                  <a class="btn" href="${esc(gmail)}" target="_blank">Gmail</a>
                  <a class="btn" href="${esc(outlook)}" target="_blank">Outlook</a>
                </div>
                <a class="btn" href="/reports" target="_blank">Open All Reports</a>
              </div>
              <div style="margin-top:8px">
                <form method="GET">
                  <label for="tlang"><b>Translate to:</b></label>
                  <select id="tlang" name="lang" onchange="this.form.submit()">
                    ${translateOptions}
                  </select>
                </form>
              </div>
              <div><b>Created:</b> ${esc(row.created || "")}</div>
            </section>

            <section class="section">
              <h2>Patient Details</h2>
              <p><b>Name:</b> ${esc(row.patient_name || "")}</p>
              <p><b>Email:</b> <a href="mailto:${esc(row.patient_email || "")}">${esc(row.patient_email || "")}</a></p>
              <p><b>Blood Type:</b> ${esc(row.blood_type || "")}</p>
              <div class="ec-grid">
                <div><span class="label">Emergency Contact:</span> ${esc(row.emer_name || "")}</div>
                <div><span class="label">Phone:</span> ${esc(row.emer_phone || "")}</div>
                <div><span class="label">Email:</span> <a href="mailto:${esc(row.emer_email || "")}">${esc(row.emer_email || "")}</a></div>
              </div>
            </section>

            <section class="section">
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
            </section>

            <section class="section">
              <h2>Transcript</h2>
              <div style="display:flex; gap:12px; flex-wrap:wrap">
                <div style="flex:1; min-width:280px">
                  <h3>Original (${esc(detectedLang)})</h3>
                  <pre>${esc(fromTranscript)}</pre>
                </div>
                <div style="flex:1; min-width:280px">
                  <h3>Translated (${esc(targetLang)})</h3>
                  <pre>${esc(translatedTranscript)}</pre>
                </div>
              </div>
            </section>

            <section class="section">
              <h2>QR</h2>
              <p class="muted">Scan this QR with a phone, or click the link below to open the report.</p>
              <img src="${esc(qrDataUrl)}" width="180" alt="QR for this report" style="border:1px dashed #00e5c0;padding:6px;border-radius:8px;background:#fff"/>
              <p><a href="${esc(shareUrl)}" target="_blank">${esc(shareUrl)}</a></p>
            </section>
          </main></div>
        </body></html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (err) {
    console.error("Report render error:", err);
    res.status(500).send("Server error rendering report.");
  }
});

// health
app.get("/healthz", (req, res) => res.json({ ok: true }));

await initDB();
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
  console.log(`   Public base URL: ${PUBLIC_BASE_URL}`);
});
