// Voice input for individual fields + robust email normalization

(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  function normalizeEmailSpoken(raw) {
    if (!raw) return '';
    let s = ' ' + raw.toLowerCase().trim() + ' ';

    // tokens → symbols
    s = s.replace(/\s+at\s+/g, '@');
    s = s.replace(/\s+dot\s+/g, '.');
    s = s.replace(/\s+period\s+/g, '.');
    s = s.replace(/\s+underscore\s+/g, '_');
    s = s.replace(/\s+(hyphen|dash)\s+/g, '-');
    s = s.replace(/\s+plus\s+/g, '+');

    // common domains
    s = s.replace(/\s+gmail\s*\.?\s*com\s*/g, '@gmail.com ');
    s = s.replace(/\s+outlook\s*\.?\s*com\s*/g, '@outlook.com ');
    s = s.replace(/\s+hotmail\s*\.?\s*com\s*/g, '@hotmail.com ');
    s = s.replace(/\s+yahoo\s*\.?\s*com\s*/g, '@yahoo.com ');

    // tighten spaces
    s = s.replace(/\s*@\s*/g, '@');
    s = s.replace(/\s*\.\s*/g, '.');
    s = s.replace(/\s+/g, ' ').trim();

    // no spaces inside email
    s = s.replace(/\s+/g, '');

    // clean repeated dots
    s = s.replace(/\.\.+/g, '.');

    return s;
  }

  function isEmailField(el) {
    const id = (el.id || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const type = (el.type || '').toLowerCase();
    return type === 'email' || id.includes('email') || name.includes('email');
  }

  document.querySelectorAll('.mic-btn').forEach(btn => {
    if (!SR) {
      btn.disabled = true;
      btn.title = 'Speech recognition not supported in this browser';
      return;
    }

    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const el = document.getElementById(targetId);
      if (!el) return;

      const rec = new SR();
      rec.lang = (window.__uiLang || 'en-US');
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      const original = el.style.backgroundColor;
      btn.classList.add('mic-active');
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e) => {
        const raw = e.results[0][0].transcript || '';
        const text = isEmailField(el) ? normalizeEmailSpoken(raw) : raw;

        if (el.tagName === 'SELECT') {
          const lower = text.toLowerCase();
          const opt = [...el.options].find(o => o.textContent.toLowerCase().includes(lower));
          if (opt) el.value = opt.value;
        } else {
          el.value = text;
        }
      };

      rec.onend = () => {
        btn.classList.remove('mic-active');
        el.style.backgroundColor = original;
      };
      rec.onerror = () => {
        btn.classList.remove('mic-active');
        el.style.backgroundColor = original;
      };

      try { rec.start(); } catch {
        btn.classList.remove('mic-active');
        el.style.backgroundColor = original;
      }
    });
  });
})();
