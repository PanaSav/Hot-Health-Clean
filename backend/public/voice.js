(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supports = !!SR;

  function normalizeSpoken(text, fieldId) {
    let t = ` ${text.toLowerCase()} `;

    // common dictation terms → symbols
    t = t
      .replace(/\s(at|arroba)\s/g, ' @ ')
      .replace(/\s(dot|period|point)\s/g, ' . ')
      .replace(/\s(underscore|under score)\s/g, ' _ ')
      .replace(/\s(dash|hyphen)\s/g, ' - ')
      .replace(/\s(plus)\s/g, ' + ')
      .replace(/\s(comma)\s/g, ' , ')
      .replace(/\s(space)\s/g, ' ');

    t = t.replace(/\s+/g, ' ').trim();

    // Emails should not contain spaces
    if (fieldId === 'pEmail' || fieldId === 'eEmail') {
      t = t.replace(/\s+/g, '');
      // simple clean-up like “john at mail dot com” → “john@mail.com”
      t = t.replace(/@\.?/g, '@').replace(/\.{2,}/g, '.');
    }
    return t;
  }

  document.querySelectorAll('.mic-btn').forEach(btn => {
    if (!supports) { btn.disabled = true; btn.title = 'Speech recognition not supported'; return; }
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;

      const rec = new SR();
      rec.lang = 'en-CA';          // Canadian English default; adjust as needed
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      btn.disabled = true;
      const originalBg = el.style.background;
      el.style.background = '#fff7cc';

      rec.onresult = (e) => {
        const raw = e.results[0][0].transcript || '';
        const text = normalizeSpoken(raw, targetId);
        if (el.tagName === 'SELECT') {
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(text.toLowerCase()));
          if (opt) el.value = opt.value;
        } else {
          el.value = text;
        }
      };
      rec.onend = () => { btn.disabled = false; el.style.background = originalBg; };
      rec.onerror = () => { btn.disabled = false; el.style.background = originalBg; };

      try { rec.start(); } catch { btn.disabled = false; el.style.background = originalBg; }
    });
  });
})();
