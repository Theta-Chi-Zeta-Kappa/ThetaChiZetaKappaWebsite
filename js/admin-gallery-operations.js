(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const input=$('stagingFiles'), drop=$('uploadDropzone'), feedback=$('selectedFiles');
  const progress=$('uploadProgress'), percent=$('uploadPercentage'), message=$('uploadMessage');
  const summarize=()=>{
    const files=[...(input?.files||[])];
    if(feedback) feedback.textContent=files.length?(files.length===1?files[0].name:files.length+' photos selected'):'No photos selected';
  };
  input?.addEventListener('change',summarize);
  if(drop && input){
    const highlight=e=>{e.preventDefault();drop.classList.add('drag-active');};
    ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,highlight));
    ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,e=>{e.preventDefault();drop.classList.remove('drag-active');}));
    drop.addEventListener('drop',e=>{
      if(!e.dataTransfer?.files?.length)return;
      try{
        const transfer=new DataTransfer();
        for(const file of [...e.dataTransfer.files])transfer.items.add(file);
        input.files=transfer.files;summarize();
      }catch{feedback.textContent='Drag-and-drop is unavailable in this browser. Please use Choose Files.';}
    });
    drop.addEventListener('keydown',e=>{if((e.key==='Enter'||e.key===' ')&&e.target===drop){e.preventDefault();input.click();}});
  }
  const observer=typeof MutationObserver==='function'&&progress?new MutationObserver(()=>{
    if(percent)percent.textContent=Math.round(Number(progress.value)||0)+'%';
  }):null;
  observer?.observe(progress,{attributes:true,attributeFilter:['value']});
  const form=$('stagingUpload');
  form?.addEventListener('submit',()=>{
    if(progress){progress.value=0;percent.textContent='0%';}
  });
  // The existing uploader calls form.reset() on success; reflect that in its file-selection label.
  form?.addEventListener('reset',()=>setTimeout(summarize,0));
  const requests=$('operationsRequestsTitle'),requestMsg=$('operationsRequestsMessage');
  const user=window.TCZKAdminAuth?.storedUser?.();
  if(requests && user?.role==='admin' && Number(user.priority)<=2){
    window.TCZKAdminAuth.api('/api/gallery-v19/manage/requests')
      .then(d=>{
        const total=(d.requests||[]).filter(x=>x.status==='submitted').length;
        requests.textContent=total?total+' pending change request'+(total===1?'':'s'):'No Pending Change Requests';
        requestMsg.textContent=total?'Open the review queue to evaluate submitted changes.':'There are currently no requests awaiting administrator review.';
      })
      .catch(()=>{requests.textContent='Change Requests';requestMsg.textContent='Open the review queue to check current requests.';});
  }
})();
