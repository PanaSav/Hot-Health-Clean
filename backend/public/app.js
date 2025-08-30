// backend/public/app.js

const $  = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const errBox = $('#error');
const out    = $('#result');
const meta   = $('#recMeta');
const btnRec = $('#btnRec');
const btnGen = $('#btnGen');

function setError(msg){ if (errBox) errBox.textContent = msg || ''; }
function setMeta(msg){ if (meta) meta.textContent = msg || ''; }

// Prefill working language from browser (best-effort)
(() => {
  const el = $('#workLangDetected');
  if (el && !el.value) {
    try {
      const navLang = (navigator.language || '').split('-')[0] || '';
      const map = { en:'English', fr:'Français', es:'Español', pt:'Português', de:'Deutsch', it:'Italiano', ar:'العربية', hi:'हिन्दी', zh:'中文', ja:'日本語', ko:'한국어', he:'עברית', sr:'Srpski', pa:'ਪੰਜਾਬੀ' };
      el.value = map[navLang] || (navigator.language || 'English');
    } catch {}
  }
})();

// ------------------------------
// Speech Recognition mics (inputs + selects)
// Toggleable start/stop with icon swap
// ------------------------------
(function wireMics(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const active = new Map(); // btn -> recognition

  $$('.mic').forEach(btn => {
    if (!SR) { btn.disabled = true; btn.title = 'Speech recognition not supported in this browser'; return; }

    let listening = false;
    const targetId = btn.getAttribute('data-target');
    const kind     = btn.getAttribute('data-kind') || 'input';
    const targetEl = document.getElementById(targetId);

    if (!targetEl) { btn.disabled = true; return; }

    const start = () => {
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.dataset.icon = btn.textContent;
      btn.textContent = '⏹️';
      btn.classList.add('listening');
      listening = true;
      active.set(btn, rec);

      rec.onresult = (e) => {
        let text = e.results?.[0]?.[0]?.transcript || '';
        // heuristics for emails/URLs/phones
        text = text
          .replace(/\s+at\s+/ig,'@')
          .replace(/\s+dot\s+/ig,'.')
          .replace(/\s+dash\s+/ig,'-')
          .replace(/\s+plus\s+/ig,'+');

        if (kind === 'select') {
          // Try matching option text OR value
          const opts = [...targetEl.options];
          // also map by language names to codes, rough
          const langNameToCode = {
            english:'en', français:'fr', french:'fr', español:'es', spanish:'es', português:'pt', portuguese:'pt',
            deutsch:'de', german:'de', italiano:'it', italian:'it', العربية:'ar', hindi:'hi', हिन्दी:'hi', 中文:'zh',
            日本語:'ja', korean:'ko', 한국어:'ko', עברית:'he', srpski:'sr', serbian:'sr', ਪੰਜਾਬੀ:'pa', punjabi:'pa'
          };
          const lower = text.trim().toLowerCase();
          let code = langNameToCode[lower];
          if (code) {
            const opt = opts.find(o => o.value === code);
            if (opt) targetEl.value = opt.value;
          } else {
            const opt = opts.find(o =>
              o.textContent.trim().toLowerCase().includes(lower) ||
              o.value.toLowerCase() === lower
            );
            if (opt) targetEl.value = opt.value;
          }
        } else {
          targetEl.value = text;
        }
      };

      rec.onend = () => stop();
      rec.onerror = () => stop();

      try { rec.start(); } catch { stop(); }
    };

    const stop = () => {
      const rec = active.get(btn);
      if (rec) {
        try { rec.stop(); } catch {}
        active.delete(btn);
      }
      if (listening) {
        btn.textContent = btn.dataset.icon || '🎙️';
        btn.classList.remove('listening');
      }
      listening = false;
    };

    btn.addEventListener('click', () => {
      if (!listening) start();
      else stop();
    });
  });
})();

// ------------------------------
// Mini recorders (MediaRecorder)
// ------------------------------
const Recorders = {
  bp:null, meds:null, allergies:null, weight:null, conditions:null, general:null, classic:null
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
        setError('Microphone blocked or unsupported by browser/HTTPS'); return false;
      }
      mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      mr.onstop = ()=>{ mr.stream.getTracks().forEach(t=>t.stop()); clearTimeout(timer); };

      mr.start();
      metaEl && (metaEl.textContent = 'Recording…');
      timer = setTimeout(()=>{ try{ mr?.stop(); }catch{} }, limitMs);
      return true;
    },
    stop: async () => {
      return new Promise(resolve=>{
        if (!mr || mr.state==='inactive') return resolve(null);
        mr.onstop = ()=>{
          mr.stream.getTracks().forEach(t=>t.stop());
          const blob = new Blob(chunks, { type:'audio/webm' });
          metaEl && (metaEl.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`);
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

// ------------------------------
// Classic recorder
// ------------------------------
let classicState='idle';
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

// ------------------------------
// Form gathering + submit
// ------------------------------
function formVals() {
  return {
    // language
    lang: $('#lang')?.value.trim() || '',

    // patient
    name: $('#pName')?.value.trim() || '',
    email: $('#pEmail')?.value.trim() || '',
    emer_name: $('#eName')?.value.trim() || '',
    emer_phone: $('#ePhone')?.value.trim() || '',
    emer_email: $('#eEmail')?.value.trim() || '',
    blood_type: $('#blood')?.value.trim() || '',

    // doctor
    doctor_name: $('#dName')?.value.trim() || '',
    doctor_address: $('#dAddr')?.value.trim() || '',
    doctor_phone: $('#dPhone')?.value.trim() || '',
    doctor_fax: $('#dFax')?.value.trim() || '',
    doctor_email: $('#dEmail')?.value.trim() || '',

    // pharmacy
    pharmacy_name: $('#phName')?.value.trim() || '',
    pharmacy_address: $('#phAddr')?.value.trim() || '',
    pharmacy_phone: $('#phPhone')?.value.trim() || '',
    pharmacy_fax: $('#phFax')?.value.trim() || '',

    // typed mini fields
    t_bp: $('#t_bp')?.value.trim() || '',
    t_meds: $('#t_meds')?.value.trim() || '',
    t_allergies: $('#t_allergies')?.value.trim() || '',
    t_weight: $('#t_weight')?.value.trim() || '',
    t_conditions: $('#t_conditions')?.value.trim() || '',
    t_general: $('#t_general')?.value.trim() || ''
  };
}

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
