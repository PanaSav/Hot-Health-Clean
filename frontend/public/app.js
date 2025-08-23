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

let rec = null, chunks = [], startTs = 0;

// Warn if not secure and not localhost
(function warnInsecure(){
  const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const isSecure = location.protocol === 'https:';
  if (!isSecure && !isLocalhost) {
    const w = document.createElement('div');
    w.style.cssText = 'background:#fff3cd;color:#7c2d12;padding:10px;border:1px solid #facc15;border-radius:8px;margin:10px 0';
    w.innerHTML = 'Microphone requires HTTPS or localhost. Open <b>https://10.0.0.125:4000</b> (or your HTTPS host), or use <b>http://localhost:4000</b> on this PC.';
    document.querySelector('main').prepend(w);
  }
})();

btn.addEventListener('click', async () => {
  err.textContent = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    err.textContent = 'This browser does not support audio recording. Try Chrome/Edge.';
    return;
  }
  if (!rec || rec.state === 'inactive') {
    start();
  } else {
    stop();
  }
});

async function start(){
  try{
    const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const isSecure = location.protocol === 'https:';
    if (!isSecure && !isLocalhost) throw new Error('SECURE_ORIGIN_REQUIRED');

    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    chunks = [];

    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');

    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = e => { err.textContent = 'Recorder error: ' + (e.error?.message || e.message || e.name || 'unknown'); };
    rec.onstop = onStop;

    startTs = Date.now();
    rec.start(250);

    btn.textContent = 'Stop';
    hint.textContent = 'Recording… speak now.';
    meta.textContent = '';
    out.textContent = 'Recording…';
  }catch(e){
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      err.textContent = 'Microphone blocked. Click the mic icon in the address bar and allow access.';
    } else if (e && e.message === 'SECURE_ORIGIN_REQUIRED') {
      err.textContent = 'Mic requires HTTPS or localhost. Open https://<your-ip>:4000 or http://localhost:4000.';
    } else {
      err.textContent = 'Microphone access failed: ' ' + (e.message || e.name || 'unknown error');
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
  const mimeType = rec?.mimeType || 'audio/webm';
  const blob = new Blob(chunks, { type: mimeType });

  meta.textContent = `Length ~${Math.round(ms/1000)}s · Size ${Math.round(blob.size/1024)} KB`;
  if (blob.size < 6000) { // ~6KB sanity
    err.textContent = 'Recording too short — try 3–10 seconds.';
    out.textContent = '';
    return;
  }

  const fd = new FormData();
  fd.append('audio', blob, 'rec.webm');
  fd.append('patientName', pName.value || '');
  fd.append('patientEmail', pEmail.value || '');
  fd.append('emergencyName', eName.value || '');
  fd.append('emergencyPhone', ePhone.value || '');
  fd.append('emergencyEmail', eEmail.value || '');
  fd.append('bloodType', blood.value || '');
  fd.append('targetLang', lang.value || '');

  out.textContent = 'Uploading…';
  try{
    const ctl = new AbortController();
    const t = setTimeout(()=>ctl.abort(), 30000);
    const resp = await fetch('/upload', { method:'POST', body: fd, signal: ctl.signal });
    clearTimeout(t);

    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    const link = data.reportUrl;

    out.innerHTML = `
      <div id="reportBox" style="border:2px solid #0077ff;border-radius:10px;padding:10px;margin-top:8px">
        <div><b>Report:</b> <a href="${link}" target="_blank" rel="noopener">${link}</a></div>
        <div style="margin-top:6px">
          <button onclick="window.open('${link}','_blank','noopener')">Open Report</button>
          <button onclick="navigator.clipboard.writeText('${link}')">Copy Link</button>
          <a href="mailto:?subject=Hot%20Health%20Report&body=${encodeURIComponent(link)}"><button>Email Link</button></a>
        </div>
        <div style="margin-top:8px"><img id="qr" src="${data.qrData}" width="160" height="160" alt="QR"/></div>
      </div>
      <div class="muted" style="margin-top:8px">Tip: use the “All reports” link on the report page for translate/delete.</div>
    `;
    hint.textContent = 'Ready.';
  }catch(e){
    if (e.name === 'AbortError') {
      err.textContent = 'Network/upload timeout. Check connection and try again.';
    } else {
      err.textContent = 'Upload failed: ' + (e.message || 'Unknown error');
    }
    out.textContent = '';
  }
}
