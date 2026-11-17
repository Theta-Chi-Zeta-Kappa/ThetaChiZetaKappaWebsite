(function(){
  'use strict';
  const apiBase = String(window.TCZK_ADMIN_API || '').replace(/\/$/, '');
  const apiStatus = document.getElementById('apiStatus');
  if (apiStatus && apiBase) {
    fetch(apiBase + '/api/health', {cache:'no-store'})
      .then(r => {apiStatus.textContent = r.ok ? 'Admin API online' : 'Admin API unavailable';})
      .catch(() => {apiStatus.textContent = 'Admin API unavailable';});
  }
  const sidebar = document.getElementById('adminSidebar');
  const menuBtn = document.querySelector('[data-admin-menu]');
  const closeMenu = () => {
    sidebar?.classList.remove('open');
    menuBtn?.setAttribute('aria-expanded','false');
    document.body.classList.remove('admin-mobile-nav-open');
  };
  if (sidebar && menuBtn) {
    menuBtn.setAttribute('aria-expanded','false');
    menuBtn.setAttribute('aria-controls','adminSidebar');
    menuBtn.addEventListener('click', () => {
      const opened = sidebar.classList.toggle('open');
      menuBtn.setAttribute('aria-expanded',String(opened));
      document.body.classList.toggle('admin-mobile-nav-open',opened);
    });
    document.addEventListener('keydown', e => {if(e.key==='Escape') closeMenu();});
    document.addEventListener('click', e => {
      if(sidebar.classList.contains('open') && !sidebar.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
    });
  }

  const nav = document.querySelector('.admin-nav');
  const footer = document.querySelector('.admin-logout');
  const icon = name => '/assets/admin-icons/' + name + '.png';
  const path = location.pathname.replace(/\/+$/,'/') || '/';
  const entries = [
    {id:'gallery', label:'Gallery', icon:'gallery', children:[
      {href:'/admin/gallery/',label:'Gallery Manager'},
      {href:'/admin/gallery/staging-upload/',label:'Gallery Operations'},
      {href:'/admin/gallery/staging-approvals/',label:'Pending Approvals',adminOnly:true},
      {href:'/admin/gallery/changes/',label:'Change Requests',adminOnly:true}
    ]},
    {id:'content',label:'Content',icon:'content',children:[
      {href:'/admin/content/',label:'Blog & Newsletter'},
      {href:'/admin/content/approvals/',label:'Content Approvals',adminOnly:true}
    ]},
    {id:'records',label:'Chapter Records',icon:'records',children:[
      {href:'/admin/family-tree/',label:'Family Tree'},
      {href:'/admin/history/',label:'Historical Submissions',adminOnly:true}
    ]},
    {id:'event',label:'Events',icon:'event',children:[
      {href:'/admin/forms/',label:'Forms & Surveys'},
      {href:'/admin/forms/responses/?type=registration',label:'Registration Responses',adminOnly:true},
      {href:'/admin/forms/responses/?type=survey',label:'Survey Responses',adminOnly:true}
    ]}
  ];
  function linkMatches(href){
    const u=new URL(href,location.origin);
    if(u.pathname.replace(/\/+$/,'/') !== path) return false;
    if(u.search && u.search !== location.search) return false;
    return true;
  }
  if (nav) {
    const makeImg = (name,cls) => {
      const image=document.createElement('img'); image.src=icon(name);image.alt='';
      image.setAttribute('aria-hidden','true');image.className=cls;
      image.width=25;image.height=25;return image;
    };
    const el=(tag,cls)=>{const out=document.createElement(tag);out.className=cls;return out;};
    nav.replaceChildren();
    const dashboard=el('a','admin-nav-primary');dashboard.href='/admin/dashboard/';
    dashboard.append(makeImg('dashboard','admin-custom-icon'),document.createTextNode('Dashboard'));
    if(linkMatches(dashboard.href)) dashboard.classList.add('active');
    nav.append(dashboard);
    let activeGroup=entries.find(group=>group.children.some(c=>linkMatches(c.href)))?.id || null;
    const storedKey='tczk-admin-open-group';
    let expanded=activeGroup;
    if(!expanded){try{expanded=sessionStorage.getItem(storedKey)||null;}catch{}}
    const groups=new Map();
    function openGroup(id){
      expanded=id;
      for(const [key,pair] of groups){
        const open=id===key;
        pair.button.setAttribute('aria-expanded',String(open));
        pair.submenu.hidden=!open;
        pair.container.classList.toggle('is-open',open);
      }
      try{if(id)sessionStorage.setItem(storedKey,id);else sessionStorage.removeItem(storedKey);}catch{}
    }
    for(const group of entries){
      const container=el('section','admin-nav-group');
      const toggle=el('button','admin-nav-toggle');toggle.type='button';
      toggle.setAttribute('aria-controls','admin-nav-submenu-'+group.id);
      toggle.setAttribute('aria-expanded','false');
      toggle.append(makeImg(group.icon,'admin-custom-icon'));
      const text=el('span','admin-nav-group-label');text.textContent=group.label;toggle.append(text);
      const arrow=el('span','admin-nav-chevron');arrow.setAttribute('aria-hidden','true');arrow.textContent='⌄';toggle.append(arrow);
      const submenu=el('div','admin-nav-submenu');submenu.id='admin-nav-submenu-'+group.id;submenu.hidden=true;
      for(const item of group.children){
        const anchor=el('a','admin-sub-link');anchor.href=item.href;anchor.textContent=item.label;
        if(item.adminOnly){anchor.dataset.adminOnly='';anchor.hidden=true;}
        if(linkMatches(item.href)){anchor.classList.add('active');anchor.setAttribute('aria-current','page');}
        anchor.addEventListener('click',closeMenu);
        submenu.append(anchor);
      }
      toggle.addEventListener('click',()=>openGroup(expanded===group.id?null:group.id));
      container.append(toggle,submenu);nav.append(container);
      groups.set(group.id,{container,button:toggle,submenu});
    }
    openGroup(expanded);
  }
  if (footer) {
    footer.classList.add('admin-sidebar-footer');
    footer.replaceChildren();
    const footerLink=(href,label,imgName)=>{
      const a=document.createElement('a');a.href=href;
      const img=document.createElement('img');img.src=icon(imgName);img.alt='';img.className='admin-custom-icon';img.width=25;img.height=25;
      a.append(img,document.createTextNode(label));return a;
    };
    const settings=footerLink('/admin/settings/','Site Settings','settings');
    settings.dataset.adminOnly='';settings.hidden=true;
    if(path==='/admin/settings/')settings.classList.add('active');
    const logout=footerLink('/admin/','Log Out','logout');logout.dataset.adminLogout='';
    footer.append(settings,logout);
  }
})();
