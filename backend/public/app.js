const $ = s => document.querySelector(s);

// Language UI nodes
const langDetectedEl = $('#langDetected');
const langHint = $('#langHint');
const langTargetEl = $('#lang');
const langConfirmRow = $('#langConfirmRow');
const langQuestion = $('#langQuestion');

// Buttons/areas
const btnPrefillPatient = $('#btnPrefillPatient');
const prefillPatientMeta = $('#prefillPatientMeta');
const prefillPatientErr  = $('#prefillPatientErr');

const btnPrefillStatus = $('#btnPrefillStatus');
const prefillStatusMeta = $('#prefillStatusMeta');
const prefillStatusErr  = $('#prefillStatusErr');

const btnGenerate = $('#btnGenerate');
const resultBox   = $('#result');
const errorBox    = $('#error');

const btnJournalSave = $('#btnJournalSave');
const journalText    = $('#journalText');
const journalMeta    = $('#journalMeta');
const journalErr     = $('#journalErr');

function setError(msg){ if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }
if (langHint){
  langHint.textContent = 'We’ll auto-detect your language if you use the free-speech recorder. You can choose a translation target too.';
}

// -------- Field SpeechRecognition (per-field mics) --------
(function(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function normalizeEmailSpoken(raw){
    if (!raw) return '';
    let s = ' ' + raw.toLowerCase().trim() + ' ';
    s = s.replace(/\s+at\s+/g, '@')
         .replace(/\s+dot\s+/g, '.')
         .replace(/\s+period\s+/g, '.')
         .replace(/\s+underscore\s+/g, '_')
         .replace(/\s+(hyphen|dash)\s+/g, '-')
         .replace(/\s+plus\s+/g, '+')
         .replace(/\s*@\s*/g, '@')
         .replace(/\s*\.\s*/g, '.')
         .replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+/g, '').replace(/\.\.+/g,'.');
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
      rec.lang = 'en-US';
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

// -------- Prefill free-speech (patient/status) --------
let prefillRecorder=null, prefillChunks=[];
function startPrefill(mode, metaEl, errEl){
  errEl.textContent=''; metaEl.textContent='';
  prefillChunks=[];
  if (!navigator.mediaDevices || !window.MediaRecorder){
    errEl.textContent='This browser does not support audio recording.';
    return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    prefillRecorder = new MediaRecorder(stream, { mimeType:'audio/webm' });
    prefillRecorder.ondataavailable = e=>{ if (e.data && e.data.size) prefillChunks.push(e.data); };
    prefillRecorder.onstop = async ()=>{
      try{
        const blob = new Blob(prefillChunks, { type:'audio/webm' });
        metaEl.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB. Extracting…`;
        const fd = new FormData();
        fd.append('audio', blob, 'prefill.webm');
        fd.append('mode', mode);
        const r = await fetch('/prefill', { method:'POST', body: fd });
        if (!r.ok) throw new Error(`Prefill failed (${r.status})`);
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'Prefill failed');

        if (j.detected_lang && langDetectedEl){
          const map = { en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano',
            ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ' };
          const label = map[j.detected_lang] || j.detected_lang.toUpperCase();
          langDetectedEl.value = label;
          if (langQuestion) langQuestion.textContent = `Are you speaking ${label}?`;
          if (langConfirmRow) langConfirmRow.style.display='flex';
        }

        const patch = j.patch || {};
        const filled = [];
        Object.entries(patch).forEach(([id,val])=>{
          if (!val) return;
          const el = document.getElementById(id);
          if (el){ el.value = val; filled.push(id); }
        });

        metaEl.innerHTML = filled.length
          ? `Filled ${filled.length} field(s): <span class="tiny muted">${filled.join(', ')}</span>`
          : 'No specific fields detected — try labeling, e.g., “Patient name: Jane Doe”.';
      }catch(e){
        errEl.textContent = e.message || String(e);
      }
    };
    prefillRecorder.start();
    metaEl.textContent='Recording… it will auto-stop in 45s.';
    setTimeout(()=>{ if (prefillRecorder && prefillRecorder.state!=='inactive') stopPrefill(); }, 45000);
  }).catch(()=> errEl.textContent = 'Microphone blocked. Allow permission and try again.');
}
function stopPrefill(){
  if (prefillRecorder && prefillRecorder.state!=='inactive'){
    prefillRecorder.stop();
    prefillRecorder.stream.getTracks().forEach(t=>t.stop());
  }
}

if (btnPrefillPatient){
  btnPrefillPatient.addEventListener('click', ()=>{
    if (!btnPrefillPatient.classList.contains('rec')){
      btnPrefillPatient.classList.add('rec'); btnPrefillPatient.textContent = 'Stop';
      startPrefill('patient', prefillPatientMeta, prefillPatientErr);
    }else{
      btnPrefillPatient.classList.remove('rec'); btnPrefillPatient.textContent = 'Alternative: Patient & Contact’s Info — Free Speech Recording';
      stopPrefill();
    }
  });
}
if (btnPrefillStatus){
  btnPrefillStatus.addEventListener('click', ()=>{
    if (!btnPrefillStatus.classList.contains('rec')){
      btnPrefillStatus.classList.add('rec'); btnPrefillStatus.textContent = 'Stop';
      startPrefill('status', prefillStatusMeta, prefillStatusErr);
    }else{
      btnPrefillStatus.classList.remove('rec'); btnPrefillStatus.textContent = 'Alternative: Patient Health Status — Free Speech Recording';
      stopPrefill();
    }
  });
}

// -------- Journal save (typed only; long-press behavior removed for clarity) --------
if (btnJournalSave){
  btnJournalSave.addEventListener('click', async ()=>{
    journalErr.textContent=''; journalMeta.textContent='';
    try{
      const fd = new FormData();
      fd.append('text', journalText ? journalText.value.trim() : '');
      const r = await fetch('/journal/add', { method:'POST', body: fd });
      if (!r.ok) throw new Error(`Save failed (${r.status})`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'Save failed');
      journalMeta.textContent = 'Note saved.';
    }catch(e){
      journalErr.textContent = e.message || String(e);
    }
  });
}

// -------- Generate Report (typed contents only) --------
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

    // typed status
    typed_bp: val('#typed_bp'),
    typed_weight: val('#typed_weight'),
    typed_meds: $('#typed_meds')? $('#typed_meds').value.trim() : '',
    typed_allergies: $('#typed_allergies')? $('#typed_allergies').value.trim() : '',
    typed_conditions: $('#typed_conditions')? $('#typed_conditions').value.trim() : '',
    typed_general: '' // kept empty here (journal is separate)
  };
}

async function generateReport(){
  setError(''); setResult('');
  const fd = new FormData();
  const form = gatherForm();
  for (const [k,v] of Object.entries(form)) fd.append(k, v||'');

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

      if (json.detected_lang && langDetectedEl){
        const map = { en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano',
          ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ' };
        const label = map[json.detected_lang] || json.detected_lang.toUpperCase();
        langDetectedEl.value = label;
        if (langQuestion) langQuestion.textContent = `Are you speaking ${label}?`;
        if (langConfirmRow) langConfirmRow.style.display = 'flex';
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
            <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Gmail</a>
            <a class="btn" href="https://outlook.live.com/owa/?path=/mail/action/compose&subject=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Outlook</a>
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
