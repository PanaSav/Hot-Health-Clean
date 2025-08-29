const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const errBox   = $('#error');
const resultEl = $('#result');
const shareBar = $('#shareBtns');
const openLink = $('#openLink');
const copyLink = $('#copyLink');
const gmailLink= $('#gmailLink');
const outlook  = $('#outlookLink');

const sumWrap  = $('#dualSumm');
const sumOrig  = $('#sumOrig');
const sumTrans = $('#sumTrans');
const sumLang  = $('#sumLang');

function setError(m){ errBox.textContent = m || ''; }

// ----- gather patient/contacts -----
function gatherCommon() {
  return {
    name:  $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    blood_type: $('#blood').value.trim(),

    emer_name:  $('#eName').value.trim(),
    emer_phone: $('#ePhone').value.trim(),
    emer_email: $('#eEmail').value.trim(),

    doctor_name:  $('#dName').value.trim(),
    doctor_phone: $('#dPhone').value.trim(),
    doctor_email: $('#dEmail').value.trim(),
    doctor_fax:   '',

    pharmacy_name:    $('#phName').value.trim(),
    pharmacy_phone:   $('#phPhone').value.trim(),
    pharmacy_fax:     $('#phFax').value.trim(),
    pharmacy_address: $('#phAddress').value.trim(),

    lang: $('#lang').value.trim()
  };
}

// ----- Six mini recorders -----
function makeRecorder({btnId, metaId, maxMs}) {
  const btn  = document.getElementById(btnId);
  const meta = document.getElementById(metaId);
  let mr = null, chunks = [], timer = null;

  function stop() {
    if (mr && mr.state !== 'inactive') {
      mr.stop();
      mr.stream.getTracks().forEach(t=>t.stop());
    }
    clearTimeout(timer);
    btn.textContent = 'Record';
  }

  btn.addEventListener('click', async () => {
    setError('');
    if (btn.textContent === 'Stop') return stop();

    // start
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio:true }); }
    catch { setError('Mic blocked. Allow microphone and try again.'); return; }

    chunks = [];
    mr = new MediaRecorder(stream, { mimeType:'audio/webm' });
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      clearTimeout(timer);
      const blob = new Blob(chunks, { type:'audio/webm' });
      meta.textContent = `Recorded ${(blob.size/1024).toFixed(1)} KB`;
      btn.dataset.blobUrl = URL.createObjectURL(blob);  // save for collection
    };
    mr.start();
    btn.textContent = 'Stop';
    meta.textContent = `Recording… (auto-stops in ${Math.round(maxMs/1000)}s)`;
    timer = setTimeout(stop, maxMs);
  });

  return {
    collectBlob() {
      const url = btn.dataset.blobUrl;
      if (!url) return null;
      return { blobUrl:url, metaEl:meta };
    },
    clear() {
      if (btn.dataset.blobUrl) URL.revokeObjectURL(btn.dataset.blobUrl);
      delete btn.dataset.blobUrl;
      meta.textContent = '';
    }
  };
}

const recBP         = makeRecorder({ btnId:'recBP',         metaId:'metaBP',         maxMs:20000  });
const recMeds       = makeRecorder({ btnId:'recMeds',       metaId:'metaMeds',       maxMs:180000 });
const recAllergies  = makeRecorder({ btnId:'recAllergies',  metaId:'metaAllergies',  maxMs:60000  });
const recWeight     = makeRecorder({ btnId:'recWeight',     metaId:'metaWeight',     maxMs:60000  });
const recConditions = makeRecorder({ btnId:'recConditions', metaId:'metaConditions', maxMs:180000 });
const recGeneral    = makeRecorder({ btnId:'recGeneral',    metaId:'metaGeneral',    maxMs:180000 });

const allRecorders = [recBP, recMeds, recAllergies, recWeight, recConditions, recGeneral];

// ----- Generate Report -----
$('#btnGenerate').addEventListener('click', async () => {
  try {
    setError('');
    resultEl.textContent = 'Uploading…';
    shareBar.style.display = 'none';
    sumWrap.style.display = 'none';

    // Build FormData
    const fd = new FormData();

    // Add audio blobs (if any)
    for (const r of allRecorders) {
      const found = r.collectBlob();
      if (!found) continue;
      const blob = await (await fetch(found.blobUrl)).blob();
      fd.append('audio', blob, 'part.webm'); // backend accepts multiple 'audio'
    }

    // Merge typed inputs into one note (backend appends to transcript)
    const typed = [
      $('#bpText').value.trim()         ? `Blood Pressure: ${$('#bpText').value.trim()}` : '',
      $('#medsText').value.trim()       ? `Medications: ${$('#medsText').value.trim()}`  : '',
      $('#allergiesText').value.trim()  ? `Allergies: ${$('#allergiesText').value.trim()}`: '',
      $('#weightText').value.trim()     ? `Weight: ${$('#weightText').value.trim()}`     : '',
      $('#conditionsText').value.trim() ? `Conditions: ${$('#conditionsText').value.trim()}`: '',
      $('#generalText').value.trim()    ? `General Note: ${$('#generalText').value.trim()}`: ''
    ].filter(Boolean).join('\n');
    if (typed) fd.append('typed_notes', typed);

    // Add common fields
    const common = gatherCommon();
    for (const [k,v] of Object.entries(common)) fd.append(k, v);

    // POST
    const resp = await fetch('/upload', { method:'POST', body: fd });
    if (!resp.ok) throw new Error('Server error');
    const json = await resp.json();
    if (!json.ok) throw new Error(json.error || 'Upload failed');

    // Show result & share controls
    resultEl.innerHTML = `
      <div><b>Report:</b> <a href="${json.url}" target="_blank" rel="noopener">${json.url}</a></div>
      ${json.qr ? `<div style="margin-top:8px"><img src="${json.qr}" alt="QR" style="max-width:160px"/></div>` : ''}
    `;
    openLink.href = json.url;
    copyLink.onclick = () => navigator.clipboard.writeText(json.url);
    gmailLink.href  = `https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent('Hot Health Report')}&body=${encodeURIComponent(json.url)}`;
    outlook.href    = `https://outlook.live.com/owa/?path=/mail/action/compose&subject=${encodeURIComponent('Hot Health Report')}&body=${encodeURIComponent(json.url)}`;
    shareBar.style.display = 'flex';

    if (json.summary_original || json.summary_translated) {
      sumOrig.textContent  = json.summary_original || '(none)';
      sumTrans.textContent = json.summary_translated || '(no translation)';
      sumLang.textContent  = json.target_lang_name || json.target_lang || 'Translated';
      sumWrap.style.display = 'grid';
    }

    // clear recorder metadata
    allRecorders.forEach(r => r.clear());
  } catch (e) {
    setError(e.message || String(e));
    resultEl.textContent = '—';
  }
});
