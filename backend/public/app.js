const $ = sel => document.querySelector(sel);
const btnRec = $('#btnRec');
const meta = $('#recMeta');
const out = $('#result');
const errBox = $('#error');

let mediaRecorder, chunks = [];
let autoStopTimer = null;

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
  if (!r.ok) {
    const t = await r.text().catch(()=> '');
    throw new Error(`Upload failed (${r.status}): ${t || 'Server error'}`);
  }
  return r.json();
}

function renderList(items) {
  if (!items || !items.length) return 'None';
  return `<ul class="list">${items.map(x=>`<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
}
function escapeHtml(s=''){ return String(s).replace(/[&<>"]/g,c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function renderResult(payload){
  const {
    url, qr, detectedLang, targetLangName,
    transcript, translatedTranscript,
    summary
  } = payload;

  const dual = `
    <div class="section">
      <h2>Transcript</h2>
      <div class="dual">
        <div class="block">
          <h3>Original${detectedLang ? ` (${escapeHtml(detectedLang)})` : ''}</h3>
          <p>${escapeHtml(transcript||'')}</p>
        </div>
        <div class="block">
          <h3>${targetLangName ? escapeHtml(targetLangName) : 'Translated'}</h3>
          <p>${escapeHtml(translatedTranscript || '(no translation)')}</p>
        </div>
      </div>
    </div>`;

  const summaryHtml = `
    <div class="section">
      <h2>Summary</h2>
      <div><b>Medications:</b> ${renderList(summary?.medications)}</div>
      <div><b>Allergies:</b> ${renderList(summary?.allergies)}</div>
      <div><b>Conditions:</b> ${renderList(summary?.conditions)}</div>
      <div><b>Blood Pressure:</b> ${escapeHtml(summary?.bp || '—')}</div>
      <div><b>Weight:</b> ${escapeHtml(summary?.weight || '—')}</div>
    </div>`;

  const actions = `
    <div class="section">
      <h2>Share & QR</h2>
      <div class="qr" style="margin-bottom:10px">
        ${qr ? `<img src="${qr}" alt="QR" style="max-width:180px"/>` : ''}
        <div style="font-size:13px;color:#555;margin-top:6px">Scan on a phone or use the buttons.</div>
      </div>
      <div class="btnbar">
        <a class="btn" href="${url}" target="_blank" rel="noopener">🔗 Open report</a>
        <a class="btn" href="mailto:?subject=Hot%20Health%20Report&body=${encodeURIComponent(url)}">✉️ Email</a>
        <button class="btn" id="btnCopy">🔗 Get link</button>
      </div>
    </div>`;

  out.innerHTML = `<div class="result-grid">${summaryHtml}${dual}${actions}</div>`;
  const btnCopy = document.getElementById('btnCopy');
  if (btnCopy) btnCopy.onclick = () => navigator.clipboard.writeText(url);
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
    clearTimeout(autoStopTimer);
    try {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      setMeta(`Recorded ${(blob.size/1024).toFixed(1)} KB`);
      const json = await uploadBlob(blob);
      if (!json.ok) throw new Error(json.error || 'Server error');
      renderResult(json);
    } catch (e) {
      setError(e.message || String(e));
    }
  };
  mediaRecorder.start();
  btnRec.textContent = 'Stop';
  setMeta('Recording… click Stop when done.');
  // Auto-stop after 30s if user forgets
  autoStopTimer = setTimeout(() => { if (mediaRecorder?.state === 'recording') stopRec(); }, 30000);
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
