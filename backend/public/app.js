// backend/public/app.js
function $(id){ return document.getElementById(id); }

const LS_KEYS = [
  "pName","pEmail","blood","eName","ePhone","eEmail",
  "docName","docPhone","docFax","docEmail","lang"
];

window.addEventListener('DOMContentLoaded', ()=>{
  LS_KEYS.forEach(k=>{
    const el = $(k);
    if (el && localStorage.getItem(k) !== null) el.value = localStorage.getItem(k);
  });
});

LS_KEYS.forEach(k=>{
  const el = $(k);
  if (el) el.addEventListener('change', ()=> localStorage.setItem(k, el.value || ""));
});

function appendFormValues(fd){
  const fields = {
    name: $("pName")?.value?.trim() || "",
    email: $("pEmail")?.value?.trim() || "",
    blood_type: $("blood")?.value || "",
    emer_name: $("eName")?.value?.trim() || "",
    emer_phone: $("ePhone")?.value?.trim() || "",
    emer_email: $("eEmail")?.value?.trim() || "",
    doc_name: $("docName")?.value?.trim() || "",
    doc_phone: $("docPhone")?.value?.trim() || "",
    doc_fax: $("docFax")?.value?.trim() || "",
    doc_email: $("docEmail")?.value?.trim() || "",
    lang: $("lang")?.value || ""
  };
  Object.entries(fields).forEach(([k,v])=> fd.append(k, v));
}

// --- recording ---
let mediaRecorder, chunks = [];
const btnRec = $("btnRec");
const recMeta = $("recMeta");
const result = $("result");
const errorEl = $("error");

async function startRec(){
  errorEl.textContent = "";
  try {
    const secure = location.protocol === "https:" || location.hostname === "localhost";
    if (!secure) throw new Error("Microphone requires HTTPS or localhost.");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    mediaRecorder.onstop = onStop;
    mediaRecorder.start();
    btnRec.textContent = "Stop";
    recMeta.textContent = "Recording… click Stop when done.";
  } catch (e) {
    errorEl.textContent = "ERROR: " + e.message;
  }
}
async function stopRec(){
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  btnRec.textContent = "Record";
}
btnRec.addEventListener("click", ()=> (btnRec.textContent === "Record" ? startRec() : stopRec()));

async function onStop(){
  const blob = new Blob(chunks, { type: "audio/webm" });
  recMeta.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`;
  const fd = new FormData();
  fd.append("audio", blob, "recording.webm");
  appendFormValues(fd);

  result.innerHTML = "⏫ Uploading…";

  try {
    const resp = await fetch("/upload", { method: "POST", body: fd });
    const data = await resp.json().catch(()=> ({}));
    if (!resp.ok || !data.ok) throw new Error((data && data.error) || "Upload failed");
    // show QR + link (icon only on report page; here we can preview)
    result.innerHTML = `
      <div class="qrprev"><img src="${data.qrDataUrl}" width="140"></div>
      <div><a class="btn" target="_blank" href="${data.shareUrl}">Open Report</a></div>
    `;
  } catch (e) {
    result.textContent = `Upload failed: ${e.message}`;
  }
}
