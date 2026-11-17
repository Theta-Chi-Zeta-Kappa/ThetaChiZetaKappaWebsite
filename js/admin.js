(function(){
  'use strict';

  const API_BASE=String(window.TCZK_ADMIN_API||'').replace(/\/$/,'');

  const menuBtn=document.querySelector('[data-admin-menu]');
  const sidebar=document.getElementById('adminSidebar');
  if(menuBtn&&sidebar){menuBtn.addEventListener('click',()=>sidebar.classList.toggle('open'));}

  const apiStatus=document.getElementById('apiStatus');
  function initApiStatus(){
    if(!apiStatus)return;
    const base=String(window.TCZK_ADMIN_API||'').replace(/\/$/,'');
    if(!base){apiStatus.textContent='API not configured';return;}
    fetch(base+'/api/health',{cache:'no-store'}).then(r=>{apiStatus.textContent=r.ok?'Admin API online':'Admin API unavailable';}).catch(()=>{apiStatus.textContent='Admin API unavailable';});
  }
  initApiStatus();

  // Shared admin navigation: render one canonical sidebar on every protected page.
  // Keep the primary navigation independently scrollable while Site Tools and Log Out stay pinned.
  const adminNav=document.querySelector('.admin-nav');
  const logoutBox=document.querySelector('.admin-logout');
  if(adminNav){
    const currentPath=location.pathname.replace(/\/+$/,'/') || '/';
    const items=[
      {type:'link',href:'/admin/dashboard/',icon:'▣',label:'Dashboard'},
      {type:'section',label:'Content'},
      {type:'link',href:'/admin/content/',icon:'▤',label:'Blog & Newsletter'},
      {type:'link',href:'/admin/content/approvals/',icon:'✓',label:'Content Approvals',adminOnly:true},
      {type:'section',label:'Gallery'},
      {type:'link',href:'/admin/gallery/',icon:'▧',label:'Gallery Manager'},
      {type:'link',href:'/admin/gallery/staging-upload/',icon:'⇧',label:'Upload Photos'},
      {type:'link',href:'/admin/gallery/staging-approvals/',icon:'✓',label:'Photo Approvals',adminOnly:true},
      {type:'link',href:'/admin/gallery/events/',icon:'▦',label:'Guest Events',adminOnly:true},
      {type:'link',href:'/admin/gallery/changes/',icon:'↺',label:'Change Requests',adminOnly:true},
      {type:'section',label:'Chapter Records'},
      {type:'link',href:'/admin/family-tree/',icon:'♧',label:'Family Tree'},
      {type:'link',href:'/admin/history/',icon:'▦',label:'Historical Submissions',adminOnly:true},
      {type:'link',href:'/admin/forms/',icon:'◫',label:'Forms & Surveys'},
      {type:'link',href:'/admin/forms/responses/?type=survey',icon:'↳',label:'Survey Responses',adminOnly:true},
      {type:'section',label:'Events'},
      {type:'link',href:'/admin/forms/responses/?type=registration',icon:'◆',label:'Registration Responses',adminOnly:true}
    ];
    adminNav.innerHTML='';
    items.forEach(item=>{
      if(item.type==='section'){
        const el=document.createElement('span');
        el.className='section-label';
        el.textContent=item.label;
        adminNav.appendChild(el);
        return;
      }
      const a=document.createElement('a');
      a.href=item.href;
      a.innerHTML=`<span class="admin-nav-icon" aria-hidden="true">${item.icon}</span><span>${item.label}</span>`;
      if(item.adminOnly)a.setAttribute('data-admin-only','');
      const itemUrl=new URL(item.href,location.origin),itemPath=itemUrl.pathname.replace(/\/+$/,'/')||'/';if(currentPath===itemPath&&(!itemUrl.search||itemUrl.search===location.search))a.classList.add('active');
      adminNav.appendChild(a);
    });
  }
  if(logoutBox){
    logoutBox.classList.add('admin-sidebar-footer');
    logoutBox.innerHTML=`<a class="admin-settings-link" href="/admin/settings/" data-admin-only><span class="admin-nav-icon" aria-hidden="true">⚙</span><span>Site Tools</span></a><a href="/admin/" data-admin-logout><span class="admin-nav-icon" aria-hidden="true">↪</span><span>Log Out</span></a>`;
    if(location.pathname.replace(/\/+$/,'/')==='/admin/settings/'){
      logoutBox.querySelector('.admin-settings-link')?.classList.add('active');
    }
  }

})();
