// backend/index.js — full drop-in (login gate before static + gated "/" + same API)
import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import QRCode from "qrcode";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import cookieParser from "cookie-parser";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ========== Config ========== */
const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Hotest";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/,"");

const LOGIN_USER  = process.env.LOGIN_USER  || "Pana123$";
const LOGIN_PASS  = process.env.LOGIN_PASS  || "GoGoPana$";
const COOKIE_SECRET = process.env.COOKIE_SECRET || "hot-health-cookie-secret";

const OPENAI_TRANSCRIBE_PRIMARY  = process.env.OPENAI_TRANSCRIBE_PRIMARY  || "gpt-4o-mini-transcribe";
const OPENAI_TRANSCRIBE_FALLBACK = process.env.OPENAI_TRANSCRIBE_FALLBACK || "whisper-1";
const OPENAI_TEXT_MODEL          = process.env.OPENAI_TEXT_MODEL          || "gpt-4o-mini";

/* ========== Parsers + Cookies (no static yet) ========== */
app.use(bodyParser.json({ limit: "1mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cookieParser(COOKIE_SECRET));

/* ========== Auth Gate BEFORE static ========== */
const OPEN_PATHS = new Set([
  "/healthz",
  "/login",
  "/logout",
  "/styles.css",
  "/app.js",
  "/favicon.ico",
]);

app.use((req, res, next) => {
  // allow login endpoints and static assets defined above
  if (OPEN_PATHS.has(req.path) || req.path.startsWith("/assets/")) return next();
  // allow POST /login explicitly
  if (req.path === "/login" && req.method === "POST") return next();
  // allow already authenticated
  if (req.signedCookies?.hh_auth === "ok") return next();
  // otherwise force login
  return res.redirect("/login");
});

/* ========== Static AFTER gate ========== */
app.use(express.static(path.join(__dirname, "public")));

/* ========== Healthcheck ========== */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ========== Login / Logout ========== */
app.get("/login", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const { user, pass } = req.body || {};
  if (user === LOGIN_USER && pass === LOGIN_PASS) {
    res.cookie("hh_auth", "ok", {
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      maxAge: 1000 * 60 * 60 * 8, // 8h
      // secure: true, // enable if always over https
    });
    return res.redirect("/");
  }
  return res.redirect("/login?error=1");
});

app.get("/logout", (req, res) => {
  res.clearCookie("hh_auth");
  res.redirect("/login");
});

/* ========== Uploads ========== */
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

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
    const mt = (file.mimetype || "").toLowerCase();
    // allow common audio or fall back to octet-stream (let OpenAI validate)
    if (mt === "application/octet-stream" ||
        /audio\/(webm|wav|ogg|mp3|mpeg|mp4|m4a|oga|flac)/i.test(mt)) cb(null, true);
    else cb(null, true);
  },
  limits: { fileSize: 30 * 1024 * 1024 },
});

/* ========== DB (better-sqlite3) ========== */
const db = new Database(path.join(process.cwd(), "data.sqlite"));
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    created TEXT,
    name TEXT,
    email TEXT,
    blood_type TEXT,
    emer_name TEXT,
    emer_phone TEXT,
    emer_email TEXT,
    doc_name TEXT,
    doc_phone TEXT,
    doc_fax TEXT,
    doc_email TEXT,
    pharm_name TEXT,
    pharm_phone TEXT,
    pharm_fax TEXT,
    pharm_address TEXT,
    detected_lang TEXT,
    target_lang TEXT,
    medications TEXT,
    allergies TEXT,
    conditions TEXT,
    bp TEXT,
    weight TEXT,
    transcript TEXT,
    translated_transcript TEXT
  )
`);

const stmtInsertReport = db.prepare(`
  INSERT INTO reports (
    id, created, name, email, blood_type,
    emer_name, emer_phone, emer_email,
    doc_name, doc_phone, doc_fax, doc_email,
    pharm_name, pharm_phone, pharm_fax, pharm_address,
    detected_lang, target_lang,
    medications, allergies, conditions, bp, weight,
    transcript, translated_transcript
  )
  VALUES (@id, @created, @name, @email, @blood_type,
          @emer_name, @emer_phone, @emer_email,
          @doc_name, @doc_phone, @doc_fax, @doc_email,
          @pharm_name, @pharm_phone, @pharm_fax, @pharm_address,
          @detected_lang, @target_lang,
          @medications, @allergies, @conditions, @bp, @weight,
          @transcript, @translated_transcript)
`);
const stmtGetReport   = db.prepare(`SELECT * FROM reports WHERE id = ?`);
const stmtListReports = db.prepare(`SELECT id, created, name FROM reports ORDER BY created DESC LIMIT 200`);

/* ========== Helpers ========== */
function shareBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"]?.toString() || req.protocol;
  const host  = req.headers["x-forwarded-host"]?.toString() || req.get("host");
  return `${proto}://${host}`;
}
const uniq = a => Array.from(new Set(a)).filter(Boolean);

function parseFactsFromText(text) {
  const lower = text.toLowerCase();
  const meds = [];
  const medMatch = text.match(/\b([A-Za-z][A-Za-z0-9\-]+)\b\s*(?:—|-)?\s*(\d+\s*(?:mg|mcg|g|ml))?/g);
  if (medMatch) {
    medMatch.forEach(m => {
      const parts = m.split(/—|-/).map(s => s.trim());
      if (parts[0] && !/^(i|and|the|at|my|weight|weigh|kidney|allergic)$/i.test(parts[0])) {
        meds.push(parts[1] ? `${parts[0]} — ${parts[1]}` : parts[0]);
      }
    });
  }
  const allergies = [];
  if (lower.includes("allergic to")) {
    const seg = text.split(/allergic to/i)[1] || "";
    seg.split(/,|and/).map(s=>s.trim()).forEach(w=>{
      if (w && w.length < 60) allergies.push(w.replace(/\.$/, ""));
    });
  }
  const conditions = [];
  const condWords = ["kidney","heart","liver","diabetes","asthma","hypertension","cancer","pregnancy"];
  condWords.forEach(w=>{
    if (lower.includes(w)) conditions.push(w[0].toUpperCase()+w.slice(1));
  });
  let bp = "";
  const bpMatch = text.match(/\b(\d{2,3})\s*(?:over|\/)\s*(\d{2,3})\b/i);
  if (bpMatch) bp = `${bpMatch[1]}/${bpMatch[2]}`;
  let weight = "";
  const wMatch = text.match(/\b(\d{2,3})\s*(?:pounds?|lbs?)\b/i);
  if (wMatch) weight = `${wMatch[1]} lb`;

  return {
    medications: uniq(meds).slice(0, 12),
    allergies: uniq(allergies).slice(0, 12),
    conditions: uniq(conditions).slice(0, 12),
    bp, weight
  };
}

/* ========== OpenAI ========== */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribe(filePath) {
  const stream = fs.createReadStream(filePath);
  try {
    const r = await openai.audio.transcriptions.create({
      file: stream,
      model: OPENAI_TRANSCRIBE_PRIMARY
    });
    return r.text?.trim() || "";
  } catch {
    const r2 = await openai.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: OPENAI_TRANSCRIBE_FALLBACK
    });
    return r2.text?.trim() || "";
  }
}

async function translateText(text, target) {
  if (!target) return text;
  const r = await openai.chat.completions.create({
    model: OPENAI_TEXT_MODEL,
    messages: [
      { role: "system", content: `Translate into ${target} and keep medical terms precise.` },
      { role: "user", content: text }
    ],
    temperature: 0.2
  });
  return r.choices?.[0]?.message?.content?.trim() || text;
}

/* ========== Report HTML ========== */
function renderReportHTML(data) {
  const {
    created, shareUrl, qrDataUrl,
    name, email, blood,
    emer_name, emer_phone, emer_email,
    doc_name, doc_phone, doc_fax, doc_email,
    pharm_name, pharm_phone, pharm_fax, pharm_address,
    medications, allergies, conditions, bp, weight,
    detectedLang, targetLang, transcript, translatedTranscript
  } = data;

  const list = (arr, empty = "None mentioned") =>
    (arr && arr.length) ? `<ul>${arr.map(x=>`<li>${x}</li>`).join("")}</ul>` : `<p>${empty}</p>`;

  const transcriptBlock = targetLang ? `
  <section class="section">
    <h2>Transcript</h2>
    <div class="dual-block">
      <div class="block">
        <h3>Original (${detectedLang || "auto"})</h3>
        <p>${(transcript || "").replace(/\n/g,"<br>")}</p>
      </div>
      <div class="block">
        <h3>Translated (${targetLang})</h3>
        <p>${(translatedTranscript || "").replace(/\n/g,"<br>")}</p>
      </div>
    </div>
  </section>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Hot Health — Report</title>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body class="report-body">
  <header>
    <h1>Hot Health — Report</h1>
    <p><b>Created:</b> ${created}</p>
    <div class="share-row"><span class="hint">Scan or open the share link:</span>
      <a class="icon-link" href="${shareUrl}" target="_blank" title="Open share link">🔗</a>
    </div>
    <div class="qr"><img src="${qrDataUrl}" alt="QR"></div>
  </header>

  <section class="section">
    <h2>Patient Details</h2>
    <div class="grid-two">
      <div>
        <p><b>Name:</b> ${name || "—"}</p>
        <p><b>Email:</b> ${email ? `<a href="mailto:${email}">${email}</a>` : "—"}</p>
        <p><b>Blood Type:</b> ${blood || "—"}</p>
      </div>
      <div>
        <p><b>Emergency Contact</b><br>
        ${emer_name || "—"}<br>
        ${emer_phone || "—"}<br>
        ${emer_email ? `<a href="mailto:${emer_email}">${emer_email}</a>` : "—"}</p>
      </div>
    </div>
  </section>

  <section class="section">
    <h2>Care Team</h2>
    <div class="grid-two">
      <div>
        <p><b>Family Doctor</b><br>
        ${(doc_name || "N/A")}<br>
        ${doc_phone || "N/A"}<br>
        ${doc_fax || "N/A"}<br>
        ${doc_email ? `<a href="mailto:${doc_email}">${doc_email}</a>` : "N/A"}</p>
      </div>
      <div>
        <p><b>Pharmacy</b><br>
        ${(pharm_name || "N/A")}<br>
        ${pharm_address || "N/A"}<br>
        ${pharm_phone || "N/A"}<br>
        ${pharm_fax || "N/A"}</p>
      </div>
    </div>
  </section>

  <section class="section">
    <h2>Summary</h2>
    <div class="grid-two">
      <div>
        <p><b>Blood Pressure:</b> ${bp || "—"}</p>
        <p><b>Weight:</b> ${weight || "—"}</p>
      </div>
      <div>
        <p><b>Medications</b></p>
        ${list(medications)}
        <p><b>Allergies</b></p>
        ${list(allergies)}
        <p><b>Conditions</b></p>
        ${list(conditions)}
      </div>
    </div>
  </section>

  ${transcriptBlock}

  <footer class="actions">
    <a class="btn" href="/">+ New Report</a>
    <a class="btn" href="/reports?password=${encodeURIComponent(ADMIN_PASSWORD)}">Open Reports</a>
    <a class="btn" href="mailto:?subject=${encodeURIComponent("Hot Health Report")}&body=${encodeURIComponent(shareUrl)}">Email (Default)</a>
    <a class="btn" target="_blank" href="https://mail.google.com/mail/?view=cm&fs=1&to=&su=${encodeURIComponent("Hot Health Report")}&body=${encodeURIComponent(shareUrl)}">Gmail</a>
    <a class="btn" target="_blank" href="https://outlook.live.com/mail/0/deeplink/compose?subject=${encodeURIComponent("Hot Health Report")}&body=${encodeURIComponent(shareUrl)}">Outlook</a>
  </footer>
</body>
</html>`;
}

/* ========== Reports List ========== */
app.get("/reports", (req, res) => {
  const rows = stmtListReports.all();
  const items = rows.map(r => `
    <li>
      <span class="muted">${r.created}</span> • <b>${r.name || "Unknown patient"}</b>
      <a class="btn" href="/reports/${r.id}">Open</a>
    </li>
  `).join("");

  res.send(`<!doctype html><html><head>
  <meta charset="utf-8"/><title>Reports</title>
  <link rel="stylesheet" href="/styles.css">
</head><body class="report-body">
  <header><h1>All Reports</h1></header>
  <ul class="report-list">${items || "<li>No reports yet.</li>"}</ul>
  <footer class="actions"><a class="btn" href="/">+ New Report</a></footer>
</body></html>`);
});

/* ========== Single Report ========== */
app.get("/reports/:id", async (req, res) => {
  const row = stmtGetReport.get(req.params.id);
  if (!row) return res.status(404).send("Not found");

  const base = shareBaseUrl(req);
  const shareUrl = `${base}/reports/${row.id}`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl);

  const html = renderReportHTML({
    created: row.created,
    shareUrl, qrDataUrl,
    name: row.name, email: row.email, blood: row.blood_type,
    emer_name: row.emer_name, emer_phone: row.emer_phone, emer_email: row.emer_email,
    doc_name: row.doc_name, doc_phone: row.doc_phone, doc_fax: row.doc_fax, doc_email: row.doc_email,
    pharm_name: row.pharm_name, pharm_phone: row.pharm_phone, pharm_fax: row.pharm_fax, pharm_address: row.pharm_address,
    medications: JSON.parse(row.medications || "[]"),
    allergies: JSON.parse(row.allergies || "[]"),
    conditions: JSON.parse(row.conditions || "[]"),
    bp: row.bp, weight: row.weight,
    detectedLang: row.detected_lang, targetLang: row.target_lang,
    transcript: row.transcript, translatedTranscript: row.translated_transcript
  });

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

/* ========== Upload API ========== */
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "No file" });

    const {
      name = "",
      email = "",
      blood_type = "",
      emer_name = "",
      emer_phone = "",
      emer_email = "",
      doc_name = "N/A",
      doc_phone = "N/A",
      doc_fax = "N/A",
      doc_email = "N/A",
      pharm_name = "N/A",
      pharm_phone = "N/A",
      pharm_fax = "N/A",
      pharm_address = "N/A",
      lang = ""
    } = req.body;

    const transcript = (await transcribe(req.file.path)) || "";
    const detected_lang = "";
    const facts = parseFactsFromText(transcript);

    const target_lang = lang || "";
    const translated_transcript = target_lang ? await translateText(transcript, target_lang) : "";

    const id = Math.random().toString(36).slice(2, 18);
    const created = new Date().toISOString().replace("T"," ").slice(0,19);

    stmtInsertReport.run({
      id, created, name, email, blood_type,
      emer_name, emer_phone, emer_email,
      doc_name, doc_phone, doc_fax, doc_email,
      pharm_name, pharm_phone, pharm_fax, pharm_address,
      detected_lang, target_lang,
      medications: JSON.stringify(facts.medications || []),
      allergies: JSON.stringify(facts.allergies || []),
      conditions: JSON.stringify(facts.conditions || []),
      bp: facts.bp || "",
      weight: facts.weight || "",
      transcript,
      translated_transcript
    });

    const base = shareBaseUrl(req);
    const shareUrl = `${base}/reports/${id}`;
    const qrDataUrl = await QRCode.toDataURL(shareUrl);

    res.json({ ok: true, id, shareUrl, qrDataUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  } finally {
    setTimeout(() => {
      try { if (req?.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch {}
    }, 15000);
  }
});

/* ========== Gated Home (serves index.html) ========== */
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ========== Start ========== */
app.listen(PORT, () => {
  console.log(`✅ Backend listening on ${PORT}`);
});
