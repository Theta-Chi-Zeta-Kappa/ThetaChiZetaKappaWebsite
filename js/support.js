(()=>{fetch('https://tczk-admin-api.jackkinn13.workers.dev/api/public/family-tree',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject()).then(data=>{const n=(data.members||[]).filter(m=>String(m.memberType??m.member_type??'').trim().toLowerCase()==='lost_to_time').length;document.getElementById('lttCount').textContent=n;document.getElementById('lttLabel').textContent=n===1?'Brother Lost to Time currently needs our help':'Brothers Lost to Time currently need our help';}).catch(()=>document.getElementById('lttCount').textContent='Several');const CHAPTER_DONATION_URL='https://square.link/u/xjEyYG56';const b=document.getElementById('chapterDonate');if(CHAPTER_DONATION_URL){b.href=CHAPTER_DONATION_URL;b.removeAttribute('aria-disabled');b.textContent='Donate to the Chapter';}})();
document.addEventListener('DOMContentLoaded',()=>{
 const modal=document.getElementById('historySubmissionModal'),open=document.getElementById('openHistorySubmission'),
 form=document.getElementById('historySubmissionForm'),files=document.getElementById('historyFiles'),
 list=document.getElementById('historyFileList'),status=document.getElementById('historySubmissionStatus');
 if(!modal||!open)return;
 const show=()=>{modal.classList.add('open');modal.setAttribute('aria-hidden','false');document.body.style.overflow='hidden';};
 const hide=()=>{modal.classList.remove('open');modal.setAttribute('aria-hidden','true');document.body.style.overflow='';};
 open.addEventListener('click',show);modal.querySelectorAll('[data-history-close]').forEach(x=>x.addEventListener('click',hide));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('open'))hide();});
 files?.addEventListener('change',()=>{
   const chosen=[...(files.files||[])],bytes=chosen.reduce((n,f)=>n+f.size,0);
   list.textContent=chosen.length?`${chosen.length} file${chosen.length===1?'':'s'} selected · ${(bytes/1024/1024).toFixed(1)} MB total`:'';
   status.textContent=bytes>100*1024*1024?'The selected files exceed the 100 MB submission limit.':'';
   status.className='history-submission-status'+(bytes>100*1024*1024?' error':'');
 });
 form?.addEventListener('submit',async e=>{
   e.preventDefault();
   const chosen=[...(files.files||[])],bytes=chosen.reduce((n,f)=>n+f.size,0);
   if(bytes>100*1024*1024){status.textContent='Please reduce the files to 100 MB or less before submitting.';status.className='history-submission-status error';return;}
   const submit=form.querySelector('[type="submit"]'); submit.disabled=true;
   status.textContent='Uploading your historical submission…';status.className='history-submission-status pending';
   try{
     const data=new FormData(form);
     const response=await fetch('https://tczk-admin-api.jackkinn13.workers.dev/api/public/chapter-history',{method:'POST',body:data});
     const result=await response.json().catch(()=>({}));
     if(!response.ok||!result.ok)throw new Error(result.error||'The submission could not be received.');
     status.textContent=`Thank you. Your chapter-history submission ${result.submissionId} was received${result.confirmationSent?' and a confirmation email was sent.':'.'}`;
     status.className='history-submission-status';
     form.reset();list.textContent='';
   }catch(err){status.textContent=err.message||'The submission could not be received. Please try again.';status.className='history-submission-status error';}
   finally{submit.disabled=false;}
 });
});
