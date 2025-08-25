(async function(){
  const btn = document.getElementById("btnRec");
  const meta = document.getElementById("recMeta");
  const resBox = document.getElementById("result");
  const errBox = document.getElementById("error");

  const pName = document.getElementById("pName");
  const pEmail = document.getElementById("pEmail");
  const eName = document.getElementById("eName");
  const ePhone = document.getElementById("ePhone");
  const eEmail = document.getElementById("eEmail");
  const blood = document.getElementById("blood");
  const lang  = document.getElementById("lang");

  let media, recorder, chunks = [], recording = false, startedAt = 0;

  function uiError(msg){ errBox.textContent = msg || ""; }
  function uiMeta(msg){ meta.textContent = msg || ""; }
  function uiResult(html){ resBox.innerHTML = html; }

  function supports() {
    if (!navigator.mediaDevices?.getUserMedia) return "This browser does not support audio recording.";
    if (location.protocol !== "https:" && location.hostname !== "localhost") {
      return "Microphone requires HTTPS or localhost. Open via your Render HTTPS URL.";
    }
    return null;
  }
  const check = supports();
  if (check) { uiError(check); btn.disabled = true; return; }

  btn.addEventListener("click", async () => {
    uiError("");
    if (!recording) {
      try {
        media = await navigator.mediaDevices.getUserMedia({ audio: true });
        recorder = new MediaRecorder(media, { mimeType: "audio/webm" });
        chunks = [];
        recorder.ondataavailable = e => e.data && chunks.push(e.data);
        recorder.onstop = onStop;
        recorder.start();
        recording = true;
        startedAt = Date.now();
        btn.textContent = "Stop";
        uiMeta("Recording… click Stop when done.");
      } catch (e) {
        uiError("Mic permission denied or unsupported browser.");
      }
    } else {
      recording = false;
      recorder.stop();
      btn.textContent = "Record";
      uiMeta("");
      media.getTracks().forEach(t => t.stop());
    }
  });

  async function onStop() {
    const blob = new Blob(chunks, { type: "audio/webm" });
    uiMeta(`Recorded ${(blob.size/1024).toFixed(1)} KB`);
    const fd = new FormData();
    fd.append("audio", blob, "recording.webm");
    fd.append("name", pName.value.trim());
    fd.append("email", pEmail.value.trim());
    fd.append("emer_name", eName.value.trim());
    fd.append("emer_phone", ePhone.value.trim());
    fd.append("emer_email", eEmail.value.trim());
    fd.append("blood_type", blood.value.trim());
    fd.append("lang", lang.value.trim()); // optional initial translate

    try {
      const resp = await fetch("/upload", { method: "POST", body: fd });
      const data = await resp.json().catch(()=>({}));
      if (!resp.ok || !data.ok) {
        throw new Error(`${resp.status} ${data?.error || "Server error"}`);
      }
      // Show link + QR nicely
      uiResult(`
        <div class="result-panel">
          <div>
            <div class="linkbox">${data.link}</div>
            <div class="actions">
              <a class="btn-outline" href="${data.link}" target="_blank">Open Report</a>
              <button class="btn-primary" id="copyBtn">Copy Link</button>
            </div>
          </div>
          <div class="qrbox">
            <img alt="QR" src="${data.qr}"/>
          </div>
        </div>
      `);
      const copyBtn = document.getElementById("copyBtn");
      copyBtn?.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(data.link); copyBtn.textContent="✅ Copied!"; setTimeout(()=>copyBtn.textContent="Copy Link", 1000); }
        catch { copyBtn.textContent="❌"; setTimeout(()=>copyBtn.textContent="Copy Link", 1000); }
      });
    } catch (e) {
      uiError(`Upload failed: ${e.message}`);
    }
  }
})();
