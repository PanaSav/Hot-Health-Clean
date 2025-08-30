// backend/public/app.js
const $  = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const errBox = $('#error');
const out    = $('#result');
const meta   = $('#recMeta');
const btnRec = $('#btnRec');
const btnGen = $('#btnGen');

function setError(msg){ errBox.textContent = msg || ''; }
function setMeta(msg){ meta.textContent = msg || ''; }

// --- Speech-to-text for text inputs ---
(function wireMics(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  $$('.mic').forEach(btn => {
    if (!SR) { btn.disabled = true; btn.title = 'Speech recognition not supported'; return; }
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      const kind   = btn.getAttribute('data-kind') || 'input';
      const el = document.getElementById(target);
      if (!el) return;

      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.onresult = (e)=>{
        let text = e.results[0][0].transcript || '';
        // Heuristics for email-like speech
        text = text.replace(/\s+at\s+/ig,'@').replace(/\s+dot\s+/ig,'.').replace(/\s+dash\s+/ig,'-');
        if (kind === 'select') {
          // try to match option text
          const match = [...el.options].find(o => o.textContent.toLowerCase().includes(text.toLowerCase()) || o.value.toLowerCase()===text.toLowerCase());
          if (match) el.value = match.value;
        } else {
          el.value = text;
        }
      };
      rec.start();
    });
  });
})();

// --- Mini recorders ---
const Recorders = {
  bp:null, meds:null, allergies:null, weight:null, conditions:null, general:null,
  classic:null
};
function makeRecorder(key, limitMs, metaSel) {
  let mr = null, chunks=[];
  let timer = null;
  const metaEl = $(metaSel);
  return {
    start: async () => {
      chunks = []; setError('');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
        mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      } catch {
        setError('Mic blocked or unsupported'); return;
      }
      mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = ()=>{ mr.stream.getTracks().forEach(t=>t.stop()); clearTimeout(timer); };

      mr.start();
      metaEl.textContent = 'Recording…';
      timer = setTimeout(()=>{ try{ mr?.stop(); }catch{} }, limitMs);
      return true;
    },
    stop: async () => {
      return new Promise(resolve=>{
        if (!mr || mr.state==='inactive') return resolve(null);
        mr.onstop = ()=>{
          mr.stream.getTracks().forEach(t=>t.stop());
          const blob = new Blob(chunks, { type:'audio/webm' });
          metaEl.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`;
          resolve(blob);
        };
        try { mr.stop(); } catch { resolve(null); }
        clearTimeout(timer);
      });
    }
  };
}

// Wire mini buttons
(function wireMini(){
  $$('.rec').forEach(btn=>{
    const key = btn.getAttribute('data-key');
    const ms  = Number(btn.getAttribute('data-ms') || '30000');
    if (!Recorders[key]) Recorders[key] = makeRecorder(key, ms, `#meta_${key}`);

    let state = 'idle';
    btn.addEventListener('click', async ()=>{
      if (state==='idle') {
        const ok = await Recorders[key].start();
        if (ok) { state='rec'; btn.textContent='⏹️ Stop'; }
      } else {
        const blob = await Recorders[key].stop();
        state='idle'; btn.textContent=`⏺️ Record (${Math.round(ms/1000)}s)`;
        if (blob) Recorders[key].blob = blob;
      }
    });
  });
})();

// --- Classic recorder ---
let classicState='idle'; // toggled by btnRec
(function wireClassic(){
  const ms = 30000;
  if (!btnRec) return;
  Recorders.classic = makeRecorder('classic', ms, '#recMeta');

  btnRec.addEventListener('click', async ()=>{
    if (classicState==='idle') {
      const ok = await Recorders.classic.start();
      if (ok) { classicState='rec'; btnRec.textContent='⏹️ Stop'; }
    } else {
      const blob = await Recorders.classic.stop();
      classicState='idle'; btnRec.textContent='⏺️ Record';
      if (blob) Recorders.classic.blob = blob;
    }
  });
})();

// Gather form
function formVals() {
  return {
    name: $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    emer_name: $('#eName').value.trim(),
    emer_phone: $('#ePhone').value.trim(),
    emer_email: $('#eEmail').value.trim(),
    blood_type: $('#blood').value.trim(),
    lang: $('#lang').value.trim(),
    doctor_name: $('#dName').value.trim(),
    doctor_address: $('#dAddr').value.trim(),
    doctor_phone: $('#dPhone').value.trim(),
    doctor_fax: $('#dFax').value.trim(),
    doctor_email: $('#dEmail').value.trim(),
    pharmacy_name: $('#phName').value.trim(),
    pharmacy_address: $('#phAddr').value.trim(),
    pharmacy_phone: $('#phPhone').value.trim(),
    pharmacy_fax: $('#phFax').value.trim(),
    t_bp: $('#t_bp').value.trim(),
    t_meds: $('#t_meds').value.trim(),
    t_allergies: $('#t_allergies').value.trim(),
    t_weight: $('#t_weight').value.trim(),
    t_conditions: $('#t_conditions').value.trim(),
    t_general: $('#t_general').value.trim(),
  };
}

// Generate report (multi)
btnGen?.addEventListener('click', async ()=>{
  try {
    setError(''); out.textContent='Working…';
    const f = formVals();
    const fd = new FormData();
    for (const [k,v] of Object.entries(f)) fd.append(k, v);

    // attach blobs if present
    if (Recorders.bp?.blob)         fd.append('audio_bp', Recorders.bp.blob, 'bp.webm');
    if (Recorders.meds?.blob)       fd.append('audio_meds', Recorders.meds.blob, 'meds.webm');
    if (Recorders.allergies?.blob)  fd.append('audio_allergies', Recorders.allergies.blob, 'allergies.webm');
    if (Recorders.weight?.blob)     fd.append('audio_weight', Recorders.weight.blob, 'weight.webm');
    if (Recorders.conditions?.blob) fd.append('audio_conditions', Recorders.conditions.blob, 'conditions.webm');
    if (Recorders.general?.blob)    fd.append('audio_general', Recorders.general.blob, 'general.webm');
    if (Recorders.classic?.blob)    fd.append('audio_classic', Recorders.classic.blob, 'classic.webm');

    const r = await fetch('/upload-multi', { method:'POST', body: fd });
    const json = await r.json().catch(()=> ({}));
    if (!r.ok || !json.ok) throw new Error(json.error || `Server Error (${r.status})`);

    out.innerHTML = `✅ Created. <a href="${json.url}" target="_blank" rel="noopener">Open report</a>`;
  } catch (e) {
    setError(e.message || String(e));
    out.textContent = '—';
  }
});
