// backend/public/voice.js
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return; // graceful: no SR, no field mics

  function attachMic(btn) {
    const inputId = btn.getAttribute("data-mic");
    const el = document.getElementById(inputId);
    if (!el) return;

    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = false;

    // choose language based on target select if set; else default to en
    const sel = document.getElementById("lang");
    const lang = sel?.value || "en";
    rec.lang = lang;

    btn.addEventListener("click", ()=>{
      try { rec.start(); btn.textContent = "🎤…"; } catch {}
    });

    rec.onresult = (ev)=>{
      const text = ev.results[0][0].transcript;
      if (el.value) el.value = `${el.value} ${text}`.trim();
      else el.value = text;
    };
    rec.onend = ()=>{ btn.textContent = "🎙️"; };
  }

  document.querySelectorAll("[data-mic]").forEach(attachMic);
})();
