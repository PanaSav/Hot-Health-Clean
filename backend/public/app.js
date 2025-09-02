const $ = sel => document.querySelector(sel);

// Language UI nodes
const langDetectedEl = $('#langDetected');
const langHint = $('#langHint');
const langTargetEl = $('#lang');
const langConfirmRow = $('#langConfirmRow');
const langQuestion = $('#langQuestion');

// Classic report generation nodes
const btnGenerate = $('#btnGenerate');
const resultBox   = $('#result');
const errorBox    = $('#error');

function setError(msg){ if (errorBox) errorBox.textContent = msg || ''; }
function setResult(html){ if (resultBox) resultBox.innerHTML = html || ''; }

// Initial language hint
if (langHint){
  langHint.textContent = 'We’ll auto-detect if you use a free-speech recorder. You can also select a translation target.';
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
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
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

// -------- Free-speech recorders for PREFILL (patient/status) --------
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
        metaEl.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB. Extracting...`;
        const fd = new FormData();
        fd.append('audio', blob, 'prefill.webm');
        fd.append('mode', mode);
        const r = await fetch('/prefill', { method:'POST', body: fd });
        if (!r.ok) throw new Error(`Prefill failed (${r.status})`);
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'Prefill failed');

        // Set detected language UI
        if (j.detected_lang && langDetectedEl){
          const map = { en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano',
            ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ' };
          const label = map[j.detected_lang] || j.detected_lang.toUpperCase();
          langDetectedEl.value = label;
          if (langQuestion) langQuestion.textContent = `Are you speaking ${label}?`;
          if (langConfirmRow) langConfirmRow.style.display='flex';
        }

        // Patch fields
        const patch = j.patch || {};
        Object.entries(patch).forEach(([id,val])=>{
          const el = document.getElementById(id);
          if (el && val){ el.value = val; }
        });

        metaEl.textContent = `Filled: ${Object.keys(patch).filter(k=>patch[k]).length} field(s).`;
      }catch(e){
        errEl.textContent = e.message || String(e);
      }
    };
    prefillRecorder.start();
    metaEl.textContent='Recording… it will auto-stop in 45s.';
    setTimeout(()=>{ if (prefillRecorder && prefillRecorder.state!=='inactive') stopPrefill(mode); }, 45000);
  }).catch(()=> errEl.textContent = 'Microphone blocked. Allow permission and try again.');
}
function stopPrefill(){
  if (prefillRecorder && prefillRecorder.state!=='inactive'){
    prefillRecorder.stop();
    prefillRecorder.stream.getTracks().forEach(t=>t.stop());
  }
}

// Wire buttons
const btnPrefillPatient = $('#btnPrefillPatient');
const prefillPatientMeta = $('#prefillPatientMeta');
const prefillPatientErr  = $('#prefillPatientErr');
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

const btnPrefillStatus = $('#btnPrefillStatus');
const prefillStatusMeta = $('#prefillStatusMeta');
const prefillStatusErr  = $('#prefillStatusErr');
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

// -------- Journal save (typed OR mic) --------
const btnJournalSave = $('#btnJournalSave');
const journalText    = $('#journalText');
const journalMeta    = $('#journalMeta');
const journalErr     = $('#journalErr');

let journalRecorder=null, journalChunks=[];
function startJournalMic(){
  journalErr.textContent=''; journalMeta.textContent='';
  journalChunks=[];
  if (!navigator.mediaDevices || !window.MediaRecorder){
    journalErr.textContent='This browser does not support audio recording.';
    return;
  }
  navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    journalRecorder = new MediaRecorder(stream, { mimeType:'audio/webm' });
    journalRecorder.ondataavailable = e=>{ if (e.data && e.data.size) journalChunks.push(e.data); };
    journalRecorder.onstop = async ()=>{
      try{
        const blob = new Blob(journalChunks, { type:'audio/webm' });
        const fd = new FormData();
        fd.append('audio', blob, 'journal.webm');
        fd.append('text', journalText ? journalText.value.trim() : '');
        const r = await fetch('/journal/add', { method:'POST', body: fd });
        if (!r.ok) throw new Error(`Save failed (${r.status})`);
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || 'Save failed');
        journalMeta.textContent = 'Note saved.';
      }catch(e){
        journalErr.textContent = e.message || String(e);
      }
    };
    journalRecorder.start();
    journalMeta.textContent='Recording… it will auto-stop in 60s.';
    setTimeout(()=>{ if (journalRecorder && journalRecorder.state!=='inactive') stopJournalMic(); }, 60000);
  }).catch(()=> journalErr.textContent='Microphone blocked. Allow permission and try again.');
}
function stopJournalMic(){
  if (journalRecorder && journalRecorder.state!=='inactive'){
    journalRecorder.stop();
    journalRecorder.stream.getTracks().forEach(t=>t.stop());
  }
}

if (btnJournalSave){
  btnJournalSave.addEventListener('click', async ()=>{
    // If there’s no mic going, save typed note
    if (!journalRecorder || journalRecorder.state==='inactive'){
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
    }else{
      // stopping finishes the upload
      stopJournalMic();
    }
  });

  // Long-press on the same button to toggle mic (optional UX)
  btnJournalSave.addEventListener('contextmenu', (e)=> e.preventDefault());
  btnJournalSave.addEventListener('mousedown', (e)=>{
    if (e.button===2) return; // ignore right-click
    if (!journalRecorder || journalRecorder.state==='inactive'){
      startJournalMic();
    }else{
      stopJournalMic();
    }
  });
}

// -------- Gather & Submit (Generate Report) --------
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

  // We no longer attach a "classic" blob here; prefill is separate. If you want to add a single classic recorder again, attach it like:
  // if (window.__classicBlob) fd.append('audio', window.__classicBlob, 'recording.webm');

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

      // Update detected language UI + question
      if (json.detected_lang){
        const map = { en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano',
          ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ' };
        const label = map[json.detected_lang] || json.detected_lang.toUpperCase();
        if (langDetectedEl) langDetectedEl.value = label;
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
