// backend/public/app.js

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const resultBox = $('#result');
const errorBox  = $('#error');
const btnGenerate   = $('#btnGenerate');

const langDetectedEl = $('#langDetected');
const btnLangSpeak   = $('#btnLangSpeak');
const btnLangConfirm = $('#btnLangConfirm');
const langGuessMsg   = $('#langGuessMsg');

function setError(msg){ if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }

// ------------ Email normalization (spoken → valid) ------------
function normalizeEmailSpoken(raw='') {
  let s = ' ' + raw.toLowerCase().trim() + ' ';
  s = s.replace(/\s+at\s+/g,'@')
       .replace(/\s+dot\s+/g,'.')
       .replace(/\s+period\s+/g,'.')
       .replace(/\s+underscore\s+/g,'_')
       .replace(/\s+(hyphen|dash)\s+/g,'-')
       .replace(/\s+plus\s+/g,'+')
       .replace(/\s+gmail\s*\.?\s*com\s*/g,'@gmail.com ')
       .replace(/\s+outlook\s*\.?\s*com\s*/g,'@outlook.com ')
       .replace(/\s+hotmail\s*\.?\s*com\s*/g,'@hotmail.com ')
       .replace(/\s+yahoo\s*\.?\s*com\s*/g,'@yahoo.com ')
       .replace(/\s*@\s*/g,'@')
       .replace(/\s*\.\s*/g,'.')
       .replace(/\s+/g,'')
       .replace(/\.\.+/g,'.');
  return s;
}
function isEmailField(el){
  const id=(el.id||'').toLowerCase(), name=(el.name||'').toLowerCase(), type=(el.type||'').toLowerCase();
  return type==='email' || id.includes('email') || name.includes('email');
}

// ------------ Per-field mic (Web Speech Recognition) ------------
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  $$('.mic-btn').forEach(btn => {
    if (!SR) { btn.disabled = true; btn.title = 'Speech recognition not supported'; return; }
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;
      const rec = new SR();
      rec.lang = (window.__uiLang || 'en-US');
      rec.interimResults = false; rec.maxAlternatives = 1;

      const originalBg = el.style.backgroundColor;
      btn.classList.add('mic-active');
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e) => {
        const raw = e.results[0][0].transcript || '';
        const text = isEmailField(el) ? normalizeEmailSpoken(raw) : raw;
        if (el.tagName === 'SELECT') {
          const lower = text.toLowerCase();
          const opt = Array.from(el.options).find(o => o.textContent.toLowerCase().includes(lower) || o.value.toLowerCase()===lower);
          if (opt) el.value = opt.value;
        } else {
          el.value = text;
        }
      };
      rec.onend = () => { btn.classList.remove('mic-active'); el.style.backgroundColor = originalBg; };
      rec.onerror = () => { btn.classList.remove('mic-active'); el.style.backgroundColor = originalBg; };
      try { rec.start(); } catch { btn.classList.remove('mic-active'); el.style.backgroundColor = originalBg; }
    });
  });
})();

// ------------ Language detect flow ------------
let __lastGuess = { code:'', name:'' };

if (btnLangSpeak) {
  btnLangSpeak.addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { langGuessMsg.textContent = 'Speech recognition not supported in this browser.'; return; }
    const rec = new SR();
    rec.lang = 'en-US'; // we only need a sample; backend will detect actual language
    rec.interimResults = false; rec.maxAlternatives = 1;
    langGuessMsg.textContent = 'Listening… say a short sentence.';
    rec.onresult = async (e) => {
      const sample = (e.results[0][0].transcript || '').trim();
      if (!sample) { langGuessMsg.textContent = 'No speech detected.'; return; }
      // ask backend to detect language from text
      try {
        const r = await fetch('/detect-lang', {
          method:'POST',
          headers:{ 'Content-Type': 'application/json' },
          body: JSON.stringify({ sample })
        });
        const j = await r.json();
        __lastGuess = { code: j.code || '', name: j.name || '' };
        if (__lastGuess.code) {
          langGuessMsg.textContent = `We think you’re speaking ${__lastGuess.name} — click Confirm if correct.`;
          langDetectedEl.value = __lastGuess.name || __lastGuess.code;
          window.__uiLang = (__lastGuess.code === 'en' ? 'en-US' : __lastGuess.code);
        } else {
          langGuessMsg.textContent = 'Could not determine language.';
        }
      } catch {
        langGuessMsg.textContent = 'Detection failed.';
      }
    };
    rec.onerror = () => { langGuessMsg.textContent = 'Mic error.'; };
    try { rec.start(); } catch { langGuessMsg.textContent = 'Unable to start mic.'; }
  });
}

if (btnLangConfirm) {
  btnLangConfirm.addEventListener('click', () => {
    if (!__lastGuess.code) { langGuessMsg.textContent = 'No guess yet. Tap the mic and speak first.'; return; }
    langGuessMsg.textContent = `Language set to ${__lastGuess.name}.`;
    // Store a code we can send with the form if needed
    window.__detectedLangCode = __lastGuess.code;
  });
}

// ------------ Free speech recorders (MediaRecorder → backend parse) ------------
async function recordOnce(maxMs=45000) {
  // HTTPS required in browsers for getUserMedia outside localhost
  const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
  const mr = new MediaRecorder(stream, { mimeType:'audio/webm' });
  const chunks = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { if (mr.state!=='inactive') mr.stop(); }, maxMs);
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      clearTimeout(timer);
      stream.getTracks().forEach(t => t.stop());
      resolve(new Blob(chunks, { type:'audio/webm' }));
    };
    mr.onerror = e => { clearTimeout(timer); reject(e.error || new Error('Recorder error')); };
    mr.start();
  });
}

const btnRecPatient = $('#btnRecPatient');
if (btnRecPatient) {
  btnRecPatient.addEventListener('click', async () => {
    const msg = $('#patientParseMsg');
    try {
      msg.textContent = 'Recording… speak your info. It auto-stops in 45s or click again to stop.';
      const blob = await recordOnce(45000);
      msg.textContent = 'Transcribing & parsing…';
      const fd = new FormData();
      fd.append('audio', blob, 'patient.webm');
      const r = await fetch('/parse-patient', { method:'POST', body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Parse failed');

      // Fill fields safely (only if value present)
      const F = j.fields || {};
      const setIf = (id, v) => { if (v) { const el = $('#'+id); if (el) el.value = v; } };
      setIf('pName', F.name);
      setIf('pEmail', F.email);
      setIf('blood', F.blood_type);
      setIf('eName', F.emer_name);
      setIf('ePhone', F.emer_phone);
      setIf('eEmail', F.emer_email);
      setIf('doctor_name', F.doctor_name);
      setIf('doctor_address', F.doctor_address);
      setIf('doctor_phone', F.doctor_phone);
      setIf('doctor_fax', F.doctor_fax);
      setIf('doctor_email', F.doctor_email);
      setIf('pharmacy_name', F.pharmacy_name);
      setIf('pharmacy_address', F.pharmacy_address);
      setIf('pharmacy_phone', F.pharmacy_phone);
      setIf('pharmacy_fax', F.pharmacy_fax);

      msg.textContent = 'Parsed and filled available fields ✅';
    } catch (e) {
      msg.textContent = 'Parse error: ' + (e.message || String(e));
    }
  });
}

const btnRecStatus = $('#btnRecStatus');
if (btnRecStatus) {
  btnRecStatus.addEventListener('click', async () => {
    const msg = $('#statusParseMsg');
    try {
      msg.textContent = 'Recording status… auto-stops in 60s.';
      const blob = await recordOnce(60000);
      msg.textContent = 'Transcribing & parsing status…';
      const fd = new FormData();
      fd.append('audio', blob, 'status.webm');
      const r = await fetch('/parse-status', { method:'POST', body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Parse failed');

      const f = j.facts || {};
      const set = (id, v) => { const el = $('#'+id); if (el && v) el.value = v; };
      if (f.bp) set('bp', f.bp);
      if (f.weight) set('weight', f.weight);
      if (f.medications?.length) set('meds', f.medications.join('; '));
      if (f.allergies?.length) set('allergies', f.allergies.join('; '));
      if (f.conditions?.length) set('conditions', f.conditions.join('; '));

      msg.textContent = 'Status parsed and filled ✅';
    } catch (e) {
      msg.textContent = 'Parse error: ' + (e.message || String(e));
    }
  });
}

// ------------ Gather + Generate ------------
function val(id){ const el = $('#'+id); return el ? el.value.trim() : ''; }

async function generateReport() {
  setError(''); setResult('');
  const fd = new FormData();

  // patient/contact
  fd.append('name', val('pName'));
  fd.append('email', val('pEmail'));
  fd.append('blood_type', val('blood'));
  fd.append('emer_name', val('eName'));
  fd.append('emer_phone', val('ePhone'));
  fd.append('emer_email', val('eEmail'));

  fd.append('doctor_name', val('doctor_name'));
  fd.append('doctor_address', val('doctor_address'));
  fd.append('doctor_phone', val('doctor_phone'));
  fd.append('doctor_fax', val('doctor_fax'));
  fd.append('doctor_email', val('doctor_email'));

  fd.append('pharmacy_name', val('pharmacy_name'));
  fd.append('pharmacy_address', val('pharmacy_address'));
  fd.append('pharmacy_phone', val('pharmacy_phone'));
  fd.append('pharmacy_fax', val('pharmacy_fax'));

  // language
  const target = val('lang');
  fd.append('lang', target);
  fd.append('langDetected', (window.__detectedLangCode || 'en'));

  // status typed
  fd.append('bp', val('bp'));
  fd.append('meds', val('meds'));
  fd.append('allergies', val('allergies'));
  fd.append('weight', val('weight'));
  fd.append('conditions', val('conditions'));
  fd.append('general', val('general'));

  const r = await fetch('/upload-multi', { method:'POST', body: fd });
  if (!r.ok) {
    let msg = `Upload failed (${r.status})`;
    try {
      const txt = await r.text();
      if (txt.startsWith('{')) { const j = JSON.parse(txt); if (j.error) msg = j.error; }
    } catch {}
    throw new Error(msg);
  }
  return r.json();
}

if (btnGenerate) {
  btnGenerate.addEventListener('click', async () => {
    try {
      const j = await generateReport();
      if (!j.ok) throw new Error(j.error || 'Server error');
      const shareUrl = j.url;

      const banner = `
        <div class="report-banner">
          <div class="report-icon">✅</div>
          <div class="report-text">
            <div class="report-title">Report Generated</div>
            <div class="report-sub">Open, share or email below.</div>
          </div>
          <div class="report-actions">
            <a class="btn" href="${shareUrl}" target="_blank" rel="noopener">Open Report</a>
            <button class="btn" id="btnCopyLink" type="button">Copy Link</button>
            <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Gmail</a>
            <a class="btn" href="https://outlook.office.com/mail/deeplink/compose?subject=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Outlook</a>
          </div>
        </div>
      `;
      setResult(banner);

      const copyBtn = $('#btnCopyLink');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(shareUrl); copyBtn.textContent='Copied!'; setTimeout(()=>copyBtn.textContent='Copy Link',1500); } catch {}
        });
      }
    } catch (e) {
      setError(e.message || String(e));
    }
  });
}
