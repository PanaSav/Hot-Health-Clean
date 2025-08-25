// backend/public/app.js
(() => {
  const $ = (id) => document.getElementById(id);
  const btn = $("btnRec");
  const result = $("result");
  const recMeta = $("recMeta");
  const errBox = $("error");

  let mediaRecorder, chunks = [], recStart = 0;

  function showError(msg){ errBox.textContent = msg || ""; }
  function setResult(html){ result.innerHTML = html; }

  async function startRec(){
    showError("");
    chunks = [];
    try{
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    }catch(e){
      showError("Microphone requires HTTPS or localhost, and a supported browser.");
      return;
    }
    mediaRecorder.ondataavailable = (e)=>{ if(e.data?.size) chunks.push(e.data); };
    mediaRecorder.onstop = onStop;
    mediaRecorder.start();
    recStart = Date.now();
    btn.textContent = "Stop";
    $("recHint").textContent = "Recording… click Stop when done.";
  }

  async function onStop(){
    try{
      const blob = new Blob(chunks, { type: "audio/webm" });
      const kb = Math.round(blob.size/1024);
      recMeta.textContent = `Recorded ${kb} KB`;

      if (!blob.size) { showError("No audio captured."); return; }

      const fd = new FormData();
      fd.append("audio", blob, "recording.webm"); // <-- critical name "audio"

      fd.append("name", $("pName").value || "");
      fd.append("email", $("pEmail").value || "");
      fd.append("blood_type", $("blood").value || "");
      fd.append("emer_name", $("eName").value || "");
      fd.append("emer_phone", $("ePhone").value || "");
      fd.append("emer_email", $("eEmail").value || "");

      fd.append("doc_name",  $("docName").value || "");
      fd.append("doc_phone", $("docPhone").value || "");
      fd.append("doc_fax",   $("docFax").value || "");
      fd.append("doc_email", $("docEmail").value || "");

      fd.append("pharm_name",    $("phName").value || "");
      fd.append("pharm_phone",   $("phPhone").value || "");
      fd.append("pharm_fax",     $("phFax").value || "");
      fd.append("pharm_address", $("phAddr").value || "");

      fd.append("lang", $("lang").value || "");

      setResult("Uploading…");
      const base = location.origin; // works for Render and local
      const res = await fetch(`${base}/upload`, { method: "POST", body: fd });
      const data = await res.json().catch(()=>({}));
      if (!res.ok || !data.ok) {
        throw new Error(data?.error || `Upload failed (${res.status})`);
      }
      // show QR + link
      setResult(`
        <div class="qr-wrap">
          <img class="qr" src="${data.qrDataUrl}" alt="QR"/>
        </div>
        <div class="linkRow">
          <a class="btn" target="_blank" href="${data.shareUrl}">Open report</a>
          <button class="btn" onclick="navigator.clipboard.writeText('${data.shareUrl}').then(()=>alert('Link copied'))">Copy link</button>
        </div>
      `);
    }catch(e){
      console.error(e);
      showError(`Upload failed: ${e.message}`);
      setResult("Record and stop to generate a report + QR.");
    }finally{
      btn.textContent = "Record";
      $("recHint").textContent = "Click to record a short health note (3–10s).";
    }
  }

  btn.addEventListener("click", ()=>{
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      startRec();
    } else {
      mediaRecorder.stop();
    }
  });
})();
