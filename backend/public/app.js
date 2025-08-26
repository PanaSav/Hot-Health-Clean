// /public/app.js – mic UI + upload
(() => {
  const $ = (id) => document.getElementById(id);

  const btn = $("btnRec");
  const hint = $("recHint");
  const recMeta = $("recMeta");
  const out = $("result");
  const errBox = $("error");

  let media, rec, chunks = [], recording = false;

  function showError(msg) {
    errBox.textContent = msg;
    errBox.style.display = "block";
    setTimeout(()=> errBox.style.display = "none", 6000);
  }

  async function ensureMic() {
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
      return true;
    } catch (e) {
      showError("Mic permission denied or unavailable.");
      return false;
    }
  }

  function getField(id) {
    return ($(id)?.value || "").trim();
  }

  btn.addEventListener("click", async () => {
    if (!recording) {
      if (!navigator.mediaDevices?.getUserMedia) {
        showError("This browser does not support audio recording.");
        return;
      }
      if (!await ensureMic()) return;

      chunks = [];
      rec = new MediaRecorder(media, { mimeType: "audio/webm" });
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = onStop;
      rec.start();

      recording = true;
      btn.textContent = "Stop";
      hint.textContent = "Recording… click Stop when done.";
      recMeta.textContent = "";
      out.innerHTML = "Recording…";
      errBox.textContent = "";
    } else {
      recording = false;
      try { rec.stop(); } catch {}
      btn.textContent = "Record";
      hint.textContent = "Click to record a short health note (3–10s).";
    }
  });

  async function onStop() {
    const blob = new Blob(chunks, { type: "audio/webm" });
    recMeta.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`;

    if (blob.size < 2048) {
      showError("Recording too short. Try again.");
      return;
    }

    const fd = new FormData();
    fd.append("audio", blob, "recording.webm");
    fd.append("name", getField("pName"));
    fd.append("email", getField("pEmail"));
    fd.append("emer_name", getField("eName"));
    fd.append("emer_phone", getField("ePhone"));
    fd.append("emer_email", getField("eEmail"));
    fd.append("blood_type", getField("blood"));
    // doctor & pharmacy
    fd.append("doc_name", getField("docName"));
    fd.append("doc_phone", getField("docPhone"));
    fd.append("doc_fax", getField("docFax"));
    fd.append("doc_email", getField("docEmail"));
    fd.append("pharm_name", getField("pharmName"));
    fd.append("pharm_address", getField("pharmAddr"));
    fd.append("pharm_phone", getField("pharmPhone"));
    fd.append("pharm_fax", getField("pharmFax"));
    // translation
    fd.append("lang", getField("lang"));

    out.innerHTML = "Uploading…";
    try {
      const r = await fetch("/upload", { method: "POST", body: fd });
      if (!r.ok) {
        const txt = await r.text().catch(()=> "");
        throw new Error(`Upload failed (${r.status}): ${txt || r.statusText}`);
      }
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Server error");

      // show QR + link
      out.innerHTML = `
        <div class="qr"><img src="${data.qrDataUrl}" alt="QR"></div>
        <p><a class="btn" target="_blank" href="${data.shareUrl}">Open Share Link</a></p>
      `;
    } catch (e) {
      showError(e.message || "Upload failed");
      out.textContent = "Upload failed.";
    }
  }
})();
