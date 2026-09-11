(function () {
  'use strict';

  const API_BASE = 'https://tczk-admin-api.jackkinn13.workers.dev';
  let cachedLoad = null;

  function normalizeType(value) { return String(value || '').trim().toLowerCase() === 'newsletter' ? 'Newsletter' : 'Blog'; }
  function parseDate(value) { if (!value) return null; const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
  function splitCategories(value) { return Array.isArray(value) ? value.map(v=>String(v||'').trim()).filter(Boolean) : String(value||'').split(',').map(v=>v.trim()).filter(Boolean); }
  function normalizeApiPost(post) { return {
    id: post.id || '', type: normalizeType(post.type), title: String(post.title || '').trim(),
    publishDateRaw: post.publicationDate || post.publishedAt || '', publishDate: parseDate(post.publicationDate || post.publishedAt),
    slug: String(post.slug || '').trim(), categories: splitCategories(post.categories), summary: String(post.summary || '').trim(),
    pdfLink: String(post.pdfUrl || '').trim(), featuredImage: String(post.coverUrl || '').trim(), author: String(post.authorName || '').trim(),
    authorImage: String(post.authorImageUrl || '').trim(), season: String(post.season || '').trim(), year: post.year == null ? null : Number(post.year),
    published: true, featured: Boolean(post.featured), currentNewsletter: Boolean(post.currentNewsletter), source: 'cms'
  }; }
  async function loadFromApi() {
    const response = await fetch(`${API_BASE}/api/public/posts`, {method:'GET',mode:'cors',cache:'no-store',headers:{Accept:'application/json'}});
    if (!response.ok) throw new Error(`CMS returned ${response.status}`);
    const payload = await response.json();
    if (!payload || payload.ok !== true || !Array.isArray(payload.posts)) throw new Error('CMS response was invalid.');
    return payload.posts.map(normalizeApiPost).filter(p=>p.title&&p.slug);
  }
  async function loadPosts(options) { const force=Boolean(options&&options.force); if(!force&&cachedLoad)return cachedLoad; cachedLoad=loadFromApi(); try{return await cachedLoad;}catch(e){cachedLoad=null;throw e;} }
  async function loadPostBySlug(slug) { const target=String(slug||'').trim(); if(!target)return null; const response=await fetch(`${API_BASE}/api/public/post?slug=${encodeURIComponent(target)}`,{cache:'no-store',headers:{Accept:'application/json'}}); if(response.status===404)return null; if(!response.ok)throw new Error(`CMS returned ${response.status}`); const payload=await response.json(); return payload&&payload.ok&&payload.post?normalizeApiPost(payload.post):null; }
  function sortNewest(posts){return [...posts].sort((a,b)=>(b.publishDate?b.publishDate.getTime():0)-(a.publishDate?a.publishDate.getTime():0));}
  function getPublished(posts){return sortNewest(posts.filter(p=>p.published));}
  function getFeatured(posts){return getPublished(posts).filter(p=>p.featured);}
  function getCurrentNewsletter(posts){return getPublished(posts).find(p=>p.type==='Newsletter'&&p.currentNewsletter)||null;}
  function getPostBySlug(posts,slug){const target=String(slug||'').trim().toLowerCase();return posts.find(p=>p.published&&p.slug.toLowerCase()===target)||null;}
  function getViewerUrl(post){if(!post)return '#';const slug=encodeURIComponent(post.slug);return post.type==='Newsletter'?`/newsletter/view/?issue=${slug}`:`/blog/view/?post=${slug}`;}
  function extractDriveFileId(url){const value=String(url||'').trim();if(!value)return '';const p=value.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);if(p)return p[1];const i=value.match(/[?&]id=([a-zA-Z0-9_-]+)/);return i?i[1]:'';}
  function getImageUrl(url){const value=String(url||'').trim();if(!value)return '';const id=extractDriveFileId(value);if(id)return `https://drive.google.com/thumbnail?id=${id}&sz=w1600`;if(value.startsWith('assets/'))return '/'+value;return value;}
  function getCoverUrl(post){return post&&post.id?`${API_BASE}/api/publication/file?id=${encodeURIComponent(post.id)}&kind=cover`:'';}
  function getDownloadUrl(url){return String(url||'').trim();}
  function formatDate(date,options){if(!date)return '';return new Intl.DateTimeFormat('en-US',options||{month:'long',day:'numeric',year:'numeric'}).format(date);}
  window.TCZKPosts={API_BASE,load:loadPosts,loadPostBySlug,getPublished,getFeatured,getCurrentNewsletter,getPostBySlug,getViewerUrl,getDownloadUrl,getImageUrl,getCoverUrl,formatDate,getSource:()=>'cms'};
})();
