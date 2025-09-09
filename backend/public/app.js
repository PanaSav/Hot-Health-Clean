// backend/public/app.js
// Frontend logic: per-field mics, two free-speech recorders, language detect, generate report

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const resBox = $('#result');
const errBox = $('#error');

function setResult(html){ if(resBox) resBox.innerHTML = html||''; }
function setError(msg){ if(errBox) errBox.textContent = msg||''; }

function sanitizePhone(s){
  return (s||'').replace(/[^\d+]/g,'');
}
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
  s = s.replace(/\s+/g,' ').trim();
  s = s.replace(/\s+/g,'');
  s = s.replace(/\.\.+/g,'.');
  return s;
}

// ---------- Per-field microphones ----------
(function wireFieldMics(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  $$('.mic-btn').forEach(btn=>{
    if (!SR){ btn.disabled=true; btn.title='Speech recognition not supported'; return; }
    btn.addEventListener('click', ()=>{
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;

      const rec = new SR();
      rec.lang = (window.__uiLang || 'en-US');
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      const original = el.style.backgroundColor;
      btn.classList.add('mic-active'); el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e)=>{
        let text = e.results[0][0].transcript || '';
        if (el.type==='email' || (el.id||'').toLowerCase().includes('email')) text = normalizeEmailSpoken(text);
        if ((el.id||'').toLowerCase().includes('phone')) text = sanitizePhone(text);
        if (el.tagName==='SELECT'){
          const lower = text.toLowerCase();
          const opt = [...el.options].find(o=>o.textContent.toLowerCase().includes(lower) || o.value.toLowerCase()===lower);
          if (opt) el.value = opt.value;
        } else {
          el.value = text;
        }
      };
      rec.onend = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = original; };
      rec.onerror = ()=>{ btn.classList.remove('mic-active'); el.style.backgroundColor = original; };

      try{ rec.start(); } catch { btn.classList.remove('mic-active'); el.style.backgroundColor = original; }
    });
  });
})();

// ---------- Free-speech recorders (patient/status) ----------
function makeRecorder(startBtn, stopBtn, outId, scope){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR){ if(startBtn) startBtn.disabled = true; if(stopBtn) stopBtn.disabled=true; return; }

  let rec=null, timer=null, chunksText=[];
  startBtn?.addEventListener('click', ()=>{
    setError('');
    chunksText = [];
    rec = new SR();
    rec.lang = (window.__uiLang || 'en-US');
    rec.interimResults=false; rec.maxAlternatives=1;

    rec.onresult = (e)=>{ const t=e.results[0][0].transcript||''; chunksText.push(t); };
    rec.onend = async ()=>{
      stopBtn?.classList.remove('mic-active');
      const text = (chunksText.join(' ').trim());
      if (text){
        // send to server to parse into fields
        try{
          const r = await fetch('/parse-free', {
            method:'POST',
            headers:{ 'Content-Type':'application/json' },
            body: JSON.stringify({ text, scope })
          });
          const j = await r.json();
          if (j.ok && j.fields){
            if (scope==='patient'){
              if (j.fields.name)       $('#pName').value = j.fields.name;
              if (j.fields.email)      $('#pEmail').value = j.fields.email;
              if (j.fields.emer_name)  $('#eName').value = j.fields.emer_name;
              if (j.fields.emer_phone) $('#ePhone').value = sanitizePhone(j.fields.emer_phone);
              if (j.fields.emer_email) $('#eEmail').value = j.fields.emer_email;
            } else {
              // status block: we fill typed_* helpers
              if (j.fields.bp)         $('#typed_bp')?.value = j.fields.bp;
              if (j.fields.weight)     $('#typed_weight')?.value = j.fields.weight;
              if (j.fields.medications?.length) $('#typed_meds')?.value = j.fields.medications.join('; ');
              if (j.fields.allergies?.length)   $('#typed_allergies')?.value = j.fields.allergies.join('; ');
              if (j.fields.conditions?.length)  $('#typed_conditions')?.value = j.fields.conditions.join('; ');
            }
          }
          const target = $('#'+outId); if (target) target.value = text;
        }catch(e){ setError('Parse failed'); }
      }
    };
    stopBtn?.classList.add('mic-active');
    try{ rec.start(); }catch {}
    // auto-stop timers
    const ms = scope==='patient' ? 60000 : 180000; // 1 min patient, 3 min status journal
    timer = setTimeout(()=>{ try{ rec.stop(); }catch{} }, ms);
  });

  stopBtn?.addEventListener('click', ()=>{
    try{ rec?.stop(); }catch{}
    clearTimeout(timer); stopBtn?.classList.remove('mic-active');
  });
}

makeRecorder($('#patStart'), $('#patStop'), 'patient_free_text', 'patient');
makeRecorder($('#statStart'), $('#statStop'), 'status_free_text',  'status');

// ---------- Language detect helper (optional prompt) ----------
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

// ---------- Generate Report ----------
$('#btnGenerate')?.addEventListener('click', async ()=>{
  try{
    setError(''); setResult('');

    // quick phone validation
    for (const id of ['ePhone','doctor_phone','pharmacy_phone']){
      const el = $('#'+id);
      if (el && el.value && !isLikelyPhone(el.value)) return setError('Phone looks invalid (numbers only).');
    }

    const fd = new FormData();

    // patient typed fields
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
    ids.forEach(id=>{
      const el = $('#'+id);
      if (el) fd.append(map[id], el.value.trim());
    });

    // language
    const langSel = $('#lang'); fd.append('lang', (langSel?.value||'').trim());

    // patient free text → for server audit and for detect UX
    const pft = $('#patient_free_text')?.value||''; if (pft) fd.append('typed_patient_free', pft);
    // status typed fields
    const sid = ['typed_bp','typed_meds','typed_allergies','typed_weight','typed_conditions','typed_general'];
    sid.forEach(id=>{ const el=$('#'+id); if (el) fd.append(id, el.value.trim()); });

    // hidden “auto-parsed” fields (set by free-speech parser)
    const autoMap = ['name_auto','email_auto','emer_name_auto','emer_phone_auto','emer_email_auto'];
    autoMap.forEach(id=>{ const el=$('#'+id); if (el && el.value) fd.append(id, el.value.trim()); });

    // call multi endpoint (no audio is fine)
    const r = await fetch('/upload-multi', { method:'POST', body: fd });
    const text = await r.text();
    let json;
    try{ json = JSON.parse(text); }
    catch{ throw new Error(`Server error`); }
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
