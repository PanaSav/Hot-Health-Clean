// PHI masking (conservative)
function deidentify(text = '') {
  if (!text) return text;
  // Emails
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[email]');
  // Phones
  text = text.replace(/\+?\d[\d\-\s().]{6,}\d/g, '[phone]');
  // Simple person names (very rough; avoids inside hyphenated/letter-spelled tokens)
  text = text.replace(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g, '[name]');
  // Addresses
  text = text.replace(/\b\d{1,5}\s+[A-Za-z0-9.\- ]+\s+(Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Court|Ct|Lane|Ln)\b/gi, '[address]');
  // ❌ Do NOT mask blood types here (was causing "L-[bloodtype]P-..." on letter-spelled meds)
  return text;
}
