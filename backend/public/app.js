// public/app.js
const $ = s => document.querySelector(s);

const errBox = $('#error');
const out    = $('#result');
const btnGen = $('#btnGenerate');

function gatherForm(){
  return {
    name: $('#pName').value.trim(),
    email: $('#pEmail').value.trim(),
    blood_type: $('#blood').value.trim(),

    emer_name: $('#eName')?.value.trim() || '',
    emer_phone: $('#ePhone')?.value.trim() || '',
    emer_email: $('#eEmail')?.value.trim() || '',

    doctor_name: $('#dName')?.value.trim() || 'N/A',
    doctor_phone: $('#dPhone')?.value.trim() || 'N/A',
    doctor_fax: $('#dFax')?.value.trim() || 'N/A',
    doctor_email: $('#dEmail')?.value.trim() || 'N/A',

    pharmacy_name: $('#phName')?.value.trim() || 'N/A',
    pharmacy_phone: $('#phPhone')?.value.trim() || 'N/A',
    pharmacy_fax: $('#phFax')?.value.trim() || 'N/A',
    pharmacy_address: $('#phAddr')?.value.trim() || 'N/A',

    lang: $('#lang').value.trim()
  };
}

function setError(m){ errBox.textContent = m || ''; }

// Mini recorder model
class MiniRecorder {
  constructor(root){
    this.root = root;
    this.key = root.dataset.key;
    this.maxMs = Number(root.dataset.max||60000);
    this.btn = root.querySelector('.rec');
    this.hint = root.querySelector('.hint');
    this.media = null;
    this.chunks = [];
    this.timer = null;
    this.blob = null;

    this.btn.addEventListener('click', ()=> this.toggle());
  }
  async start(){
    try{
      this.chunks = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
      this.media = new MediaRecorder(stream, { mimeType:'audio/webm' });
      this.media.ondataavailable = e => { if (e.data && e.data.size) this.chunks.push(e.data); };
      this.media.onstop = () => {
        clearTimeout(this.timer);
        try{
          this.blob = new Blob(this.chunks, { type:'audio/webm' });
          this.hint.textContent = `Recorded ${(this.blob.size/1024).toFixed(1)} KB`;
        }catch(e){ setError(e.message||String(e)); }
        this.btn.textContent = 'Record';
      };
      this.media.start();
      this.btn.textContent = 'Stop';
      this.hint.textContent = `Recording… auto-stops at ${(this.maxMs/1000)|0}s`;
      this.timer = setTimeout(()=> this.stop(), this.maxMs);
    }catch(e){
      setError('Mic blocked or unsupported. Allow permission.');
    }
  }
  stop(){
    if (this.media && this.media.state!=='inactive'){
      this.media.stop();
      this.media.stream.getTracks().forEach(t=>t.stop());
    }
  }
  toggle(){
    if (this.media && this.media.state!=='inactive') this.stop();
    else this.start();
  }
}

// init all mini recorders
const minis = [...document.querySelectorAll('.mini')].map(div => new MiniRecorder(div));

// Upload merges all six into one server transcription + `parts` text
btnGen.addEventListener('click', async ()=>{
  try{
    setError('');
    out.textContent = 'Uploading & generating…';

    // pick the biggest blob as the primary audio (so whisper works best)
    const blobs = minis.map(m=>m.blob).filter(Boolean);
    if (!blobs.length) { setError('Please record at least one section.'); out.textContent=''; return; }
    const primary = blobs.sort((a,b)=>b.size-a.size)[0];

    // Concatenate text markers for parsing hints on server
    // (Server will treat this as extra text "parts" merged with the transcription)
    const parts = minis.map(m => m.blob ? `#${m.key}` : '').filter(Boolean).join('\n');

    const fd = new FormData();
    fd.append('audio', primary, 'recording.webm');
    const f = gatherForm();
    Object.entries(f).forEach(([k,v])=> fd.append(k,v));
    fd.append('parts', parts);

    const r = await fetch('/upload', { method:'POST', body: fd });
    const txt = await r.text();
    let json;
    try { json = JSON.parse(txt); } catch { throw new Error(`Upload failed (${r.status}): ${txt}`); }
    if (!json.ok) throw new Error(json.error||'Server error');

    out.innerHTML = `✅ Created. <a class="btn alt" href="${json.url}" target="_blank" rel="noopener">Open report</a>`;
  }catch(e){
    setError(e.message||String(e));
  }
});
