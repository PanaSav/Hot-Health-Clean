// backend/public/app.js
const $=sel=>document.querySelector(sel);

function setError(msg){$('#error').textContent=msg||'';}
function setResult(msg){$('#result').innerHTML=msg||'';}

// Mini recorders
(()=>{
  const supports=!!(window.MediaRecorder&&navigator.mediaDevices?.getUserMedia);
  const recBtns=document.querySelectorAll('.rec-btn');
  if(!supports){recBtns.forEach(b=>{b.disabled=true;b.title='Not supported';});return;}
  recBtns.forEach(btn=>{
    let mr=null,chunks=[],timer=null;
    btn.addEventListener('click',async()=>{
      if(btn.dataset.state==='rec'){try{mr.stop();}catch{};return;}
      const target=btn.dataset.target;const field=document.getElementById(target);
      const maxMs=Number(btn.dataset.max||30000);
      btn.dataset.state='rec';btn.textContent='⏺️ Stop';
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      mr=new MediaRecorder(stream,{mimeType:'audio/webm'});
      chunks=[];
      mr.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data);};
      mr.onstop=()=>{
        stream.getTracks().forEach(t=>t.stop());clearTimeout(timer);
        btn.dataset.state='';btn.textContent='🎤';
        const blob=new Blob(chunks,{type:'audio/webm'});
        const kb=(blob.size/1024).toFixed(1);
        field.value=(field.value+' [Recorded '+kb+' KB]').trim();
      };
      mr.start();timer=setTimeout(()=>{try{mr.stop();}catch{}},maxMs);
    });
  });
})();

// Generate report
$('#btnGenerate').addEventListener('click',async()=>{
  setError('');setResult('');
  const fd=new FormData();
  fd.append('name',$('#pName').value);
  fd.append('email',$('#pEmail').value);
  fd.append('blood_type',$('#blood').value);
  fd.append('emer_name',$('#eName').value);
  fd.append('emer_phone',$('#ePhone').value);
  fd.append('emer_email',$('#eEmail').value);
  fd.append('lang',$('#lang').value);
  fd.append('bp_text',$('#bpText').value);
  fd.append('meds_text',$('#medsText').value);
  fd.append('allergies_text',$('#allText').value);
  fd.append('weight_text',$('#wtText').value);
  fd.append('conditions_text',$('#condText').value);
  fd.append('general_text',$('#genText').value);
  try{
    const r=await fetch('/upload',{method:'POST',body:fd});
    if(!r.ok) throw new Error('Upload failed '+r.status);
    const j=await r.json();
    if(j.ok)setResult(`✅ Created. <a href="${j.url}" target="_blank">Open report</a>`);
    else throw new Error(j.error);
  }catch(e){setError(e.message);}
});
