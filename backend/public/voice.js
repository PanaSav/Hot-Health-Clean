(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  document.querySelectorAll('.mic-btn').forEach(btn => {
    if (!SR) { btn.disabled = true; btn.title = 'Speech recognition not supported'; return; }
    let rec = null;
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;

      if (rec) { try { rec.stop(); } catch {} return; }

      rec = new SR();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      const originalBg = el.style.background;
      btn.textContent = '⏹️';
      el.style.background = '#fff7cc';

      rec.onresult = (e) => {
        let text = (e.results[0][0].transcript || '').trim();
        // light normalization for emails and numbers
        text = text.replace(/\s+at\s+sign/ig,'@').replace(/\s+dot\s+/ig,'.');
        if (el.tagName === 'SELECT') {
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(text.toLowerCase()));
          if (opt) el.value = opt.value;
        } else {
          el.value = text;
        }
      };
      rec.onend = () => {
        btn.textContent = '🎤';
        el.style.background = originalBg;
        rec = null;
      };
      rec.onerror = () => {
        btn.textContent = '🎤';
        el.style.background = originalBg;
        rec = null;
      };
      try { rec.start(); } catch { btn.textContent = '🎤'; el.style.background = originalBg; rec = null; }
    });
  });
})();
