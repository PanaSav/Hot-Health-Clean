// backend/public/app.js — fixed success rendering + "Open All Reports" hint
(() => {
  const $ = s => document.querySelector(s);

  const btn = $("#btnRec");
  const result = $("#result");
  const recMeta = $("#recMeta");
  const errBox = $("#error");

  const pName = $("#pName");
  const pEmail = $("#pEmail");
  const eName = $("#eName");
  const ePhone = $("#ePhone");
  const eEmail = $("#eEmail");
  const blood = $("#blood");
  const lang  = $("#lang");

  let mediaRecorder;
  let chunks = [];
  let recording = false;

  const setError = msg => {
    errBox.textContent = msg || "";
    errBox.style.display = msg ? "block" : "none";
  };
  const setResult = html => result.innerHTML = html;
  const setMeta = msg => recMeta.textContent = msg || "";

  async function start() {
    setError("");
    if (!(location.protocol === "https:" || location.hostname === "localhost")) {
      setError("Microphone requires HTTPS or localhost. Open this site with https:// or use http://localhost.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      mediaRecorder.onstop = onStop;
      mediaRecorder.start();
      recording = true;
      btn.textContent = "Stop";
      setMeta("Recording… click Stop when done.");
      setResult("Recording…");
    } catch (e) {
      setError("This browser does not support audio recording, or mic permission was denied.");
      console.error(e);
    }
  }

  async function onStop() {
    try {
      const blob = new Blob(chunks, { type: "audio/webm" });
      const kb = (blob.size/1024).toFixed(1);
      setMeta(`Recorded ${kb} KB`);

      const fd = new FormData();
      fd.append("audio", blob, "recording.webm");
      fd.append("name", pName.value || "");
      fd.append("email", pEmail.value || "");
      fd.append("emer_name", eName.value || "");
      fd.append("emer_phone", ePhone.value || "");
      fd.append("emer_email", eEmail.value || "");
      fd.append("blood_type", blood.value || "");
      fd.append("lang", lang.value || "");

      const r = await fetch("/upload", { method: "POST", body: fd });
      if (!r.ok) {
        const t = await r.text().catch(()=>"");
        throw new Error(`Upload failed (${r.status}): ${t || r.statusText}`);
      }
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || "Upload failed");

      const { id, reportUrl, qrData } = data;
      if (!id || !reportUrl) throw new Error("Server returned no report id/url.");

      const qrImg = qrData ? `<img src="${qrData}" alt="QR" class="qr-img">` : "";
      setResult(`
        <div class="report-summary">
          <div><b>Shareable Link:</b> <a href="${reportUrl}" target="_blank">${reportUrl}</a></div>
          <div class="qr">${qrImg}</div>
          <div class="hint">Scan the QR on a phone or click the link to open the report. · <a href="/reports" target="_blank">Open All Reports</a></div>
        </div>
      `);
    } catch (e) {
      console.error(e);
      setError(e.message || "Upload error");
      setResult("");
    } finally {
      chunks = [];
    }
  }

  function stop() {
    try {
      recording = false;
      btn.textContent = "Record";
      mediaRecorder?.stop();
    } catch (e) { console.error(e); }
  }

  btn?.addEventListener("click", () => (!recording ? start() : stop()));
})();
