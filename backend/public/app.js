// Six mini recorders, auto-stop, merge blobs, plus typed sections -> POST /upload
const $ = s=>document.querySelector(s);
const $$ = s=>document.querySelectorAll(s);

const btnGenerate = $('#btnGenerate');
const statusBox = $('#status');
const errorBox = $('#error');
const resultBox = $('#result');

function setStatus(m){ statusBox.textContent = m || ''; }
function setError(m){ errorBox.textContent = m || ''; }

const media = {
  // each key -> { recorder, chunks:[], timerId, maxSec, metaEl }
};
let stream;

// init mini recorders
$$('.rec-card').forEach(card=>{
  const key = card.dataset.key;
  const max = Number(card.dataset.max || 60);
  const btn = card.querySelector('.rec-btn');
  const meta= card.querySelector('.rec-meta');

  media[key] = { recorder:null, chunks:[], timerId:null, maxSec:max, metaEl:meta, btnEl:btn, sizeKB:0 };

  btn.addEventListener('click', async ()=>{
    const entry = media[key];
    if (!entry.recorder || entry.recorder.state==='inactive') {
      // start
      setError('');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      } catch {
        setError('Microphone blocked. Allow mic and try again.');
        return;
      }
      entry.chunks = [];
      entry.sizeKB = 0;
      const rec = new MediaRecorder(stream, { mimeType:'audio/webm' });
      rec.ondataavailable = e=>{ if (e.data && e.data.size) { entry.chunks.push(e.data); entry.sizeKB += e.data.size/1024; } };
      rec.onstop = ()=>{
        stream.getTracks().forEach(t=>t.stop());
        btn.textContent = `Record (${max>=120?`${Math.round(max/60)}m`:max+'s'})`;
        entry.metaEl.textContent = entry.chunks.length ? `Recorded ~${entry.sizeKB.toFixed(1)} KB` : 'No audio';
        if (entry.timerId) { clearTimeout(entry.timerId); entry.timerId=null; }
      };
      entry.recorder = rec;
      rec.start();
      btn.textContent = '■ Stop';
      entry.metaEl.textContent = `Recording… auto-stops at ${max}s`;
      entry.timerId = setTimeout(()=>{ if(rec.state!=='inactive') rec.stop(); }, max*1000);
    } else {
      // stop
      entry.recorder.stop();
    }
  });
});

function gatherPatient() {
  return {
    name: $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    emer_name: $('#eName').value.trim(),
    emer_phone: $('#ePhone').value.trim(),
    emer_email: $('#eEmail').value.trim(),
    blood_type: $('#blood').value.trim(),
    target_lang: $('#lang').value.trim(),
    doctor_name: $('#dName').value.trim(),
    doctor_phone: $('#dPhone').value.trim(),
    doctor_fax: $('#dFax').value.trim(),
    doctor_email: $('#dEmail').value.trim(),
    pharmacy_name: $('#phName').value.trim(),
    pharmacy_address: $('#phAddr').value.trim(),
    pharmacy_phone: $('#phPhone').value.trim(),
    pharmacy_fax: $('#phFax').value.trim()
  };
}

function gatherSections() {
  return {
    bp:         $('#txt-bp').value.trim(),
    meds:       $('#txt-meds').value.trim(),
    allergies:  $('#txt-allergies').value.trim(),
    weight:     $('#txt-weight').value.trim(),
    conditions: $('#txt-conditions').value.trim(),
    general:    $('#txt-general').value.trim()
  };
}

async function generateReport() {
  try{
    setError('');
    setStatus('Preparing…');

    // merge all audio chunks into one Blob (same MIME)
    const blobs = [];
    for (const k of Object.keys(media)) {
      const entry = media[k];
      if (entry.recorder && entry.recorder.state!=='inactive') {
        // ensure stopped
        entry.recorder.stop();
      }
      if (entry.chunks && entry.chunks.length) {
        blobs.push(...entry.chunks);
      }
    }
    const audioBlob = blobs.length ? new Blob(blobs, { type:'audio/webm' }) : null;

    const fd = new FormData();
    const patient = gatherPatient();
    const sections = gatherSections();
    for (const [k,v] of Object.entries(patient)) fd.append(k, v);
    fd.append('sections', JSON.stringify(sections));
    if (audioBlob) fd.append('audio', audioBlob, 'note.webm');

    setStatus('Uploading…');
    const r = await fetch('/upload', { method:'POST', body:fd });
    const isJson = (r.headers.get('content-type')||'').includes('application/json');
    if (!r.ok) {
      const txt = isJson ? (await r.json()).error : await r.text();
      throw new Error(txt || `Server error (${r.status})`);
    }
    const json = isJson ? await r.json() : null;
    if (!json?.ok) throw new Error(json?.error || 'Unknown server error');

    const url = json.url;
    resultBox.innerHTML = `
      ✅ Created! 
      <a class="btn" href="${url}" target="_blank" rel="noopener">Open Report</a>
      <a class="btn" href="mailto:?subject=${encodeURIComponent('Hot Health Report')}&body=${encodeURIComponent(url)}">✉️ Email</a>
      <button class="btn" onclick="navigator.clipboard.writeText('${url}').then(()=>alert('Link copied!'))">🔗 Copy Link</button>
      <button class="btn" onclick="window.open('${url}','_blank')">🖨️ Print</button>
    `;
    setStatus('');
  }catch(e){
    setStatus('');
    setError(e.message || String(e));
  }
}

btnGenerate.addEventListener('click', generateReport);
