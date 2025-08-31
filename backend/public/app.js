// Simple helpers
const $ = (s) => document.querySelector(s);

const btnRec = $('#btnRec');
const meta   = $('#recMeta');
const out    = $('#result');
const errBox = $('#error');
const detectedLangEl = $('#detectedLang');

let mediaRecorder, chunks = [];
let lastDetectedLang = ''; // filled after first successful upload

function setError(msg){ errBox.textContent = msg || ''; }
function setMeta(msg){  meta.textContent  = msg || ''; }
function showCheck(url, detected, target) {
  const targetLabel = target ? ` → ${target}` : '';
  out.innerHTML = `
    <div class="report-ok">
      <span class="check">✅</span>
      <div>
        <div class="title">Report generated</div>
        <div class="sub">Detected: <b>${detected || 'auto'}</b>${targetLabel}</div>
        <div class="actions">
          <a class="btn" href="${url}" target="_blank" rel="noopener">Open report</a>
          <a class="btn" href="${url}" target="_blank" rel="noopener">Copy link</a>
        </div>
      </div>
    </div>
  `;
}

// Speech recognition (browser)
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Email speech normalization
function normalizeEmailSpeech(text) {
  if (!text) return '';
  let t = ' ' + text.toLowerCase().trim() + ' ';
  // canonical replacements
  t = t
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\s+underscore\s+/g, '_')
    .replace(/\s+dash\s+/g, '-')
    .replace(/\s+hyphen\s+/g, '-')
    .replace(/\s+plus\s+/g, '+')
    .replace(/\s+space\s+/g, '')
    .replace(/\s+/g, '');
  // compact periods like "gmail . com"
  t = t.replace(/\.{2,}/g, '.'); // collapse multiple dots
  // remove stray trailing periods/spaces
  t = t.replace(/^\.+|\.+$/g, '');
  return t;
}

function attachMicButtons() {
  document.querySelectorAll('.mic-btn').forEach(btn => {
    if (!SR) {
      btn.disabled = true; btn.title = 'Speech recognition not supported';
      return;
    }
    const targetId = btn.getAttribute('data-target');
    const emailMode = btn.classList.contains('mic-email');
    btn.addEventListener('click', () => {
      const el = document.getElementById(targetId);
      if (!el) return;
      const rec = new SR();
      rec.lang = (detectedLangEl.value || navigator.language || 'en-US');
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.classList.add('rec-on');
      const originalBg = el.style.backgroundColor;
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e) => {
        let text = e.results[0]?.[0]?.transcript || '';
        if (emailMode) text = normalizeEmailSpeech(text);
        el.value = text;
      };
      rec.onend = () => {
        btn.classList.remove('rec-on');
        el.style.backgroundColor = originalBg;
      };
      rec.onerror = () => {
        btn.classList.remove('rec-on');
        el.style.backgroundColor = originalBg;
      };
      try { rec.start(); } catch { btn.classList.remove('rec-on'); el.style.backgroundColor = originalBg; }
    });
  });
}

function gatherForm() {
  return {
    name: $('#pName')?.value.trim() || '',
    email: ($('#pEmail')?.value || '').trim().toLowerCase(),
    emer_name: $('#eName')?.value.trim() || '',
    emer_phone: $('#ePhone')?.value.trim() || '',
    emer_email: ($('#eEmail')?.value || '').trim().toLowerCase(),
    blood_type: $('#blood')?.value.trim() || '',
    lang: $('#lang')?.value.trim() || ''
  };
}

async function uploadBlob(blob) {
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  const f = gatherForm();
  for (const [k,v] of Object.entries(f)) fd.append(k, v);

  const r = await fetch('/upload', { method:'POST', body: fd });
  if (!r.ok) {
    let msg = `Server error (${r.status})`;
    try { const t = await r.text(); if (t && t.startsWith('{')) msg = JSON.parse(t).error || msg; } catch {}
    throw new Error(msg);
  }
  return r.json();
}

async function startRec() {
  setError('');
  setMeta('');
  chunks = [];
  const hint = $('#recHint');
  if (hint) hint.textContent = 'Recording… click Stop when done.';
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

      // Fill detected language if backend provided it (your backend typically does)
      if (json.detected_lang && !lastDetectedLang) {
        lastDetectedLang = json.detected_lang;
        detectedLangEl.value = lastDetectedLang;
      }
      showCheck(json.url, json.detected_lang || lastDetectedLang || 'auto', gatherForm().lang);
    } catch (e) {
      setError(e.message || String(e));
    }
  };
  mediaRecorder.start();
  btnRec.textContent = 'Stop';
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

attachMicButtons();
