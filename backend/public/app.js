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

function gmailLink(url) {
  const u = encodeURIComponent(url);
  return `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent('Hot Health Report')}&body=${u}`;
}
function outlookLink(url) {
  const u = encodeURIComponent(url);
  return `https://outlook.office.com/mail/deeplink/compose?subject=${encodeURIComponent('Hot Health Report')}&body=${u}`;
}

async function uploadBlob(blob) {
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  const f = gatherForm();
  for (const [k,v] of Object.entries(f)) fd.append(k, v);

  const r = await fetch('/upload', { method:'POST', body: fd });
  const ct = r.headers.get('content-type') || '';

  if (!r.ok) {
    if (r.status === 401) { window.location.href = '/login'; return Promise.reject(new Error('AUTH')); }
    const text = ct.includes('application/json') ? JSON.stringify(await r.json()) : await r.text();
    throw new Error(`Upload failed (${r.status}): ${text.slice(0,200)}`);
  }
  if (!ct.includes('application/json')) {
    const text = await r.text();
    throw new Error(`Unexpected response (not JSON). First bytes: ${text.slice(0,120)}`);
  }
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

      const openLink = `<a class="btn" href="${json.url}" target="_blank" rel="noopener">Open report</a>`;
      const gmail = `<a class="btn" href="${gmailLink(json.url)}" target="_blank" rel="noopener">Gmail</a>`;
      const outlook = `<a class="btn" href="${outlookLink(json.url)}" target="_blank" rel="noopener">Outlook</a>`;
      const qr = json.qr ? `<div class="qr"><img src="${json.qr}" alt="QR" style="max-width:160px"/></div>` : '';

      // Optional summaries on the result card
      const sumOrig = json.summary_original ? `<div class="small"><b>Summary (orig):</b> ${json.summary_original}</div>` : '';
      const sumTran = json.summary_translated ? `<div class="small"><b>Summary (translated):</b> ${json.summary_translated}</div>` : '';

      out.innerHTML = `
        <div class="result-card">
          ${qr}
          <div class="btnbar">
            ${openLink} <a class="btn" onclick="window.print()" href="javascript:void(0)">🖨️ Print</a>
            ${gmail} ${outlook}
          </div>
          ${sumOrig}${sumTran}
        </div>
      `;
    } catch (e) {
      if (e.message !== 'AUTH') setError(e.message || String(e));
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
