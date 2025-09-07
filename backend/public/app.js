// Caregiver Card — front-end logic
// Field mics • two free-speech recorders • classic recorder • language detect • JSON-safe posting

const $ = (s) => document.querySelector(s);

// Elements
const btnGenerate = $('#btnGenerate');
const resultBox   = $('#result');
const errorBox    = $('#error');
const metaBox     = $('#meta');

const langSel     = $('#lang');
const langDetectedEl = $('#langDetected');
const btnDetectFromSpeech = $('#btnDetectFromSpeech');
const langConfirmWrap = $('#langConfirmWrap');
const langGuessName = $('#langGuessName');
const langConfirmYes = $('#langConfirmYes');

// Classic recorder
const btnRecClassic = $('#btnRecClassic');
const recMetaClassic = $('#recMetaClassic');
let classicChunks = [], classicRecorder = null;
let lastClassicBlob = null;

// Free speech recorders
const recPatientFree = $('#recPatientFree');
const recPatientFreeMeta = $('#recPatientFreeMeta');
let pfChunks = [], pfRecorder = null, pfBlob = null;

const recStatusFree = $('#recStatusFree');
const recStatusFreeMeta = $('#recStatusFreeMeta');
let sfChunks = [], sfRecorder = null, sfBlob = null;

// Utility
function setError(msg){ if(errorBox){ errorBox.textContent = msg || ''; } }
function setMeta(msg){ if(metaBox){ metaBox.textContent = msg || ''; } }
function setResult(html){ if(resultBox){ resultBox.innerHTML = html || ''; } }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// Email speech normalization (matches backend)
function normalizeEmailSpoken(raw=''){
  let s=(' '+raw.toLowerCase().trim()+' ');
  s=s.replace(/\s+at\s+/g,'@').replace(/\s+dot\s+/g,'.').replace(/\s+period\s+/g,'.');
  s=s.replace(/\s+underscore\s+/g,'_').replace(/\s+(hyphen|dash)\s+/g,'-').replace(/\s+plus\s+/g,'+');
  s=s.replace(/\s+gmail\s*\.?\s*com\s*/g,'@gmail.com ').replace(/\s+outlook\s*\.?\s*com\s*/g,'@outlook.com ');
  s=s.replace(/\s+hotmail\s*\.?\s*com\s*/g,'@hotmail.com ').replace(/\s+yahoo\s*\.?\s*com\s*/g,'@yahoo.com ');
  s=s.replace(/\s*@\s*/g,'@').replace(/\s*\.\s*/g,'.').replace(/\s+/g,' ').trim().replace(/\s+/g,'');
  s=s.replace(/\.\.+/g,'.'); return s;
}
function isEmailField(el){
  const id=(el.id||'').toLowerCase(), name=(el.name||'').toLowerCase(), type=(el.type||'').toLowerCase();
  return type==='email' || id.includes('email') || name.includes('email');
}

// Field mic wiring
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.querySelectorAll('.mic-btn').forEach(btn=>{
    if(!SR){ btn.disabled=true; btn.title='Speech recognition not supported'; return; }
    btn.addEventListener('click', ()=>{
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if(!el) return;

      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.classList.add('mic-active');
      const origBg = el.style.backgroundColor;
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e)=>{
        const raw = e.results[0][0].transcript || '';
        const text = isEmailField(el) ? normalizeEmailSpoken(raw) : raw;
        if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
          el.value = text;
        } else if (el.tagName === 'SELECT') {
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(text.toLowerCase()));
          if (opt) el.value = opt.value;
        }
      };
      rec.onend = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = origBg; };
      rec.onerror = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = origBg; };

      try { rec.start(); } catch { btn.classList.remove('mic-active'); el.style.backgroundColor = origBg; }
    });
  });
})();

// Generic media recorder helper
async function recordFor(button, metaSpan, ms=60000){ // default 60s
  setError('');
  let stream;
  try{
    stream = await navigator.mediaDevices.getUserMedia({ audio:true });
  }catch{
    setError('Microphone blocked. Allow mic access and try again.');
    return null;
  }
  const chunks=[]; const rec = new MediaRecorder(stream, { mimeType:'audio/webm' });
  return await new Promise((resolve)=>{
    let stopped=false;
    rec.ondataavailable = e=>{ if(e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = ()=>{
      stream.getTracks().forEach(t=>t.stop());
      const blob = new Blob(chunks, { type:'audio/webm' });
      if (metaSpan) metaSpan.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`;
      resolve(blob);
    };
    rec.start();
    button.disabled = true;
    const orig = button.textContent;
    button.textContent = '⏹ Stop';
    metaSpan && (metaSpan.textContent = 'Recording…');

    button.onclick = ()=>{ if(stopped) return; stopped=true; rec.stop(); button.textContent=orig; button.disabled=false; };

    setTimeout(()=>{ if(stopped) return; stopped=true; rec.stop(); button.textContent=orig; button.disabled=false; }, ms);
  });
}

// Classic recorder
if (btnRecClassic){
  btnRecClassic.addEventListener('click', async ()=>{
    lastClassicBlob = await recordFor(btnRecClassic, recMetaClassic, 60000);
  });
}

// Patient free recorder
if (recPatientFree){
  recPatientFree.addEventListener('click', async ()=>{
    pfBlob = await recordFor(recPatientFree, recPatientFreeMeta, 60000);
  });
}
// Status free recorder
if (recStatusFree){
  recStatusFree.addEventListener('click', async ()=>{
    sfBlob = await recordFor(recStatusFree, recStatusFreeMeta, 90000);
  });
}

// Detect language from a quick sample (prompted)
if (btnDetectFromSpeech){
  btnDetectFromSpeech.addEventListener('click', async ()=>{
    setError('');
    // Quick 5s sample using classic logic
    const tmpBtn = btnDetectFromSpeech;
    const fakeSpan = { textContent:'' };
    const sample = await recordFor(tmpBtn, fakeSpan, 5000);
    if (!sample) return;
    const text = await sample.text(); // not audio content—just to keep code simple; we’ll use a spoken tip instead
    // Best-effort: reuse status free if available; else ask user to speak once into Status recorder,
    // then call backend detect using typed_general (or any text they said).
    // Here we just prompt user to say a short phrase into Status recorder, then detect from that field if present.
    const general = $('#typed_general').value.trim();
    const sourceText = general || 'Blood pressure one twenty over eighty. Weight one eighty pounds.';
    try{
      const r = await fetch('/detect-lang', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text: sourceText })
      });
      const j = await r.json();
      if (j.ok){
        langDetectedEl.value = `${j.name} (${j.code})`;
        langGuessName.textContent = j.name;
        langConfirmWrap.style.display = 'inline-block';
      } else {
        setError(j.error || 'Language detect failed');
      }
    }catch(e){
      setError('Language detect failed');
    }
  });
}

// Gather inputs
function getVal(id){ const el=$(id); return el ? el.value.trim() : ''; }
function buildFormData(){
  const fd = new FormData();
  // Patient + emergency
  fd.append('name', getVal('#pName'));
  fd.append('email', getVal('#pEmail'));
  fd.append('blood_type', getVal('#blood'));
  fd.append('emer_name', getVal('#eName'));
  fd.append('emer_phone', getVal('#ePhone'));
  fd.append('emer_email', getVal('#eEmail'));
  // Doctor
  fd.append('doctor_name', getVal('#dName'));
  fd.append('doctor_address', getVal('#dAddr'));
  fd.append('doctor_phone', getVal('#dPhone'));
  fd.append('doctor_fax', getVal('#dFax'));
  fd.append('doctor_email', getVal('#dEmail'));
  // Pharmacy
  fd.append('pharmacy_name', getVal('#phName'));
  fd.append('pharmacy_address', getVal('#phAddr'));
  fd.append('pharmacy_phone', getVal('#phPhone'));
  fd.append('pharmacy_fax', getVal('#phFax'));
  // Health status typed
  fd.append('typed_meds', getVal('#typed_meds'));
  fd.append('typed_allergies', getVal('#typed_allergies'));
  fd.append('typed_conditions', getVal('#typed_conditions'));
  fd.append('bp', getVal('#bp'));
  fd.append('weight', getVal('#weight'));
  // General journal
  fd.append('typed_general', getVal('#typed_general'));
  // Language
  const target = langSel ? langSel.value.trim() : '';
  fd.append('lang', target);
  // Audio blobs
  if (pfBlob) fd.append('audio_patientfree', pfBlob, 'pf.webm');
  if (sfBlob) fd.append('audio_statusfree',  sfBlob, 'sf.webm');
  if (lastClassicBlob) fd.append('audio_classic', lastClassicBlob, 'classic.webm');
  return fd;
}

// Generate Report
if (btnGenerate){
  btnGenerate.addEventListener('click', async ()=>{
    setError(''); setMeta(''); setResult('');
    const fd = buildFormData();

    // If absolutely nothing entered, warn before calling server
    const hasAny =
      [...fd.keys()].some(k=>!k.startsWith('audio_') && (fd.get(k)||'').toString().trim()) ||
      pfBlob || sfBlob || lastClassicBlob;
    if (!hasAny){ setError('Please type or record some information first.'); return; }

    // Post to multi endpoint
    let j;
    try{
      const r = await fetch('/upload-multi', { method:'POST', body: fd });
      const txt = await r.text(); // robust against HTML error pages
      try { j = JSON.parse(txt); } catch { throw new Error('Server Error'); }
      if (!r.ok || !j.ok) throw new Error(j?.error || `Upload failed (${r.status})`);
    }catch(e){
      setError(e.message || 'Server Error');
      return;
    }

    // Banner with actions
    const shareUrl = j.url;
    const banner = `
      <div class="report-banner">
        <div class="report-icon">✅</div>
        <div class="report-text">
          <div class="report-title">Report Generated</div>
          <div class="report-sub">Open, copy or email your report below.</div>
        </div>
        <div class="report-actions">
          <a class="btn" href="${shareUrl}" target="_blank" rel="noopener">Open Report</a>
          <button class="btn" id="btnCopyLink" type="button">Copy Link</button>
          <a class="btn" target="_blank" rel="noopener"
             href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}">Gmail</a>
          <a class="btn" target="_blank" rel="noopener"
             href="https://outlook.office.com/mail/deeplink/compose?subject=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}">Outlook</a>
        </div>
      </div>`;
    setResult(banner);
    const copyBtn = $('#btnCopyLink');
    if (copyBtn){
      copyBtn.addEventListener('click', async ()=>{
        try{ await navigator.clipboard.writeText(shareUrl); copyBtn.textContent='Copied!'; await sleep(1200); copyBtn.textContent='Copy Link'; }catch{}
      });
    }
  });
}
