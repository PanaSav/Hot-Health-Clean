// public/app.js
// Six mini recorders + typed inputs. Auto-stop timers. Uploads all blobs + fields to /upload.

const $  = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const errBox = $('#error');
const out    = $('#result');
const genBtn = $('#btnGen');

function setError(msg=''){ errBox.textContent = msg; }
function setResult(html=''){ out.innerHTML = html; }

function gatherProfile() {
  return {
    name: $('#pName')?.value?.trim() || '',
    email: $('#pEmail')?.value?.trim() || '',
    phone: $('#pPhone')?.value?.trim() || '',
    blood_type: $('#blood')?.value?.trim() || '',
    emer_name: $('#eName')?.value?.trim() || '',
    emer_phone: $('#ePhone')?.value?.trim() || '',
    emer_email: $('#eEmail')?.value?.trim() || '',
    doctor_name: $('#dName')?.value?.trim() || 'N/A',
    doctor_phone: $('#dPhone')?.value?.trim() || '',
    doctor_email: $('#dEmail')?.value?.trim() || '',
    doctor_fax: $('#dFax')?.value?.trim() || '',
    pharmacy_name: $('#phName')?.value?.trim() || '',
    pharmacy_phone: $('#phPhone')?.value?.trim() || '',
    pharmacy_fax: $('#phFax')?.value?.trim() || '',
    pharmacy_address: $('#phAddr')?.value?.trim() || '',
    lang: $('#lang')?.value?.trim() || ''
  };
}

function gatherTypedNotes() {
  return {
    bp_note: $('#txt-bp')?.value?.trim() || '',
    meds_note: $('#txt-meds')?.value?.trim() || '',
    allergies_note: $('#txt-allergies')?.value?.trim() || '',
    weight_note: $('#txt-weight')?.value?.trim() || '',
    conditions_note: $('#txt-conditions')?.value?.trim() || '',
    general_note: $('#txt-general')?.value?.trim() || ''
  };
}

// Recorder controller for each mini block
class MiniRecorder {
  constructor(key, maxSeconds = 30) {
    this.key = key;
    this.max = maxSeconds;
    this.btn = document.querySelector(`.rec[data-key="${key}"]`);
    this.timerEl = document.querySelector(`#tm-${key}`);
    this.mediaRecorder = null;
    this.chunks = [];
    this.elapsed = 0;
    this.tid = null;
    if (this.btn) this.btn.addEventListener('click', () => this.toggle());
  }

  async start() {
    setError('');
    this.chunks = [];
    this.elapsed = 0;
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record audio. Use Chrome/Edge or iOS Safari 14+.');
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Microphone blocked. Allow mic permission and try again.');
      return;
    }
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    this.mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.mediaRecorder.onstop = () => { stream.getTracks().forEach(t => t.stop()); };
    this.mediaRecorder.start();
    this.btn.textContent = '⏹️';
    this.tick();
  }

  stop() {
    if (!this.mediaRecorder) return;
    if (this.tid) { clearInterval(this.tid); this.tid = null; }
    this.mediaRecorder.stop();
    this.btn.textContent = '🎙️';
  }

  toggle() {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') this.start();
    else this.stop();
  }

  tick() {
    this.tid = setInterval(() => {
      this.elapsed++;
      const mm = String(Math.floor(this.elapsed / 60)).padStart(2,'0');
      const ss = String(this.elapsed % 60).padStart(2,'0');
      if (this.timerEl) this.timerEl.textContent = `${mm}:${ss}`;
      if (this.elapsed >= this.max) this.stop();
    }, 1000);
  }

  blob() {
    if (!this.chunks.length) return null;
    return new Blob(this.chunks, { type: 'audio/webm' });
  }
}

// Init recorders
const recs = {
  bp:         new MiniRecorder('bp', 30),
  meds:       new MiniRecorder('meds', 180),
  allergies:  new MiniRecorder('allergies', 60),
  weight:     new MiniRecorder('weight', 60),
  conditions: new MiniRecorder('conditions', 180),
  general:    new MiniRecorder('general', 180)
};

async function uploadAll() {
  const fd = new FormData();

  // Profile fields
  const prof = gatherProfile();
  Object.entries(prof).forEach(([k,v]) => fd.append(k, v));

  // Typed notes
  const notes = gatherTypedNotes();
  Object.entries(notes).forEach(([k,v]) => fd.append(k, v));

  // Audio blobs (append multiple fields all as 'audio')
  let count = 0;
  for (const key of Object.keys(recs)) {
    const b = recs[key].blob();
    if (b) { fd.append('audio', b, `${key}.webm`); count++; }
  }

  if (!count) {
    setError('Please record at least one section (or type notes).');
  }

  const r = await fetch('/upload', { method: 'POST', body: fd });
  if (!r.ok) {
    // May return HTML error page; avoid JSON.parse crash
    const text = await r.text().catch(()=> '');
    throw new Error(text || `Upload failed (${r.status})`);
  }
  return r.json();
}

genBtn?.addEventListener('click', async () => {
  try {
    setError('');
    setResult('Uploading & generating…');
    const json = await uploadAll();
    if (!json.ok) throw new Error(json.error || 'Server error');
    setResult(`✅ Created. <a href="${json.url}" target="_blank" rel="noopener">Open report</a>`);
  } catch (e) {
    setError(e.message || String(e));
    setResult('');
  }
});
