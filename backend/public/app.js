// Caregiver Card — front-end
const $ = (s)=>document.querySelector(s);

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

// Recorders
const btnRecClassic = $('#btnRecClassic');
const recMetaClassic = $('#recMetaClassic');
let classicRecorder=null, classicChunks=[], lastClassicBlob=null;

const recPatientFree = $('#recPatientFree');
const recPatientFreeMeta = $('#recPatientFreeMeta');
let pfRecorder=null, pfChunks=[], pfBlob=null;

const recStatusFree = $('#recStatusFree');
const recStatusFreeMeta = $('#recStatusFreeMeta');
let sfRecorder=null, sfChunks=[], sfBlob=null;

function setError(m){ if(errorBox) errorBox.textContent=m||''; }
function setMeta(m){ if(metaBox) metaBox.textContent=m||''; }
function setResult(h){ if(resultBox) resultBox.innerHTML=h||''; }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

// Email normalization
function normalizeEmailSpoken(raw=''){
  let s=(' '+raw.toLowerCase().trim()+' ');
  s=s.replace(/\s+at\s+/g,'@').replace(/\s+dot\s+/g,'.').replace(/\s+period\s+/g,'.');
  s=s.replace(/\s+underscore\s+/g,'_').replace(/\s+(hyphen|dash)\s+/g,'-').replace(/\s+plus\s+/g,'+');
  s=s.replace(/\s+gmail\s*\.?\s*com\s*/g,'@gmail.com ').replace(/\s+outlook\s*\.?\s*com\s*/g,'@outlook.com ');
  s=s.replace(/\s+hotmail\s*\.?\s*com\s*/g,'@hotmail.com ').replace(/\s+yahoo\s*\.?\s*com\s*/g,'@yahoo.com ');
  s=s.replace(/\s*@\s*/g,'@').replace(/\s*\.\s*/g,'.').replace(/\s+/g,' ').trim().replace(/\s+/g,'');
  s=s.replace(/\.\.+/g,'.');
  return s;
}
function isEmailField(el){
  const id=(el.id||'').toLowerCase(), name=(el.name||'').toLowerCase(), type=(el.type||'').toLowerCase();
  return type==='email' || id.includes('email') || name.includes('email');
}

// Field mics
(()=> {
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  document.querySelectorAll('.mic-btn').forEach(btn=>{
    if(!SR){ btn.disabled=true; btn.title='Speech recognition not supported'; return; }
    btn.addEventListener('click', ()=>{
      const targetId=btn.getAttribute('data-target');
      const el=document.getElementById(targetId);
      if(!el) return;
      const rec=new SR();
      rec.lang='en-US';
      rec.interimResults=false; rec.maxAlternatives=1;
      btn.classList.add('mic-active');
      const bg=el.style.backgroundColor; el.style.backgroundColor='#fff7cc';
      rec.onresult=(e)=>{
        const raw=e.results[0][0].transcript||'';
        const text=isEmailField(el)?normalizeEmailSpoken(raw):raw;
        if (el.tagName==='TEXTAREA'||el.tagName==='INPUT') el.value=text;
        else if(el.tagName==='SELECT'){
          const opt=[...el.options].find(o=>o.textContent.toLowerCase().includes(text.toLowerCase()));
          if(opt) el.value=opt.value;
        }
      };
      rec.onend = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor=bg; };
      rec.onerror= ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor=bg; };
      try{ rec.start(); }catch{ btn.classList.remove('mic-active'); el.style.backgroundColor=bg; }
    });
  });
})();

// Media recorder helper
async function recordFor(button, metaSpan, ms){
  setError('');
  let stream;
  try{ stream=await navigator.mediaDevices.getUserMedia({ audio:true }); }
  catch{ setError('Microphone blocked. Allow mic and try again.'); return null; }
  const chunks=[]; const rec=new MediaRecorder(stream, { mimeType:'audio/webm' });
  return await new Promise((resolve)=>{
    let stopped=false;
    rec.ondataavailable=e=>{ if(e.data && e.data.size) chunks.push(e.data); };
    rec.onstop=()=>{
      stream.getTracks().forEach(t=>t.stop());
      const blob=new Blob(chunks,{type:'audio/webm'});
      if(metaSpan) metaSpan.textContent=`Recorded ${(blob.size/1024).toFixed(1)} KB`;
      resolve(blob);
    };
    rec.start();
    const original=button.textContent; button.textContent='⏹ Stop'; button.disabled=true;
    metaSpan && (metaSpan.textContent='Recording…');
    button.onclick=()=>{ if(stopped) return; stopped=true; rec.stop(); button.textContent=original; button.disabled=false; };
    setTimeout(()=>{ if(stopped) return; stopped=true; rec.stop(); button.textContent=original; button.disabled=false; }, ms);
  });
}

// Classic (90s)
if(btnRecClassic){
  btnRecClassic.addEventListener('click', async()=>{
    lastClassicBlob = await recordFor(btnRecClassic, recMetaClassic, 90_000);
  });
}
// Patient free (120s)
if(recPatientFree){
  recPatientFree.addEventListener('click', async()=>{
    pfBlob = await recordFor(recPatientFree, recPatientFreeMeta, 120_000);
  });
}
// Status free (120s)
if(recStatusFree){
  recStatusFree.addEventListener('click', async()=>{
    sfBlob = await recordFor(recStatusFree, recStatusFreeMeta, 120_000);
  });
}

// Language detect (uses current journal or sample text)
if(btnDetectFromSpeech){
  btnDetectFromSpeech.addEventListener('click', async()=>{
    setError('');
    const sample = document.querySelector('#typed_general')?.value.trim() ||
                   'Blood pressure one twenty over eighty. Weight one eighty pounds.';
    try{
      const r=await fetch('/detect-lang',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text: sample }) });
      const j=await r.json();
      if(j.ok){
        langDetectedEl.value = `${j.name} (${j.code})`;
        langGuessName.textContent = j.name;
        langConfirmWrap.style.display='inline-block';
      }else setError(j.error||'Language detect failed');
    }catch{ setError('Language detect failed'); }
  });
}

// Gather values
function v(id){ const el=$(id); return el? el.value.trim():''; }

function buildFormData(){
  const fd=new FormData();
  // Patient
  fd.append('name', v('#pName'));
  fd.append('email', v('#pEmail'));
  fd.append('blood_type', v('#blood'));
  fd.append('emer_name', v('#eName'));
  fd.append('emer_phone', v('#ePhone'));
  fd.append('emer_email', v('#eEmail'));
  // Doctor
  fd.append('doctor_name', v('#dName'));
  fd.append('doctor_address', v('#dAddr'));
  fd.append('doctor_phone', v('#dPhone'));
  fd.append('doctor_fax', v('#dFax'));
  fd.append('doctor_email', v('#dEmail'));
  // Pharmacy
  fd.append('pharmacy_name', v('#phName'));
  fd.append('pharmacy_address', v('#phAddr'));
  fd.append('pharmacy_phone', v('#phPhone'));
  fd.append('pharmacy_fax', v('#phFax'));
  // Status typed
  fd.append('bp', v('#bp'));
  fd.append('weight', v('#weight'));
  fd.append('typed_meds', v('#typed_meds'));
  fd.append('typed_allergies', v('#typed_allergies'));
  fd.append('typed_conditions', v('#typed_conditions'));
  // Journal
  fd.append('typed_general', v('#typed_general'));
  // Target language
  fd.append('lang', (langSel?langSel.value.trim():''));
  // Audio blobs
  if(pfBlob) fd.append('audio_patientfree', pfBlob, 'pf.webm');
  if(sfBlob) fd.append('audio_statusfree',  sfBlob, 'sf.webm');
  if(lastClassicBlob) fd.append('audio_classic', lastClassicBlob, 'classic.webm');
  return fd;
}

if(btnGenerate){
  btnGenerate.addEventListener('click', async ()=>{
    setError(''); setMeta(''); setResult('');
    const fd=buildFormData();

    const hasAny =
      [...fd.keys()].some(k=>!k.startsWith('audio_') && (fd.get(k)||'').toString().trim()) ||
      pfBlob || sfBlob || lastClassicBlob;
    if (!hasAny){ setError('Please type or record some information first.'); return; }

    try{
      const r=await fetch('/upload-multi',{ method:'POST', body: fd });
      const txt=await r.text();
      let j; try{ j=JSON.parse(txt);}catch{ throw new Error('Server Error'); }
      if(!r.ok || !j.ok) throw new Error(j?.error || `Upload failed (${r.status})`);

      const url=j.url;
      const banner = `
        <div class="report-banner">
          <div class="report-icon">✅</div>
          <div class="report-text">
            <div class="report-title">Report Generated</div>
            <div class="report-sub">Open, copy or email your report below.</div>
          </div>
          <div class="report-actions">
            <a class="btn" href="${url}" target="_blank" rel="noopener">Open Report</a>
            <button class="btn" id="btnCopyLink" type="button">Copy Link</button>
            <a class="btn" target="_blank" rel="noopener"
               href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Caregiver%20Card%20Report&body=${encodeURIComponent(url)}">Gmail</a>
            <a class="btn" target="_blank" rel="noopener"
               href="https://outlook.office.com/mail/deeplink/compose?subject=Caregiver%20Card%20Report&body=${encodeURIComponent(url)}">Outlook</a>
          </div>
        </div>`;
      setResult(banner);
      const copyBtn = $('#btnCopyLink');
      if(copyBtn){
        copyBtn.addEventListener('click', async ()=>{
          try{ await navigator.clipboard.writeText(url); copyBtn.textContent='Copied!'; await sleep(1200); copyBtn.textContent='Copy Link'; }catch{}
        });
      }
    }catch(e){
      setError(e.message || 'Server Error');
    }
  });
}
