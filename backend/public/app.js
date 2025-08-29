// frontend app logic: six mini recorders + inputs, upload as audios[] + typed_notes

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const errBox = $('#error');
const outBox = $('#result');

// state for recorders
const state = {
  recs: {},   // key -> { mediaRecorder, chunks, timer, running }
  blobs: {}   // key -> Blob
};

function setError(msg){ errBox.textContent = msg || ''; }
function setResult(html){ outBox.innerHTML = html || ''; }

function gatherPatient() {
  return {
    name: $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    emer_name: $('#eName').value.trim(),
    emer_phone: $('#ePhone').value.trim(),
    emer_email: $('#eEmail').value.trim(),
    blood_type: $('#blood').value.trim(),
    lang: $('#lang').value.trim(),
    doctor_name: $('#dName').value.trim(),
    doctor_phone: $('#dPhone').value.trim(),
    doctor_email: $('#dEmail').value.trim(),
    doctor_fax: $('#dFax').value.trim(),
    pharmacy_name: $('#phName').value.trim(),
    pharmacy_phone: $('#phPhone').value.trim(),
    pharmacy_fax: $('#phFax').value.trim(),
    pharmacy_address: $('#phAddr').value.trim()
  };
}

function typedNotesBundle() {
  const bp = $('#bpText').value.trim();
  const meds = $('#medsText').value.trim();
  const allergies = $('#allergiesText').value.trim();
  const weight = $('#weightText').value.trim();
  const cond = $('#conditionsText').value.trim();
  const general = $('#generalText').value.trim();

  const pieces = [];
  if (bp) pieces.push(`Blood pressure: ${bp}`);
  if (meds) pieces.push(`Medications: ${meds}`);
  if (allergies) pieces.push(`Allergies: ${allergies}`);
  if (weight) pieces.push(`Weight: ${weight}`);
  if (cond) pieces.push(`Conditions: ${cond}`);
  if (general) pieces.push(`General: ${general}`);

  return pieces.join('\n');
}

async function startMic(btn, key, limitSec) {
  setError('');
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    setError('This browser does not support audio recording.');
    return;
  }
  if (state.recs[key]?.running) return; // already running

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setError('Microphone blocked. Allow mic permission and try again.');
    return;
  }

  const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
  state.recs[key] = { mediaRecorder: rec, chunks: [], timer: null, running: true };
  btn.textContent = '⏹️';
  btn.classList.add('recording');

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size) state.recs[key].chunks.push(e.data);
  };

  rec.onstop = () => {
    // build blob
    try {
      const blob = new Blob(state.recs[key].chunks, { type: 'audio/webm' });
      state.blobs[key] = blob;
    } catch {}
    // cleanup
    stream.getTracks().forEach(t => t.stop());
    clearTimeout(state.recs[key].timer);
    state.recs[key].running = false;
    btn.textContent = '🎙️';
    btn.classList.remove('recording');
  };

  // auto-stop timer
  state.recs[key].timer = setTimeout(() => {
    if (rec.state !== 'inactive') rec.stop();
  }, limitSec * 1000);

  rec.start();
}

function stopMic(key) {
  const r = state.recs[key];
  if (r && r.mediaRecorder && r.mediaRecorder.state !== 'inactive') {
    r.mediaRecorder.stop();
  }
}

$$('.mic').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.getAttribute('data-key');
    const limit = Number(btn.getAttribute('data-limit') || '30');
    const r = state.recs[key];
    if (!r || !r.running) startMic(btn, key, limit);
    else stopMic(key);
  });
});

$('#btnGenerate').addEventListener('click', async () => {
  try {
    setError('');
    setResult('Uploading…');

    const fd = new FormData();
    // append blobs
    for (const [key, blob] of Object.entries(state.blobs)) {
      if (blob && blob.size) {
        fd.append('audios[]', blob, `${key}.webm`);
      }
    }

    // append typed notes (merged server-side)
    const typed = typedNotesBundle();
    if (typed) fd.append('typed_notes', typed);

    // patient fields
    const p = gatherPatient();
    for (const [k,v] of Object.entries(p)) fd.append(k, v);

    const r = await fetch('/upload', { method: 'POST', body: fd });
    if (!r.ok) {
      // Try to read JSON; if HTML error, throw text
      const text = await r.text();
      try {
        const j = JSON.parse(text);
        throw new Error(j.error || ('Upload failed: ' + r.status));
      } catch {
        throw new Error(text);
      }
    }
    const json = await r.json();
    if (!json.ok) throw new Error(json.error || 'Server error');

    setResult(`✅ Created. <a href="${json.url}" target="_blank" rel="noopener">Open report</a>`);

  } catch (e) {
    setError(e.message || String(e));
    setResult('');
  }
});
