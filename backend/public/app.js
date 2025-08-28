/* backend/public/app.js
   Six mini recorders + Generate Report
   - Auto-stop timers per category
   - Tries to upload combined WebM; if 400/format error, falls back to largest part
*/

// ---- Small helpers ----
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const errBox = $('#error');
const okBox  = $('#result');

function setErr(msg) { errBox.textContent = msg || ''; }
function setOK(msg)  { okBox.innerHTML = msg || ''; }

function gatherForm() {
  return {
    name:       $('#pName')?.value.trim()  || '',
    email:      $('#pEmail')?.value.trim() || '',
    blood_type: $('#blood')?.value.trim()  || '',
    emer_name:  $('#eName')?.value.trim()  || '',
    emer_phone: $('#ePhone')?.value.trim() || '',
    emer_email: $('#eEmail')?.value.trim() || '',
    // optional target language select (add one if you want on the page)
    lang:       $('#lang')?.value.trim()   || ''
  };
}

// ---- Categories & limits (ms) ----
const CATS = [
  { key:'bp',         label:'Blood Pressure',       limitMs: 20_000 },
  { key:'meds',       label:'Medications & Dose',   limitMs:180_000 },
  { key:'allergies',  label:'Allergies',            limitMs: 60_000 },
  { key:'weight',     label:'Weight',               limitMs: 60_000 },
  { key:'conditions', label:'Conditions',           limitMs:180_000 },
  { key:'general',    label:'General Health Note',  limitMs:180_000 },
];

// Track state per category
const recorders = new Map(); // key -> { stream, mr, chunks[], timerId, btn }
const blobs     = new Map(); // key -> Blob

// Wire up the six recorder buttons that exist in index.html (.rec-btn with data-cat)
function initRecorders() {
  $$('.rec-btn').forEach((btn) => {
    const key = btn.getAttribute('data-cat');
    const spec = CATS.find(c => c.key === key);
    if (!spec) return;

    btn.addEventListener('click', async () => {
      const state = recorders.get(key);
      // If already recording, stop it
      if (state && state.mr && state.mr.state !== 'inactive') {
        stopOne(key, 'Stopped.');
        return;
      }
      // Otherwise, start a new recording
      await startOne(key, spec.limitMs, btn);
    });
  });
}

// Start a recorder for one category
async function startOne(key, limitMs, btn) {
  setErr('');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    const mr = new MediaRecorder(stream, { mimeType:'audio/webm' });
    const chunks = [];

    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      try {
        const blob = new Blob(chunks, { type:'audio/webm' });
        blobs.set(key, blob);
        btn.textContent = `🎤 ${labelFor(key)} (recorded ${(blob.size/1024).toFixed(1)} KB) — tap to re-record`;
      } catch (e) {
        setErr('Failed to finalize recording for ' + labelFor(key));
      } finally {
        // cleanup stream tracks
        stream.getTracks().forEach(t => t.stop());
      }
    };

    mr.start();
    btn.textContent = `⏺️ Stop ${labelFor(key)} (auto-stops in ${(limitMs/1000)|0}s)`;

    const timerId = setTimeout(() => {
      if (mr.state !== 'inactive') mr.stop();
    }, limitMs);

    recorders.set(key, { stream, mr, chunks, timerId, btn });
  } catch (e) {
    setErr('Mic permission denied or not available for ' + labelFor(key));
  }
}

// Stop a specific recorder
function stopOne(key, note='') {
  const rec = recorders.get(key);
  if (!rec) return;
  if (rec.timerId) clearTimeout(rec.timerId);
  if (rec.mr && rec.mr.state !== 'inactive') {
    rec.mr.stop();
  }
  rec.btn.textContent = `🎤 ${labelFor(key)} ${note ? '('+note+')' : ''}`;
}

// Utility: get category label
function labelFor(key) {
  const c = CATS.find(x => x.key === key);
  return c ? c.label : key;
}

// Try to create a single combined WebM (simple concatenation of blobs).
// NOTE: This works in many browsers when all parts share the same codec.
// If the API rejects it, we will fall back to the largest single part.
function makeCombinedBlob(parts) {
  if (!parts.length) return null;
  return new Blob(parts, { type:'audio/webm' });
}

// Upload FormData -> /upload
async function uploadBlob(blob) {
  const fd = new FormData();
  fd.append('audio', blob, 'recording.webm');
  const form = gatherForm();
  Object.entries(form).forEach(([k,v]) => fd.append(k, v));

  const r = await fetch('/upload', { method:'POST', body: fd });
  // If server returns HTML error page, throw a cleaner message
  const ct = r.headers.get('content-type') || '';
  if (!r.ok) {
    let text = await r.text();
    if (ct.includes('text/html')) text = 'Server error';
    throw new Error(`Upload failed (${r.status}): ${text}`);
  }
  return r.json();
}

// Generate report: bundle parts -> upload
async function onGenerate() {
  setErr('');
  setOK('');

  // Gather available blobs in UI order
  const available = CATS
    .map(c => ({ key:c.key, blob: blobs.get(c.key) }))
    .filter(x => x.blob && x.blob.size > 0);

  if (!available.length) {
    setErr('No audio recorded. Please record at least one section.');
    return;
  }

  // 1) Try combined
  try {
    const combined = makeCombinedBlob(available.map(x => x.blob));
    if (!combined || combined.size === 0) throw new Error('empty');
    const res = await uploadBlob(combined);
    if (!res.ok) throw new Error(res.error || 'Server error');
    setOK(`✅ Report created. <a href="${res.url}" target="_blank" rel="noopener">Open report</a>`);
    return;
  } catch (e) {
    // fall through to largest single-part upload
  }

  // 2) Fallback: pick the largest single part
  try {
    const largest = available.reduce((a,b)=> (a.blob.size > b.blob.size ? a : b));
    const res = await uploadBlob(largest.blob);
    if (!res.ok) throw new Error(res.error || 'Server error');
    setOK(`✅ Report created (fallback from one section: ${labelFor(largest.key)}). <a href="${res.url}" target="_blank" rel="noopener">Open report</a>`);
  } catch (e2) {
    setErr(e2.message || String(e2));
  }
}

// Hook up Generate Report
function initGenerate() {
  const genBtn = $('#genBtn');
  if (!genBtn) return;
  genBtn.addEventListener('click', onGenerate);
}

// Initialize on load
window.addEventListener('DOMContentLoaded', () => {
  initRecorders();
  initGenerate();
});
