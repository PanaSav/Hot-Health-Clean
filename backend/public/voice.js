(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.querySelectorAll('.mic-btn').forEach(btn=>{
    if (!SR) { btn.disabled=true; btn.title='Speech recognition not supported'; return; }
    btn.addEventListener('click', ()=>{
      const id = btn.getAttribute('data-target');
      const el = document.getElementById(id);
      if (!el) return;
      const rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.disabled = true;
      const originalBg = el.style.background;
      el.style.background = '#fff7cc';

      rec.onresult = e => {
        let text = e.results[0][0].transcript || '';
        // light normalization: say "at" -> "@", "dot" -> "."
        text = text.replace(/\bat\b/gi,'@').replace(/\bdot\b/gi,'.');
        if (el.tagName === 'SELECT') {
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(text.toLowerCase()));
          if (opt) el.value = opt.value;
        } else {
          el.value = text;
        }
      };
      rec.onend = ()=>{ btn.disabled=false; el.style.background = originalBg; };
      rec.onerror = ()=>{ btn.disabled=false; el.style.background = originalBg; };

      try { rec.start(); } catch { btn.disabled=false; el.style.background = originalBg; }
    });
  });
})();
