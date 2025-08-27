(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supports = !!SR;
  document.querySelectorAll('.mic-btn').forEach(btn => {
    if (!supports) { btn.disabled = true; btn.title = 'Speech recognition not supported'; return; }
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;

      const rec = new SR();
      rec.lang = 'en-US';           // You can make this dynamic by current detected UI language
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.disabled = true;
      const originalBg = el.style.background;
      el.style.background = '#fff7cc';

      rec.onresult = (e) => {
        const text = e.results[0][0].transcript || '';
        if (el.tagName === 'SELECT') {
          // try to match an option by text
          const val = [...el.options].find(o => o.textContent.toLowerCase().includes(text.toLowerCase()));
          if (val) el.value = val.value;
        } else {
          el.value = text;
        }
      };
      rec.onend = () => {
        btn.disabled = false;
        el.style.background = originalBg;
      };
      rec.onerror = () => {
        btn.disabled = false;
        el.style.background = originalBg;
      };

      try { rec.start(); } catch { btn.disabled = false; el.style.background = originalBg; }
    });
  });
})();
