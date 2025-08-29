const $ = s => document.querySelector(s);

const btnRec   = $('#btnRec');
const btnGen   = $('#btnGenerate');
const meta     = $('#recMeta');
const out      = $('#result');
const errBox   = $('#error');

let mediaRecorder, chunks = [], autoStopTimer = null;

// gather all fields
function gatherForm(){
  return {
    name: $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    blood_type: $('#blood').value.trim(),

    emer_name: $('#eName').value.trim(),
    emer_phone: $('#ePhone').value.trim(),
    emer_email: $('#eEmail').value.trim(),

    doctor_name: $('#dName').value.trim() || 'N/A',
    doctor_phone: $('#dPhone').value.trim() || 'N/A',
    doctor_fax: $('#dFax').value.trim() || 'N/A',
    doctor_email: $('#dEmail').value.trim() || 'N/A',

    pharmacy_name: $('#phName').value.trim() || 'N/A',
    pharmacy_phone: $('#phPhone').value.trim() || 'N/A',
    pharmacy_fax: $('#phFax').value.trim() || 'N/A',
    pharmacy_address: $('#phAddr').value.trim() || 'N/A',

    lang: $('#lang').value.trim()
  };
}

function setError(m){ errBox.textContent = m || ''; }
function setMeta(m){ meta.textContent = m || ''; }

async function uploadBlob(blob){
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');

  const f = gatherForm();
  for (const [k,v] of Object.entries(f)) fd.append(k,v);

  // you can also pass “parts” (extra typed/voice chunks) later if needed
  fd.append('parts','');

  const r = await fetch('/upload', { method:'POST', body: fd });
  if (!r.ok) {
    const txt = await r.text().catch(()=>r.statusText);
    throw new Error(`Upload failed (${r.status}): ${txt}`);
  }
  return r.json();
}

function toggleRecordingUI(active){
  btnRec.textContent = active ? 'Stop' : 'Record';
}

async function startRec(){
  try{
    setError(''); setMeta(''); chunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = () => {
      clearTimeout(autoStopTimer);
      try{
        const blob = new Blob(chunks, { type:'audio/webm' });
        setMeta(`Recorded ${(blob.size/1024).toFixed(1)} KB`);
        // don’t auto-upload; wait for Generate Report (so users can fill fields first)
        btnGen.disabled = false;
      }catch(e){ setError(e.message||String(e)); }
    };
    mediaRecorder.start();
    toggleRecordingUI(true);
    setMeta('Recording… auto-stops at 60 seconds.');
    btnGen.disabled = true;
    // Auto-stop at 60s if user doesn’t click stop
    autoStopTimer = setTimeout(()=>stopRec(), 60000);
  }catch(e){
    setError('Microphone blocked or unsupported. Use Chrome/Edge/Safari and allow permission.');
  }
}

function stopRec(){
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    toggleRecordingUI(false);
  }
}

btnRec.addEventListener('click', ()=>{
  if (btnRec.textContent === 'Record') startRec();
  else stopRec();
});

btnGen.addEventListener('click', async ()=>{
  try{
    setError('');
    if (!chunks.length) { setError('No recording found. Click Record first.'); return; }
    const blob = new Blob(chunks, { type:'audio/webm' });
    out.textContent = 'Uploading & generating…';
    const json = await uploadBlob(blob);
    if (!json.ok) throw new Error(json.error || 'Server error');
    out.innerHTML = `✅ Created. <a class="btn alt" href="${json.url}" target="_blank" rel="noopener">Open report</a>`;
  }catch(e){
    setError(e.message||String(e));
  }
});
