const $ = sel => document.querySelector(sel);
const btnRec = $('#btnRec');
const meta = $('#recMeta');
const out = $('#result');
const errBox = $('#error');

let mediaRecorder, chunks = [];

function setError(msg){ errBox.textContent = msg || ''; }
function setMeta(msg){ meta.textContent = msg || ''; }

function gatherForm() {
  return {
    name: $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    emer_name: $('#eName').value.trim(),
    emer_phone: $('#ePhone').value.trim(),
    emer_email: $('#eEmail').value.trim(),
    blood_type: $('#blood').value.trim(),
    lang: $('#lang').value.trim()
  };
}

async function uploadBlob(blob) {
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  const f = gatherForm();
  for (const [k,v] of Object.entries(f)) fd.append(k, v);

  const r = await fetch('/upload', { method:'POST', body: fd });
  if (!r.ok) throw new Error(`Upload failed (${r.status})`);
  return r.json();
}

async function startRec() {
  setError('');
  setMeta('');
  chunks = [];
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setError('Microphone blocked. Allow mic permission and try again.');
    return;
  }
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    try {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      setMeta(`Recorded ${(blob.size/1024).toFixed(1)} KB`);
      const json = await uploadBlob(blob);
      if (!json.ok) throw new Error(json.error || 'Server error');
      out.innerHTML = `✅ Created. <a href="${json.url}" target="_blank" rel="noopener">Open report</a>`;
    } catch (e) {
      setError(e.message || String(e));
    }
  };
  mediaRecorder.start();
  btnRec.textContent = 'Stop';
  setMeta('Recording… click Stop when done.');
}

function stopRec() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop());
    btnRec.textContent = 'Record';
  }
}

btnRec.addEventListener('click', () => {
  if (btnRec.textContent === 'Record') startRec();
  else stopRec();
});
