// backend/index.js  (sqlite3-only, no 'sqlite' helper)
import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import QRCode from "qrcode";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { fileURLToPath } from "url";
import bodyParser from "body-parser";
import fetch from "node-fetch";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 10000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TEXT_MODEL = process.env.OPENAI_TEXT_MODEL || "gpt-4o";
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const FALLBACK_TRANSCRIBE_MODEL = "whisper-1";
if (!OPENAI_API_KEY) {
  console.warn("⚠️  OPENAI_API_KEY missing — transcription/LLM calls will fail.");
}

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const ext = (path.extname(file.originalname) || ".webm").toLowerCase();
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    const ok = /audio\/(webm|wav|ogg|mp3|mpeg|mp4|m4a|oga|flac)/i.test(file.mimetype || "");
    cb(ok ? null : new Error("UNSUPPORTED_AUDIO_TYPE"));
  },
  limits: { fileSize: 30 * 1024 * 1024 },
});

// --- sqlite3 ONLY (promisified helpers) ---
sqlite3.verbose();
const dbFile = path.join(process.cwd(), "hothealth.sqlite");
const db = new sqlite3.Database(dbFile);

const dbExec = (sql) =>
  new Promise((res, rej) => db.exec(sql, (err) => (err ? rej(err) : res())));
const dbRun = (sql, params = []) =>
  new Promise((res, rej) =>
    db.run(sql, params, function (err) {
      if (err) rej(err);
      else res(this);
    })
  );
const dbGet = (sql, params = []) =>
  new Promise((res, rej) => db.get(sql, params, (err, row) => (err ? rej(err) : res(row))));
const dbAll = (sql, params = []) =>
  new Promise((res, rej) => db.all(sql, params, (err, rows) => (err ? rej(err) : res(rows))));

// Init schema
async function initDb() {
  await dbExec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      created TEXT,
      name TEXT,
      email TEXT,
      emer_name TEXT,
      emer_phone TEXT,
      emer_email TEXT,
      blood TEXT,
      doc_name TEXT,
      doc_phone TEXT,
      doc_fax TEXT,
      doc_email TEXT,
      transcript TEXT,
      translatedTranscript TEXT,
      detectedLang TEXT,
      targetLang TEXT,
      medications TEXT,
      medicationsT TEXT,
      allergies TEXT,
      allergiesT TEXT,
      conditions TEXT,
      conditionsT TEXT,
      bp TEXT,
      bpT TEXT,
      weight TEXT,
      weightT TEXT
    );
  `);
  async function addCol(name, def) {
    try { await dbExec(`ALTER TABLE reports ADD COLUMN ${name} ${def}`); } catch {}
  }
  await addCol("doc_name", "TEXT");
  await addCol("doc_phone", "TEXT");
  await addCol("doc_fax", "TEXT");
  await addCol("doc_email", "TEXT");
  await addCol("medicationsT", "TEXT");
  await addCol("allergiesT", "TEXT");
  await addCol("conditionsT", "TEXT");
  await addCol("bpT", "TEXT");
  await addCol("weightT", "TEXT");
}
await initDb();

// Helpers
function baseUrlFrom(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`.replace(/\/+$/, "");
}
function shortId() {
  return crypto.randomBytes(8).toString("hex");
}
function cleanList(arr) {
  return (arr || []).map((s) => (s || "").trim()).filter(Boolean);
}
function uniq(arr) {
  return [...new Set(arr)];
}

// OpenAI calls
async function openaiTranscribe(localPath, filename, model) {
  const endpoint = "https://api.openai.com/v1/audio/transcriptions";
  const form = new (await import("form-data")).default();
  form.append("model", model);
  form.append("file", fs.createReadStream(localPath), { filename });

  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`${resp.status} ${t}`);
  }
  return resp.json();
}

async function openaiExtractFacts(transcript) {
  const prompt = `
You will extract structured health facts from the user's note. Return strict JSON with keys:
{ "medications": [ "name — amount units", ... ],
  "allergies": [ ... ],
  "conditions": [ ... ],
  "blood_pressure": "e.g., 120/75" or "",
  "weight": "e.g., 200 lb" or "" }

Rules:
- Do NOT place weight or blood pressure into conditions.
- Normalize units (mg, g, mcg, lb/lbs, kg).
- Keep medication names as-is (no hallucination).
- If nothing found for a category, use [] or "" accordingly.

Text:
"""${transcript}"""`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TEXT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content || "{}";
  try { return JSON.parse(text); } catch { return { medications:[], allergies:[], conditions:[], blood_pressure:"", weight:"" }; }
}

async function openaiTranslate(text, targetLangCode) {
  if (!targetLangCode) return text;
  const prompt = `Translate to ${targetLangCode}. Keep units and medical names exactly. Text:\n"""${text}"""`;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: TEXT_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    }),
  });
  if (!resp.ok) throw new Error(await resp.text());
  const data = await resp.json();
  return data?.choices?.[0]?.message?.content?.trim() || text;
}

// Routes
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/reports/:id", async (req, res) => {
  const id = req.params.id;
  const row = await dbGet("SELECT * FROM reports WHERE id = ?", [id]);
  if (!row) return res.status(404).send("Report not found");

  const shareUrl = `${baseUrlFrom(req)}/reports/${id}`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl);
  const adminPw = encodeURIComponent(ADMIN_PASSWORD);

  const tpl = fs.readFileSync(path.join(__dirname, "templates", "report.html"), "utf8");
  function esc(v){ return (v ?? "").toString().replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s])); }
  const html = tpl
    .replaceAll("{{created}}", esc(row.created || ""))
    .replaceAll("{{name}}", esc(row.name || ""))
    .replaceAll("{{email}}", esc(row.email || ""))
    .replaceAll("{{blood}}", esc(row.blood || ""))
    .replaceAll("{{emer_name}}", esc(row.emer_name || ""))
    .replaceAll("{{emer_phone}}", esc(row.emer_phone || ""))
    .replaceAll("{{emer_email}}", esc(row.emer_email || ""))
    .replaceAll("{{doc_name}}", esc(row.doc_name || ""))
    .replaceAll("{{doc_phone}}", esc(row.doc_phone || ""))
    .replaceAll("{{doc_fax}}", esc(row.doc_fax || ""))
    .replaceAll("{{doc_email}}", esc(row.doc_email || ""))
    .replaceAll("{{shareUrl}}", esc(shareUrl))
    .replaceAll("{{qrDataUrl}}", esc(qrDataUrl))
    .replaceAll("{{adminPw}}", esc(adminPw))
    .replaceAll("{{detectedLang}}", esc(row.detectedLang || ""))
    .replaceAll("{{targetLang}}", esc(row.targetLang || ""))
    .replaceAll("{{transcript}}", esc(row.transcript || ""))
    .replaceAll("{{translatedTranscript}}", esc(row.translatedTranscript || ""))
    .replaceAll("{{medications}}", esc(row.medications || "None"))
    .replaceAll("{{medicationsT}}", esc(row.medicationsT || (row.medications || "None")))
    .replaceAll("{{allergies}}", esc(row.allergies || "None"))
    .replaceAll("{{allergiesT}}", esc(row.allergiesT || (row.allergies || "None")))
    .replaceAll("{{conditions}}", esc(row.conditions || "None"))
    .replaceAll("{{conditionsT}}", esc(row.conditionsT || (row.conditions || "None")))
    .replaceAll("{{bp}}", esc(row.bp || ""))
    .replaceAll("{{bpT}}", esc(row.bpT || (row.bp || "")))
    .replaceAll("{{weight}}", esc(row.weight || ""))
    .replaceAll("{{weightT}}", esc(row.weightT || (row.weight || "")));

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/reports", async (req, res) => {
  const password = (req.query.password || "").toString();
  if (password !== ADMIN_PASSWORD) return res.status(401).send("Unauthorized — add ?password=");

  const rows = await dbAll(
    "SELECT id, created, name, email, blood, emer_name, emer_phone, emer_email, doc_name, doc_phone, doc_email, detectedLang, targetLang FROM reports ORDER BY datetime(created) DESC"
  );

  const tpl = fs.readFileSync(path.join(__dirname, "templates", "reports.html"), "utf8");
  const base = baseUrlFrom(req);
  const langOptions = [
    ["", "— No translation —"],
    ["en","English"],["fr","Français"],["es","Español"],["pt","Português"],
    ["de","Deutsch"],["it","Italiano"],["ar","العربية"],["hi","हिन्दी"],
    ["zh","中文"],["ja","日本語"],["ko","한국어"],["sr","Srpski"],
    ["pa","ਪੰਜਾਬੀ"],["he","עברית"]
  ];
  const langSelect = (id) => `
    <form action="${base}/reports/${id}/translate" method="GET" class="row">
      <select name="lang">
        ${langOptions.map(([v,l])=>`<option value="${v}">${l}</option>`).join("")}
      </select>
      <input type="hidden" name="password" value="${ADMIN_PASSWORD}">
      <button type="submit">Translate</button>
    </form>`;

  const listHtml = rows.map(r=>{
    const share = `${base}/reports/${r.id}`;
    return `
      <div class="card">
        <div class="row1">
          <div class="title">
            <span class="badge">Report for</span> <b>${(r.name||"—")}</b>
          </div>
          <div class="actions">
            <a class="btn" target="_blank" href="${share}" title="Open">🔗 Open</a>
            <a class="btn" target="_blank" href="mailto:${r.email}?subject=Hot%20Health%20Report&body=${encodeURIComponent(share)}" title="Email Patient">📧 Patient</a>
            <a class="btn" target="_blank" href="mailto:${r.emer_email}?subject=Shared%20Hot%20Health%20Report&body=${encodeURIComponent(share)}" title="Email Emergency">🆘 Emergency</a>
            <a class="btn danger" href="${base}/reports/${r.id}/delete?password=${ADMIN_PASSWORD}" title="Delete">🗑️ Delete</a>
          </div>
        </div>
        <div class="row2">
          <div class="info">
            <span title="Created">🕒 ${r.created}</span>
            <span title="Blood">🩸 ${r.blood||"—"}</span>
            <span title="Patient email">📧 ${r.email||"—"}</span>
            <span title="Emergency">🆘 ${r.emer_name||"—"} • ${r.emer_phone||"—"} • ${r.emer_email||"—"}</span>
            <span title="Doctor">👨‍⚕️ ${r.doc_name||"—"} • ${r.doc_phone||"—"} • ${r.doc_email||"—"}</span>
            <span title="Lang">🌐 ${r.detectedLang||"?"} → ${r.targetLang||"—"}</span>
          </div>
          <div class="translate">
            ${langSelect(r.id)}
          </div>
        </div>
      </div>
    `;
  }).join("");

  const html = tpl.replace("{{LIST}}", listHtml);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

app.get("/reports/:id/translate", async (req, res) => {
  const password = (req.query.password || "").toString();
  if (password !== ADMIN_PASSWORD) return res.status(401).send("Unauthorized");
  const id = req.params.id;
  const targetLang = (req.query.lang || "").toString().trim();
  const row = await dbGet("SELECT * FROM reports WHERE id = ?", [id]);
  if (!row) return res.status(404).send("Not found");

  let [medsT, allergiesT, conditionsT, bpT, weightT, translatedTranscript] =
    ["", "", "", "", "", ""];
  try {
    if (row.medications) medsT = await openaiTranslate(row.medications, targetLang);
    if (row.allergies)   allergiesT = await openaiTranslate(row.allergies, targetLang);
    if (row.conditions)  conditionsT = await openaiTranslate(row.conditions, targetLang);
    if (row.bp)          bpT = await openaiTranslate(row.bp, targetLang);
    if (row.weight)      weightT = await openaiTranslate(row.weight, targetLang);
    if (row.transcript)  translatedTranscript = await openaiTranslate(row.transcript, targetLang);
  } catch (e) {
    console.error("translate error:", e.message);
  }

  await dbRun(
    `UPDATE reports SET
      targetLang = ?,
      translatedTranscript = ?,
      medicationsT = ?, allergiesT = ?, conditionsT = ?,
      bpT = ?, weightT = ?
     WHERE id = ?`,
    [targetLang, translatedTranscript, medsT, allergiesT, conditionsT, bpT, weightT, id]
  );

  res.redirect(`/reports/${id}`);
});

app.get("/reports/:id/delete", async (req, res) => {
  const password = (req.query.password || "").toString();
  if (password !== ADMIN_PASSWORD) return res.status(401).send("Unauthorized");
  await dbRun("DELETE FROM reports WHERE id = ?", [req.params.id]);
  res.redirect(`/reports?password=${ADMIN_PASSWORD}`);
});

app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: "No file" });

    const name = (req.body.name || "").trim();
    const email = (req.body.email || "").trim();
    const blood = (req.body.blood_type || "").trim();
    const emer_name = (req.body.emer_name || "").trim();
    const emer_phone = (req.body.emer_phone || "").trim();
    const emer_email = (req.body.emer_email || "").trim();
    const doc_name  = (req.body.doc_name || "").trim();
    const doc_phone = (req.body.doc_phone || "").trim();
    const doc_fax   = (req.body.doc_fax || "").trim();
    const doc_email = (req.body.doc_email || "").trim();
    const targetLang = (req.body.lang || "").trim();

    console.log("📥 Upload received:", {
      hasFile: !!file, filePath: file.path, originalName: file.originalname,
      mime: file.mimetype, size: file.size
    });

    let transcript = "";
    try {
      const t1 = await openaiTranscribe(file.path, file.originalname, TRANSCRIBE_MODEL);
      transcript = (t1.text || "").trim();
      console.log("✅ Transcribed (gpt-4o-mini-transcribe) chars:", transcript.length);
    } catch (e) {
      console.warn("… primary transcribe failed, trying whisper-1:", e.message);
      const t2 = await openaiTranscribe(file.path, file.originalname, FALLBACK_TRANSCRIBE_MODEL);
      transcript = (t2.text || "").trim();
      console.log("✅ Transcribed (whisper-1) chars:", transcript.length);
    }

    const facts = await openaiExtractFacts(transcript);
    const meds = cleanList(facts.medications || []);
    let allergies = cleanList(facts.allergies || []);
    let conditions = cleanList(facts.conditions || []);
    const bp = (facts.blood_pressure || "").trim();
    const weight = (facts.weight || "").trim();

    function looksLikeWeight(s){
      return /\b(weigh(?:ed|s|ing)?|weight)\b/i.test(s) ||
             /\b(\d{2,3})\s?(kg|kilograms|kilos|lbs|pounds)\b/i.test(s);
    }
    function looksLikeBP(s){
      return /\b\d{2,3}\s*\/\s*\d{2,3}\b/.test(s) || /\bblood\s*pressure\b/i.test(s);
    }
    conditions = conditions.filter(c => c && !looksLikeWeight(c) && !looksLikeBP(c));
    allergies = uniq(allergies);
    conditions = uniq(conditions);

    // detect language (simple)
    let detectedLang = "en";
    try {
      const det = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: TEXT_MODEL,
          messages: [{ role: "user", content: `Detect language code (2 letters) for:\n"""${transcript}"""\nRespond with only the code.` }],
          temperature: 0
        }),
      });
      const dd = await det.json();
      const langCode = (dd?.choices?.[0]?.message?.content || "en").trim().slice(0,2).toLowerCase();
      if (/^[a-z]{2}$/.test(langCode)) detectedLang = langCode;
    } catch (e) {
      console.warn("lang detect failed:", e.message);
    }

    // upload-time translate (optional)
    let translatedTranscript = transcript;
    let medsT = meds.join(", ");
    let allergiesT = allergies.join(", ");
    let conditionsT = conditions.join(", ");
    let bpT = bp;
    let weightT = weight;
    if (targetLang) {
      try {
        translatedTranscript = await openaiTranslate(transcript, targetLang);
        medsT = meds.length ? await openaiTranslate(meds.join(", "), targetLang) : "";
        allergiesT = allergies.length ? await openaiTranslate(allergies.join(", "), targetLang) : "";
        conditionsT = conditions.length ? await openaiTranslate(conditions.join(", "), targetLang) : "";
        bpT = bp ? await openaiTranslate(bp, targetLang) : "";
        weightT = weight ? await openaiTranslate(weight, targetLang) : "";
      } catch (e) {
        console.warn("upload-time translate failed:", e.message);
      }
    }

    const id = shortId();
    const created = new Date().toISOString().replace("T", " ").slice(0, 19);
    await dbRun(
      `INSERT INTO reports
        (id, created, name, email, emer_name, emer_phone, emer_email, blood,
         doc_name, doc_phone, doc_fax, doc_email,
         transcript, translatedTranscript, detectedLang, targetLang,
         medications, medicationsT, allergies, allergiesT, conditions, conditionsT,
         bp, bpT, weight, weightT)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, created, name, email, emer_name, emer_phone, emer_email, blood,
        doc_name, doc_phone, doc_fax, doc_email,
        transcript, translatedTranscript, detectedLang, targetLang,
        meds.join(", "), medsT, allergies.join(", "), allergiesT, conditions.join(", "), conditionsT,
        bp, bpT, weight, weightT
      ]
    );

    const shareUrl = `${baseUrlFrom(req)}/reports/${id}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    res.json({ ok: true, id, shareUrl, qrDataUrl });
  } catch (e) {
    console.error("UPLOAD error:", e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
