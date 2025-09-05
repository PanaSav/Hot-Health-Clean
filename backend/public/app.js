// backend/public/app.js
// Field-level speech (mic icons), two free-speech recorders that parse & populate fields,
// robust Generate Report that never fails with "No Content" if reasonable data exists.

const $ = s => document.querySelector(s);
const byId = id => document.getElementById(id);

// --- elements
const langDetectedEl = byId('langDetected');
const langSelect     = byId('lang');

const btnRecPatientFree = byId('btnRecPatientFree');
const btnRecStatusFree  = byId('btnRecStatusFree');

const btnGenerate = byId('btnGenerate');
const resultBox   = byId('result');
const errorBox    = byId('error');

function setError(msg){ if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }

// -------------------------
// Email speech normalization
// -------------------------
function normalizeEmailSpoken(raw) {
  if (!raw) return '';
  let s = ' ' + raw.toLowerCase().trim() + ' ';
  s = s.replace(/\s+at\s+/g, '@');
  s = s.replace(/\s+dot\s+/g, '.').replace(/\s+period\s+/g, '.');
  s = s.replace(/\s+underscore\s+/g, '_');
  s = s.replace(/\s+(hyphen|dash)\s+/g, '-');
  s = s.replace(/\s+plus\s+/g, '+');

  s = s.replace(/\s+gmail\s*\.?\s*com\s*/g, '@gmail.com ');
  s = s.replace(/\s+outlook\s*\.?\s*com\s*/g, '@outlook.com ');
  s = s.replace(/\s+hotmail\s*\.?\s*com\s*/g, '@hotmail.com ');
  s = s.replace(/\s+yahoo\s*\.?\s*com\s*/g, '@yahoo.com ');

  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+/g, '');
  s = s.replace(/\.\.+/g, '.');
  return s;
}
function isEmailField(el) {
  const id = (el.id || '').toLowerCase();
  const name = (el.name || '').toLowerCase();
  const type = (el.type || '').toLowerCase();
  return type === 'email' || id.includes('email') || name.includes('email');
}

// -------------------------
// Field-level mic (SpeechRecognition)
// -------------------------
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.querySelectorAll('.mic-btn').forEach(btn => {
    if (!SR) { btn.disabled = true; btn.title = 'Speech recognition not supported'; return; }
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const el = byId(targetId);
      if (!el) return;

      const rec = new SR();
      rec.lang = (window.__uiLang || 'en-US');
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.classList.add('mic-active');
      const restore = () => btn.classList.remove('mic-active');

      rec.onresult = (e) => {
        const raw = e.results[0][0].transcript || '';
        const text = isEmailField(el) ? normalizeEmailSpoken(raw) : raw;
        if (el.tagName === 'SELECT') {
          const lower = text.toLowerCase();
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(lower));
          if (opt) el.value = opt.value;
        } else {
          el.value = text;
        }
      };
      rec.onend = restore;
      rec.onerror = restore;

      try { rec.start(); } catch { restore(); }
    });
  });
})();

// -------------------------
// Free-speech recorders (MediaRecorder → /parse-free)
// -------------------------
async function recordAndParse(scope) {
  setError('');
  const supports = !!(navigator.mediaDevices && window.MediaRecorder);
  if (!supports) { setError('This browser does not support recording.'); return; }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setError('Microphone blocked. Allow mic permission.'); return;
  }

  const chunks = [];
  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  const btn = scope === 'patient' ? btnRecPatientFree : btnRecStatusFree;
  btn.disabled = true; btn.textContent = '⏹️ Stop';

  const stopAfterMs = 60000; // 60s safety
  const stopper = setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, stopAfterMs);

  rec.ondataavailable = (e)=>{ if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = async () => {
    clearTimeout(stopper);
    stream.getTracks().forEach(t=>t.stop());
    btn.disabled = false; btn.textContent = '🎙️ Record';

    try {
      const blob = new Blob(chunks, { type:'audio/webm' });
      const fd = new FormData();
      fd.append('audio_free', blob, 'free.webm');
      const r = await fetch('/parse-free', { method:'POST', body: fd });
      if (!r.ok) throw new Error(`Parse failed (${r.status})`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Parse failed');

      // set detected language + confirmation prompt
      if (langDetectedEl) {
        langDetectedEl.value = j.detected_lang || '';
        const c = $('#langConfirm');
        if (c) {
          c.style.display = 'block';
          c.textContent = `We think you’re speaking: ${j.detected_lang?.toUpperCase() || '—'}. Please confirm.`;
        }
      }

      if (scope === 'patient') {
        // fill patient/contact/doctor/pharmacy fields
        const F = j.fields || {};
        const map = ['pName:name','pEmail:email','eName:emer_name','ePhone:emer_phone','eEmail:emer_email',
                     'blood:blood_type','doctor_name:doctor_name','doctor_address:doctor_address',
                     'doctor_phone:doctor_phone','doctor_fax:doctor_fax','doctor_email:doctor_email',
                     'pharmacy_name:pharmacy_name','pharmacy_address:pharmacy_address',
                     'pharmacy_phone:pharmacy_phone','pharmacy_fax:pharmacy_fax'];
        map.forEach(pair=>{
          const [id, key] = pair.split(':');
          const el = byId(id);
          if (el && F[key] && String(F[key]).trim()) {
            el.value = String(F[key]).trim();
          }
        });
        // blood select matching
        if (F.blood_type && byId('blood')) {
          const val = F.blood_type.toUpperCase().replace(/\s+/g,'');
          const opt = [...byId('blood').options].find(o => o.value.toUpperCase() === val);
          if (opt) byId('blood').value = opt.value;
        }
      } else {
        // fill status fields from facts
        const facts = j.facts || {};
        if (facts.bp && byId('bp')) byId('bp').value = facts.bp;
        if (facts.weight && byId('weight')) byId('weight').value = facts.weight;

        if (facts.medications?.length && byId('meds')) byId('meds').value = facts.medications.join('; ');
        if (facts.allergies?.length && byId('allergies')) byId('allergies').value = facts.allergies.join('; ');
        if (facts.conditions?.length && byId('conditions')) byId('conditions').value = facts.conditions.join('; ');

        // keep raw transcript in general if provided and field empty
        if (j.transcript && byId('general') && !byId('general').value.trim()) {
          byId('general').value = j.transcript;
        }
      }
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  rec.start();
}
if (btnRecPatientFree) btnRecPatientFree.addEventListener('click', ()=>recordAndParse('patient'));
if (btnRecStatusFree)  btnRecStatusFree.addEventListener('click',  ()=>recordAndParse('status'));

// -------------------------
// Gather form & Generate Report
// -------------------------
function val(id){ const el = byId(id); return el ? el.value.trim() : ''; }

function gatherPatient() {
  return {
    name: val('pName'), email: val('pEmail'), blood_type: val('blood'),
    emer_name: val('eName'), emer_phone: val('ePhone'), emer_email: val('eEmail'),
    doctor_name: val('doctor_name'), doctor_address: val('doctor_address'),
    doctor_phone: val('doctor_phone'), doctor_fax: val('doctor_fax'), doctor_email: val('doctor_email'),
    pharmacy_name: val('pharmacy_name'), pharmacy_address: val('pharmacy_address'),
    pharmacy_phone: val('pharmacy_phone'), pharmacy_fax: val('pharmacy_fax'),
    lang: (langSelect && langSelect.value) ? langSelect.value : ''
  };
}
function gatherStatusTyped() {
  return {
    typed_bp: val('bp'),
    typed_meds: val('meds'),
    typed_allergies: val('allergies'),
    typed_weight: val('weight'),
    typed_conditions: val('conditions'),
    typed_general: val('general')
  };
}

async function generateReport() {
  setError(''); setResult('');
  const fd = new FormData();

  // patient & status typed fields
  const P = gatherPatient();
  const S = gatherStatusTyped();
  Object.entries(P).forEach(([k,v]) => fd.append(k, v));
  Object.entries(S).forEach(([k,v]) => fd.append(k, v));

  // (optional) classic audio is not used here for correctness; endpoint accepts typed-only
  const r = await fetch('/upload-multi', { method:'POST', body: fd });
  let json;
  if (!r.ok) {
    try { json = await r.json(); } catch {}
    const msg = json?.error ? `Upload failed: ${json.error}` : `Upload failed (${r.status})`;
    throw new Error(msg);
  }
  json = await r.json();
  if (!json.ok) throw new Error(json.error || 'Server error');

  const shareUrl = json.url;
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
        <a class="btn" href="https://outlook.live.com/owa/?path=/mail/action/compose&subject=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Outlook</a>
      </div>
    </div>
  `;
  setResult(banner);
  const copyBtn = $('#btnCopyLink');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(shareUrl); copyBtn.textContent='Copied!'; setTimeout(()=>copyBtn.textContent='Copy Link',1500); }
      catch {}
    });
  }
}

if (btnGenerate) btnGenerate.addEventListener('click', () => {
  generateReport().catch(e => setError(e.message || String(e)));
});
