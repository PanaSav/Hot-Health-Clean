// Frontend helpers: clear banner, show errors, detect language, generate report banner + actions

const $ = s => document.querySelector(s);

const btnGenerate   = $('#btnGenerate');          // your existing Generate button
const resultBox     = $('#result');               // where success banner goes
const errorBox      = $('#error');                // errors
const langDetected  = $('#langDetected');         // read-only "Detected" input
const langTargetSel = $('#lang');                 // target <select>
const btnDetectLang = $('#btnDetectLang');        // optional "Detect" button
const langConfirmUI = $('#langConfirm');          // optional confirmation container

function setError(msg){ if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }

function gatherPatientForm() {
  const get = id => { const el = document.querySelector(id); return el ? el.value.trim() : ''; };
  return {
    name: get('#pName'),
    email: get('#pEmail'),
    emer_name:  get('#eName'),
    emer_phone: get('#ePhone'),
    emer_email: get('#eEmail'),
    blood_type: get('#blood'),
    lang:       (langTargetSel && langTargetSel.value) ? langTargetSel.value.trim() : ''
  };
}

// Build a sample of what the user typed for language detection (safe subset)
function sampleForDetection() {
  const parts = [];
  const ids = ['#pName','#pEmail','#eName','#ePhone','#eEmail','#doctorName','#pharmacyName','#typed_general'];
  ids.forEach(id => {
    const el = document.querySelector(id);
    if (el && el.value) parts.push(el.value);
  });
  // limit to 800 chars
  return parts.join('\n').slice(0, 800);
}

async function detectLanguageNow() {
  const sample = sampleForDetection();
  if (!sample) {
    // no text yet; nothing to detect
    if (langConfirmUI) langConfirmUI.innerHTML = '<div class="muted">Add a few words, then Detect.</div>';
    return;
  }
  try {
    const resp = await fetch('/detect-lang', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ sample })
    });
    const j = await resp.json();
    const code = (j.code || '').toLowerCase();
    const name = j.name || code.toUpperCase();

    if (langDetected) langDetected.value = name || '';

    if (langConfirmUI) {
      if (!code) {
        langConfirmUI.innerHTML = '<div class="muted">Couldn’t detect. You can still select a target language.</div>';
      } else {
        // Build confirm mini-UI
        const options = [...(langTargetSel?.options || [])].map(o=>o.value);
        const canSelect = options.includes(code);
        const confirmBtn = canSelect
          ? `<button class="btn" id="btnConfirmLang" type="button">Use ${name}</button>`
          : '';
        langConfirmUI.innerHTML = `
          <div class="lang-banner">
            <div class="lang-icon">🗣️</div>
            <div class="lang-text">
              <div class="lang-title">We think you’re speaking <b>${name}</b>.</div>
              <div class="lang-sub">Confirm or choose a target language below.</div>
            </div>
            <div class="lang-actions">
              ${confirmBtn}
            </div>
          </div>
        `;
        if (canSelect) {
          const b = $('#btnConfirmLang');
          if (b) b.addEventListener('click', () => {
            // If you want to set target == detected, set it here; otherwise leave as a confirmation visual only
            langTargetSel.value = code; // simple behavior: mirror to target
            b.textContent = 'Language Set';
            setTimeout(()=> b.textContent='Use '+name, 1200);
          });
        }
      }
    }
  } catch {
    if (langConfirmUI) langConfirmUI.innerHTML = '<div class="muted">Detection unavailable right now.</div>';
  }
}

// Attach Detect button if present
if (btnDetectLang) {
  btnDetectLang.addEventListener('click', detectLanguageNow);
}

// Create a report (classic flow — your existing single recorder, or no audio)
async function createReport(audioBlob) {
  setError('');
  setResult('');

  const fd = new FormData();

  if (audioBlob) fd.append('audio', audioBlob, 'recording.webm');

  const form = gatherPatientForm();
  Object.entries(form).forEach(([k,v])=> fd.append(k, v));

  const resp = await fetch('/upload', { method:'POST', body: fd });
  if (!resp.ok) {
    let msg = `Upload failed (${resp.status})`;
    try {
      const txt = await resp.text();
      if (txt.startsWith('{')) {
        const j = JSON.parse(txt);
        if (j.error) msg = j.error;
      }
    } catch {}
    throw new Error(msg);
  }
  return resp.json();
}

// Pretty green banner with actions
function showReportBanner(shareUrl, targetCode) {
  const target = targetCode ? targetCode.toUpperCase() : '';
  const banner = `
    <div class="report-banner">
      <div class="report-icon">✅</div>
      <div class="report-text">
        <div class="report-title">Report Generated</div>
        <div class="report-sub">
          ${target ? `Translated to <b>${target}</b>. ` : ''}Open, share or email below.
        </div>
      </div>
      <div class="report-actions">
        <a class="btn" href="${shareUrl}" target="_blank" rel="noopener">Open Report</a>
        <button class="btn" id="btnCopyLink" type="button">Copy Link</button>
        <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Hot%20Health%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Gmail</a>
        <a class="btn" href="https://outlook.live.com/owa/?path=/mail/action/compose&subject=Hot%20Health%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Outlook</a>
      </div>
    </div>
  `;
  setResult(banner);
  const copyBtn = $('#btnCopyLink');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(shareUrl);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy Link'), 1500);
      } catch {}
    });
  }
}

// Wire Generate button (uses your global classic blob if present)
if (btnGenerate) {
  btnGenerate.addEventListener('click', async () => {
    try {
      const blob = window.__lastRecordedBlob || null;
      const json = await createReport(blob);
      if (!json.ok) throw new Error(json.error || 'Server error');
      // surface detected if backend returned it
      if (langDetected && json.detected_lang) langDetected.value = json.detected_lang.toUpperCase();

      const selected = (langTargetSel && langTargetSel.value) ? langTargetSel.value : '';
      showReportBanner(json.url, selected);
    } catch (e) {
      setError(e.message || String(e));
    }
  });
}
