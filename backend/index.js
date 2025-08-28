<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Hot Health — One Port</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href="/styles.css" />
  <style>
    /* Lightweight layout helpers in case your styles.css is older */
    .wrap { max-width: 980px; margin: 0 auto; padding: 16px; }
    header { display:flex; gap:12px; align-items:center; justify-content:space-between; border-bottom:3px solid aquamarine; padding:12px 0; }
    header h1 { margin:0; color:#4b0082; }
    .row { display:flex; gap:8px; flex-wrap:wrap; }
    .card { background:#fff; border:2px solid aquamarine; border-radius:12px; padding:14px; margin:14px 0; }
    .rec-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:12px; }
    .rec { border:1px solid #dbe7ff; background:#f8faff; border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:8px; }
    .rec .top { display:flex; align-items:center; justify-content:space-between; gap:8px; }
    .rec .label { font-weight:600; }
    .rec .hint { font-size:12px; color:#566; }
    .rec .status { font-size:12px; color:#334; min-height:1.3em; }
    .pill { display:inline-flex; align-items:center; gap:6px; border:1px solid #dbe7ff; background:#eef4ff; border-radius:999px; padding:6px 10px; cursor:pointer; user-select:none; }
    .pill[disabled] { opacity:.6; cursor:not-allowed; }
    .pill .dot { width:10px; height:10px; border-radius:50%; background:#999; }
    .pill.rec-on .dot { background:#e11; box-shadow:0 0 0 3px rgba(255,0,0,.15); }
    .danger { color:#b00; }
    .success { color:#08660e; }
    .btn { text-decoration:none; border:1px solid #dbe7ff; padding:9px 12px; border-radius:8px; background:#f0f5ff; color:#234; font-size:14px; display:inline-flex; align-items:center; gap:6px; }
    .btn.primary { background:#0a84ff; color:#fff; border-color:#0a84ff; }
    .btnbar { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .muted { color:#556; font-size:13px; }
    input, select { padding:10px 12px; border:1px solid #cfd8ea; border-radius:8px; font-size:14px; }
    .error { color:#b00; }
    .ok { color:#08660e; }
  </style>
</head>
<body>
  <header class="wrap">
    <h1>Hot Health — One Port</h1>
    <nav class="btnbar">
      <a class="btn" href="/reports">Open Reports</a>
      <form method="POST" action="/logout" style="display:inline">
        <button class="btn" type="submit">Log out</button>
      </form>
    </nav>
  </header>

  <main class="wrap">
    <!-- PATIENT & OPTIONS -->
    <section class="card">
      <h2>Patient & Options</h2>
      <div class="row">
        <input id="pName" placeholder="Patient Name" />
        <input id="pEmail" placeholder="Patient Email" />
      </div>
      <div class="row">
        <input id="eName" placeholder="Emergency Contact Name" />
        <input id="ePhone" placeholder="Emergency Contact Phone" />
        <input id="eEmail" placeholder="Emergency Contact Email" />
      </div>
      <div class="row">
        <select id="blood">
          <option value="">Blood Type (optional)</option>
          <option>O+</option><option>O-</option><option>A+</option><option>A-</option>
          <option>B+</option><option>B-</option><option>AB+</option><option>AB-</option>
        </select>
        <select id="lang">
          <option value="">— Target language (optional) —</option>
          <option value="en">English</option><option value="fr">Français</option><option value="es">Español</option>
          <option value="pt">Português</option><option value="de">Deutsch</option><option value="it">Italiano</option>
          <option value="ar">العربية</option><option value="hi">हिन्दी</option><option value="pa">ਪੰਜਾਬੀ</option>
          <option value="sr">Srpski</option><option value="he">עברית</option><option value="zh">中文</option>
          <option value="ja">日本語</option><option value="ko">한국어</option>
        </select>
      </div>
    </section>

    <!-- SIX MINI RECORDERS -->
    <section class="card">
      <h2>Record Health Status</h2>
      <div class="muted" style="margin-bottom:8px;">
        Tip: speak your health note (e.g., meds, allergies, conditions, BP, weight). Each recorder auto-stops.
      </div>

      <div class="rec-grid">

        <div class="rec" data-id="bp" data-max="30">
          <div class="top">
            <div class="label">Blood Pressure</div>
            <button class="pill mic">
              <span class="dot"></span>
              <span class="txt">Record (max 30s)</span>
            </button>
          </div>
          <div class="hint">Say e.g. “120 over 75”.</div>
          <div class="status" aria-live="polite"></div>
        </div>

        <div class="rec" data-id="meds" data-max="60">
          <div class="top">
            <div class="label">Medications & Dose</div>
            <button class="pill mic">
              <span class="dot"></span>
              <span class="txt">Record (max 60s)</span>
            </button>
          </div>
          <div class="hint">List meds like “Lisinopril 10 mg, Metformin 500 mg”.</div>
          <div class="status" aria-live="polite"></div>
        </div>

        <div class="rec" data-id="allergies" data-max="45">
          <div class="top">
            <div class="label">Allergies</div>
            <button class="pill mic">
              <span class="dot"></span>
              <span class="txt">Record (max 45s)</span>
            </button>
          </div>
          <div class="hint">e.g., “allergic to penicillin, peanuts, dust”.</div>
          <div class="status" aria-live="polite"></div>
        </div>

        <div class="rec" data-id="weight" data-max="30">
          <div class="top">
            <div class="label">Weight</div>
            <button class="pill mic">
              <span class="dot"></span>
              <span class="txt">Record (max 30s)</span>
            </button>
          </div>
          <div class="hint">e.g., “I weigh 215 pounds”.</div>
          <div class="status" aria-live="polite"></div>
        </div>

        <div class="rec" data-id="conditions" data-max="60">
          <div class="top">
            <div class="label">Conditions</div>
            <button class="pill mic">
              <span class="dot"></span>
              <span class="txt">Record (max 60s)</span>
            </button>
          </div>
          <div class="hint">e.g., “I have a kidney condition”.</div>
          <div class="status" aria-live="polite"></div>
        </div>

        <div class="rec" data-id="note" data-max="60">
          <div class="top">
            <div class="label">General Health Note</div>
            <button class="pill mic">
              <span class="dot"></span>
              <span class="txt">Record (max 60s)</span>
            </button>
          </div>
          <div class="hint">Any other details your clinician should know.</div>
          <div class="status" aria-live="polite"></div>
        </div>

      </div>
    </section>

    <!-- ACTIONS -->
    <section class="card">
      <h2>Shareable Report</h2>
      <div class="btnbar">
        <button id="btnGen" class="btn primary">Generate Report</button>
        <a class="btn" href="/reports">Open Reports</a>
      </div>
      <div id="result" class="muted" style="margin-top:8px;">Record in any tiles above, then click Generate Report.</div>
      <div id="error" class="error" style="margin-top:6px;"></div>
    </section>
  </main>

  <script src="/app.js"></script>
</body>
</html>
