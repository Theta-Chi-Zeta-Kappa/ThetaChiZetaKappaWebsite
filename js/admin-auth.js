(function(){
  'use strict';

  const API_BASE=String(window.TCZK_ADMIN_API||'').replace(/\/$/,'');
  const TOKEN_KEY='tczk_admin_session';
  const USER_KEY='tczk_admin_user';

  function token(){return sessionStorage.getItem(TOKEN_KEY)||'';}
  function storedUser(){
    try{return JSON.parse(sessionStorage.getItem(USER_KEY)||'null');}
    catch{return null;}
  }

  async function api(path,options={}){
    if(!API_BASE||API_BASE.includes('YOUR-SUBDOMAIN')) throw new Error('Admin API is not configured.');
    const headers=new Headers(options.headers||{});
    if(options.body!=null&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
    if(!headers.has('Accept'))headers.set('Accept','application/json');
    const t=token();
    if(t)headers.set('Authorization',`Bearer ${t}`);
    const response=await fetch(API_BASE+path,{...options,headers});
    const data=await response.json().catch(()=>({}));
    if(!response.ok||data.ok===false){
      const error=new Error(data.error||`Request failed (HTTP ${response.status}).`);
      error.status=response.status;
      throw error;
    }
    return data;
  }

  function clearSession(){
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
  }

  function setSession(data){
    if(!data||!data.token)throw new Error('The login response did not contain a session token.');
    sessionStorage.setItem(TOKEN_KEY,data.token);
    sessionStorage.setItem(USER_KEY,JSON.stringify(data.user||{}));
  }

  function redirectToLogin(){
    const here=location.pathname+location.search+location.hash;
    const next=encodeURIComponent(here);
    location.replace(`/admin/?next=${next}`);
  }

  async function requireAuth(){
    if(!token()){
      redirectToLogin();
      return null;
    }
    try{
      const data=await api('/api/auth/session');
      sessionStorage.setItem(USER_KEY,JSON.stringify(data.user||{}));
      updateUserUI(data.user);
      applyRoleUI(data.user);
      const required=document.body.dataset.adminRole;
      if(required&&data.user?.role!==required){location.replace('/admin/dashboard/');return null;}
      return data;
    }catch(err){
      clearSession();
      redirectToLogin();
      return null;
    }
  }

  function applyRoleUI(user){
    document.querySelectorAll('[data-admin-only]').forEach(el=>{el.hidden=user?.role!=='admin';});
  }

  async function logout(){
    try{if(token())await api('/api/auth/logout',{method:'POST',body:'{}'});}catch(err){console.warn('Logout request failed',err);}
    clearSession();
    location.replace('/admin/');
  }

  function updateUserUI(user){
    if(!user)return;
    document.querySelectorAll('[data-admin-user]').forEach(el=>{
      const label=user.displayName||user.email||'Administrator';
      el.textContent=label+' ●';
      if(user.email)el.title=user.email+(user.role?` · ${user.role}`:'');
    });
  }

  async function initLogin(){
    const form=document.getElementById('adminLoginForm');
    if(!form)return;

    const email=document.getElementById('email');
    const password=document.getElementById('password');
    const message=document.getElementById('loginMessage');
    const submit=form.querySelector('button[type="submit"]');

    if(token()){
      try{
        await api('/api/auth/session');
        const params=new URLSearchParams(location.search);
        location.replace(params.get('next')||'/admin/dashboard/');
        return;
      }catch{clearSession();}
    }

    if(message)message.textContent='Sign in with an authorized TCZK administrator account.';

    form.addEventListener('submit',async e=>{
      e.preventDefault();
      if(message){message.textContent='Signing in…';message.classList.remove('login-error','login-success');}
      if(submit){submit.disabled=true;submit.textContent='Signing In…';}
      try{
        const data=await api('/api/auth/login',{
          method:'POST',
          body:JSON.stringify({email:(email?.value||'').trim(),password:password?.value||''})
        });
        setSession(data);
        if(password)password.value='';
        if(message){message.textContent='Login successful. Opening the admin portal…';message.classList.add('login-success');}
        const params=new URLSearchParams(location.search);
        const next=params.get('next');
        location.replace(next&&next.startsWith('/admin/')?next:'/admin/dashboard/');
      }catch(err){
        if(password)password.value='';
        if(message){message.textContent=err.message||'Unable to sign in.';message.classList.add('login-error');}
        password?.focus();
      }finally{
        if(submit){submit.disabled=false;submit.textContent='Log In';}
      }
    });
  }

  document.addEventListener('DOMContentLoaded',()=>{
    document.querySelectorAll('[data-admin-logout]').forEach(el=>el.addEventListener('click',e=>{e.preventDefault();logout();}));
    const u=storedUser();
    if(u){updateUserUI(u);applyRoleUI(u);}
    if(document.body.matches('[data-admin-protected]'))requireAuth();
    else initLogin();
  });

  window.TCZKAdminAuth={api,token,storedUser,requireAuth,logout,clearSession,applyRoleUI};
})();
