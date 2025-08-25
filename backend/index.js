// backend/index.js  (sqlite3-only, doctor defaults, pharmacy fields, no 'sqlite' helper)
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

const app = express();
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// uploads/
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer (expects field name: "audio")
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

// sqlite3 helper (promisified)
sqlite3.verbose();
const dbFile = path.join(process.cwd(), "hothealth.sqlite");
const db = new sqlite3.Database(dbFile);
const dbExec = (sql) => new Promise((res, rej) => db.exec(sql, (e)=>e?rej(e):res()));
const dbRun  = (sql, p=[]) => new Promise((res, rej)=>db.run(sql,p,function(e){e?rej(e):res(this)}));
const dbGet  = (sql, p=[]) => new Promise((res, rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));
const dbAll  = (sql, p=[]) => new Promise((res, rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)));

// schema init (adds pharmacy + doctor defaults handled at insert time)
async function initDb(){
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
      pharm_name TEXT,
      pharm_phone TEXT,
      pharm_fax TEXT,
      pharm_address TEXT,
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
  async function addCol(name, def){ try{ await dbExec(`ALTER TABLE reports ADD COLUMN ${name} ${def}`);}catch{} }
  await addCol("pharm_name","TEXT");
  await addCol("pharm_phone","TEXT");
  await addCol("pharm_fax","TEXT");
  await addCol("pharm_address","TEXT");
  await addCol("medicationsT","TEXT");
  await addCol("allergiesT","TEXT");
  await addCol("conditionsT","TEXT");
  await addCol("bpT","TEXT");
  await addCol("weightT","TEXT");
}
await initDb();

function baseUrlFrom(req){
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/,"");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host  = req.headers["x-forwarded-host"]  || req.headers.host;
  return `${proto}://${host}`.replace(/\/+$/,"");
}
function shortId(){ return crypto.randomBytes(8).toString("hex"); }
function cleanList(a){ return (a||[]).map(s=>(s||"").trim()).filter(Boolean); }
function uniq(a){ return [...new Set(a)]; }

// OpenAI helpers
async function openaiTranscribe(localPath, filename, model){
  const endpoint = "https://api.openai.com/v1/audio/transcriptions";
  const FormData = (await import("form-data")).default;
  const form = new FormData();
  form.append("model", model);
  form.append("file", fs.createReadStream(localPath), { filename });
  const resp = await fetch(endpoint, { method:"POST", headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  return resp.json();
}
async function openaiExtractFacts(transcript){
  const prompt = `
Return strict JSON with:
{"medications":["name — amount units",...],
 "allergies":[],
 "conditions":[],
 "blood_pressure":"",
 "weight":""}
Rules: Do not put weight/BP into conditions.
Text:"""${transcript}"""`;
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body: JSON.stringify({ model: TEXT_MODEL, messages:[{role:"user",content:prompt}], temperature:0.2 })
  });
  if(!r.ok) throw new Error(await r.text());
  const j = await r.json();
  try { return JSON.parse(j?.choices?.[0]?.message?.content || "{}"); }
  catch { return { medications:[], allergies:[], conditions:[], blood_pressure:"", weight:"" }; }
}
async function openaiTranslate(text, lang){
  if (!lang) return text;
  const prompt = `Translate to ${lang}. Keep meds and units exact.\n"""${text}"""`;
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,"Content-Type":"application/json"},
    body: JSON.stringify({ model: TEXT_MODEL, messages:[{role:"user",content:prompt}], temperature:0.2 })
  });
  if(!r.ok) throw new Error(await r.text());
  const j = await r.json();
  return j?.choices?.[0]?.message?.content?.trim() || text;
}

// routes
app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.get("/health", (_req,res)=>res.json({ok:true}));

app.get("/reports/:id", async (req,res)=>{
  const id = req.params.id;
  const row = await dbGet("SELECT * FROM reports WHERE id = ?", [id]);
  if (!row) return res.status(404).send("Report not found");

  const shareUrl = `${baseUrlFrom(req)}/reports/${id}`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl);
  const tpl = fs.readFileSync(path.join(__dirname,"templates","report.html"),"utf8");
  const esc = (v)=> (v??"").toString().replace(/[&<>]/g,s=>({ "&":"&amp;","<":"&lt;",">":"&gt;"}[s]));
  const html = tpl
    .replaceAll("{{created}}", esc(row.created||""))
    .replaceAll("{{name}}", esc(row.name||""))
    .replaceAll("{{email}}", esc(row.email||""))
    .replaceAll("{{blood}}", esc(row.blood||""))
    .replaceAll("{{emer_name}}", esc(row.emer_name||"N/A"))
    .replaceAll("{{emer_phone}}", esc(row.emer_phone||"N/A"))
    .replaceAll("{{emer_email}}", esc(row.emer_email||"N/A"))
    .replaceAll("{{doc_name}}", esc(row.doc_name||"N/A"))
    .replaceAll("{{doc_phone}}", esc(row.doc_phone||"N/A"))
    .replaceAll("{{doc_fax}}", esc(row.doc_fax||"N/A"))
    .replaceAll("{{doc_email}}", esc(row.doc_email||"N/A"))
    .replaceAll("{{pharm_name}}", esc(row.pharm_name||"N/A"))
    .replaceAll("{{pharm_phone}}", esc(row.pharm_phone||"N/A"))
    .replaceAll("{{pharm_fax}}", esc(row.pharm_fax||"N/A"))
    .replaceAll("{{pharm_address}}", esc(row.pharm_address||"N/A"))
    .replaceAll("{{shareUrl}}", esc(shareUrl))
    .replaceAll("{{qrDataUrl}}", esc(qrDataUrl))
    .replaceAll("{{detectedLang}}", esc(row.detectedLang||""))
    .replaceAll("{{targetLang}}", esc(row.targetLang||""))
    .replaceAll("{{transcript}}", esc(row.transcript||""))
    .replaceAll("{{translatedTranscript}}", esc(row.translatedTranscript||""))
    .replaceAll("{{medications}}", esc(row.medications||"None"))
    .replaceAll("{{medicationsT}}", esc(row.medicationsT||row.medications||"None"))
    .replaceAll("{{allergies}}", esc(row.allergies||"None"))
    .replaceAll("{{allergiesT}}", esc(row.allergiesT||row.allergies||"None"))
    .replaceAll("{{conditions}}", esc(row.conditions||"None"))
    .replaceAll("{{conditionsT}}", esc(row.conditionsT||row.conditions||"None"))
    .replaceAll("{{bp}}", esc(row.bp||""))
    .replaceAll("{{bpT}}", esc(row.bpT||row.bp||""))
    .replaceAll("{{weight}}", esc(row.weight||""))
    .replaceAll("{{weightT}}", esc(row.weightT||row.weight||""));
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(html);
});

// list page (unchanged structurally)
app.get("/reports", async (req,res)=>{
  const password = (req.query.password || "").toString();
  if (password !== ADMIN_PASSWORD) return res.status(401).send("Unauthorized — add ?password=");
  const rows = await dbAll("SELECT id, created, name, email, blood, emer_name, emer_phone, emer_email, doc_name, doc_phone, doc_email, pharm_name, detectedLang, targetLang FROM reports ORDER BY datetime(created) DESC");
  const tpl = fs.readFileSync(path.join(__dirname,"templates","reports.html"),"utf8");
  const base = baseUrlFrom(req);
  const listHtml = rows.map(r=>{
    const share = `${base}/reports/${r.id}`;
    return `
      <div class="card">
        <div class="row1">
          <div class="title"><span class="badge">Report for</span> <b>${r.name||"—"}</b></div>
          <div class="actions">
            <a class="btn" target="_blank" href="${share}" title="Open">🔗 Open</a>
            <a class="btn" target="_blank" href="mailto:${r.email}?subject=Hot%20Health%20Report&body=${encodeURIComponent(share)}" title="Email Patient">📧 Patient</a>
          </div>
        </div>
        <div class="row2">
          <div class="info">
            <span>🕒 ${r.created}</span>
            <span>🩸 ${r.blood||"—"}</span>
            <span>👨‍⚕️ ${r.doc_name||"N/A"}</span>
            <span>🏥 ${r.pharm_name||"N/A"}</span>
            <span>🌐 ${r.detectedLang||"?"} → ${r.targetLang||"—"}</span>
          </div>
        </div>
      </div>`;
  }).join("");
  const html = tpl.replace("{{LIST}}", listHtml);
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(html);
});

// translate + delete (unchanged)
app.get("/reports/:id/translate", async (req,res)=>{
  const password = (req.query.password || "").toString();
  if (password !== ADMIN_PASSWORD) return res.status(401).send("Unauthorized");
  const id = req.params.id;
  const targetLang = (req.query.lang || "").toString().trim();
  const row = await dbGet("SELECT * FROM reports WHERE id = ?", [id]);
  if (!row) return res.status(404).send("Not found");
  let medsT = "", allergiesT = "", conditionsT = "", bpT = "", weightT = "", translatedTranscript = "";
  try {
    if (row.medications) medsT = await openaiTranslate(row.medications, targetLang);
    if (row.allergies)   allergiesT = await openaiTranslate(row.allergies, targetLang);
    if (row.conditions)  conditionsT = await openaiTranslate(row.conditions, targetLang);
    if (row.bp)          bpT = await openaiTranslate(row.bp, targetLang);
    if (row.weight)      weightT = await openaiTranslate(row.weight, targetLang);
    if (row.transcript)  translatedTranscript = await openaiTranslate(row.transcript, targetLang);
  } catch (e) { console.error("translate error:", e.message); }
  await dbRun(
    `UPDATE reports SET targetLang=?, translatedTranscript=?, medicationsT=?, allergiesT=?, conditionsT=?, bpT=?, weightT=? WHERE id=?`,
    [targetLang, translatedTranscript, medsT, allergiesT, conditionsT, bpT, weightT, id]
  );
  res.redirect(`/reports/${id}`);
});
app.get("/reports/:id/delete", async (req,res)=>{
  const password = (req.query.password || "").toString();
  if (password !== ADMIN_PASSWORD) return res.status(401).send("Unauthorized");
  await dbRun("DELETE FROM reports WHERE id = ?", [req.params.id]);
  res.redirect(`/reports?password=${ADMIN_PASSWORD}`);
});

// UPLOAD — critical: requires field name "audio"
app.post("/upload", upload.single("audio"), async (req,res)=>{
  try{
    if (!req.file) return res.status(400).json({ ok:false, error:"No file" });

    // patient + contacts
    const name  = (req.body.name  || "").trim();
    const email = (req.body.email || "").trim();
    const blood = (req.body.blood_type || "").trim();
    const emer_name  = (req.body.emer_name  || "").trim();
    const emer_phone = (req.body.emer_phone || "").trim();
    const emer_email = (req.body.emer_email || "").trim();

    // doctor (default N/A if blank)
    const doc_name  = (req.body.doc_name  || "N/A").trim() || "N/A";
    const doc_phone = (req.body.doc_phone || "N/A").trim() || "N/A";
    const doc_fax   = (req.body.doc_fax   || "N/A").trim() || "N/A";
    const doc_email = (req.body.doc_email || "N/A").trim() || "N/A";

    // pharmacy (new) default N/A if blank
    const pharm_name    = (req.body.pharm_name    || "N/A").trim() || "N/A";
    const pharm_phone   = (req.body.pharm_phone   || "N/A").trim() || "N/A";
    const pharm_fax     = (req.body.pharm_fax     || "N/A").trim() || "N/A";
    const pharm_address = (req.body.pharm_address || "N/A").trim() || "N/A";

    const targetLang = (req.body.lang || "").trim();

    console.log("📥 Upload received:", {
      filePath: req.file.path, mime: req.file.mimetype, size: req.file.size
    });

    // transcribe
    let transcript = "";
    try {
      const t1 = await openaiTranscribe(req.file.path, req.file.originalname, TRANSCRIBE_MODEL);
      transcript = (t1.text || "").trim();
      console.log("✅ Transcribed (gpt-4o-mini-transcribe) chars:", transcript.length);
    } catch (e) {
      console.warn("… primary transcribe failed; trying whisper-1:", e.message);
      const t2 = await openaiTranscribe(req.file.path, req.file.originalname, FALLBACK_TRANSCRIBE_MODEL);
      transcript = (t2.text || "").trim();
      console.log("✅ Transcribed (whisper-1) chars:", transcript.length);
    }

    // extract facts
    const facts = await openaiExtractFacts(transcript);
    let medications = cleanList(facts.medications || []);
    let allergies   = cleanList(facts.allergies   || []);
    let conditions  = cleanList(facts.conditions  || []);
    const bp        = (facts.blood_pressure || "").trim();
    const weight    = (facts.weight || "").trim();

    // remove misfiled weight/BP from conditions
    function looksLikeWeight(s){ return /\b(weigh(?:ed|s|ing)?|weight)\b/i.test(s) || /\b\d{2,3}\s?(kg|kilograms|kilos|lbs|pounds)\b/i.test(s); }
    function looksLikeBP(s){ return /\b\d{2,3}\s*\/\s*\d{2,3}\b/.test(s) || /\bblood\s*pressure\b/i.test(s); }
    conditions = conditions.filter(c => c && !looksLikeWeight(c) && !looksLikeBP(c));

    // language detect (best-effort)
    let detectedLang = "en";
    try{
      const det = await fetch("https://api.openai.com/v1/chat/completions",{
        method:"POST",
        headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},
        body: JSON.stringify({
          model: TEXT_MODEL,
          messages:[{role:"user",content:`Detect 2-letter code for:\n"""${transcript}"""\nRespond with only the code.`}],
          temperature:0
        })
      });
      const dd = await det.json();
      const code = (dd?.choices?.[0]?.message?.content || "en").trim().slice(0,2).toLowerCase();
      if (/^[a-z]{2}$/.test(code)) detectedLang = code;
    }catch(e){ console.warn("lang detect failed:", e.message); }

    // optional live translate
    let translatedTranscript = transcript;
    let medicationsT = medications.join(", ");
    let allergiesT   = allergies.join(", ");
    let conditionsT  = conditions.join(", ");
    let bpT = bp;
    let weightT = weight;

    if (targetLang){
      try {
        translatedTranscript = await openaiTranslate(transcript, targetLang);
        if (medications.length) medicationsT = await openaiTranslate(medications.join(", "), targetLang);
        if (allergies.length)   allergiesT   = await openaiTranslate(allergies.join(", "), targetLang);
        if (conditions.length)  conditionsT  = await openaiTranslate(conditions.join(", "), targetLang);
        if (bp)                 bpT          = await openaiTranslate(bp, targetLang);
        if (weight)             weightT      = await openaiTranslate(weight, targetLang);
      } catch(e){ console.warn("upload-time translate failed:", e.message); }
    }

    // persist
    const id = shortId();
    const created = new Date().toISOString().replace("T"," ").slice(0,19);
    await dbRun(
      `INSERT INTO reports
      (id, created, name, email, emer_name, emer_phone, emer_email, blood,
       doc_name, doc_phone, doc_fax, doc_email,
       pharm_name, pharm_phone, pharm_fax, pharm_address,
       transcript, translatedTranscript, detectedLang, targetLang,
       medications, medicationsT, allergies, allergiesT, conditions, conditionsT,
       bp, bpT, weight, weightT)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, created, name, email, emer_name, emer_phone, emer_email, blood,
        doc_name, doc_phone, doc_fax, doc_email,
        pharm_name, pharm_phone, pharm_fax, pharm_address,
        transcript, translatedTranscript, detectedLang, targetLang,
        medications.join(", "), medicationsT, allergies.join(", "), allergiesT, conditions.join(", "), conditionsT,
        bp, bpT, weight, weightT
      ]
    );

    // response (QR + link)
    const shareUrl = `${baseUrlFrom(req)}/reports/${id}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl);
    res.json({ ok:true, id, shareUrl, qrDataUrl });
  }catch(e){
    console.error("UPLOAD error:", e);
    res.status(500).json({ ok:false, error: e.message || "Server error" });
  }
});

app.listen(PORT, ()=> console.log(`✅ Backend listening on ${PORT}`));
