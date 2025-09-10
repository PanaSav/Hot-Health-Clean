// backend/public/app.js
// Mic buttons now use MediaRecorder -> /transcribe (reliable). Free-speech recorders also use MediaRecorder.
// After transcription we populate fields OR typed_* areas, then /upload-multi creates the report.

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const resBox = $('#result');
const errBox = $('#error');
function setResult(html){ if(resBox) resBox.innerHTML = html||''; }
function setError(msg){ if(errBox) errBox.textContent = msg||''; }

function sanitizePhone(s){ return (s||'').replace(/[^\d+]/g,''); }
function isLikelyPhone(s){ return /^\+?\d{7,}$/.test(sanitizePhone(s)); }
function normalizeEmailSpoken(raw){
  if (!raw) return '';
  let s = ' '+raw.toLowerCase().trim()+' ';
  s = s.replace(/\s+at\s+/g,'@')
       .replace(/\s+dot\s+/g,'.')
       .replace(/\s+period\s+/g,'.')
       .replace(/\s+underscore\s+/g,'_')
       .replace(/\s+(hyphen|dash)\s+/g,'-')
       .replace(/\s+plus\s+/g,'+');
  s = s.replace(/\s*@\s*/g,'@').replace(/\s*\.\s*/g,'.');
  s = s.replace(/\s+/g,' ').trim().replace(/\s+/g,'');
  s = s.replace(/\.\.+/g,'.');
  return s;
}

// ---- Record helpers (MediaRecorder -> /transcribe)
async function transcribeBlob(blob){
  const fd = new FormData();
  fd.append('audio', blob, 'mic.webm');
  const r = await fetch('/transcribe', { method:'POST', body: fd });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error||'Transcription failed');
  return j.text || '';
}

function makeClickHoldRecorder(btn, { maxMs=15000, onText }){
  if (!btn) return;
  let mediaRecorder=null, chunks=[], timer=null, stream=null;

  async function start(){
    setError('');
    chunks=[];
    try{
      stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    }catch{ setError('Microphone blocked. Allow mic permission.'); return; }
    mediaRecorder = new MediaRecorder(stream, { mimeType:'audio/webm' });
    mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = async ()=>{
      try{
        const blob = new Blob(chunks, { type:'audio/webm' });
        const text = await transcribeBlob(blob);
        onText?.(text);
      }catch(e){ setError(e.message||'Transcription error'); }
      stream.getTracks().forEach(t=>t.stop());
      btn.classList.remove('mic-active');
    };
    mediaRecorder.start();
    btn.classList.add('mic-active');
    timer = setTimeout(()=>stop(), maxMs);
  }
  function stop(){
    try{ mediaRecorder?.stop(); }catch{}
    clearTimeout(timer);
  }
  btn.addEventListener('mousedown', start);
  btn.addEventListener('touchstart', (e)=>{ e.preventDefault(); start(); }, { passive:false });
  btn.addEventListener('mouseup', stop);
  btn.addEventListener('mouseleave', ()=>{ if(btn.classList.contains('mic-active')) stop(); });
  btn.addEventListener('touchend', ()=>stop());
}

// ---- Per-field mic buttons (data-target points to input/select)
$$('.mic-btn').forEach(btn=>{
  const targetId = btn.getAttribute('data-target');
  const el = document.getElementById(targetId);
  if (!el) return;

  makeClickHoldRecorder(btn, {
    maxMs: 15000,
    onText: (raw)=>{
      let text = raw;
      if (el.type==='email' || (el.id||'').toLowerCase().includes('email')) text = normalizeEmailSpoken(raw);
      if ((el.id||'').toLowerCase().includes('phone')) text = sanitizePhone(raw);
      if (el.tagName==='SELECT'){
        const lower = text.toLowerCase();
        const opt = [...el.options].find(o=>o.textContent.toLowerCase().includes(lower) || o.value.toLowerCase()===lower);
        if (opt) el.value = opt.value;
      } else {
        el.value = text;
      }
    }
  });
});

// ---- Free-speech recorders (patient/status) that parse and fill fields
function wireFreeSpeechRecorders(){
  const patBtn = $('#patHold');
  const statBtn = $('#statHold');
  const patientOut = $('#patient_free_text');
  const statusOut  = $('#status_free_text');

  makeClickHoldRecorder(patBtn, {
    maxMs: 60000,
    onText: async (text)=>{
      if (patientOut) patientOut.value = text;
      try{
        const r = await fetch('/parse-free', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ text, scope:'patient' })
        });
        const j = await r.json();
        if (j.ok && j.fields){
          if (j.fields.name)       $('#pName').value = j.fields.name;
          if (j.fields.email)      $('#pEmail').value = j.fields.email;
          if (j.fields.emer_name)  $('#eName').value = j.fields.emer_name;
          if (j.fields.emer_phone) $('#ePhone').value = sanitizePhone(j.fields.emer_phone);
          if (j.fields.emer_email) $('#eEmail').value = j.fields.emer_email;
        }
      }catch{ setError('Parse failed'); }
    }
  });

  makeClickHoldRecorder(statBtn, {
    maxMs: 180000,
    onText: async (text)=>{
      if (statusOut) statusOut.value = text;
      try{
        const r = await fetch('/parse-free', {
          method:'POST',
          headers:{ 'Content-Type':'application/json' },
          body: JSON.stringify({ text, scope:'status' })
        });
        const j = await r.json();
        if (j.ok && j.fields){
          if (j.fields.bp)             $('#typed_bp')?.value = j.fields.bp;
          if (j.fields.weight)         $('#typed_weight')?.value = j.fields.weight;
          if (j.fields.medications?.length) $('#typed_meds')?.value = j.fields.medications.join('; ');
          if (j.fields.allergies?.length)   $('#typed_allergies')?.value = j.fields.allergies.join('; ');
          if (j.fields.conditions?.length)  $('#typed_conditions')?.value = j.fields.conditions.join('; ');
        }
      }catch{ setError('Parse failed'); }
    }
  });
}
wireFreeSpeechRecorders();

// ---- Language detect hint (optional)
async function detectLangFromSnippet(){
  try{
    const sample = ($('#patient_free_text')?.value || $('#status_free_text')?.value || '').trim().slice(0,300);
    if (!sample) return;
    const r = await fetch('/detect-lang', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ text: sample }) });
    const j = await r.json();
    if (j.ok){
      const det = $('#langDetected'); if (det) det.value = `${j.name} (${j.code})`;
      const confirm = $('#langConfirm'); if (confirm){ confirm.checked = true; confirm.dataset.code = j.code; }
    }
  }catch{}
}
setTimeout(detectLangFromSnippet, 1500);

// ---- Generate Report (typed content only; audio is already transcribed client-side)
$('#btnGenerate')?.addEventListener('click', async ()=>{
  try{
    setError(''); setResult('');

    // phone quick check
    for (const id of ['ePhone','doctor_phone','pharmacy_phone']){
      const el = $('#'+id);
      if (el && el.value && !isLikelyPhone(el.value)) return setError('Phone looks invalid (numbers only).');
    }

    const fd = new FormData();

    // Patient & contacts fields
    const ids = [
      'pName','pEmail','blood','eName','ePhone','eEmail',
      'doctor_name','doctor_address','doctor_phone','doctor_fax','doctor_email',
      'pharmacy_name','pharmacy_address','pharmacy_phone','pharmacy_fax'
    ];
    const map = {
      pName:'name', pEmail:'email', blood:'blood_type',
      eName:'emer_name', ePhone:'emer_phone', eEmail:'emer_email',
      doctor_name:'doctor_name', doctor_address:'doctor_address', doctor_phone:'doctor_phone', doctor_fax:'doctor_fax', doctor_email:'doctor_email',
      pharmacy_name:'pharmacy_name', pharmacy_address:'pharmacy_address', pharmacy_phone:'pharmacy_phone', pharmacy_fax:'pharmacy_fax'
    };
    ids.forEach(id=>{ const el=$('#'+id); if(el) fd.append(map[id], el.value.trim()); });

    // language
    fd.append('lang', ($('#lang')?.value||'').trim());

    // typed status (including parsed results from free-speech)
    const sid = ['typed_bp','typed_meds','typed_allergies','typed_weight','typed_conditions','typed_general'];
    sid.forEach(id=>{ const el=$('#'+id); if(el) fd.append(id, el.value.trim()); });

    const r = await fetch('/upload-multi', { method:'POST', body: fd });
    const text = await r.text();
    let json; try{ json = JSON.parse(text); }catch{ throw new Error('Server error'); }
    if (!json.ok) throw new Error(json.error||'Server error');

    setResult(`
      <div class="report-banner">
        <div class="report-icon">✅</div>
        <div class="report-text">
          <div class="report-title">Report Generated</div>
          <div class="report-sub">Open, share, or email below.</div>
        </div>
        <div class="report-actions">
          <a class="btn" href="${json.url}" target="_blank" rel="noopener">Open Report</a>
          <button class="btn" id="btnCopyLink" type="button">Copy Link</button>
          <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Caregiver%20Card&body=${encodeURIComponent(json.url)}" target="_blank" rel="noopener">Gmail</a>
          <a class="btn" href="https://outlook.live.com/owa/?path=/mail/action/compose&subject=Caregiver%20Card&body=${encodeURIComponent(json.url)}" target="_blank" rel="noopener">Outlook</a>
        </div>
      </div>
    `);
    $('#btnCopyLink')?.addEventListener('click', async ()=>{
      try{ await navigator.clipboard.writeText(json.url); const b=$('#btnCopyLink'); if(b){b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy Link',1200);} }catch{}
    });
  }catch(e){
    setError(e.message||'Server error');
  }
});
