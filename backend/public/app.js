// backend/public/app.js
// Robust mic handling: toggle or press&hold, reliable /transcribe path, auto-parsing, JSON-only flows.

document.addEventListener('DOMContentLoaded', () => {
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const resBox = $('#result');
  const errBox = $('#error');

  function setResult(html) { if (resBox) resBox.innerHTML = html || ''; }
  function setError(msg)   { if (errBox) errBox.textContent = msg || ''; }

  // ---------- Helpers
  function log(...a){ console.log('[mic]', ...a); }
  function sanitizePhone(s){ return (s||'').replace(/[^\d+]/g,''); }
  function isLikelyPhone(s){ return /^\+?\d{7,}$/.test(sanitizePhone(s)); }
  function normalizeEmailSpoken(raw){
    if (!raw) return '';
    let s = ' ' + raw.toLowerCase().trim() + ' ';
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

  async function transcribeBlob(blob){
    const fd = new FormData();
    fd.append('audio', blob, 'mic.webm');
    const r = await fetch('/transcribe', { method:'POST', body: fd });
    const j = await r.json().catch(()=>null);
    if (!j || !j.ok) throw new Error((j && j.error) || `Transcription failed (${r.status})`);
    return j.text || '';
  }

  function attachRecorderToggle(btn, { maxMs = 15000, onText }){
    if (!btn) return;
    let recorder = null, stream = null, chunks = [], timer = null, active = false;

    async function start(){
      setError('');
      chunks = [];
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      } catch (e) {
        setError('Microphone blocked. Click the address-bar mic icon to Allow, then reload.');
        log('getUserMedia failed:', e);
        return;
      }
      try {
        recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      } catch (e) {
        setError('Recording not supported in this browser.');
        log('MediaRecorder ctor failed:', e);
        return;
      }

      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        try {
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const text = await transcribeBlob(blob);
          log('transcribed:', text);
          onText?.(text);
        } catch (e) {
          setError(e.message || 'Transcription error');
          log('transcribe error:', e);
        } finally {
          stream.getTracks().forEach(t => t.stop());
          btn.classList.remove('mic-active');
          btn.setAttribute('aria-pressed', 'false');
          active = false;
        }
      };

      try { recorder.start(); } catch (e) {
        setError('Unable to start recording.');
        log('recorder.start failed:', e);
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      active = true;
      btn.classList.add('mic-active');
      btn.setAttribute('aria-pressed', 'true');
      if (maxMs) timer = setTimeout(stop, maxMs);
    }

    function stop(){
      try { recorder && recorder.state !== 'inactive' && recorder.stop(); } catch {}
      if (timer) clearTimeout(timer);
    }

    // Toggle: click to start, click again to stop
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        setError('Recording not supported in this browser.');
        return;
      }
      if (active) stop(); else start();
    });
  }

  // ---------- Per-field mic buttons
  $$('.mic-btn[data-target]').forEach(btn => {
    const targetId = btn.getAttribute('data-target');
    const el = document.getElementById(targetId);
    if (!el) return;

    attachRecorderToggle(btn, {
      maxMs: 15000,
      onText: (raw) => {
        let text = raw;
        const idLower = (el.id || '').toLowerCase();
        const typeLower = (el.type || '').toLowerCase();
        if (typeLower === 'email' || idLower.includes('email')) text = normalizeEmailSpoken(raw);
        if (idLower.includes('phone')) text = sanitizePhone(raw);

        if (el.tagName === 'SELECT') {
          const lower = text.toLowerCase();
          const match = Array.from(el.options).find(o =>
            o.textContent.toLowerCase().includes(lower) || o.value.toLowerCase() === lower
          );
          if (match) el.value = match.value;
        } else {
          el.value = text;
        }
      }
    });
  });

  // ---------- Free-speech recorders (Patient & Status)
  function parsePatient(text){
    return fetch('/parse-free', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ text, scope: 'patient' })
    }).then(r => r.json());
  }
  function parseStatus(text){
    return fetch('/parse-free', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ text, scope: 'status' })
    }).then(r => r.json());
  }

  attachRecorderToggle($('#patHold'), {
    maxMs: 60000,
    onText: async (text) => {
      const out = $('#patient_free_text'); if (out) out.value = text;
      try {
        const j = await parsePatient(text);
        if (j.ok && j.fields) {
          if (j.fields.name)       $('#pName')?.value = j.fields.name;
          if (j.fields.email)      $('#pEmail')?.value = j.fields.email;
          if (j.fields.emer_name)  $('#eName')?.value = j.fields.emer_name;
          if (j.fields.emer_phone) $('#ePhone')?.value = sanitizePhone(j.fields.emer_phone);
          if (j.fields.emer_email) $('#eEmail')?.value = j.fields.emer_email;
        } else {
          log('parse-patient not ok:', j);
        }
      } catch (e) {
        setError('Could not parse patient info.');
        log('parse-patient err:', e);
      }
    }
  });

  attachRecorderToggle($('#statHold'), {
    maxMs: 180000,
    onText: async (text) => {
      const out = $('#status_free_text'); if (out) out.value = text;
      try {
        const j = await parseStatus(text);
        if (j.ok && j.fields) {
          if (j.fields.bp)                   $('#typed_bp')?.value = j.fields.bp;
          if (j.fields.weight)               $('#typed_weight')?.value = j.fields.weight;
          if (j.fields.medications?.length)  $('#typed_meds')?.value = j.fields.medications.join('; ');
          if (j.fields.allergies?.length)    $('#typed_allergies')?.value = j.fields.allergies.join('; ');
          if (j.fields.conditions?.length)   $('#typed_conditions')?.value = j.fields.conditions.join('; ');
        } else {
          log('parse-status not ok:', j);
        }
      } catch (e) {
        setError('Could not parse health status.');
        log('parse-status err:', e);
      }
    }
  });

  // ---------- Language detect from a snippet (optional hint)
  async function detectLangFromSnippet(){
    const sample = ($('#patient_free_text')?.value || $('#status_free_text')?.value || '').trim().slice(0,300);
    if (!sample) return;
    try{
      const r = await fetch('/detect-lang', {
        method:'POST', headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify({ text: sample })
      });
      const j = await r.json();
      if (j.ok){
        const det = $('#langDetected'); if (det) det.value = `${j.name} (${j.code})`;
        const confirm = $('#langConfirm'); if (confirm){ confirm.checked = true; confirm.dataset.code = j.code; }
        log('detected lang:', j);
      }
    }catch(e){ log('detect-lang err', e); }
  }
  setTimeout(detectLangFromSnippet, 1200);

  // ---------- Generate Report (typed & parsed content only)
  $('#btnGenerate')?.addEventListener('click', async ()=>{
    try{
      setError(''); setResult('');

      // phone checks
      for (const id of ['ePhone','doctor_phone','pharmacy_phone']) {
        const el = $('#'+id);
        if (el && el.value && !isLikelyPhone(el.value)) {
          setError('Phone looks invalid (use digits only, allow +country).');
          return;
        }
      }

      const fd = new FormData();
      // patient/contacts
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
      ids.forEach(id => { const el = $('#'+id); if (el) fd.append(map[id], el.value.trim()); });

      // language target
      fd.append('lang', ($('#lang')?.value || '').trim());

      // status typed/parsed fields
      ['typed_bp','typed_meds','typed_allergies','typed_weight','typed_conditions','typed_general']
        .forEach(id => { const el = $('#'+id); if (el) fd.append(id, el.value.trim()); });

      const r = await fetch('/upload-multi', { method:'POST', body: fd });
      const text = await r.text();
      let json; try { json = JSON.parse(text); } catch { throw new Error('Server error'); }
      if (!json.ok) throw new Error(json.error || 'Server error');

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
        try { await navigator.clipboard.writeText(json.url); const b=$('#btnCopyLink'); if(b){ b.textContent='Copied!'; setTimeout(()=>b.textContent='Copy Link',1200);} } catch {}
      });
    } catch (e) {
      setError(e.message || 'Server error');
      console.error('Generate error:', e);
    }
  });

  // Final capability check
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    setError('Recording not supported in this browser. Try the latest Chrome or Edge.');
    log('media or MediaRecorder missing', navigator.mediaDevices, window.MediaRecorder);
  } else {
    log('MediaRecorder ready');
  }
});
