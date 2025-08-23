// app.js (ESM)
const $ = (s) => document.querySelector(s);
const btn   = $('#btnRec');
const hint  = $('#recHint');
const meta  = $('#recMeta');
const errorBox = $('#error');
const result = $('#result');

const pName  = $('#pName');
const pEmail = $('#pEmail');
const eName  = $('#eName');
const ePhone = $('#ePhone');
const eEmail = $('#eEmail');
const blood  = $('#blood');
const lang   = $('#lang');

let mediaRecorder, chunks = [], isRecording = false;

function setError(msg) {
  console.error(msg);
  errorBox.textContent = msg || '';
}
function setResult(html) {
  result.innerHTML = html;
}

async function startRecording() {
  setError('');
  // Mic requires HTTPS or localhost
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isSecure = location.protocol === 'https:';
  if (!isLocalhost && !isSecure) {
    setError('Microphone requires HTTPS or localhost. Open this page via your ngrok HTTPS URL, or http://localhost.');
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setError('This browser does not support audio recording. Try Chrome/Edge or iOS Safari 14+.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mediaRecorder.onstop = onStop;
    mediaRecorder.start();
    isRecording = true;
    btn.textContent = 'Stop';
    hint.textContent = 'Recording… click Stop when done.';
    meta.textContent = new Date().toLocaleTimeString();
  } catch (e) {
    setError('Failed to access microphone: ' + (e.message || e));
  }
}

async function onStop() {
  try {
    const blob = new Blob(chunks, { type: 'audio/webm' });
    if (!blob.size) {
      setError('No audio captured. Try again.');
      resetUI();
      return;
    }
    meta.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`;

    const fd = new FormData();
    fd.append('audio', blob, 'recording.webm');
    fd.append('name',  pName.value || '');
    fd.append('email', pEmail.value || '');
    fd.append('emer_name',  eName.value || '');
    fd.append('emer_phone', ePhone.value || '');
    fd.append('emer_email', eEmail.value || '');
    fd.append('blood_type', blood.value || '');
    fd.append('lang', (lang.value || '')); // optional target

    // same-origin: backend serves this page, so POST to /upload
    const controller = new AbortController();
    const id = setTimeout(()=>controller.abort(), 30000); // 30s
    const res = await fetch('/upload', { method: 'POST', body: fd, signal: controller.signal });
    clearTimeout(id);

    if (!res.ok) {
      const txt = await res.text().catch(()=>res.statusText);
      throw new Error(`Upload failed (${res.status}): ${txt}`);
    }

    const data = await res.json();
    // Expect { ok:true, id, link, qrDataUrl? }
    const qr = data.qrDataUrl ? `<img src="${data.qrDataUrl}" alt="QR" width="160" height="160" />` : '';
    setResult(`
      <div><b>Report Link:</b> <a href="${data.link}" target="_blank" rel="noopener">${data.link}</a></div>
      <div style="margin-top:8px">${qr}</div>
    `);
    hint.textContent = 'Uploaded. Open the report link above.';
  } catch (e) {
    setError(e.message || e);
  } finally {
    resetUI();
  }
}

function stopRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
  }
}

function resetUI() {
  isRecording = false;
  btn.textContent = 'Record';
}

btn.addEventListener('click', () => {
  if (!isRecording) startRecording();
  else stopRecording();
});
