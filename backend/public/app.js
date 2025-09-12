// backend/public/app.js
document.addEventListener('DOMContentLoaded', () => {
  const $  = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const resBox = $('#result');
  const errBox = $('#error');
  const setResult = (h)=>{ if(resBox) resBox.innerHTML = h || ''; };
  const setError  = (m)=>{ if(errBox) errBox.textContent = m || ''; };
  const log = (...a)=>console.log('[mic]', ...a);

  // ---------- Normalizers
  function sanitizePhone(s){ return (s||'').replace(/[^\d+]/g,''); }
  function normalizeEmailSpoken(raw){
    if (!raw) return '';
    let s = ' ' + raw.toLowerCase().trim() + ' ';
    s = s.replace(/\s+at\s+/g,'@').replace(/\s+dot\s+/g,'.')
         .replace(/\s+period\s+/g,'.').replace(/\s+underscore\s+/g,'_')
         .replace(/\s+(hyphen|dash)\s+/g,'-').replace(/\s+plus\s+/g,'+')
         .replace(/\s*@\s*/g,'@').replace(/\s*\.\s*/g,'.')
         .replace(/\s+/g,' ').trim().replace(/\s+/g,'').replace(/\.\.+/g,'.');
    return s;
  }

  // ---------- Server calls
  async function transcribeBlob(blob){
    const fd = new FormData();
    fd.append('audio', blob, 'mic.webm');
    const r = await fetch('/transcribe', { method:'POST', body: fd });
    const j = await r.json().catch(()=>null);
    if (!j || !j.ok) throw new Error((j && j.error) || `Transcription failed (${r.status})`);
    return j.text || '';
  }
  const parseFree = (text, scope) =>
    fetch('/parse-free', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, scope })})
      .then(r=>r.json());

  // ---------- Recorder wiring
  function attachRecorderToggle(btn, { maxMs = 15000, onText }){
    if (!btn) return;
    let recorder=null, stream=null, chunks=[], timer=null, active=false;

    async function start(){
      setError('');
      chunks=[];
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      } catch {
        setError('Microphone blocked. Allow it in the browser bar, then reload.');
        return;
      }
      try {
        recorder = new MediaRecorder(stream, { mimeType:'audio/webm' });
      } catch {
        setError('Recording not supported in this browser.');
        return;
      }
      recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = async ()=>{
        try{
          const blob = new Blob(chunks, { type:'audio/webm' });
          const text = await transcribeBlob(blob);
          if (typeof onText === 'function') onText(text);
        } catch(e) {
          setError(e.message || 'Transcription error');
          log('transcribe error:', e);
        } finally {
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
          btn.classList.remove('mic-active');
          btn.setAttribute('aria-pressed','false');
          active=false;
        }
      };
      try { recorder.start(); } catch { setError('Could not start recording.'); return; }
      active=true;
      btn.classList.add('mic-active'); btn.setAttribute('aria-pressed','true');
      if (maxMs) timer = setTimeout(()=>{ try{ recorder.stop(); }catch{} }, maxMs);
    }
    function stop(){
      try { if (recorder && recorder.state!=='inactive') recorder.stop(); } catch {}
      if (timer) clearTimeout(timer);
    }
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      if (!navigator.mediaDevices || !window.MediaRecorder) { setError('Recording not supported.'); return; }
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
        const id = (el.id || '').toLowerCase();
        const type = (el.type || '').toLowerCase();
        if (type==='email' || id.includes('email')) text = normalizeEmailSpoken(raw);
        if (id.includes('phone')) text = sanitizePhone(raw);

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

  // ---------- Free-speech “Patient” recorder -> fill fields
  attachRecorderToggle(document.getElementById('patHold'), {
    maxMs: 60000,
    onText: async (text) => {
      const out = document.getElementById('patient_free_text'); if (out) out.value = text;
      try{
        const j = await parseFree(text, 'patient');
        if (j && j.ok && j.fields) {
          const F = j.fields;
          const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
          set('pName', F.name);
          set('pEmail', F.email);
          set('eName', F.emer_name);
          set('ePhone', F.emer_phone);
          set('eEmail', F.emer_email);
          set('blood', F.blood_type);
        }
      } catch(e){ setError('Could not parse patient info.'); }
    }
  });

  // ---------- Free-speech “Status” recorder -> fill status fields
  attachRecorderToggle(document.getElementById('statHold'), {
    maxMs: 180000,
    onText: async (text) => {
      const out = document.getElementById('status_free_text'); if (out) out.value = text;
      try{
        const j = await parseFree(text, 'status');
        if (j && j.ok && j.fields) {
          const F = j.fields;
          const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
          set('typed_bp', F.bp);
          set('typed_weight', F.weight);
          if (Array.isArray(F.medications)) set('typed_meds', F.medications.join('; '));
          if (Array.isArray(F.allergies))   set('typed_allergies', F.allergies.join('; '));
          if (Array.isArray(F.conditions))  set('typed_conditions', F.conditions.join('; '));
          set('typed_general', F.general);
        }
      } catch(e){ setError('Could not parse health status.'); }
    }
  });

  // ---------- Generate Report (typed content only)
  const genBtn = document.getElementById('btnGenerate');
  if (genBtn) {
    genBtn.addEventListener('click', async ()=>{
      try{
        setError(''); setResult('');

        const fd = new FormData();
        // Patient & contacts
        const map = {
          pName:'name', pEmail:'email', blood:'blood_type',
          eName:'emer_name', ePhone:'emer_phone', eEmail:'emer_email',
          doctor_name:'doctor_name', doctor_address:'doctor_address', doctor_phone:'doctor_phone', doctor_fax:'doctor_fax', doctor_email:'doctor_email',
          pharmacy_name:'pharmacy_name', pharmacy_address:'pharmacy_address', pharmacy_phone:'pharmacy_phone', pharmacy_fax:'pharmacy_fax'
        };
        Object.keys(map).forEach(id => {
          const el = document.getElementById(id);
          if (el) fd.append(map[id], (el.value || '').trim());
        });
        const langEl = document.getElementById('lang');
        fd.append('lang', (langEl && langEl.value ? langEl.value.trim() : ''));

        // Status typed fields
        ['typed_bp','typed_meds','typed_allergies','typed_weight','typed_conditions','typed_general']
          .forEach(id => { const el = document.getElementById(id); if (el) fd.append(id, (el.value || '').trim()); });

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
        const copyBtn = document.getElementById('btnCopyLink');
        if (copyBtn) copyBtn.addEventListener('click', async ()=>{
          try { await navigator.clipboard.writeText(json.url); copyBtn.textContent='Copied!'; setTimeout(()=>copyBtn.textContent='Copy Link',1200); } catch {}
        });

      } catch(e){
        setError(e.message || 'Server error');
        console.error('Generate error:', e);
      }
    });
  }

  if (!navigator.mediaDevices || !window.MediaRecorder) {
    setError('Recording not supported in this browser. Try latest Chrome or Edge.');
  } else {
    console.log('[mic] MediaRecorder ready');
  }
});
