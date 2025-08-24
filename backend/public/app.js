/* Hot Health – frontend controller */
(() => {
  const $ = (q) => document.querySelector(q);

  const btnRec = $("#btnRec");
  const recHint = $("#recHint");
  const recMeta = $("#recMeta");
  const errBox = $("#error");
  const result = $("#result");

  const pName = $("#pName");
  const pEmail = $("#pEmail");
  const eName = $("#eName");
  const ePhone = $("#ePhone");
  const eEmail = $("#eEmail");
  const blood = $("#blood");
  const lang = $("#lang");

  let media, recorder, chunks = [];

  function showError(msg) {
    errBox.textContent = msg;
    errBox.style.display = msg ? "block" : "none";
  }
  function setRecUI(state) {
    if (state === "idle") {
      btnRec.textContent = "Record";
      recHint.textContent = "Click to record a short health note (3–10s).";
    } else {
      btnRec.textContent = "Stop";
      recHint.textContent = "Recording… click Stop when done.";
    }
  }

  async function ensureMic() {
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      throw new Error("Microphone requires HTTPS or localhost. Open this site via https (Render URL) or use http://localhost.");
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support audio recording. Try Chrome/Edge or iOS Safari 14+.");
    }
  }

  async function startRecording() {
    await ensureMic();
    showError("");
    media = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(media, { mimeType: "audio/webm" });
    chunks = [];
    recorder.ondataavailable = (e) => e.data && chunks.push(e.data);
    recorder.onstop = onStopped;
    recorder.start();
    setRecUI("rec");
  }

  async function stopRecording() {
    try { recorder && recorder.state === "recording" && recorder.stop(); }
    catch {}
    setRecUI("idle");
  }

  async function onStopped() {
    try {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const kb = (blob.size / 1024).toFixed(1);
      recMeta.textContent = `Recorded ${kb} KB`;

      const fd = new FormData();
      fd.append("audio", blob, "recording.webm");
      fd.append("name", (pName.value || "").trim());
      fd.append("email", (pEmail.value || "").trim());
      fd.append("emer_name", (eName.value || "").trim());
      fd.append("emer_phone", (ePhone.value || "").trim());
      fd.append("emer_email", (eEmail.value || "").trim());
      fd.append("blood_type", (blood.value || "").trim());
      fd.append("lang", (lang.value || "").trim());

      const resp = await fetch("/upload", { method: "POST", body: fd });
      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`Upload failed (${resp.status}): ${txt}`);
      }
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || "Server error");

      // Build immediate result panel (link + QR)
      const url = data.link;
      // Use server-provided dataURL QR if present, otherwise fallback to QR endpoint
      const qrSrc = data.qr || `/reports/${data.id}/qrcode.png`;

      result.innerHTML = `
        <div class="result-panel">
          <div>
            <div class="linkbox" id="shareLink">${url}</div>
            <div class="actions">
              <button class="btn-aqua" id="copyBtn">Copy Link</button>
              <a class="btn-primary" href="${url}" target="_blank" rel="noopener">Open Report</a>
              <a class="btn" style="background:#2d3748;color:#fff" href="/reports?password=Hotest" target="_blank" rel="noopener">Open All Reports</a>
            </div>
          </div>
          <div class="qrbox">
            <img alt="QR code" src="${qrSrc}">
          </div>
        </div>
      `;

      $("#copyBtn")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(url);
          const btn = $("#copyBtn");
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = "Copy Link"), 1200);
        } catch {
          alert("Copy failed");
        }
      });
    } catch (e) {
      showError(e.message || String(e));
    } finally {
      try { media && media.getTracks().forEach(t => t.stop()); } catch {}
    }
  }

  btnRec?.addEventListener("click", () => {
    if (btnRec.textContent === "Record") startRecording();
    else stopRecording();
  });

  // Initial UI
  setRecUI("idle");
})();
