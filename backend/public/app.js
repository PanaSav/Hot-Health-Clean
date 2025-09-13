/* app.js — single field mics + journal recorder + detect + parse + generate */

const $ = s => document.querySelector(s);
const resultBox = $('#result');
const errorBox  = $('#error');

function setError(m){ if(errorBox) errorBox.textContent = m||''; }
function setResult(html){ if(resultBox) resultBox.innerHTML = html||''; }

// -------- email normalization (spoken) ----------
function normalizeEmailSpoken(raw=''){
  let s = ' ' + raw.toLowerCase().trim() + ' ';
  s = s.replace(/\s+at\s+/g,'@')
       .replace(/\s+dot\s+/g,'.')
       .replace(/\s+period\s+/g,'.')
       .replace(/\s+underscore\s+/g,'_')
       .replace(/\s+(hyphen|dash)\s+/g,'-')
       .replace(/\s+plus\s+/g,'+');

  s = s.replace(/\s+gmail\s*\.?\s*com\s*/g,'@gmail.com ')
       .replace(/\s+outlook\s*\.?\s*com\s*/g,'@outlook.com ')
       .replace(/\s+hotmail\s*\.?\s*com\s*/g,'@hotmail.com ')
       .replace(/\s+yahoo\s*\.?\s*com\s*/g,'@yahoo.com ');

  s = s.replace(/\s*@\s*/g,'@').replace(/\s*\.\s*/g,'.');
  s = s.replace(/\s+/g,'').replace(/\.\.+/g,'.');
  return s;
}
function isEmailField(el){
  const id=(el.id||'').toLowerCase(), name=(el.name||'').toLowerCase(), type=(el.type||'').toLowerCase();
  return type==='email' || id.includes('email') || name.includes('email');
}
function normalizePhoneDigits(text=''){
  return text.replace(/[^\d+]/g,'').slice(0,20);
}

// -------- MediaRecorder helper ----------
async function recordOnce(ms=10000){
  const stream = await navigator.mediaDevices.getUserMedia({audio:true});
  const rec = new MediaRecorder(stream, { mimeType:'audio/webm' });
  const chunks = [];
  return await new Promise((resolve,reject)=>{
    const t = setTimeout(()=>{ if(rec.state!=='inactive') rec.stop(); }, ms);
    rec.ondataavailable = e=>{ if(e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = ()=>{ clearTimeout(t); stream.getTracks().forEach(t=>t.stop()); resolve(new Blob(chunks,{type:'audio/webm'})); };
    rec.onerror = e=>{ clearTimeout(t); stream.getTracks().forEach(t=>t.stop()); reject(e.error||e); };
    rec.start();
  });
}

// -------- Robust JSON guard ----------
async function readJSONorAuthMessage(resp){
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')){
    const txt = await resp.text();
    // Login page or HTML? Treat as auth problem
    throw new Error('Not signed in (session expired). Please reload and sign in.');
  }
  return resp.json();
}

// -------- POST helpers ----------
async function transcribeBlob(blob){
  const fd = new FormData(); fd.append('audio', blob, 'rec.webm');
  const r = await fetch('/transcribe', { method:'POST', body:fd, credentials:'same-origin' });
  if (r.status === 401) throw new Error('Not signed in (401). Please reload and sign in.');
  if(!r.ok) throw new Error('Transcription failed ('+r.status+')');
  return readJSONorAuthMessage(r);
}
async function detectLanguageFromText(text){
  const r = await fetch('/detect-language-text', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ text }), credentials:'same-origin'
  });
  if (r.status === 401) return { ok:false, lang:'', name:'' };
  if(!r.ok) return { ok:false, lang:'', name:'' };
  try { return await readJSONorAuthMessage(r); } catch { return { ok:false, lang:'', name:'' }; }
}
async function parseFreeSpeech(text){
  const r = await fetch('/parse-free-speech', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ text }), credentials:'same-origin'
  });
  if (r.status === 401) throw new Error('Not signed in (401). Please reload and sign in.');
  if(!r.ok) throw new Error('Parse failed');
  return readJSONorAuthMessage(r);
}
async function generateReport(payload){
  const r = await fetch('/upload-multi', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify(payload), credentials:'same-origin'
  });
  if (r.status === 401) throw new Error('Not signed in (401). Please reload and sign in.');
  if(!r.ok){
    let msg='Server error';
    try{ const j = await readJSONorAuthMessage(r); if(j?.error) msg=j.error; }catch{}
    throw new Error(msg);
  }
  return readJSONorAuthMessage(r);
}

// -------- field mic buttons ----------
document.querySelectorAll('.mic-btn').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    try{
      const id = btn.getAttribute('data-target');
      const el = document.getElementById(id);
      if(!el) return;
      setError('');
      btn.classList.add('mic-active');

      const blob = await recordOnce(12000);
      const { ok, text } = await transcribeBlob(blob);
      if(!ok) throw new Error('Transcription failed');

      let val = text || '';
      if (isEmailField(el)) val = normalizeEmailSpoken(val);
      if (/phone|fax/i.test(id)) val = normalizePhoneDigits(val);

      el.value = val;
    }catch(e){
      console.log('[mic] transcribe error:', e);
      setError(e.message||String(e));
    }finally{
      btn.classList.remove('mic-active');
    }
  });
});

// -------- journal recorder ----------
const jBtn = $('#journalRec');
const jMeta= $('#jMeta');
const jBox = $('#journal');
const langDetected = $('#langDetected');
const langConfirm = $('#langConfirm');
const langConfirm2= $('#langConfirm2');
const langTarget  = $('#lang');

if (jBtn){
  jBtn.addEventListener('click', async ()=>{
    try{
      setError(''); jMeta.textContent='Recording… (up to ~60s)';
      jBtn.disabled = true; jBtn.classList.add('mic-active');

      const blob = await recordOnce(60000);
      jMeta.textContent = 'Transcribing…';
      const { ok, text } = await transcribeBlob(blob);
      if(!ok) throw new Error('Transcription failed');
      jBox.value = text;

      // detect language
      const det = await detectLanguageFromText(text);
      if(det.ok && det.lang){
        langDetected.value = det.name || det.lang.toUpperCase();
        const msg = `We think you’re speaking <b>${det.name||det.lang}</b> — tap Translate To if you want a translated report.`;
        langConfirm.innerHTML = msg;
        langConfirm2.innerHTML= msg;
      }

      // parse into fields
      jMeta.textContent = 'Parsing free speech…';
      const parsed = await parseFreeSpeech(text);
      if(parsed.ok){
        const F = parsed.fields||{};
        const S = parsed.status||{};
        // Patient/contact
        if ($('#pName'))  $('#pName').value  = F.name||$('#pName').value;
        if ($('#pEmail')) $('#pEmail').value = F.email||$('#pEmail').value;
        if ($('#blood'))  $('#blood').value  = F.blood_type||$('#blood').value;

        if ($('#eName'))  $('#eName').value  = F.emer_name||$('#eName').value;
        if ($('#ePhone')) $('#ePhone').value = F.emer_phone||$('#ePhone').value;
        if ($('#eEmail')) $('#eEmail').value = F.emer_email||$('#eEmail').value;

        if ($('#dName'))    $('#dName').value    = F.doctor_name||$('#dName').value;
        if ($('#dAddress')) $('#dAddress').value = F.doctor_address||$('#dAddress').value;
        if ($('#dPhone'))   $('#dPhone').value   = F.doctor_phone||$('#dPhone').value;
        if ($('#dFax'))     $('#dFax').value     = F.doctor_fax||$('#dFax').value;
        if ($('#dEmail'))   $('#dEmail').value   = F.doctor_email||$('#dEmail').value;

        if ($('#phName'))    $('#phName').value    = F.pharmacy_name||$('#phName').value;
        if ($('#phAddress')) $('#phAddress').value = F.pharmacy_address||$('#phAddress').value;
        if ($('#phPhone'))   $('#phPhone').value   = F.pharmacy_phone||$('#phPhone').value;
        if ($('#phFax'))     $('#phFax').value     = F.pharmacy_fax||$('#phFax').value;

        // Status
        if ($('#bp'))        $('#bp').value        = S.bp||$('#bp').value;
        if ($('#weight'))    $('#weight').value    = S.weight||$('#weight').value;
        if ($('#meds'))      $('#meds').value      = (S.medications||[]).join('; ') || $('#meds').value;
        if ($('#allergies')) $('#allergies').value = (S.allergies||[]).join('; ')   || $('#allergies').value;
        if ($('#conditions'))$('#conditions').value= (S.conditions||[]).join('; ')  || $('#conditions').value;
      }
      jMeta.textContent = 'Journal parsed and applied.';
    }catch(e){
      console.log('[journal] error:', e);
      setError(e.message||String(e));
      jMeta.textContent='';
    }finally{
      jBtn.disabled=false; jBtn.classList.remove('mic-active');
    }
  });
}

// -------- gather + generate --------
function val(id){ const el=$(id); return el ? el.value.trim() : ''; }

$('#btnGenerate')?.addEventListener('click', async ()=>{
  try{
    setError(''); setResult('');
    const payload = {
      detected_lang: (langDetected?.value||'').trim(),
      target_lang:   (langTarget?.value||'').trim(),

      name: val('#pName'), email: val('#pEmail'), blood_type: val('#blood'),
      emer_name: val('#eName'), emer_phone: val('#ePhone'), emer_email: val('#eEmail'),
      doctor_name: val('#dName'), doctor_address: val('#dAddress'), doctor_phone: val('#dPhone'), doctor_fax: val('#dFax'), doctor_email: val('#dEmail'),
      pharmacy_name: val('#phName'), pharmacy_address: val('#phAddress'), pharmacy_phone: val('#phPhone'), pharmacy_fax: val('#phFax'),

      bp: val('#bp'), weight: val('#weight'),
      medications: val('#meds'), allergies: val('#allergies'), conditions: val('#conditions'),

      transcript: '',
      journal_text: val('#journal')
    };

    const any = Object.values(payload).some(v => (v||'').length);
    if(!any) throw new Error('Please enter or record at least some information.');

    const j = await generateReport(payload);
    if(!j.ok) throw new Error(j.error||'Server error');

    const shareUrl = j.url;
    const banner = `
      <div class="report-banner">
        <div class="report-icon">✅</div>
        <div class="report-text">
          <div class="report-title">Report Generated</div>
          <div class="report-sub">Open, copy link, or email below.</div>
        </div>
        <div class="report-actions">
          <a class="btn" href="${shareUrl}" target="_blank" rel="noopener">Open Report</a>
          <button class="btn" id="btnCopyLink" type="button">Copy Link</button>
          <a class="btn" href="https://mail.google.com/mail/?view=cm&fs=1&tf=1&su=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Gmail</a>
          <a class="btn" href="https://outlook.office.com/mail/deeplink/compose?subject=Caregiver%20Card%20Report&body=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Outlook</a>
        </div>
      </div>`;
    setResult(banner);
    $('#btnCopyLink')?.addEventListener('click', async ()=>{
      try{ await navigator.clipboard.writeText(shareUrl); const b=$('#btnCopyLink'); if(b){ b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy Link',1500);} }catch{}
    });
  }catch(e){
    setError(e.message||String(e));
  }
});
