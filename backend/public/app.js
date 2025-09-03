// Caregiver Card — front-end logic (speech dictation, mini recorders, generate)

const $ = (s) => document.querySelector(s);

/* =====================
   Speech dictation for fields
   ===================== */
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

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

    s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.').trim();
    s = s.replace(/\s+/g, '');       // emails cannot have spaces
    s = s.replace(/\.\.+/g, '.');    // de-duplicate dots
    return s;
  }
  function isEmailField(el){
    const id=(el.id||'').toLowerCase(), name=(el.name||'').toLowerCase(), type=(el.type||'').toLowerCase();
    return type==='email' || id.includes('email') || name.includes('email');
  }

  document.querySelectorAll('.mic-btn').forEach(btn=>{
    if(!SR){ btn.disabled=true; btn.title='Speech recognition not supported'; return; }
    btn.addEventListener('click', ()=>{
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if(!el) return;

      const rec = new SR();
      rec.lang = 'en-US';       // You can change this default or wire to UI language
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.classList.add('mic-active');
      const origBG = el.style.backgroundColor;
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e)=>{
        const raw = e.results[0][0].transcript || '';
        const text = isEmailField(el) ? normalizeEmailSpoken(raw) : raw;

        if (el.tagName === 'SELECT') {
          const lower = text.toLowerCase();
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(lower) || o.value.toLowerCase().includes(lower));
          if (opt) el.value = opt.value;
        } else {
          if (el.tagName === 'TEXTAREA') el.value = (el.value ? el.value + ' ' : '') + text;
          else el.value = text;
        }

        // naive “language detected” UX: if any speech occurs, set a placeholder
        const det = $('#langDetected');
        if (det && !det.value) det.value = 'auto';
      };
      rec.onend = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = origBG; };
      rec.onerror = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = origBG; };
      try{ rec.start(); }catch{ btn.classList.remove('mic-active'); el.style.backgroundColor = origBG; }
    });
  });
})();

/* =====================
   Mini recorders + classic recorder
   ===================== */

const RECORD_LIMITS_MS = {
  bp: 30_000,
  meds: 180_000,
  allergies: 90_000,
  weight: 60_000,
  conditions: 180_000,
  general: 180_000,
  classic: 60_000
};

const state = {
  chunks: {},
  media: {},
  timers: {},
  blobs: {} // final audio blobs by key
};

function setupRecorder(key){
  const btn = $(`#rec_${key}`);
  const meta = $(`#meta_${key}`);
  if(!btn || !meta) return;

  btn.addEventListener('click', async ()=>{
    if(state.media[key] && state.media[key].state === 'recording'){
      stopRecorder(key);
      return;
    }
    // start
    try{
      const stream = await navigator.mediaDevices.getUserMedia({audio:true});
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      state.chunks[key] = [];
      state.media[key] = mr;

      mr.ondataavailable = (e)=>{ if(e.data && e.data.size) state.chunks[key].push(e.data); };
      mr.onstop = ()=>{
        // finalize blob
        stream.getTracks().forEach(t=>t.stop());
        const blob = new Blob(state.chunks[key]||[], { type: 'audio/webm' });
        state.blobs[key] = blob;
        meta.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`;
        btn.classList.remove('on');
        btn.textContent = 'Start';
        if(state.timers[key]) clearTimeout(state.timers[key]);
      };

      mr.start();
      btn.classList.add('on');
      btn.textContent = 'Stop';
      meta.textContent = 'Recording…';

      // auto-stop
      state.timers[key] = setTimeout(()=> stopRecorder(key), RECORD_LIMITS_MS[key]||60_000);

    }catch(e){
      meta.textContent = 'Mic blocked — allow permission.';
    }
  });
}

function stopRecorder(key){
  const mr = state.media[key];
  if(mr && mr.state !== 'inactive') mr.stop();
}

/* hook all */
['bp','meds','allergies','weight','conditions','general','classic'].forEach(setupRecorder);

/* =====================
   Generate Report (multi-upload)
   ===================== */

const btnGenerate = $('#btnGenerate');
const resultBox = $('#result');
const errorBox = $('#error');

function setError(m){ if(errorBox) errorBox.textContent = m||''; }
function setResult(h){ if(resultBox) resultBox.innerHTML = h||''; }

function getVal(id){ const el=$(id); return el ? el.value.trim() : ''; }

function gatherPatient(){
  return {
    name: getVal('#pName'),
    email: getVal('#pEmail'),
    blood_type: getVal('#blood'),
    emer_name: getVal('#eName'),
    emer_phone:getVal('#ePhone'),
    emer_email:getVal('#eEmail'),
    doctor_name: getVal('#doctor_name'),
    doctor_address:getVal('#doctor_address'),
    doctor_phone:getVal('#doctor_phone'),
    doctor_fax:  getVal('#doctor_fax'),
    doctor_email:getVal('#doctor_email'),
    pharmacy_name: getVal('#pharmacy_name'),
    pharmacy_address:getVal('#pharmacy_address'),
    pharmacy_phone:getVal('#pharmacy_phone'),
    pharmacy_fax:  getVal('#pharmacy_fax'),
    lang: getVal('#lang')
  };
}

function gatherTypedStatus(){
  return {
    typed_bp: getVal('#typed_bp'),
    typed_meds: getVal('#typed_meds'),
    typed_allergies: getVal('#typed_allergies'),
    typed_weight: getVal('#typed_weight'),
    typed_conditions: getVal('#typed_conditions'),
    typed_general: getVal('#typed_general')
  };
}

async function generateReport(){
  setError(''); setResult('');

  const fd = new FormData();
  // patient fields
  const patient = gatherPatient();
  Object.entries(patient).forEach(([k,v])=> fd.append(k, v));

  // typed status
  const typed = gatherTypedStatus();
  Object.entries(typed).forEach(([k,v])=> fd.append(k, v));

  // audio parts (mini)
  Object.entries(state.blobs).forEach(([k,blob])=>{
    if(!blob || !blob.size) return;
    if(k==='classic') fd.append('audio_classic', blob, 'classic.webm');
    else fd.append(`audio_${k}`, blob, `${k}.webm`);
  });

  // guarantee content: if no audio and no typed provided, build minimal typed_general from patient
  const noAudio = Object.values(state.blobs).every(b => !b || !b.size);
  const noTyped = !Object.values(typed).some(v => v && v.length>0);
  if(noAudio && noTyped){
    const fallback = [
      patient.name && `Patient Name: ${patient.name}`,
      patient.email && `Email: ${patient.email}`,
      patient.blood_type && `Blood: ${patient.blood_type}`
    ].filter(Boolean).join(' — ');
    if(fallback) fd.set('typed_general', fallback);
  }

  const r = await fetch('/upload-multi', { method:'POST', body: fd });
  if(!r.ok){
    let msg = `Upload failed (${r.status})`;
    try{
      const t = await r.text();
      if(t.startsWith('{')){ const j=JSON.parse(t); if(j.error) msg = j.error; }
    }catch{}
    throw new Error(msg);
  }
  return r.json();
}

if(btnGenerate){
  btnGenerate.addEventListener('click', async ()=>{
    try{
      const json = await generateReport();
      if(!json.ok) throw new Error(json.error||'Server error');

      const banner = `
        <div class="report-banner">
          <div class="report-icon">✅</div>
          <div class="report-text">
            <div class="report-title">Report Generated</div>
            <div class="report-sub">Open, copy link or email below.</div>
          </div>
          <div class="report-actions">
            <a class="btn" href="${json.url}" target="_blank" rel="noopener">Open Report</a>
            <button class="btn" id="btnCopyLink" type="button">Copy Link</button>
            <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Caregiver%20Card%20Report&body=${encodeURIComponent(json.url)}" target="_blank" rel="noopener">Gmail</a>
            <a class="btn" href="https://outlook.live.com/owa/?path=/mail/action/compose&subject=Caregiver%20Card%20Report&body=${encodeURIComponent(json.url)}" target="_blank" rel="noopener">Outlook</a>
          </div>
        </div>`;
      setResult(banner);

      const copyBtn = $('#btnCopyLink');
      if(copyBtn){
        copyBtn.addEventListener('click', async ()=>{
          try{ await navigator.clipboard.writeText(json.url); copyBtn.textContent='Copied!'; setTimeout(()=>copyBtn.textContent='Copy Link',1500); }catch{}
        });
      }
    }catch(e){
      setError(e.message||String(e));
    }
  });
}
