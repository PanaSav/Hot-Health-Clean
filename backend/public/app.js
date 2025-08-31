// Frontend logic for six mini recorders, field mics, language detect, and reporting banner

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const btnGenerate = $('#btnGenerate');
const resultBox   = $('#result');
const errorBox    = $('#error');

const langDetectedEl = $('#langDetected');
const detectNameEl   = $('#detectName');
const btnDetect      = $('#btnDetect');
const langTargetEl   = $('#lang');

function setError(msg){ if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }

// -------- Field mic (SpeechRecognition) with email normalization -------
(function fieldMics(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function normalizeEmailSpoken(raw) {
    if (!raw) return '';
    let s = (' ' + raw.toLowerCase().trim() + ' ').replace(/\s+/g,' ');
    s = s.replace(/\sat\s/g, '@')
         .replace(/\sdot\s/g, '.')
         .replace(/\speriod\s/g, '.')
         .replace(/\sunderscore\s/g, '_')
         .replace(/\s(hyphen|dash)\s/g, '-')
         .replace(/\splus\s/g, '+');

    // common domains
    s = s.replace(/ gmail\s*(dot)?\s*com/g, '@gmail.com ')
         .replace(/ outlook\s*(dot)?\s*com/g, '@outlook.com ')
         .replace(/ hotmail\s*(dot)?\s*com/g, '@hotmail.com ')
         .replace(/ yahoo\s*(dot)?\s*com/g, '@yahoo.com ');

    // trim spaces around @ / .
    s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.').trim();

    // no spaces in emails
    s = s.replace(/\s+/g, '');
    s = s.replace(/\.\.+/g, '.');
    return s;
  }

  function isEmailField(el) {
    const id = (el.id||'').toLowerCase();
    const name = (el.name||'').toLowerCase();
    const type = (el.type||'').toLowerCase();
    return type === 'email' || id.includes('email') || name.includes('email');
  }

  $$('.mic-btn').forEach(btn => {
    if (!SR) { btn.disabled = true; btn.title = 'Speech recognition not supported'; return; }
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;

      const rec = new SR();
      rec.lang = (window.__uiLang || 'en-US');
      rec.interimResults = false; rec.maxAlternatives = 1;

      const original = el.style.backgroundColor;
      btn.classList.add('mic-active');
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = e => {
        const raw = e.results[0][0].transcript || '';
        const text = isEmailField(el) ? normalizeEmailSpoken(raw) : raw;
        if (el.tagName === 'SELECT') {
          const lower = text.toLowerCase();
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(lower));
          if (opt) el.value = opt.value;
        } else el.value = text;
      };
      rec.onend = () => { btn.classList.remove('mic-active'); el.style.backgroundColor = original; };
      rec.onerror = () => { btn.classList.remove('mic-active'); el.style.backgroundColor = original; };

      try { rec.start(); } catch { btn.classList.remove('mic-active'); el.style.backgroundColor = original; }
    });
  });
})();

// -------- Six mini recorders (MediaRecorder) ---------------------------
const recorders = {
  bp:         { dur: 20_000, chunks: [], blob: null, elMeta: '#meta_bp' },
  meds:       { dur:180_000, chunks: [], blob: null, elMeta: '#meta_meds' },
  allergies:  { dur: 60_000, chunks: [], blob: null, elMeta: '#meta_allergies' },
  weight:     { dur: 60_000, chunks: [], blob: null, elMeta: '#meta_weight' },
  conditions: { dur:180_000, chunks: [], blob: null, elMeta: '#meta_conditions' },
  general:    { dur:180_000, chunks: [], blob: null, elMeta: '#meta_general' }
};

const active = {}; // key -> {mediaRecorder, timer}
$$('.rec').forEach(btn => {
  btn.addEventListener('click', async () => {
    const key = btn.getAttribute('data-key');
    const R = recorders[key]; if (!R) return;
    const meta = $(R.elMeta);

    if (!active[key]) {
      // start
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { meta && (meta.textContent = 'Mic blocked'); return; }

      R.chunks = []; R.blob = null;
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mr.ondataavailable = e => { if (e.data && e.data.size) R.chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        R.blob = new Blob(R.chunks, { type:'audio/webm' });
        meta && (meta.textContent = `Recorded ${(R.blob.size/1024).toFixed(1)} KB`);
        btn.textContent = '🎤 Record';
        active[key] = null;
      };
      mr.start();
      btn.textContent = '⏹️ Stop';
      meta && (meta.textContent = 'Recording…');

      const timer = setTimeout(() => { if (mr.state !== 'inactive') mr.stop(); }, R.dur);
      active[key] = { mediaRecorder: mr, timer };
    } else {
      // stop
      const { mediaRecorder, timer } = active[key];
      clearTimeout(timer);
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    }
  });
});

// -------- Helpers to gather typed + blobs ------------------------------
function getVal(id){ const el = $(id); return el ? el.value.trim() : ''; }

function gatherPatient() {
  return {
    name: getVal('#pName'),
    email: getVal('#pEmail'),
    emer_name: getVal('#eName'),
    emer_phone: getVal('#ePhone'),
    emer_email: getVal('#eEmail'),
    blood_type: getVal('#blood'),
    doctor_name: getVal('#doctor_name'),
    doctor_address: getVal('#doctor_address'),
    doctor_phone: getVal('#doctor_phone'),
    doctor_fax: getVal('#doctor_fax'),
    doctor_email: getVal('#doctor_email'),
    pharmacy_name: getVal('#pharmacy_name'),
    pharmacy_address: getVal('#pharmacy_address'),
    pharmacy_phone: getVal('#pharmacy_phone'),
    pharmacy_fax: getVal('#pharmacy_fax'),
    lang: getVal('#lang')
  };
}

function gatherTypedParts() {
  return {
    typed_bp: getVal('#typed_bp'),
    typed_meds: getVal('#typed_meds'),
    typed_allergies: getVal('#typed_allergies'),
    typed_weight: getVal('#typed_weight'),
    typed_conditions: getVal('#typed_conditions'),
    typed_general: getVal('#typed_general')
  };
}

// -------- Detect language (server) ------------------------------------
async function detectLanguageSample() {
  const parts = gatherTypedParts();
  // Build a small sample: prefer typed; if none, just a stub
  const sample = Object.values(parts).filter(Boolean).join('\n').slice(0, 2000) || 'hello';
  const r = await fetch('/detect-language', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ text: sample })
  });
  const j = await r.json();
  if (j.ok) {
    if (langDetectedEl) langDetectedEl.value = j.name || j.code || '';
    if (detectNameEl)   detectNameEl.textContent = j.name || '—';
    window.__detectedLangCode = j.code || '';
  }
}
if (btnDetect) btnDetect.addEventListener('click', detectLanguageSample);

// -------- Generate report ---------------------------------------------
async function createReport() {
  const fd = new FormData();

  // Attach patient fields
  const P = gatherPatient();
  Object.entries(P).forEach(([k,v]) => fd.append(k, v));

  // Attach typed parts
  const T = gatherTypedParts();
  Object.entries(T).forEach(([k,v]) => fd.append(k, v));

  // Attach blobs for each recorder if any
  for (const [key, R] of Object.entries(recorders)) {
    if (R.blob && R.blob.size) {
      fd.append(`audio_${key}`, R.blob, `${key}.webm`);
    }
  }

  const resp = await fetch('/upload-multi', { method:'POST', body: fd });
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

if (btnGenerate) {
  btnGenerate.addEventListener('click', async () => {
    setError(''); setResult('');
    try {
      const j = await createReport();
      if (!j.ok) throw new Error(j.error || 'Server error');

      // Banner with ✅ and actions
      const shareUrl = j.url;
      const target   = (langTargetEl && langTargetEl.value) ? langTargetEl.value.toUpperCase() : '';
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
            <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&su=Hot%20Health%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Gmail</a>
            <a class="btn" href="https://outlook.office.com/mail/deeplink/compose?subject=Hot%20Health%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Outlook</a>
          </div>
        </div>
      `;
      setResult(banner);
      const copyBtn = $('#btnCopyLink');
      if (copyBtn) copyBtn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(shareUrl); copyBtn.textContent = 'Copied!'; setTimeout(()=>copyBtn.textContent='Copy Link', 1500); } catch {}
      });

      // Show detected language suggestion (from server result if provided)
      if (j.detected_lang && langDetectedEl) {
        langDetectedEl.value = j.detected_lang.toUpperCase();
        if (detectNameEl) detectNameEl.textContent = j.detected_lang.toUpperCase();
      }
    } catch (e) {
      setError(e.message || String(e));
    }
  });
}
