// Front-end logic: field mics (SpeechRecognition), classic recorder (MediaRecorder), submit to /upload

const $ = sel => document.querySelector(sel);

// Detect UI nodes
const langDetectedEl = $('#langDetected');
const langHint = $('#langHint');
const langTargetEl = $('#lang');

const btnRec   = $('#btnRec');
const recMeta  = $('#recMeta');
const recErr   = $('#recErr');

const btnGenerate = $('#btnGenerate');
const resultBox   = $('#result');
const errorBox    = $('#error');

function setError(msg){ if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }
function setRecErr(msg){ if (recErr) recErr.textContent = msg || ''; }
function setRecMeta(msg){ if (recMeta) recMeta.textContent = msg || ''; }

// -------- Language hint (simple prompt you can refine) --------
if (langHint){
  langHint.textContent = 'We think you are speaking English — tap to confirm or change.';
}
if (langDetectedEl){
  langDetectedEl.value = 'English';
}

// -------- Field SpeechRecognition (mic icons) --------
(function(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function normalizeEmailSpoken(raw){
    if (!raw) return '';
    let s = ' ' + raw.toLowerCase().trim() + ' ';
    s = s.replace(/\s+at\s+/g, '@');
    s = s.replace(/\s+dot\s+/g, '.');
    s = s.replace(/\s+period\s+/g, '.');
    s = s.replace(/\s+underscore\s+/g, '_');
    s = s.replace(/\s+(hyphen|dash)\s+/g, '-');
    s = s.replace(/\s+plus\s+/g, '+');

    s = s.replace(/\s+gmail\s*\.?\s*com\s*/g, '@gmail.com ');
    s = s.replace(/\s+outlook\s*\.?\s*com\s*/g, '@outlook.com ');
    s = s.replace(/\s+hotmail\s*\.?\s*com\s*/g, '@hotmail.com ');
    s = s.replace(/\s+yahoo\s*\.?\s*com\s*/g, '@yahoo.com ');

    s = s.replace(/\s*@\s*/g, '@');
    s = s.replace(/\s*\.\s*/g, '.');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+/g, '');
    s = s.replace(/\.\.+/g, '.');
    return s;
  }
  function isEmailField(el){
    const id=(el.id||'').toLowerCase(), name=(el.name||'').toLowerCase(), type=(el.type||'').toLowerCase();
    return type==='email' || id.includes('email') || name.includes('email');
  }

  document.querySelectorAll('.mic-btn').forEach(btn=>{
    if (!SR){ btn.disabled=true; btn.title='Speech recognition not supported'; return; }
    btn.addEventListener('click', ()=>{
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;
      const rec = new SR();
      rec.lang = 'en-US'; // you can dynamically map from detected
      rec.interimResults = false; rec.maxAlternatives = 1;

      const orig = el.style.backgroundColor;
      btn.classList.add('mic-active');
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e)=>{
        const raw = e.results[0][0].transcript || '';
        const text = isEmailField(el)? normalizeEmailSpoken(raw) : raw;
        if (el.tagName==='SELECT'){
          const lower = text.toLowerCase();
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(lower));
          if (opt) el.value = opt.value;
        }else{
          el.value = text;
        }
      };
      rec.onend = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = orig; };
      rec.onerror = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = orig; };

      try{ rec.start(); }catch{ btn.classList.remove('mic-active'); el.style.backgroundColor = orig; }
    });
  });
})();

// -------- Classic free-speech recorder --------
let mediaRecorder=null, chunks=[];
function startRec(){
  setRecErr(''); setRecMeta('');
  chunks=[];
  if (!navigator.mediaDevices || !window.MediaRecorder){
    setRecErr('This browser does not support audio recording. Use Chrome/Edge or iOS Safari 14+.');
    return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    mediaRecorder = new MediaRecorder(stream, { mimeType:'audio/webm' });
    mediaRecorder.ondataavailable = e=>{ if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = ()=>{
      const blob = new Blob(chunks, { type:'audio/webm' });
      window.__classicBlob = blob; // store for Generate Report
      setRecMeta(`Recorded ${(blob.size/1024).toFixed(1)} KB`);
    };
    mediaRecorder.start();
    btnRec.textContent='Stop';
    setRecMeta('Recording… it will auto-stop in 60s.');
    // auto stop after 60s
    setTimeout(()=>{
      if (mediaRecorder && mediaRecorder.state!=='inactive'){
        stopRec();
      }
    }, 60000);
  }).catch(()=> setRecErr('Microphone blocked. Allow permission and try again.'));
}
function stopRec(){
  if (mediaRecorder && mediaRecorder.state!=='inactive'){
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t=>t.stop());
    btnRec.textContent='Record';
  }
}
if (btnRec){
  btnRec.addEventListener('click', ()=> {
    if (btnRec.textContent==='Record') startRec(); else stopRec();
  });
}

// -------- Gather & Submit --------
function val(id){ const el=$(id); return el? el.value.trim() : ''; }
function gatherForm(){
  return {
    // patient
    name: val('#pName'),
    email: val('#pEmail'),
    blood_type: val('#blood'),
    emer_name: val('#eName'),
    emer_phone: val('#ePhone'),
    emer_email: val('#eEmail'),

    // doctor
    doctor_name: val('#dName'),
    doctor_address: val('#dAddress'),
    doctor_phone: val('#dPhone'),
    doctor_fax: val('#dFax'),
    doctor_email: val('#dEmail'),

    // pharmacy
    pharmacy_name: val('#phName'),
    pharmacy_address: val('#phAddress'),
    pharmacy_phone: val('#phPhone'),
    pharmacy_fax: val('#phFax'),

    // language
    lang: val('#lang'),

    // typed health status
    typed_bp: val('#typed_bp'),
    typed_weight: val('#typed_weight'),
    typed_meds: $('#typed_meds')? $('#typed_meds').value.trim() : '',
    typed_allergies: $('#typed_allergies')? $('#typed_allergies').value.trim() : '',
    typed_conditions: $('#typed_conditions')? $('#typed_conditions').value.trim() : '',
    typed_general: $('#typed_general')? $('#typed_general').value.trim() : ''
  };
}

async function generateReport(){
  setError(''); setResult('');
  const fd = new FormData();
  const form = gatherForm();
  for (const [k,v] of Object.entries(form)) fd.append(k, v||'');

  if (window.__classicBlob){
    fd.append('audio', window.__classicBlob, 'recording.webm');
  }

  const r = await fetch('/upload', { method:'POST', body: fd });
  if (!r.ok){
    let msg = `Server Error`;
    try{
      const t=await r.text();
      if (t && t.startsWith('{')){ const j=JSON.parse(t); if (j.error) msg=j.error; }
    }catch{}
    throw new Error(msg);
  }
  return r.json();
}

if (btnGenerate){
  btnGenerate.addEventListener('click', async ()=>{
    try{
      const json = await generateReport();
      if (!json.ok) throw new Error(json.error || 'Server error');

      // show detected language in UI if provided
      if (json.detected_lang && langDetectedEl) {
        const map = { en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano',
          ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ' };
        langDetectedEl.value = map[json.detected_lang] || json.detected_lang;
      }

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
            <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Hot%20Health%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Gmail</a>
            <a class="btn" href="https://outlook.live.com/owa/?path=/mail/action/compose&subject=Hot%20Health%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Outlook</a>
          </div>
        </div>
      `;
      setResult(banner);

      const copyBtn = $('#btnCopyLink');
      if (copyBtn){
        copyBtn.addEventListener('click', async ()=>{
          try{ await navigator.clipboard.writeText(shareUrl); copyBtn.textContent='Copied!'; setTimeout(()=>copyBtn.textContent='Copy Link', 1500); }catch{}
        });
      }
    }catch(e){
      setError(e.message || String(e));
    }
  });
}
