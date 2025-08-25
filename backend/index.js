import express from "express";
import multer from "multer";
import sqlite3 from "sqlite3";
import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import bodyParser from "body-parser";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const port = process.env.PORT || 10000; // Render binds here by default
const uploadDir = path.resolve("./uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ---------- DB ----------
const db = new sqlite3.Database("./reports.db");
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      patient_name TEXT,
      patient_email TEXT,
      emer_name TEXT,
      emer_phone TEXT,
      emer_email TEXT,
      blood_type TEXT,
      transcript TEXT,
      translated TEXT,
      language TEXT,
      target_language TEXT,
      meds_json TEXT,
      allergies_json TEXT,
      conditions_json TEXT,
      vitals_json TEXT
    )
  `);
});

function esc(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function safeParseJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

// ---------- OpenAI ----------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Middleware ----------
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(process.cwd(), "backend", "public"))); // serve /public assets

// ---------- Helpers ----------
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
  const host  = (req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return `${proto}://${host}`;
}

function guessFacts(text) {
  const meds = [];
  // e.g., "Amlodipine 10 mg", "Dexilant 60 mg", "Lisinopril 20mg twice daily"
  const medRe = /\b([A-Z][a-z][A-Za-z\-]{1,30})\s+(\d{1,4})\s?(mg|mcg|g|ml)\b(?:[^.,;()]{0,30})?/g;
  for (const m of text.matchAll(medRe)) {
    meds.push({
      name: m[1],
      dose: m[2],
      unit: m[3],
      freq: undefined,
      notes: undefined
    });
  }

  const allergies = [];
  const allBlock =
    text.match(/\ballergic to ([^.]+)[\.\n,]?/i)?.[1] ||
    text.match(/\ballerg(?:y|ies)\s*(?:\:|to)\s*([^.]+)[\.\n,]?/i)?.[1];
  if (allBlock) {
    allBlock.split(/,| and /i).map(s => s.trim()).filter(Boolean).forEach(a => allergies.push(a));
  }

  const conditions = [];
  const condRe = /\b(diabetes|hypertension|asthma|kidney (?:disease|condition)|heart (?:failure|disease)|copd|stroke|migraine|cancer)\b/ig;
  for (const c of text.matchAll(condRe)) conditions.push(c[0].toLowerCase());

  // vitals: BP & weight
  let bp;
  const bpRe = /\b(\d{2,3})\s*(?:over|\/)\s*(\d{2,3})\b/i;
  const bpM = text.match(bpRe);
  if (bpM) bp = { sys: Number(bpM[1]), dia: Number(bpM[2]) };

  let weight;
  const wtRe = /\b(\d{2,3}(?:\.\d+)?)\s*(kg|kilograms|lbs?|pounds)\b/i;
  const wtM = text.match(wtRe);
  if (wtM) {
    weight = { value: Number(wtM[1]), unit: wtM[2].toLowerCase() };
  }

  return { meds, allergies, conditions, vitals: { bp, weight } };
}

// ---------- Multer ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const ext = ".webm";
    cb(null, `${unique}${ext}`);
  }
});
const upload = multer({ storage });

// ---------- Pages ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "backend", "public", "index.html"));
});

app.get("/reports", (req, res) => {
  // simple admin view with password gate
  const adminPw = process.env.ADMIN_PASSWORD;
  const provided = (req.query.password || "").trim();
  if (adminPw && provided !== adminPw) return res.status(401).send("Unauthorized — add ?password=...");

  db.all("SELECT id, created_at, patient_name, target_language FROM reports ORDER BY created_at DESC LIMIT 200", [], (err, rows = []) => {
    if (err) return res.status(500).send("DB error");
    const tpl = fs.readFileSync(path.join(process.cwd(), "backend", "templates", "reports.html"), "utf8");
    const list = rows.map(r => `
      <tr>
        <td>${esc(r.created_at || "")}</td>
        <td>${esc(r.patient_name || "(anon)")}</td>
        <td>${esc(r.id)}</td>
        <td>${esc(r.target_language || "-")}</td>
        <td>
          <a class="btn-outline" href="/reports/${r.id}${adminPw ? `?password=${encodeURIComponent(provided)}` : ""}">View</a>
          <form method="post" action="/reports/${r.id}/translate" style="display:inline-block;margin-left:6px">
            ${adminPw ? `<input type="hidden" name="password" value="${esc(provided)}"/>` : ""}
            <select name="to">
              <option value="fr">fr</option><option value="es">es</option><option value="pt">pt</option>
              <option value="de">de</option><option value="it">it</option><option value="ar">ar</option>
              <option value="hi">hi</option><option value="zh">zh</option><option value="ja">ja</option><option value="ko">ko</option>
            </select>
            <button class="btn-aqua" type="submit">Translate</button>
          </form>
        </td>
      </tr>
    `).join("");
    res.send(tpl.replace("{{ROWS}}", list).replace("{{PWQS}}", adminPw ? `?password=${encodeURIComponent(provided)}` : ""));
  });
});

// ---------- Upload ----------
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    const hasFile = !!req.file;
    if (!hasFile) return res.status(400).json({ ok: false, error: "No file uploaded" });

    const id = Math.random().toString(36).slice(2);
    const fp = req.file.path;

    // Transcribe
    let transcript = "";
    try {
      const tr = await openai.audio.transcriptions.create({
        file: fs.createReadStream(fp),
        model: "gpt-4o-mini-transcribe"
      });
      transcript = (tr.text || "").trim();
    } catch (e) {
      console.error("Transcription error:", e);
      return res.status(500).json({ ok: false, error: "Transcription failed" });
    }

    // Parse basic facts
    const facts = guessFacts(transcript);
    const meds_json = JSON.stringify(facts.meds);
    const allergies_json = JSON.stringify(facts.allergies);
    const conditions_json = JSON.stringify(facts.conditions);
    const vitals_json = JSON.stringify(facts.vitals);

    // Optional initial translate
    const lang = "en"; // default unless you detect otherwise
    const requestedTarget = (req.body.lang || "").trim();
    let translated = "";
    let target_language = "";
    if (requestedTarget) {
      try {
        const model = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
        const prompt = `Translate the following text into ${requestedTarget}. Output only the translated text:\n\n${transcript}`;
        const resp = await openai.responses.create({ model, input: prompt });
        translated = (resp.output_text || "").trim();
        target_language = requestedTarget;
      } catch (e) {
        console.error("Initial translate fail (continuing without it):", e);
      }
    }

    // Save
    const nowIso = new Date().toISOString().replace("T", " ").slice(0, 19);
    await new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO reports (id, created_at, patient_name, patient_email, emer_name, emer_phone, emer_email, blood_type,
                              transcript, translated, language, target_language, meds_json, allergies_json, conditions_json, vitals_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, nowIso,
          req.body.name || "", req.body.email || "",
          req.body.emer_name || "", req.body.emer_phone || "", req.body.emer_email || "",
          req.body.blood_type || "",
          transcript, translated, lang, target_language,
          meds_json, allergies_json, conditions_json, vitals_json
        ],
        (err) => err ? reject(err) : resolve()
      );
    });

    const base = getBaseUrl(req);
    const link = `${base}/reports/${id}`;
    const qr = await QRCode.toDataURL(link);

    res.json({ ok: true, id, link, qr, reportId: id, reportUrl: link });
  } catch (e) {
    console.error("Upload error:", e);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- Report page ----------
app.get("/reports/:id", (req, res) => {
  const adminPw = process.env.ADMIN_PASSWORD;
  const provided = (req.query.password || "").trim();

  db.get("SELECT * FROM reports WHERE id = ?", [req.params.id], (err, r) => {
    if (err || !r) return res.status(404).send("Report not found");

    const tplPath = path.join(process.cwd(), "backend", "templates", "report.html");
    if (!fs.existsSync(tplPath)) return res.status(500).send("Template missing");

    const meds = safeParseJSON(r.meds_json, []);
    const allergies = safeParseJSON(r.allergies_json, []);
    const conditions = safeParseJSON(r.conditions_json, []);
    const vitals = safeParseJSON(r.vitals_json, {});

    const base = getBaseUrl(req);
    const selfUrl = `${base}${req.originalUrl.split("?")[0]}${adminPw && provided ? `?password=${encodeURIComponent(provided)}` : ""}`;

    // Assemble small HTML pieces for template
    const bloodPill = r.blood_type ? `<span class="pill">Blood: ${esc(r.blood_type)}</span>` : "";
    const emerLine = [r.emer_name, r.emer_phone, r.emer_email].filter(Boolean).join(" · ");

    // Render
    let html = fs.readFileSync(tplPath, "utf8");
    function put(key, val) { html = html.replaceAll(`{{${key}}}`, val ?? ""); }

    put("SELF_URL", esc(selfUrl));
    put("BACK_HREF", adminPw && provided ? `/reports?password=${encodeURIComponent(provided)}` : "#");
    put("SHOW_BACK", adminPw && provided ? "block" : "none");

    put("DATE", esc(r.created_at || ""));
    put("PATIENT_NAME", esc(r.patient_name || "(anon)"));
    put("BLOOD_PILL", bloodPill);
    put("PATIENT_EMAIL", esc(r.patient_email || ""));
    put("EMER", esc(emerLine || "(none)"));
    put("TRANSCRIPT", esc(r.transcript || ""));
    put("TRANSLATED", esc(r.translated || ""));
    put("ID", esc(r.id));

    res.send(html);
  });
});

// ---------- QR image ----------
app.get("/reports/:id/qrcode.png", async (req, res) => {
  db.get("SELECT id FROM reports WHERE id = ?", [req.params.id], async (err, row) => {
    if (err || !row) return res.status(404).send("Report not found");
    try {
      const url = `${getBaseUrl(req)}/reports/${row.id}`;
      const png = await QRCode.toBuffer(url, { type: "png", errorCorrectionLevel: "M", margin: 1, width: 512 });
      res.setHeader("Content-Type", "image/png");
      res.send(png);
    } catch (e) {
      console.error("QR error:", e);
      res.status(500).send("QR generation failed");
    }
  });
});

// ---------- Translate ----------
app.post("/reports/:id/translate", async (req, res) => {
  try {
    const adminPw = process.env.ADMIN_PASSWORD;
    const provided = (req.body.password || req.query.password || "").trim();
    if (adminPw && provided !== adminPw) return res.status(401).send("Unauthorized — add ?password= or include 'password'");

    const to = (req.body.to || "").trim();
    if (!to) return res.status(400).send("Missing target language");

    const row = await new Promise((resolve, reject) => {
      db.get("SELECT transcript FROM reports WHERE id = ?", [req.params.id], (err, r) => err ? reject(err) : resolve(r));
    });
    if (!row) return res.status(404).send("Report not found");
    if (!row.transcript) return res.status(400).send("No transcript to translate");

    const model = process.env.OPENAI_TEXT_MODEL || "gpt-4o-mini";
    const prompt = `Translate the following text into ${to}. Output only the translated text:\n\n${row.transcript}`;
    const resp = await openai.responses.create({ model, input: prompt });
    const translated = (resp.output_text || "").trim();

    await new Promise((resolve, reject) => {
      db.run("UPDATE reports SET translated=?, target_language=? WHERE id=?",
        [translated, to, req.params.id],
        (err) => err ? reject(err) : resolve()
      );
    });

    const qs = (adminPw && provided) ? `?password=${encodeURIComponent(provided)}` : "";
    res.redirect(`/reports/${req.params.id}${qs}`);
  } catch (e) {
    console.error("Translate error:", e);
    res.status(500).send("Translate failed");
  }
});

// ---------- Start ----------
app.listen(port, () => {
  console.log(`✅ Backend listening on ${port}`);
});
