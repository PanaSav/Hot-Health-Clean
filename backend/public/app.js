// Upload logic + clearer “Report Generated” banner (safe update)
const $ = s => document.querySelector(s);
const btnGenerate = $('#btnGenerate');         // your existing Generate button id
const resultBox = $('#result');               // container where we show success banner
const errorBox  = $('#error');                // error text container (keep existing id)
const langDetectedEl = $('#langDetected');    // read-only detected field (if present)
const langTargetEl   = $('#lang');            // your target language <select>

function setError(msg) { if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }

// Serialize all Patient & Options inputs (keep existing ids/names)
function gatherPatientForm() {
  const get = id => ($(id) ? $(id).value.trim() : '');
  return {
    name:     get('#pName'),
    email:    get('#pEmail'),
    emer_name:  get('#eName'),
    emer_phone: get('#ePhone'),
    emer_email: get('#eEmail'),
    blood_type: get('#blood'),
    lang:       get('#lang') || ''
  };
}

// If you already have your six mini recorders combining into note parts,
// keep that logic untouched. We only read the final Blob (or the “classic” one).
async function createReport(audioBlob) {
  setError('');
  setResult('');

  const fd = new FormData();

  // Attach audio if present
  if (audioBlob) {
    fd.append('audio', audioBlob, 'recording.webm');
  }

  // Attach typed fields
  const form = gatherPatientForm();
  for (const [k,v] of Object.entries(form)) fd.append(k, v);

  // Optional: surface detected language in UI if your backend returns it
  if (langDetectedEl) langDetectedEl.value = (window.__lastDetectedLang || '');

  const resp = await fetch('/upload', { method:'POST', body: fd });
  if (!resp.ok) {
    // If backend returned HTML error page, show a friendly message
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

// Hook to your existing “Generate Report” button
if (btnGenerate) {
  btnGenerate.addEventListener('click', async () => {
    try {
      // If you keep a global blob for the classic recorder, reuse it:
      const blob = window.__lastRecordedBlob || null;

      const json = await createReport(blob);
      if (!json.ok) throw new Error(json.error || 'Server error');

      // Prettier green banner with icon + actions
      const shareUrl = json.url;
      const target = (langTargetEl && langTargetEl.value) ? langTargetEl.value : '';
      const banner = `
        <div class="report-banner">
          <div class="report-icon">✅</div>
          <div class="report-text">
            <div class="report-title">Report Generated</div>
            <div class="report-sub">
              ${target ? `Translated to <b>${target.toUpperCase()}</b>. ` : ''}Open, share or email below.
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

      // Copy handler
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
    } catch (e) {
      setError(e.message || String(e));
    }
  });
}

// (Optional) If you auto-detect language on page load, set it in the UI field.
// Just set window.__lastDetectedLang somewhere in your existing code; we’ll display it if the read-only input exists.
</script>
