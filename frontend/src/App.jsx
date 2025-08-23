const btn = document.getElementById('btnRec');
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

btn.addEventListener('click', async () => {
  err.textContent = '';
  if (!rec || rec.state === 'inactive') {
    start();
  } else {
    stop();
  }
});

async function start(){
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    chunks = [];
    rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported('audio/webm') ? {mimeType:'audio/webm'} : undefined);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = onStop;
    startTs = Date.now();
    rec.start(250);
    btn.textContent = 'Stop';
    hint.textContent = 'Recording… speak now.';
    meta.textContent = '';
    out.innerHTML = 'Recording…';
  }catch(e){
    err.textContent = 'Microphone access is required: ' + e.message;
  }
}

function stop(){
  try { rec?.stop(); rec?.stream?.getTracks()?.forEach(t=>t.stop()); } catch {}
  btn.textContent = 'Record';
  hint.textContent = 'Processing…';
}

async function onStop(){
  const ms = Date.now() - startTs;
  const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
  meta.textContent = `Length ~${Math.round(ms/1000)}s · Size ${Math.round(blob.size/1024)} KB`;
  if (blob.size < 5000) { err.textContent = 'Recording too short — try 3–10 seconds.'; out.textContent=''; return; }

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
    const resp = await fetch('/upload', { method:'POST', body: fd });
    if (!resp.ok) throw new Error(await resp.text());
    const data = await resp.json();
    const link = data.reportUrl;
    out.innerHTML = `
      <div id="reportBox">
        <div><b>Report:</b> <a href="${link}" target="_blank">${link}</a></div>
        <div style="margin-top:6px">
          <button onclick="window.open('${link}','_blank')">Open Report</button>
          <button onclick="navigator.clipboard.writeText('${link}')">Copy Link</button>
          <a href="mailto:?subject=Hot%20Health%20Report&body=${encodeURIComponent(link)}"><button>Email Link</button></a>
        </div>
        <div style="margin-top:8px"><img id="qr" src="${data.qrData}" width="160" height="160" alt="QR"/></div>
      </div>
      <div class="muted" style="margin-top:8px">Tip: open the report and use the "All reports" link for admin translate/delete.</div>
    `;
  }catch(e){
    console.error(e);
    err.textContent = 'Upload failed: ' + (e.message || 'Unknown error');
    out.textContent = '';
  }finally{
    hint.textContent = 'Ready.';
  }
}
