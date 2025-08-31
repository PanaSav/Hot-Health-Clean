<script>
/* Voice input for individual fields (safe update)
   - Leaves existing field/mic wiring intact
   - Adds email-specific normalization (spoken → real email)
*/
(() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Map common spoken tokens to email-safe characters
  function normalizeEmailSpoken(raw) {
    if (!raw) return '';
    let s = ' ' + raw.toLowerCase().trim() + ' ';

    // common connectors
    s = s.replace(/\s+at\s+/g, '@');          // "john at example dot com"
    s = s.replace(/\s+dot\s+/g, '.');         // dot → .
    s = s.replace(/\s+period\s+/g, '.');
    s = s.replace(/\s+underscore\s+/g, '_');
    s = s.replace(/\s+(hyphen|dash)\s+/g, '-');
    s = s.replace(/\s+plus\s+/g, '+');

    // common domains
    s = s.replace(/\s+gmail\s*\.?\s*com\s*/g, '@gmail.com ');
    s = s.replace(/\s+outlook\s*\.?\s*com\s*/g, '@outlook.com ');
    s = s.replace(/\s+hotmail\s*\.?\s*com\s*/g, '@hotmail.com ');
    s = s.replace(/\s+yahoo\s*\.?\s*com\s*/g, '@yahoo.com ');

    // remove residual spaces around @ and .
    s = s.replace(/\s*@\s*/g, '@');
    s = s.replace(/\s*\.\s*/g, '.');

    // collapse spaces
    s = s.replace(/\s+/g, ' ').trim();

    // final pass: strip spaces entirely (emails don’t have spaces)
    s = s.replace(/\s+/g, '');

    // rudimentary cleanup: avoid double dots like "john..doe"
    s = s.replace(/\.\.+/g, '.');

    return s;
  }

  function isEmailField(el) {
    const id = (el.id || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const type = (el.type || '').toLowerCase();
    return (
      type === 'email' ||
      id.includes('email') ||
      name.includes('email')
    );
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
      rec.lang = (window.__uiLang || 'en-US'); // keep your current lang if you set it elsewhere
      rec.interimResults = false;
      rec.maxAlternatives = 1;

      const original = el.style.backgroundColor;
      btn.classList.add('mic-active');
      el.style.backgroundColor = '#fff7cc';

      rec.onresult = (e) => {
        const raw = e.results[0][0].transcript || '';

        // If an email-like field, normalize heavily
        const text = isEmailField(el) ? normalizeEmailSpoken(raw) : raw;

        if (el.tagName === 'SELECT') {
          // attempt to match any option containing the spoken text
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
</script>
