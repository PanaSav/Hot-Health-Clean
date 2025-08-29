const $ = sel => document.querySelector(sel);

const btnRec = $('#btnRec');
const meta   = $('#recMeta');
const out    = $('#result');
const errBox = $('#error');

const openLink   = $('#openLink');
const copyLink   = $('#copyLink');
const gmailLink  = $('#gmailLink');
const outlookLink= $('#outlookLink');
const shareBar   = $('#shareBtns');

const dualSumm = $('#dualSumm');
const sumOrig  = $('#sumOrig');
const sumTrans = $('#sumTrans');
const sumLang  = $('#sumLang');

let mediaRecorder, chunks = [];
let autoStopTimer = null;

function setError(msg){ errBox.textContent = msg || ''; }
function setMeta(msg){ meta.textContent = msg || ''; }

function gatherForm() {
  return {
    name: $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    blood_type: $('#blood').value.trim(),

    emer_name:  $('#eName').value.trim(),
    emer_phone: $('#ePhone').value.trim(),
    emer_email: $('#eEmail').value.trim(),

    doctor_name:  $('#dName').value.trim(),
    doctor_phone: $('#dPhone').value.trim(),
    doctor_email: $('#dEmail').value.trim(),
    doctor_fax:   '',

    pharmacy_name:    $('#phName').value.trim(),
    pharmacy_phone:   $('#phPhone').value.trim(),
    pharmacy_fax:     $('#phFax').value.trim(),
    pharmacy_address: $('#phAddress').value.trim(),

    lang: $('#lang').value.trim()
  };
}

async function uploadBlob(blob) {
  const fd = new FormData();
  // One audio part for now; backend supports many
  fd.append('audio', blob, 'recording.webm');
  const f = gatherForm();
  for (const [k,v] of Object.entries(f)) fd.append(k, v);

  const r = await fetch('/upload', { method:'POST', body: fd });
  if (!r.ok) throw new Error(`Server error`);
  return r.json();
}

function startAutoStop(ms) {
  clearTimeout(autoStopTimer);
  autoStopTimer = setTimeout(() => { if (btnRec.textContent === 'Stop') stopRec(); }, ms);
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
      clearTimeout(autoStopTimer);
      const blob = new Blob(chunks, { type: 'audio/webm' });
      setMeta(`Recorded ${(blob.size/1024).toFixed(1)} KB`);
      const json = await uploadBlob(blob);
      if (!json.ok) throw new Error(json.error || 'Server error');

      // Result + QR
      out.innerHTML = `
        <div><b>Report:</b> <a href="${json.url}" target="_blank" rel="noopener">${json.url}</a></div>
        ${json.qr ? `<div style="margin-top:8px"><img src="${json.qr}" alt="QR" style="max-width:160px"/></div>` : ''}
      `;

      // Share buttons
      openLink.href = json.url;
      copyLink.onclick = () => navigator.clipboard.writeText(json.url);
      gmailLink.href   = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent('Hot Health Report')}&body=${encodeURIComponent(json.url)}`;
      outlookLink.href = `https://outlook.live.com/owa/?path=/mail/action/compose&subject=${encodeURIComponent('Hot Health Report')}&body=${encodeURIComponent(json.url)}`;
      shareBar.style.display = 'flex';

      // Dual summary (original + translated)
      if (json.summary_original || json.summary_translated) {
        sumOrig.textContent = json.summary_original || '(none)';
        sumTrans.textContent = json.summary_translated || '(no translation)';
        sumLang.textContent = json.target_lang_name || json.target_lang || 'Translated';
        dualSumm.style.display = 'grid';
      } else {
        dualSumm.style.display = 'none';
      }
    } catch (e) {
      setError(e.message || String(e));
    }
  };
  mediaRecorder.start();
  btnRec.textContent = 'Stop';
  setMeta('Recording… click Stop when done (auto-stops in 30s).');
  startAutoStop(30_000);
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
