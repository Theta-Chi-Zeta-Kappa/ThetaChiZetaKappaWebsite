(function(){
  'use strict';
  const $=id=>document.getElementById(id);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const actionLabels={
    account_activated:'Account activated',invite_created:'Invitation created',invite_revoked:'Invitation revoked',invite_deleted:'Invitation deleted',account_updated:'Account updated',
    content_draft_created:'Draft created',content_draft_updated:'Draft updated',content_asset_uploaded:'Publication file uploaded',content_submitted:'Publication submitted',content_changes_requested:'Changes requested',content_rejected:'Publication rejected',content_published:'Publication published',content_archived:'Publication archived',content_restored:'Publication restored',content_rejected_deleted:'Rejected publication deleted',content_deleted:'Publication deleted',
    gallery_submission_created:'Gallery submission created',gallery_submitted:'Gallery batch submitted',gallery_changes_requested:'Gallery changes requested',gallery_published:'Gallery batch published',gallery_image_updated:'Gallery image updated',gallery_year_changed:'Gallery year changed',gallery_image_hidden:'Gallery image hidden',gallery_image_restored:'Gallery image restored',gallery_change_requested:'Gallery change requested',gallery_change_approved:'Gallery change approved',gallery_change_returned:'Gallery change returned',gallery_change_rejected:'Gallery change rejected'
  };
  function relativeTime(value){
    if(!value)return'—';
    const d=new Date(value),ms=d.getTime()-Date.now();if(Number.isNaN(d.getTime()))return String(value);
    const abs=Math.abs(ms),rtf=new Intl.RelativeTimeFormat(undefined,{numeric:'auto'});
    if(abs<60_000)return rtf.format(Math.round(ms/1000),'second');
    if(abs<3_600_000)return rtf.format(Math.round(ms/60_000),'minute');
    if(abs<86_400_000)return rtf.format(Math.round(ms/3_600_000),'hour');
    if(abs<604_800_000)return rtf.format(Math.round(ms/86_400_000),'day');
    return d.toLocaleDateString();
  }
  function activitySummary(item){
    const d=item.details||{},title=d.title?`“${d.title}”`:'';
    switch(item.action){
      case'content_draft_created':return`Created ${d.type==='newsletter'?'newsletter':'blog'} draft ${title}`.trim();
      case'content_draft_updated':return`Updated draft ${title}`.trim();
      case'content_asset_uploaded':return`Uploaded ${d.kind||'file'}${d.filename?` · ${d.filename}`:''}`;
      case'content_submitted':return`Submitted ${title} for approval`.trim();
      case'content_changes_requested':return`Returned ${title} for changes`.trim();
      case'content_rejected':return`Rejected ${title}`.trim();
      case'content_published':return`Published ${title}`.trim();
      case'content_archived':return`Archived ${title}`.trim();
      case'content_restored':return`Restored ${title}`.trim();
      case'content_rejected_deleted':return`Deleted rejected ${d.type==='newsletter'?'newsletter':'publication'} ${title}`.trim();
      case'content_deleted':return`Deleted archived newsletter ${title}`.trim();
      case'gallery_submission_created':return`Created gallery batch ${d.sourceBatchId||item.entityId||''}`.trim();
      case'gallery_submitted':return`Submitted gallery batch${d.activeCount!=null?` · ${d.activeCount} active image${Number(d.activeCount)===1?'':'s'}`:''}`;
      case'gallery_changes_requested':return'Gallery batch returned for changes';
      case'gallery_published':return`Published ${d.publishedCount??''} gallery image${Number(d.publishedCount)===1?'':'s'}`.replace('Published  gallery','Published gallery');
      case'gallery_image_updated':return`Updated gallery image ${item.entityId||''}`.trim();
      case'gallery_year_changed':return`Changed gallery year${d.from||d.to?` · ${d.from??'—'} → ${d.to??'—'}`:''}`;
      case'gallery_image_hidden':return`Hid gallery image ${item.entityId||''}`.trim();
      case'gallery_image_restored':return`Restored gallery image ${item.entityId||''}`.trim();
      case'gallery_change_requested':return`Submitted gallery image change ${item.entityId||''}`.trim();
      case'gallery_change_approved':return`Approved gallery image change ${item.entityId||''}`.trim();
      case'gallery_change_returned':return`Returned gallery image change ${item.entityId||''}`.trim();
      case'gallery_change_rejected':return`Rejected gallery image change ${item.entityId||''}`.trim();
      case'invite_created':return`Invited ${d.email||'new user'}${d.role?` as ${d.role}`:''}`;
      case'invite_revoked':return`Revoked invitation for ${d.email||'user'}`;
      case'invite_deleted':return`Deleted ${d.previousStatus||'closed'} invitation for ${d.email||'user'}`;
      case'account_activated':return`Activated account for ${d.email||'user'}`;
      case'account_updated':return`Updated account for ${d.email||'user'}`;
      default:return actionLabels[item.action]||String(item.action||'Activity').replaceAll('_',' ');
    }
  }
  function activityLink(item,user){
    if(item.entityType==='content_post')return'/admin/content/';
    if(item.entityType==='gallery_image')return'/admin/gallery/';
    if(item.entityType==='gallery_approval_batch')return user?.role==='admin'?'/admin/gallery/approvals/':'/admin/gallery/';
    if((item.entityType==='admin_invite'||item.entityType==='admin_user')&&user?.role==='admin')return'/admin/settings/';
    return'';
  }
  async function loadActivity(user){
    const body=$('recentActivityRows');if(!body)return;
    try{
      const res=await TCZKAdminAuth.api('/api/admin/activity?limit=10');
      const rows=res.activity||[];
      if(!rows.length){body.innerHTML='<tr><td colspan="4"><span class="muted">No recent activity has been logged yet.</span></td></tr>';return;}
      body.innerHTML=rows.map(item=>{
        const actor=item.userName||item.userEmail||'System';
        const link=activityLink(item,user);
        const exact=item.createdAt?new Date(item.createdAt).toLocaleString():'—';
        return`<tr><td><strong>${esc(actionLabels[item.action]||String(item.action||'Activity').replaceAll('_',' '))}</strong><br><small>${esc(activitySummary(item))}</small></td><td>${esc(actor)}</td><td><span title="${esc(exact)}">${esc(relativeTime(item.createdAt))}</span></td><td>${link?`<a class="link-action" href="${esc(link)}">View</a>`:'—'}</td></tr>`;
      }).join('');
    }catch(e){body.innerHTML=`<tr><td colspan="4"><span class="muted">Recent activity is unavailable: ${esc(e.message||'Unable to load activity.')}</span></td></tr>`;}
  }
  document.addEventListener('DOMContentLoaded',async()=>{
    const user=TCZKAdminAuth.storedUser();
    loadActivity(user);
    try{const cs=await TCZKAdminAuth.api('/api/content/stats');const st=cs.stats||{};const b=$('dashboardBlogCount');if(b)b.textContent=st.blog??0;const n=$('dashboardNewsletterCount');if(n)n.textContent=st.newsletter??0;}catch{}
    try{const g=await TCZKAdminAuth.api('/api/gallery/manage');const cards=[...document.querySelectorAll('.stat-card')];const galleryCard=cards.find(c=>c.querySelector('b')?.textContent==='Gallery Records');if(galleryCard){galleryCard.querySelector('strong').textContent=g.stats?.total??g.images?.length??'—';galleryCard.querySelector('span').textContent=`${g.stats?.visible??'—'} public · ${g.stats?.hidden??'—'} hidden`;}}catch{}
    if(user?.role==='admin'){try{const cp=await TCZKAdminAuth.api('/api/content/posts?status=submitted');const n=(cp.posts||[]).length;const ce=$('pendingContentApprovalCount');if(ce)ce.textContent=n;const cl=$('pendingContentApprovalLabel');if(cl)cl.textContent=n?`${n} awaiting review`:'Nothing awaiting review';}catch{const ce=$('pendingContentApprovalCount');if(ce)ce.textContent='—';}}
    const el=$('pendingApprovalCount');if(!el||user?.role!=='admin')return;
    try{const[a,c]=await Promise.all([TCZKAdminAuth.api('/api/gallery/approvals'),TCZKAdminAuth.api('/api/gallery/manage/change-requests')]);const n=(a.batches||[]).filter(b=>b.status==='submitted').length;el.textContent=n;const l=$('pendingApprovalLabel');if(l){const changes=(c.requests||[]).length;l.textContent=changes?`${n} batch approval${n===1?'':'s'} · ${changes} image change${changes===1?'':'s'}`:(n?`${n} awaiting review`:'Nothing awaiting review');}}catch{el.textContent='—';}
  });
})();
