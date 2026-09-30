(function(){
  'use strict';

  const API_BASE=String(window.TCZK_ADMIN_API||'').replace(/\/$/,'');

  const menuBtn=document.querySelector('[data-admin-menu]');
  const sidebar=document.getElementById('adminSidebar');
  if(menuBtn&&sidebar){menuBtn.addEventListener('click',()=>sidebar.classList.toggle('open'));}

  const apiStatus=document.getElementById('apiStatus');
  initApiStatus();

  const input=document.getElementById('galleryBatchInput');
  if(!input) return;

  const choose=document.getElementById('chooseBatch');
  const zone=document.getElementById('galleryDropzone');
  const summary=document.getElementById('fileSummary');
  const workspace=document.getElementById('reviewWorkspace');
  const grid=document.getElementById('reviewImageGrid');
  const batchTitle=document.getElementById('batchTitle');
  const batchSummaryText=document.getElementById('batchSummaryText');
  const selectAll=document.getElementById('selectAllImages');
  const selectionCount=document.getElementById('selectionCount');
  const bulkYear=document.getElementById('bulkYear');
  const applyBulkYear=document.getElementById('applyBulkYear');
  const visibleImageCount=document.getElementById('visibleImageCount');
  const emptyFilterState=document.getElementById('emptyFilterState');
  const editorEmpty=document.getElementById('editorEmpty');
  const editorBody=document.getElementById('editorBody');
  const editorPreview=document.getElementById('editorPreview');
  const editorStatus=document.getElementById('editorStatus');
  const editorOriginalName=document.getElementById('editorOriginalName');
  const editorWebFile=document.getElementById('editorWebFile');
  const editorDimensions=document.getElementById('editorDimensions');
  const editorYear=document.getElementById('editorYear');
  const editorDecade=document.getElementById('editorDecade');
  const rotationBadge=document.getElementById('rotationBadge');
  const rotateLeft=document.getElementById('rotateLeft');
  const rotateRight=document.getElementById('rotateRight');
  const toggleRemoveImage=document.getElementById('toggleRemoveImage');
  const replaceBatch=document.getElementById('replaceBatch');
  const discardBatch=document.getElementById('discardBatch');
  const publishChecks=document.getElementById('publishChecks');
  const publishCount=document.getElementById('publishCount');
  const publishBatch=document.getElementById('publishBatch');
  const publishModal=document.getElementById('publishModal');
  const publishModalCopy=document.getElementById('publishModalCopy');
  const publishModalSummary=document.getElementById('publishModalSummary');
  const cancelPublish=document.getElementById('cancelPublish');
  const confirmPublish=document.getElementById('confirmPublish');
  const uploadProgress=document.getElementById('uploadProgress');

  let batch=null;
  let selectedId=null;
  let currentFilter='all';
  let objectUrls=[];
  let apiOnline=false;

  if(choose){choose.addEventListener('click',()=>input.click());}
  input.addEventListener('change',()=>handleBatchFile(input.files[0]));

  if(zone){
    ['dragenter','dragover'].forEach(evt=>zone.addEventListener(evt,e=>{e.preventDefault();zone.classList.add('drag');}));
    ['dragleave','drop'].forEach(evt=>zone.addEventListener(evt,e=>{e.preventDefault();zone.classList.remove('drag');}));
    zone.addEventListener('drop',e=>handleBatchFile(e.dataTransfer.files[0]));
  }

  if(replaceBatch) replaceBatch.addEventListener('click',()=>input.click());
  if(discardBatch) discardBatch.addEventListener('click',resetBatch);

  document.querySelectorAll('[data-review-filter]').forEach(btn=>btn.addEventListener('click',()=>{
    currentFilter=btn.dataset.reviewFilter;
    document.querySelectorAll('[data-review-filter]').forEach(x=>x.classList.toggle('active',x===btn));
    renderGrid();
  }));

  if(selectAll) selectAll.addEventListener('change',()=>{
    if(!batch)return;
    getFilteredImages().forEach(img=>img.selected=selectAll.checked);
    renderGrid();
    updateSelectionUI();
  });

  if(applyBulkYear) applyBulkYear.addEventListener('click',()=>{
    if(!batch)return;
    const year=parseYear(bulkYear.value);
    if(!year){
      bulkYear.focus();
      bulkYear.setCustomValidity('Enter a year from 1900 through 2099.');
      bulkYear.reportValidity();
      return;
    }
    bulkYear.setCustomValidity('');
    const selected=batch.images.filter(i=>i.selected&&!i.removed);
    const chosen=selected.length?selected:batch.images.filter(i=>!i.removed);
    chosen.forEach(img=>{img.year=year;img.decade=yearToDecade(year);});
    renderGrid();
    renderEditor();
    updateSelectionUI();
    updatePublishState();
    showBatchEditNotice(`${year} applied to ${chosen.length} ${selected.length?'selected image':'image'}${chosen.length===1?'':'s'}${selected.length?'':' in the active batch'}.`);
  });

  if(editorYear) editorYear.addEventListener('input',()=>{
    const img=getSelected(); if(!img)return;
    const year=parseYear(editorYear.value);
    img.year=year;
    img.decade=year?yearToDecade(year):'';
    editorDecade.textContent=img.decade||'—';
    renderGrid();
    updatePublishState();
  });

  if(rotateLeft) rotateLeft.addEventListener('click',()=>rotateSelected(-90));
  if(rotateRight) rotateRight.addEventListener('click',()=>rotateSelected(90));
  if(toggleRemoveImage) toggleRemoveImage.addEventListener('click',()=>{
    const img=getSelected();if(!img)return;
    img.removed=!img.removed;
    if(img.removed) img.selected=false;
    renderGrid();renderEditor();updateSelectionUI();updatePublishState();
  });

  if(publishBatch) publishBatch.addEventListener('click',()=>{
    if(!batch||publishBatch.disabled)return;
    const ready=batch.images.filter(i=>!i.removed);
    publishModalCopy.textContent=`${ready.length} reviewed image${ready.length===1?' is':'s are'} ready for the final publishing step.`;
    publishModalSummary.innerHTML=`<div><b>Batch:</b> ${escapeHtml(batch.batchId)}</div><div><b>Images:</b> ${ready.length}</div><div><b>Removed:</b> ${batch.images.filter(i=>i.removed).length}</div><div><b>Destination:</b> existing R2 display/ + thumbs/ folders</div>`;
    publishModal.hidden=false;
  });
  if(cancelPublish) cancelPublish.addEventListener('click',()=>publishModal.hidden=true);
  if(publishModal) publishModal.addEventListener('click',e=>{if(e.target===publishModal)publishModal.hidden=true;});
  if(confirmPublish) confirmPublish.addEventListener('click',async()=>{
    if(!batch)return;
    confirmPublish.disabled=true;
    if(cancelPublish)cancelPublish.disabled=true;
    if(uploadProgress){uploadProgress.className='upload-progress';uploadProgress.textContent='Preparing secure staging upload…';}
    try{
      await submitForApproval();
      publishModal.hidden=true;
      showSummary(`<b>${escapeHtml(batch.fileName)}</b><br>Submitted successfully for administrator approval. The live gallery has not changed yet.`, 'success');
      resetBatch();
      window.scrollTo({top:0,behavior:'smooth'});
    }catch(err){
      console.error(err);
      if(uploadProgress){uploadProgress.className='upload-progress error';uploadProgress.textContent=err.message||'Submission failed.';}
    }finally{
      confirmPublish.disabled=false;
      if(cancelPublish)cancelPublish.disabled=false;
    }
  });

  async function handleBatchFile(file){
    if(!file)return;
    if(!/\.zip$/i.test(file.name)){showSummary(`<b>${escapeHtml(file.name)}</b><br>That is not a ZIP file. Choose the gallery-batch.zip produced by the processor.`, 'error');return;}
    showSummary(`<b>${escapeHtml(file.name)}</b><br>${formatBytes(file.size)} · Opening Gallery v3 batch…`, 'loading');
    try{
      clearObjectUrls();
      const parsed=await parseGalleryZip(file);
      batch=parsed;
      selectedId=batch.images[0]?.id||null;
      workspace.hidden=false;
      showSummary(`<b>${escapeHtml(file.name)}</b><br>${formatBytes(file.size)} · ${batch.images.length} paired WebP image${batch.images.length===1?'':'s'} validated locally. Checking D1 for duplicates…`, 'loading');
      batchTitle.textContent=`Batch ${batch.batchId}`;
      renderGrid();renderEditor();updateSelectionUI();updatePublishState();
      await checkBatchDuplicates();
      workspace.scrollIntoView({behavior:'smooth',block:'start'});
    }catch(err){
      console.error(err);
      showSummary(`<b>${escapeHtml(file.name)}</b><br>${escapeHtml(err.message||'Unable to read this gallery batch.')}`, 'error');
    }
  }

  async function parseGalleryZip(file){
    const buffer=await file.arrayBuffer();
    const entries=parseCentralDirectory(buffer);
    const byName=new Map(entries.map(e=>[e.name,e]));
    const manifestEntry=byName.get('manifest.json');
    if(!manifestEntry) throw new Error('manifest.json is missing from the root of the ZIP.');
    const manifestText=await entryText(buffer,manifestEntry);
    let manifest;
    try{manifest=JSON.parse(manifestText);}catch(e){throw new Error('manifest.json is not valid JSON.');}
    if(manifest.manifestVersion!==1||!Array.isArray(manifest.images)) throw new Error('This is not a supported Gallery v3 manifest.');
    if(String(manifest.imageFormat||'').toLowerCase()!=='webp') throw new Error('The batch manifest does not specify WebP output.');

    const images=[];
    for(const record of manifest.images){
      if(!record.webFile||!/\.webp$/i.test(record.webFile)) throw new Error('A manifest image is missing a valid WebP filename.');
      const displayEntry=byName.get(`display/${record.webFile}`);
      const thumbEntry=byName.get(`thumbs/${record.webFile}`);
      if(!displayEntry) throw new Error(`Missing display/${record.webFile}`);
      if(!thumbEntry) throw new Error(`Missing thumbs/${record.webFile}`);
      const thumbBytes=await entryBytes(buffer,thumbEntry);
      const thumbUrl=URL.createObjectURL(new Blob([thumbBytes],{type:'image/webp'}));
      objectUrls.push(thumbUrl);
      const year=parseYear(record.year);
      images.push({
        id:String(record.id||record.digest||record.webFile),
        digest:String(record.digest||''),
        originalName:String(record.originalName||record.webFile),
        webFile:String(record.webFile),
        width:Number(record.width)||0,
        height:Number(record.height)||0,
        year:year,
        decade:year?yearToDecade(year):String(record.decade||''),
        rotation:normalizeRotation(Number(record.rotation)||0),
        removed:false,
        selected:false,
        duplicate:false,
        duplicateRecord:null,
        thumbUrl,
        displayEntry,
        thumbEntry
      });
    }
    if(!images.length) throw new Error('The manifest contains no images.');
    return {batchId:String(manifest.batchId||file.name.replace(/\.zip$/i,'')),generatedAt:manifest.generatedAt||'',processor:manifest.processor||'',images,fileName:file.name,fileSize:file.size,buffer};
  }

  function parseCentralDirectory(buffer){
    const dv=new DataView(buffer);const bytes=new Uint8Array(buffer);let eocd=-1;
    for(let i=Math.max(0,buffer.byteLength-65557);i<=buffer.byteLength-22;i++){
      if(dv.getUint32(i,true)===0x06054b50)eocd=i;
    }
    if(eocd<0) throw new Error('The ZIP central directory could not be found.');
    const total=dv.getUint16(eocd+10,true);let pos=dv.getUint32(eocd+16,true);const out=[];
    for(let n=0;n<total;n++){
      if(dv.getUint32(pos,true)!==0x02014b50) throw new Error('The ZIP directory is malformed.');
      const method=dv.getUint16(pos+10,true);const compressedSize=dv.getUint32(pos+20,true);const uncompressedSize=dv.getUint32(pos+24,true);const nameLen=dv.getUint16(pos+28,true);const extraLen=dv.getUint16(pos+30,true);const commentLen=dv.getUint16(pos+32,true);const localOffset=dv.getUint32(pos+42,true);
      const name=new TextDecoder().decode(bytes.slice(pos+46,pos+46+nameLen));
      out.push({name,method,compressedSize,uncompressedSize,localOffset});
      pos+=46+nameLen+extraLen+commentLen;
    }
    return out;
  }

  async function entryBytes(buffer,entry){
    const dv=new DataView(buffer);const bytes=new Uint8Array(buffer);const p=entry.localOffset;
    if(dv.getUint32(p,true)!==0x04034b50) throw new Error(`Invalid ZIP entry: ${entry.name}`);
    const nameLen=dv.getUint16(p+26,true);const extraLen=dv.getUint16(p+28,true);const start=p+30+nameLen+extraLen;const compressed=bytes.slice(start,start+entry.compressedSize);
    if(entry.method===0)return compressed;
    if(entry.method!==8)throw new Error(`Unsupported ZIP compression for ${entry.name}.`);
    if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot open compressed gallery ZIPs locally. Use a current Chrome, Edge, Firefox, or Safari browser.');
    let stream;
    try{stream=new DecompressionStream('deflate-raw');}catch(e){throw new Error('This browser cannot decode ZIP files locally.');}
    const response=new Response(new Blob([compressed]).stream().pipeThrough(stream));
    return new Uint8Array(await response.arrayBuffer());
  }
  async function entryText(buffer,entry){return new TextDecoder('utf-8').decode(await entryBytes(buffer,entry));}

  function renderGrid(){
    if(!batch)return;
    const images=getFilteredImages();
    grid.innerHTML='';
    for(const img of images){
      const card=document.createElement('article');
      card.className='review-image-card'+(img.id===selectedId?' active':'')+(img.removed?' removed':'')+(img.duplicate?' duplicate':'');
      card.dataset.id=img.id;
      const flags=[];
      if(img.removed)flags.push('<span class="thumb-flag removed">Removed</span>');
      else if(img.duplicate)flags.push('<span class="thumb-flag duplicate">Duplicate</span>');
      else if(!img.year)flags.push('<span class="thumb-flag warn">Needs year</span>');
      if(img.rotation)flags.push(`<span class="thumb-flag">${img.rotation}°</span>`);
      card.innerHTML=`<input class="review-card-select" type="checkbox" ${img.selected?'checked':''} ${img.removed?'disabled':''} aria-label="Select ${escapeHtml(img.originalName)}"><div class="review-thumb-wrap"><img class="review-thumb" src="${img.thumbUrl}" alt="${escapeHtml(img.originalName)}" style="transform:rotate(${img.rotation}deg)"><div class="review-thumb-flags">${flags.join('')}</div></div><div class="review-card-meta"><strong title="${escapeHtml(img.originalName)}">${escapeHtml(img.originalName)}</strong><span>${img.year||'Year not set'}${img.decade?' · '+escapeHtml(img.decade):''}</span></div>`;
      card.addEventListener('click',e=>{
        if(e.target.classList.contains('review-card-select'))return;
        selectedId=img.id;renderGrid();renderEditor();
      });
      const checkbox=card.querySelector('.review-card-select');
      checkbox.addEventListener('change',()=>{img.selected=checkbox.checked;updateSelectionUI();});
      grid.appendChild(card);
    }
    visibleImageCount.textContent=`${images.length} image${images.length===1?'':'s'}`;
    emptyFilterState.hidden=images.length!==0;
    updateSelectionUI(false);
  }

  function renderEditor(){
    const img=getSelected();
    if(!img){editorEmpty.hidden=false;editorBody.hidden=true;editorStatus.textContent='Select an image';editorStatus.className='status-pill';return;}
    editorEmpty.hidden=true;editorBody.hidden=false;
    editorPreview.src=img.thumbUrl;editorPreview.style.transform=`rotate(${img.rotation}deg)`;
    rotationBadge.textContent=`${img.rotation}°`;
    editorOriginalName.textContent=img.originalName;
    editorOriginalName.title=img.originalName;
    editorWebFile.textContent=img.webFile;
    editorWebFile.title=img.webFile;
    editorDimensions.textContent=img.width&&img.height?`${img.width} × ${img.height}`:'—';
    editorYear.value=img.year||'';
    editorDecade.textContent=img.decade||'—';
    if(img.removed){editorStatus.textContent='Removed';editorStatus.className='status-pill removed';toggleRemoveImage.textContent='Restore To Batch';}
    else if(img.duplicate){editorStatus.textContent='Duplicate';editorStatus.className='status-pill duplicate';toggleRemoveImage.textContent='Remove From Batch';}
    else if(!img.year){editorStatus.textContent='Needs year';editorStatus.className='status-pill warning';toggleRemoveImage.textContent='Remove From Batch';}
    else{editorStatus.textContent='Ready';editorStatus.className='status-pill ready';toggleRemoveImage.textContent='Remove From Batch';}
  }

  function rotateSelected(delta){
    const img=getSelected();if(!img||img.removed)return;
    img.rotation=normalizeRotation(img.rotation+delta);
    renderGrid();renderEditor();
  }

  function updateSelectionUI(syncSelectAll=true){
    if(!batch)return;
    const selected=batch.images.filter(i=>i.selected&&!i.removed).length;
    selectionCount.textContent=`${selected} selected`;
    if(syncSelectAll){
      const filtered=getFilteredImages().filter(i=>!i.removed);
      selectAll.checked=filtered.length>0&&filtered.every(i=>i.selected);
      selectAll.indeterminate=filtered.some(i=>i.selected)&&!filtered.every(i=>i.selected);
    }
  }

  function updatePublishState(){
    if(!batch)return;
    const active=batch.images.filter(i=>!i.removed);
    const duplicates=active.filter(i=>i.duplicate).length;
    const publishable=active.filter(i=>!i.duplicate);
    const missingYear=publishable.filter(i=>!i.year).length;
    const paired=active.length;
    const removed=batch.images.length-active.length;
    const checks=[
      {ok:paired>0,text:`${paired} image pair${paired===1?'':'s'} present in display/ and thumbs/`},
      {ok:duplicates===0,text:duplicates?`${duplicates} duplicate image${duplicates===1?' is':'s are'} still active`:'No active images duplicate the existing gallery'},
      {ok:missingYear===0,text:missingYear?`${missingYear} image${missingYear===1?' still needs':'s still need'} a year`:'Every publishable image has a year'},
      {ok:true,text:`${removed} image${removed===1?'':'s'} removed from this batch`},
      {ok:true,text:'Existing legacy gallery images remain unchanged'}
    ];
    publishChecks.innerHTML=checks.map(c=>`<div class="publish-check${c.ok?'':' bad'}"><span class="dot"></span><span>${escapeHtml(c.text)}</span></div>`).join('');
    publishCount.textContent=publishable.length;
    publishBatch.disabled=!(publishable.length&&missingYear===0&&duplicates===0&&apiOnline);
    batchSummaryText.textContent=`${publishable.length} ready · ${duplicates} duplicate · ${missingYear} need year · ${removed} removed`;
  }


  async function submitForApproval(){
    const active=batch.images.filter(i=>!i.removed);
    const payload={
      sourceBatchId:batch.batchId,
      processorVersion:batch.processor||'Gallery v3',
      sourceFileName:batch.fileName,
      images:batch.images.map((i,index)=>({
        sourceId:i.id,digest:i.digest,originalName:i.originalName,webFile:i.webFile,
        width:i.width,height:i.height,rotation:i.rotation,year:i.year||null,
        decade:i.decade||'',alt:String(i.originalName||i.webFile).replace(/\.[^.]+$/,''),
        removed:Boolean(i.removed),sortOrder:index
      }))
    };
    if(uploadProgress)uploadProgress.textContent='Creating approval record…';
    const created=await TCZKAdminAuth.api('/api/gallery/workflow/create',{method:'POST',body:JSON.stringify(payload)});
    const workflowId=created.batch.id;
    let complete=0,total=active.length*2;
    try{
      for(const img of active){
        for(const [variant,entry] of [['display',img.displayEntry],['thumb',img.thumbEntry]]){
          const bytes=await entryBytes(batch.buffer,entry);
          if(uploadProgress)uploadProgress.textContent=`Uploading ${++complete} of ${total}: ${img.webFile} (${variant})…`;
          await TCZKAdminAuth.api(`/api/gallery/workflow/upload?batchId=${encodeURIComponent(workflowId)}&imageId=${encodeURIComponent(img.id)}&variant=${variant}`,{
            method:'POST',headers:{'Content-Type':'image/webp'},body:bytes
          });
        }
      }
      if(uploadProgress)uploadProgress.textContent='Verifying staged files and submitting for approval…';
      const submitted=await TCZKAdminAuth.api('/api/gallery/workflow/submit',{method:'POST',body:JSON.stringify({batchId:workflowId})});
      if(uploadProgress){uploadProgress.className='upload-progress success';uploadProgress.textContent='Submission complete.';}
      return submitted;
    }catch(err){
      try{await TCZKAdminAuth.api('/api/gallery/workflow/cancel',{method:'POST',body:JSON.stringify({batchId:workflowId})});}catch(_e){}
      throw err;
    }
  }

  async function initApiStatus(){
    if(!apiStatus)return;
    if(!API_BASE||API_BASE.includes('YOUR-SUBDOMAIN')){
      setApiStatus('offline','API not configured');
      return;
    }
    setApiStatus('checking','API checking');
    try{
      const response=await fetch(`${API_BASE}/api/health`,{headers:{'Accept':'application/json'}});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json();
      if(!data.ok||!data.d1?.connected||!data.r2?.connected)throw new Error('Health check failed');
      apiOnline=true;
      setApiStatus('online',`API online · ${data.d1.galleryImages} images`);
    }catch(err){
      console.error('Admin API health check failed',err);
      apiOnline=false;
      setApiStatus('offline','API offline');
    }
    updatePublishState();
  }

  function setApiStatus(state,text){
    if(!apiStatus)return;
    apiStatus.className=`api-status api-status-${state}`;
    apiStatus.innerHTML=`<span class="api-dot"></span> ${escapeHtml(text)}`;
  }

  async function checkBatchDuplicates(){
    if(!batch)return;
    batch.images.forEach(img=>{img.duplicate=false;img.duplicateRecord=null;});
    if(!API_BASE||API_BASE.includes('YOUR-SUBDOMAIN')){
      showSummary(`<b>${escapeHtml(batch.fileName)}</b><br>${batch.images.length} images validated locally. Add your Worker URL in <b>/js/admin-config.js</b> to enable duplicate checking.`, 'error');
      renderGrid();renderEditor();updatePublishState();
      return;
    }
    if(!apiOnline){
      await initApiStatus();
    }
    if(!apiOnline){
      showSummary(`<b>${escapeHtml(batch.fileName)}</b><br>Local validation succeeded, but the admin API is offline. Duplicate checking could not be completed.`, 'error');
      renderGrid();renderEditor();updatePublishState();
      return;
    }
    try{
      if(!window.TCZKAdminAuth)throw new Error('Authentication helper is unavailable.');
      const data=await window.TCZKAdminAuth.api('/api/gallery/check-duplicates',{
        method:'POST',
        body:JSON.stringify({digests:batch.images.map(img=>img.digest).filter(Boolean)})
      });
      const duplicateMap=new Map((data.duplicates||[]).map(row=>[String(row.digest||'').toLowerCase(),row]));
      batch.images.forEach(img=>{
        const row=duplicateMap.get(String(img.digest||'').toLowerCase());
        img.duplicate=!!row;
        img.duplicateRecord=row||null;
      });
      const duplicateCount=batch.images.filter(img=>img.duplicate).length;
      showSummary(`<b>${escapeHtml(batch.fileName)}</b><br>${batch.images.length} images validated · ${duplicateCount} duplicate${duplicateCount===1?'':'s'} found in D1 · ${batch.images.length-duplicateCount} new.`, duplicateCount?'loading':'success');
      renderGrid();renderEditor();updateSelectionUI();updatePublishState();
    }catch(err){
      console.error('Duplicate check failed',err);
      showSummary(`<b>${escapeHtml(batch.fileName)}</b><br>Local validation succeeded, but duplicate checking failed: ${escapeHtml(err.message||'Unknown error')}`, 'error');
      renderGrid();renderEditor();updatePublishState();
    }
  }

  function getFilteredImages(){
    if(!batch)return[];
    if(currentFilter==='needs-year')return batch.images.filter(i=>!i.removed&&!i.year);
    if(currentFilter==='duplicates')return batch.images.filter(i=>i.duplicate&&!i.removed);
    if(currentFilter==='removed')return batch.images.filter(i=>i.removed);
    return batch.images;
  }
  function getSelected(){return batch?.images.find(i=>i.id===selectedId)||null;}

  function showBatchEditNotice(message){
    if(!summary)return;
    showSummary(`<b>Batch updated</b><br>${escapeHtml(message)}`, 'success');
  }

  function resetBatch(){
    clearObjectUrls();batch=null;selectedId=null;currentFilter='all';workspace.hidden=true;grid.innerHTML='';input.value='';summary.style.display='none';summary.className='file-summary';
    document.querySelectorAll('[data-review-filter]').forEach(x=>x.classList.toggle('active',x.dataset.reviewFilter==='all'));
  }
  function clearObjectUrls(){for(const u of objectUrls)URL.revokeObjectURL(u);objectUrls=[];}
  function showSummary(html,state){summary.style.display='block';summary.className=`file-summary ${state||''}`;summary.innerHTML=html;}
  function parseYear(value){const n=Number(value);return Number.isInteger(n)&&n>=1900&&n<=2099?n:null;}
  function yearToDecade(year){return `${Math.floor(year/10)*10}s`;}
  function normalizeRotation(n){return((n%360)+360)%360;}
  function formatBytes(n){if(!Number.isFinite(n))return'';if(n<1024)return n+' B';if(n<1048576)return(n/1024).toFixed(1)+' KB';return(n/1048576).toFixed(1)+' MB';}
  function escapeHtml(s){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
})();
