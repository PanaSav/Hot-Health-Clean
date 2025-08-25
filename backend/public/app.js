// backend/public/app.js
(() => {
  const $ = (id) => document.getElementById(id);
  const btn = $("btnRec");
  const result = $("result");
  const recMeta = $("recMeta");
  const errBox = $("error");

  let mediaRecorder, chunks = [], stream;

  const showError = (m) => errBox.textContent = m || "";
  const setResult = (h) => result.innerHTML = h;

  async function startRec() {
    showError("");
    chunks = [];
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Prefer a webm container with opus
      const preferred = "audio/webm;codecs=opus";
      const mimeType = MediaRecorder.isTypeSupported?.(preferred) ? preferred : "audio/webm";
      mediaRecorder = new MediaRecorder(stream, { mimeType });
    } catch (e) {
      showError("Microphone requires HTTPS or localhost, and a supported browser (Chrome/Edge/Safari 14+).");
      return;
    }
    mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    mediaRecorder.onstop = onStop;
    mediaRecorder.start();
    btn.textContent = "Stop";
    $("recHint").textContent = "Recording… click Stop when done.";
  }

  async function onStop() {
    try {
      // stop tracks
      stream?.getTracks()?.forEach(t => t.stop());

      // Build a proper File so the browser sets the part Content-Type for Multer
      const file = new File(chunks, "recording.webm", { type: "audio/webm" });
      if (!file.size) { showError("No audio captured."); return; }

      const kb = Math.round(file.size / 1024);
      recMeta.textContent = `Recorded ${kb} KB`;

      const fd = new FormData();
      fd.append("audio", file); // <-- CRITICAL name: "audio"

      // patient/contact
      fd.append("name", $("pName").value || "");
      fd.append("email", $("pEmail").value || "");
      fd.append("blood_type", $("blood").value || "");
      fd.append("emer_name", $("eName").value || "");
      fd.append("emer_phone", $("ePhone").value || "");
      fd.append("emer_email", $("eEmail").value || "");

      // doctor
      fd.append("doc_name", $("docName").value || "");
      fd.append("doc_phone", $("docPhone").value || "");
      fd.append("doc_fax", $("docFax").value || "");
      fd.append("doc_email", $("docEmail").value || "");

      // pharmacy
      fd.append("pharm_name", $("phName").value || "");
      fd.append("pharm_phone", $("phPhone").value || "");
      fd.append("pharm_fax", $("phFax").value || "");
      fd.append("pharm_address", $("phAddr").value || "");

      // optional target language
      fd.append("lang", $("lang").value || "");

      setResult("Uploading…");
      const res = await fetch(`${location.origin}/upload`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data?.error || `HTTP ${res.status}`);

      setResult(`
        <div class="qr-wrap">
          <img class="qr" src="${data.qrDataUrl}" alt="QR"/>
        </div>
        <div class="linkRow">
          <a class="btn" target="_blank" href="${data.shareUrl}">Open report</a>
          <button class="btn" onclick="navigator.clipboard.writeText('${data.shareUrl}').then(()=>alert('Link copied'))">Copy link</button>
        </div>
      `);
    } catch (e) {
      console.error(e);
      showError(`Upload failed: ${e.message || e}`);
      setResult("Record and stop to generate a report + QR.");
    } finally {
      btn.textContent = "Record";
      $("recHint").textContent = "Click to record a short health note (3–10s).";
      mediaRecorder = null;
      chunks = [];
      stream = null;
    }
  }

  btn.addEventListener("click", () => {
    if (!mediaRecorder) startRec();
    else mediaRecorder.stop();
  });
})();
