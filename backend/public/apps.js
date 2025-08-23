const btn  = document.getElementById('btnRec');
const hint = document.getElementById('recHint');
const meta = document.getElementById('recMeta');
const out  = document.getElementById('result');
const err  = document.getElementById('error');

const pName  = document.getElementById('pName');
const pEmail = document.getElementById('pEmail');
const eName  = document.getElementById('eName');
const ePhone = document.getElementById('ePhone');
const eEmail = document.getElementById('eEmail');
const blood  = document.getElementById('blood');
const lang   = document.getElementById('lang');

let rec = null, chunks = [], startTs = 0, chosenMime = '', chosenExt = 'webm';

function isLocalhost(){ return location.hostname === 'localhost' || location.hostname === '127.0.0.1'; }
function isSecure(){ return location.protocol === 'https:'; }

(function warnInsecure(){
  if (!isSecure() && !isLocalhost()) {
    const w = document.createElement('div');
    w.className = 'warning';
    w.innerHTML = 'Microphone requires HTTPS or localhost. Open <b>https://&lt;your-ip&gt;:4000</b>, or use <b>http://localhost:4000</b> on this PC.';
    document.querySelector('main').prepend(w);
  }
})();

btn.addEventListener('click', async () => {
  err.textContent = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = 'This browser does not support audio recording. Try Chrome/Edge or iOS Safari 14+.';
    return;
  }
  if (!rec || rec.state === 'inactive') start(); else stop();
});

function chooseMime(){
  if (window.MediaRecorder?.isTypeSupported?.('audio/webm;codecs=opus')) { chosenMime='audio/webm;codecs=opus'; chosenExt='webm'; return; }
  if (window.MediaRecorder?.isTypeSupported?.('audio/webm'))           { chosenMime='audio/webm';             chosenExt='webm'; return; }
  if (window.MediaRecorder?.isTypeSupported?.('audio/mp4'))            { chosenMime='audio/mp4';              chosenExt='m4a'; return; }
  chosenMime=''; chosenExt='webm';
}

async function start(){
  try{
    if (!isSecure() && !isLocalhost()) throw new Error('SECURE_ORIGIN_REQUIRED');
    chooseMime();

    const stream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, channelCount:1 }});
    chunks = [];
    rec = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = e => { err.textContent = 'Recorder error: ' + (e.error?.message || e.message || e.name || 'unknown'); };
    rec.onstop = onStop;

    startTs = Date.now();
    rec.start(250);

    btn.textContent = 'Stop';
    hint.textContent = `Recording… (${chosenMime || 'default codec'})`;
    meta.textContent = '';
    out.textContent = 'Recording…';
  }catch(e){
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      err.textContent = 'Microphone blocked. Click the mic icon in the address bar and allow access.';
    } else if (e && e.message === 'SECURE_ORIGIN_REQUIRED') {
      err.textContent = 'Mic requires HTTPS or localhost. Open https://<your-ip>:4000 or http://localhost:4000.';
    } else {
      err.textContent = 'Microphone access failed: ' + (e.message || e.name || 'unknown error');
    }
  }
}

function stop(){
  try { rec?.stop(); rec?.stream?.getTracks()?.forEach(t=>t.stop()); } catch {}
  btn.textContent = 'Record';
  hint.textContent = 'Processing…';
}

async function onStop(){
  const ms = Date.now() - startTs;
  const mimeType = rec?.mimeType || chosenMime || 'audio/webm';
  const blob = new Blob(chunks, { type: mimeType });

  meta.textContent = `Length ~${Math.round(ms/1000)}s · Size ${Math.round(blob.size/1024)} KB · ${mimeType || 'default'}`;
  if (blob.size < 6000) {
    err.textContent = 'Recording too short — try 3–10 seconds.';
    out.textContent = '';
    return;
  }

  const fd = new FormData();
  const filename = chosenExt === 'm4a' ? 'rec.m4a' : 'rec.webm';
  fd.append('audio', blob, filename);
  fd.append('patientName', pName.value || '');
  fd.append('patientEmail', pEmail.value || '');
  fd.append('bloodType', blood.value || '');
  fd.append('emergencyName', eName.value || '');
  fd.append('emergencyPhone', ePhone.value || '');
  fd.append('emergencyEmail', eEmail.value || '');
  fd.append('targetLang', lang.value || '');

  out.textContent = 'Uploading…';
  try{
    const ctl = new AbortController();
    const t = setTimeout(()=>ctl.abort(), 45000);
    const resp = await fetch('/upload', { method:'POST', body: fd, signal: ctl.signal });
    clearTimeout(t);

    if (!resp.ok) {
      const txt = await resp.text().catch(()=>String(resp.status));
      throw new Error(`Upload failed (${resp.status}): ${txt}`);
    }
    const data = await resp.json();
    const link = data.reportUrl;

    out.innerHTML = `
      <div id="reportBox" class="report-box">
        <div><b>Report:</b> <a href="${link}" target="_blank" rel="noopener">${link}</a></div>
        <div class="btn-row">
          <button onclick="window.open('${link}','_blank','noopener')">Open Report</button>
          <button onclick="navigator.clipboard.writeText('${link}')">Copy Link</button>
          <a href="mailto:?subject=Hot%20Health%20Report&body=${encodeURIComponent(link)}"><button>Email Link</button></a>
        </div>
        <div class="qr-wrap"><img id="qr" src="${data.qrData}" width="160" height="160" alt="QR"/></div>
      </div>
      <div class="muted tip">Tip: use “Open All Reports” on the landing page for translate / delete.</div>
    `;
    hint.textContent = 'Ready.';
  }catch(e){
    if (e.name === 'AbortError') {
      err.textContent = 'Network/upload timeout. Check connection and try again.';
    } else {
      err.textContent = e.message || 'Upload failed.';
    }
    out.textContent = '';
  }
}
