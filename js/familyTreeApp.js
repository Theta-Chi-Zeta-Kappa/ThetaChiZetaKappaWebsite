(() => {
'use strict';

const cfg = window.TREE_CONFIG || {};
let ALL_MEMBERS = [];
let MEMBERS = [];
let byId = {};
let children = {};
let selected = null;
let view = 'tree';
let currentFamily = cfg.defaultFamily || '';
let rootIds = [];
let zoom = 1;
const ZOOM_MOBILE_MIN = 0.12, ZOOM_TABLET_MIN = 0.32, ZOOM_DESKTOP_MIN = 0.55;
const ZOOM_MOBILE_MAX = 2.25, ZOOM_DESKTOP_MAX = 1.6, ZOOM_STEP = 0.1;

const appRoot = document.querySelector('#familyTreeApp');
if (!appRoot) return;
const query = selector => appRoot.querySelector(selector);
const queryAll = selector => appRoot.querySelectorAll(selector);

const desktop = query('#desktopTree');
const mobile = query('#mobileTree');
const statusText = query('#statusText');
const detailsButton = query('#detailsButton');
const sourceStatus = query('#sourceStatus');
const familySelect = query('#familySelect');
const search = query('#search');
const results = query('#results');
const pageTitle = query('#pageTitle');
const zoomOut = query('#zoomOut');
const zoomIn = query('#zoomIn');
const zoomFit = query('#zoomFit');
const zoomLevel = query('#zoomLevel');
const validationStatus = query('#validationStatus');

function clean(v) {
  if (v === undefined || v === null || String(v).trim() === '') return 'n/a';
  return String(v).trim();
}
function normalizeHeader(h) { return String(h || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''); }
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}
function mapRows(rows) {
  if (!rows.length) return [];
  const headers = Object.keys(rows[0]);
  const key = {};
  for (const h of headers) key[normalizeHeader(h)] = h;
  const pick = (r, names) => {
    for (const name of names) {
      const h = key[normalizeHeader(name)];
      if (h !== undefined && r[h] !== undefined && r[h] !== null && String(r[h]).trim() !== '') return r[h];
    }
    return 'n/a';
  };
  return rows.map(r => ({
    id: clean(pick(r, ['Unique ID','UniqueID','ID'])).toUpperCase(),
    name: clean(pick(r, ['Name','Member Name'])),
    roster: clean(pick(r, ['Roster #','Roster','Roster Number'])),
    family: clean(pick(r, ['Family'])),
    big: clean(pick(r, ['Big ID','BigID','Big'])).toUpperCase(),
    ff: clean(pick(r, ['Founding Father','Founder'])),
    initiated: clean(pick(r, ['Initiated Year','Initiation Year','Initiated'])),
    graduation: clean(pick(r, ['Graduation Year','Graduated Year','Graduated'])),
    notes: clean(pick(r, ['Notes','Note'])) === 'n/a' ? '' : clean(pick(r, ['Notes','Note']))
  })).filter(m => m.id !== 'N/A' && m.name !== 'n/a' && m.family !== 'n/a');
}

function readWorkbook(arrayBuffer) {
  if (!window.XLSX) throw new Error('The Excel reader library did not load. Check the internet connection or host the SheetJS file locally.');
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheetName = cfg.sheetName && wb.SheetNames.includes(cfg.sheetName) ? cfg.sheetName : wb.SheetNames[0];
  if (!sheetName) throw new Error('No worksheet was found in the workbook.');
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  const mapped = mapRows(rows);
  if (!mapped.length) throw new Error(`No usable member records were found on sheet “${sheetName}”.`);
  return mapped;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
  }
  if (cell.length || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => String(v).trim() !== '')).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}

function configuredLiveUrl() {
  const candidates = [cfg.googleSheetUrl, cfg.googleCsvUrl];
  for (const value of candidates) {
    const u = String(value || '').trim();
    if (u && !/PASTE_|YOUR_/i.test(u)) return u;
  }
  return '';
}

function parseGoogleSheetReference(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('No Google Sheets URL is configured yet.');

  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { throw new Error('The Google Sheets URL is not valid. Paste the full link from your browser.'); }

  if (!/((^|\.)docs\.google\.com$)/i.test(parsed.hostname)) {
    throw new Error('This does not look like a Google Sheets link.');
  }

  const normal = parsed.pathname.match(/\/spreadsheets\/d\/([^/]+)/i);
  const published = parsed.pathname.match(/\/spreadsheets\/d\/e\/([^/]+)/i);
  const gid = parsed.searchParams.get('gid') || ((parsed.hash.match(/gid=(\d+)/i) || [])[1]) || '';

  if (published) return { kind:'published', id:published[1], gid, raw };
  if (normal) return { kind:'normal', id:normal[1], gid, raw };
  throw new Error('Could not find a spreadsheet ID in that Google Sheets URL.');
}

function rowsFromGvizResponse(response) {
  if (!response) throw new Error('Google returned an empty response.');
  if (response.status && response.status !== 'ok') {
    const message = response.errors?.map(e => e.detailed_message || e.message).filter(Boolean).join('; ');
    throw new Error(message || `Google Sheets returned status “${response.status}”.`);
  }
  const table = response.table;
  if (!table || !Array.isArray(table.cols) || !Array.isArray(table.rows)) {
    throw new Error('Google returned data in an unexpected format.');
  }

  // Google Visualization occasionally returns column IDs (A, B, C...) instead
  // of the visible header labels, especially for newly imported XLSX files.
  // The Database sheet has a deliberately fixed schema, so fall back to that
  // schema by position when Google does not expose usable labels.
  const schema = [
    'Unique ID','Name','Roster #','Family','Big ID','Founding Father',
    'Initiated Year','Graduation Year','Notes','Sort Last Name'
  ];
  let headers = table.cols.map((c, i) => String(c.label || '').trim());
  const normalized = new Set(headers.map(normalizeHeader));
  const hasRequiredLabels = normalized.has('uniqueid') && normalized.has('name') && normalized.has('family');

  if (!hasRequiredLabels && table.cols.length >= 5) {
    headers = table.cols.map((_, i) => schema[i] || `Column ${i+1}`);
  } else {
    headers = table.cols.map((c, i) => String(c.label || c.id || schema[i] || `Column ${i+1}`).trim());
  }

  return table.rows.map(row => {
    const out = {};
    headers.forEach((h, i) => {
      const cell = row.c?.[i];
      // Prefer formatted text only when it exists. Numeric roster values and
      // years otherwise remain intact through cell.v.
      out[h] = cell == null ? '' : (cell.f ?? cell.v ?? '');
    });
    return out;
  });
}

function loadGoogleViaJsonp(url) {
  const ref = parseGoogleSheetReference(url);
  return new Promise((resolve, reject) => {
    const callback = `__zkGviz_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    const cleanup = () => {
      try { delete window[callback]; } catch (_) { window[callback] = undefined; }
      script.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Google Sheets did not respond within 15 seconds. Check that the sheet is shared as “Anyone with the link – Viewer”.'));
    }, 15000);

    window[callback] = response => {
      clearTimeout(timer);
      try {
        const rows = rowsFromGvizResponse(response);
        const mapped = mapRows(rows);
        if (!mapped.length) throw new Error(`No usable member records were found on the “${cfg.sheetName || 'Database'}” sheet.`);
        resolve(mapped);
      } catch (err) { reject(err); }
      finally { cleanup(); }
    };

    script.onerror = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error('Google Sheets could not be reached. Check the share permissions and internet connection.'));
    };

    const base = ref.kind === 'published'
      ? `https://docs.google.com/spreadsheets/d/e/${encodeURIComponent(ref.id)}/gviz/tq`
      : `https://docs.google.com/spreadsheets/d/${encodeURIComponent(ref.id)}/gviz/tq`;
    const params = new URLSearchParams();
    params.set('sheet', cfg.sheetName || 'Database');
    // Explicitly tell GViz that row 1 is the header row and constrain the
    // response to the database columns. This prevents header auto-detection
    // from treating the first fraternity member as a header.
    params.set('headers', '1');
    params.set('range', 'A:J');
    params.set('tqx', `out:json;responseHandler:${callback}`);
    params.set('_', String(Date.now()));
    script.src = `${base}?${params.toString()}`;
    document.head.appendChild(script);
  });
}

async function loadFromGoogle(url = configuredLiveUrl()) {
  if (!url) throw new Error('No Google Sheets URL is configured yet.');

  // v10 intentionally uses Google's Visualization endpoint through a script tag.
  // Unlike fetch(), this works when the demo is opened as file:// on a local computer,
  // which avoids the CORS/origin failure that could occur in v9.
  try {
    return await loadGoogleViaJsonp(url);
  } catch (jsonpError) {
    // If the user supplied a direct/published CSV URL and the page is being served
    // over http(s), try ordinary CSV fetch as a secondary route.
    if (/output=csv|format=csv/i.test(url) && location.protocol !== 'file:') {
      try {
        const bust = url.includes('?') ? '&' : '?';
        const response = await fetch(`${url}${bust}_=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Google Sheets request failed (${response.status}).`);
        const mapped = mapRows(parseCsv(await response.text()));
        if (!mapped.length) throw new Error('The published Google Sheet returned no usable member records.');
        return mapped;
      } catch (_) {}
    }
    throw jsonpError;
  }
}
async function loadFromWorkbookUrl() {
  const url = cfg.fallbackWorkbookUrl || cfg.workbookUrl;
  if (!url) throw new Error('No fallback workbook URL is configured.');
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Workbook request failed (${response.status}).`);
  return readWorkbook(await response.arrayBuffer());
}

function validateRecords(records) {
  const errors = [], warnings = [];
  const seen = new Map();
  for (const m of records) {
    if (seen.has(m.id)) errors.push(`Duplicate Unique ID ${m.id} (${seen.get(m.id)} and ${m.name})`);
    else seen.set(m.id, m.name);
    if (!m.family || m.family === 'n/a') errors.push(`${m.id}: missing Family`);
    if (!m.id || m.id === 'N/A') errors.push(`${m.name}: missing Unique ID`);
    if (m.big === m.id) errors.push(`${m.id}: member cannot be their own Big`);
    if (m.id && m.family && m.family !== 'n/a') {
      const prefix = m.id.slice(0,2);
      const known = {Cannon:'CA',Farst:'FA',Knust:'KN',Storch:'ST',Franz:'FR',King:'KI',White:'WH',McEwen:'MC',Huhn:'HU',Livezy:'LI',Hulton:'HL',Yeager:'YE',Pyle:'PY',Cooney:'CO',Hunt:'HN',Bryson:'BR'};
      if (known[m.family] && prefix !== known[m.family]) warnings.push(`${m.id}: ID prefix does not match ${m.family}`);
    }
  }
  const ids = new Set(records.map(m => m.id));
  for (const m of records) if (m.big && m.big !== 'N/A' && !ids.has(m.big)) warnings.push(`${m.id}: Big ID ${m.big} was not found`);
  const map = Object.fromEntries(records.map(m => [m.id,m]));
  for (const m of records) {
    const path = new Set(); let cur = m; let guard = 0;
    while (cur && cur.big && cur.big !== 'N/A' && map[cur.big] && guard++ < records.length + 1) {
      if (path.has(cur.id)) { errors.push(`${m.id}: circular Big/Little relationship detected`); break; }
      path.add(cur.id); cur = map[cur.big];
    }
  }
  return { errors:[...new Set(errors)], warnings:[...new Set(warnings)] };
}

function setData(records, label) {
  const validation = validateRecords(records);
  if (validation.errors.length) throw new Error(`Database validation failed: ${validation.errors.slice(0,3).join('; ')}${validation.errors.length>3?' …':''}`);
  ALL_MEMBERS = records;
  // Preserve the family order supplied by the Database sheet. The workbook's
  // Database rows follow the same intended order as its family worksheet tabs,
  // so this also keeps the live Google Sheets and Excel fallback views aligned.
  const families = [...new Set(records.map(m => m.family))];
  familySelect.innerHTML = families.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  if (!families.includes(currentFamily)) currentFamily = families[0];
  familySelect.value = currentFamily;
  familySelect.disabled = false;
  search.disabled = false;
  sourceStatus.textContent = `${records.length} records loaded from ${label} at ${new Date().toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}.`;
  validationStatus.textContent = validation.warnings.length ? `${validation.warnings.length} data warning${validation.warnings.length===1?'':'s'} detected.` : 'Database validation passed.';
  validationStatus.className = validation.warnings.length ? 'validation warn' : 'validation ok';
  sourceStatus.className = 'ok';
  switchFamily(currentFamily, false);
}

function switchFamily(family, center = true) {
  currentFamily = family;
  MEMBERS = ALL_MEMBERS.filter(m => m.family === family);
  byId = Object.fromEntries(MEMBERS.map(m => [m.id, m]));
  children = {};
  MEMBERS.forEach(m => {
    if (m.big && m.big !== 'N/A' && byId[m.big]) (children[m.big] ??= []).push(m);
  });
  Object.values(children).forEach(a => a.sort((x,y) => x.id.localeCompare(y.id, undefined, {numeric:true})));
  rootIds = MEMBERS.filter(m => !m.big || m.big === 'N/A' || !byId[m.big]).map(m => m.id);
  selected = null;
  view = 'tree';
  syncViewButtons();
  pageTitle.textContent = `${family} Family Tree`;
  document.title = `${family} Family Tree · Zeta Kappa`;
  render();
  if (isCompactViewport()) requestAnimationFrame(() => fitTree({ mobileAuto: true }));
  else requestAnimationFrame(() => parkAtCanvasTop());
}

function roster(m) { return m.roster === 'n/a' || m.roster === 'N/A' ? 'Roster n/a' : `Roster #${m.roster}`; }
function node(m, cls='', x=0, y=0) {
  return `<button class="member ${cls} ${selected===m.id?'selected':''}" style="left:${x}px;top:${y}px" data-id="${escapeHtml(m.id)}" type="button"><strong>${escapeHtml(m.name)}</strong><small>${escapeHtml(roster(m))}</small></button>`;
}
function lineage(id) {
  const s = new Set(); let cur = byId[id]; let guard = 0;
  while (cur && guard++ < MEMBERS.length + 2) { s.add(cur.id); cur = byId[cur.big]; }
  return s;
}
function descendants(id) {
  const s = new Set([id]);
  function walk(x) { (children[x] || []).forEach(k => { if (!s.has(k.id)) { s.add(k.id); walk(k.id); } }); }
  walk(id); return s;
}
function allowed() { if (!selected || view === 'tree') return null; return view === 'lineage' ? lineage(selected) : descendants(selected); }
function mobileRows(root, depth=0, set=null) {
  if (set && !set.has(root.id)) return '';
  const kids = (children[root.id] || []).filter(k => !set || set.has(k.id));
  return `<div class="mobile-row" style="margin-left:${Math.min(depth*12,48)}px"><div class="branch"></div><div class="mobile-member ${selected===root.id?'selected':''}"><button data-id="${escapeHtml(root.id)}" type="button"><strong>${escapeHtml(root.name)}</strong><small>${escapeHtml(roster(root))}${kids.length?` · ${kids.length} little${kids.length>1?'s':''}`:''}</small></button></div></div>${kids.map(k=>mobileRows(k,depth+1,set)).join('')}`;
}

function layoutTree(root, set=null) {
  const count = set ? set.size : MEMBERS.length;
  const NODE_W=158, NODE_H=72;
  // Large families need a tighter contour gap; the cards stay full-size/readable.
  const X_GAP = count >= 100 ? 10 : count >= 70 ? 14 : count >= 45 ? 18 : 24;
  const Y_GAP = count >= 100 ? 42 : count >= 70 ? 46 : 50;
  const PAD_X=70, PAD_Y=58;
  const SEP=NODE_W+X_GAP;
  const visibleKids=m=>(children[m.id]||[]).filter(k=>!set||set.has(k.id));
  function build(m) {
    const kids=visibleKids(m);
    if(!kids.length) return {nodes:[{m,x:0,depth:0,kids}],left:[0],right:[0],rootX:0,maxDepth:0};
    const placed=[]; let groupLeft=[],groupRight=[]; const childRoots=[]; let maxDepth=0;
    kids.forEach((kid,index)=>{
      const sub=build(kid); let shift=0;
      if(index>0){const overlap=Math.min(groupRight.length,sub.left.length);for(let d=0;d<overlap;d++)shift=Math.max(shift,groupRight[d]+SEP-sub.left[d]);}
      placed.push(...sub.nodes.map(n=>({...n,x:n.x+shift,depth:n.depth+1}))); childRoots.push(sub.rootX+shift); maxDepth=Math.max(maxDepth,sub.maxDepth+1);
      const nextLeft=[],nextRight=[]; const levels=Math.max(groupLeft.length,sub.left.length);
      for(let d=0;d<levels;d++){const oldL=groupLeft[d],oldR=groupRight[d],newL=sub.left[d]===undefined?undefined:sub.left[d]+shift,newR=sub.right[d]===undefined?undefined:sub.right[d]+shift;nextLeft[d]=oldL===undefined?newL:(newL===undefined?oldL:Math.min(oldL,newL));nextRight[d]=oldR===undefined?newR:(newR===undefined?oldR:Math.max(oldR,newR));}
      groupLeft=nextLeft; groupRight=nextRight;
    });
    const parentX=(childRoots[0]+childRoots[childRoots.length-1])/2; const nodes=[{m,x:parentX,depth:0,kids},...placed]; const left=[parentX],right=[parentX];
    for(let d=0;d<groupLeft.length;d++){left[d+1]=groupLeft[d];right[d+1]=groupRight[d];}
    return {nodes,left,right,rootX:parentX,maxDepth};
  }
  const tree=build(root),minX=Math.min(...tree.nodes.map(n=>n.x)),maxX=Math.max(...tree.nodes.map(n=>n.x)),offset=PAD_X+NODE_W/2-minX,pos=new Map();
  for(const n of tree.nodes) pos.set(n.m.id,{x:n.x+offset,y:PAD_Y+NODE_H/2+n.depth*(NODE_H+Y_GAP),m:n.m,kids:n.kids});
  const width=Math.max(620,(maxX-minX)+NODE_W+PAD_X*2),height=PAD_Y*2+(tree.maxDepth+1)*NODE_H+tree.maxDepth*Y_GAP;
  return {pos,width,height};
}

function renderOneTree(root,set) {
  const L=layoutTree(root,set); let paths='',nodes='';
  for(const {x,y,m,kids} of L.pos.values()) {
    nodes += node(m, rootIds.includes(m.id) ? 'root' : '', x, y);
    for(const k of kids){const c=L.pos.get(k.id);if(!c)continue;const y1=y+36,y2=c.y-36,mid=(y1+y2)/2;paths+=`<path d="M ${x} ${y1} V ${mid} H ${c.x} V ${y2}"/>`;}
  }
  const sw = Math.ceil(L.width * zoom), sh = Math.ceil(L.height * zoom);
  return { html:`<div class="tree-scale-shell" style="width:${sw}px;height:${sh}px"><div class="tree-canvas" style="width:${L.width}px;height:${L.height}px;transform:scale(${zoom})"><svg class="tree-lines" viewBox="0 0 ${L.width} ${L.height}" aria-hidden="true">${paths}</svg>${nodes}</div></div>`, width:L.width, height:L.height };
}

function renderDesktop(set) {
  let roots = rootIds.map(id=>byId[id]).filter(Boolean);
  if (view==='descendants' && selected) roots=[byId[selected]];
  else if (set) roots=roots.filter(r=>set.has(r.id));
  if (!roots.length && selected && byId[selected]) roots=[byId[selected]];
  if (!roots.length) { desktop.innerHTML='<p class="load-message">No root member could be identified for this family.</p>'; return; }
  if (roots.length===1) { desktop.innerHTML=renderOneTree(roots[0],set).html; return; }
  desktop.innerHTML = `<div style="padding:18px"><strong>${roots.length} disconnected branches found.</strong><p>These records have no linked Big within the selected family. Fixing their Big ID in Excel will reconnect them.</p></div>` + roots.map(r=>`<div style="margin:20px">${renderOneTree(r,set).html}</div>`).join('');
}

function isCompactViewport(){ return window.matchMedia('(max-width:768px)').matches; }
function zoomBounds(){
  const w=window.innerWidth;
  if(w<=768) return {min:ZOOM_MOBILE_MIN,max:ZOOM_MOBILE_MAX};
  if(w<1200) return {min:ZOOM_TABLET_MIN,max:1.9};
  return {min:ZOOM_DESKTOP_MIN,max:ZOOM_DESKTOP_MAX};
}
function clampZoom(v){ const b=zoomBounds(); return Math.min(b.max, Math.max(b.min, Math.round(v*1000)/1000)); }
function parkAtCanvasTop({left=0}={}){ desktop.scrollTo({left,top:0,behavior:'auto'}); }
function updateZoomUI(){ if(zoomLevel) zoomLevel.textContent=`${Math.round(zoom*100)}%`; }
function applyZoomToDOM(){
  desktop.querySelectorAll('.tree-canvas').forEach(canvas=>{
    const w=parseFloat(canvas.style.width)||canvas.offsetWidth;
    const h=parseFloat(canvas.style.height)||canvas.offsetHeight;
    canvas.style.transform=`scale(${zoom})`;
    const shell=canvas.closest('.tree-scale-shell');
    if(shell){ shell.style.width=`${Math.ceil(w*zoom)}px`; shell.style.height=`${Math.ceil(h*zoom)}px`; }
  });
  updateZoomUI();
}
function setZoom(next,{anchorX=null,anchorY=null}={}){
  const old=zoom, z=clampZoom(next); if(Math.abs(z-old)<0.0005) return;
  const ax=anchorX ?? desktop.clientWidth/2, ay=anchorY ?? desktop.clientHeight/2;
  const contentX=(desktop.scrollLeft+ax)/old, contentY=(desktop.scrollTop+ay)/old;
  zoom=z; applyZoomToDOM();
  desktop.scrollLeft=Math.max(0,contentX*zoom-ax);
  desktop.scrollTop=Math.max(0,contentY*zoom-ay);
}
function fitTree({mobileAuto=false}={}){
  const canvases=[...desktop.querySelectorAll('.tree-canvas')]; if(!canvases.length) return;
  const maxW=Math.max(...canvases.map(c=>parseFloat(c.style.width)||c.offsetWidth));
  const maxH=Math.max(...canvases.map(c=>parseFloat(c.style.height)||c.offsetHeight));
  const availW=Math.max(180,desktop.clientWidth-(isCompactViewport()?16:28));
  const availH=Math.max(220,desktop.clientHeight-(isCompactViewport()?16:28));
  /* On phones, fit the complete tree into the viewport. The lower zoom floor
     lets very wide families genuinely fit; pinch zoom immediately restores detail. */
  const target=clampZoom(Math.min(1,availW/maxW,availH/maxH));
  zoom=target; applyZoomToDOM();
  requestAnimationFrame(()=>parkAtCanvasTop());
}

function updateStatus(message='') {
  if(message){statusText.textContent=message;detailsButton.hidden=!selected;return;}
  if(selected){const m=byId[selected];const rootName=rootIds.length===1&&byId[rootIds[0]]?byId[rootIds[0]].name:'family root';statusText.textContent=`${m.name} selected · ${view==='tree'?'full family view':view==='lineage'?`direct lineage to ${rootName}`:'descendant branch'}.`;detailsButton.hidden=false;}
  else{statusText.textContent=`${MEMBERS.length} members in ${currentFamily} · Click a member to select them; double-click to open details.`;detailsButton.hidden=true;}
}
function render() {
  if (!MEMBERS.length) { desktop.innerHTML='<p class="load-message">No members found for this family.</p>'; mobile.innerHTML=''; updateStatus(); return; }
  const set=allowed(); renderDesktop(set);
  let roots=rootIds.map(id=>byId[id]).filter(Boolean);
  if(view==='descendants'&&selected) roots=[byId[selected]];
  else if(set) roots=roots.filter(r=>set.has(r.id));
  if(!roots.length&&selected) roots=[byId[selected]];
  mobile.innerHTML=`<div class="mobile-list">${roots.map(r=>mobileRows(r,0,set)).join('')}</div>`; updateStatus();
}
function selectMember(id,{center=false}={}) { if(!byId[id]) return; selected=id; render(); if(center) requestAnimationFrame(centerSelected); }
function clearSelection(){selected=null;if(view!=='tree'){view='tree';syncViewButtons();}render();}
function syncViewButtons(){queryAll('[data-view]').forEach(x=>x.classList.toggle('active',x.dataset.view===view));}
function centerSelected(){
  if(!selected)return;
  const el=desktop.querySelector(`[data-id="${CSS.escape(selected)}"]`);if(!el)return;
  const er=el.getBoundingClientRect(),dr=desktop.getBoundingClientRect();
  const left=desktop.scrollLeft+(er.left-dr.left)+(er.width/2)-(desktop.clientWidth/2);
  const top=desktop.scrollTop+(er.top-dr.top)+(er.height/2)-(desktop.clientHeight/2);
  desktop.scrollTo({left:Math.max(0,left),top:Math.max(0,top),behavior:'smooth'});
}
function showMemberDetails(id=selected){if(!id||!byId[id])return;const m=byId[id],big=byId[m.big],kids=children[id]||[],isFounder=String(m.ff).trim().toUpperCase()==='FF',founderMark=isFounder?'<div class="founder-mark">★ Founding Father</div>':'';query('#memberDetails').innerHTML=`<div class="details"><span class="badge">${escapeHtml(m.id)}</span><h2 class="${isFounder?'founder-name':''}">${escapeHtml(m.name)}</h2>${founderMark}<p>${escapeHtml(roster(m))}</p><div class="detail-grid"><div><span>Family</span>${escapeHtml(m.family)}</div><div><span>Big Brother</span>${escapeHtml(big?big.name:'None recorded')}</div><div><span>Littles</span>${kids.length}</div><div><span>Initiated</span>${escapeHtml(m.initiated)}</div><div><span>Graduated</span>${escapeHtml(m.graduation)}</div></div>${m.notes?`<p><strong>Note:</strong> ${escapeHtml(m.notes)}</p>`:''}<div class="actions"><button data-action="lineage" type="button">View lineage</button><button data-action="descendants" type="button">View descendants</button><button data-action="tree" type="button">Show in full tree</button></div></div>`;queryAll('[data-action]').forEach(b=>b.addEventListener('click',()=>{view=b.dataset.action;syncViewButtons();query('#memberDialog').close();render();requestAnimationFrame(centerSelected);}));query('#memberDialog').showModal();}

let pan={active:false,moved:false,startX:0,startY:0,left:0,top:0,pointerId:null};
let recentCardClick={id:null,time:0};
const touchPointers=new Map();
let pinch=null;

desktop.addEventListener('click',e=>{if(pan.moved){e.preventDefault();e.stopPropagation();pan.moved=false;return;}const card=e.target.closest('.member');if(card){const id=card.dataset.id,now=performance.now(),isDouble=recentCardClick.id===id&&now-recentCardClick.time<=400;recentCardClick=isDouble?{id:null,time:0}:{id,time:now};selectMember(id);if(isDouble)showMemberDetails(id);return;}recentCardClick={id:null,time:0};if(e.target.closest('.tree-canvas')||e.target===desktop)clearSelection();});
mobile.addEventListener('click',e=>{const card=e.target.closest('[data-id]');if(card){selectMember(card.dataset.id);return;}if(e.target===mobile||e.target.closest('.mobile-list'))clearSelection();});

function pointerDistance(a,b){ return Math.hypot(b.x-a.x,b.y-a.y); }
function pointerMidpoint(a,b){ return {x:(a.x+b.x)/2,y:(a.y+b.y)/2}; }
function beginPinch(){
  if(touchPointers.size<2)return;
  const pts=[...touchPointers.values()].slice(0,2), rect=desktop.getBoundingClientRect();
  const mid=pointerMidpoint(pts[0],pts[1]);
  pinch={distance:Math.max(1,pointerDistance(pts[0],pts[1])),startZoom:zoom,
    contentX:(desktop.scrollLeft+(mid.x-rect.left))/zoom,
    contentY:(desktop.scrollTop+(mid.y-rect.top))/zoom};
  pan.active=false; pan.moved=true;
}

desktop.addEventListener('pointerdown',e=>{
  if(e.pointerType==='touch'){
    touchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    try{desktop.setPointerCapture(e.pointerId)}catch(_){}
    if(touchPointers.size===1){
      pan={active:true,moved:false,startX:e.clientX,startY:e.clientY,left:desktop.scrollLeft,top:desktop.scrollTop,pointerId:e.pointerId};
      desktop.classList.add('dragging');
    }else if(touchPointers.size===2){ beginPinch(); desktop.classList.add('dragging'); }
    e.preventDefault(); return;
  }
  if(e.button!==0)return;
  pan={active:true,moved:false,startX:e.clientX,startY:e.clientY,left:desktop.scrollLeft,top:desktop.scrollTop,pointerId:e.pointerId};
  desktop.classList.add('dragging');desktop.setPointerCapture(e.pointerId);
});

desktop.addEventListener('pointermove',e=>{
  if(e.pointerType==='touch' && touchPointers.has(e.pointerId)){
    touchPointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(touchPointers.size>=2){
      if(!pinch)beginPinch();
      const pts=[...touchPointers.values()].slice(0,2), rect=desktop.getBoundingClientRect();
      const mid=pointerMidpoint(pts[0],pts[1]);
      const next=clampZoom(pinch.startZoom*(pointerDistance(pts[0],pts[1])/pinch.distance));
      zoom=next;applyZoomToDOM();
      desktop.scrollLeft=Math.max(0,pinch.contentX*zoom-(mid.x-rect.left));
      desktop.scrollTop=Math.max(0,pinch.contentY*zoom-(mid.y-rect.top));
      pan.moved=true;
    }else if(pan.active){
      const dx=e.clientX-pan.startX,dy=e.clientY-pan.startY;
      if(Math.abs(dx)>4||Math.abs(dy)>4)pan.moved=true;
      if(pan.moved){desktop.scrollLeft=pan.left-dx;desktop.scrollTop=pan.top-dy;}
    }
    e.preventDefault();return;
  }
  if(!pan.active)return;const dx=e.clientX-pan.startX,dy=e.clientY-pan.startY;if(Math.abs(dx)>4||Math.abs(dy)>4)pan.moved=true;if(pan.moved){desktop.scrollLeft=pan.left-dx;desktop.scrollTop=pan.top-dy;e.preventDefault();}
});

function endPointer(e){
  if(e && e.pointerType==='touch'){
    touchPointers.delete(e.pointerId);
    try{desktop.releasePointerCapture(e.pointerId)}catch(_){}
    pinch=null;
    if(touchPointers.size===1){
      const [id,pt]=touchPointers.entries().next().value;
      pan={active:true,moved:true,startX:pt.x,startY:pt.y,left:desktop.scrollLeft,top:desktop.scrollTop,pointerId:id};
    }else if(touchPointers.size===0){pan.active=false;desktop.classList.remove('dragging');}
    return;
  }
  if(!pan.active)return;pan.active=false;desktop.classList.remove('dragging');try{desktop.releasePointerCapture(pan.pointerId)}catch(_){}
}
desktop.addEventListener('pointerup',endPointer);desktop.addEventListener('pointercancel',endPointer);desktop.addEventListener('dragstart',e=>e.preventDefault());desktop.addEventListener('selectstart',e=>e.preventDefault());
/* Soft wheel capture -------------------------------------------------------
   While the pointer is over the graphical tree, the wheel pans the tree first.
   At a vertical edge, page scrolling is handed back progressively instead of
   switching from fully blocked to fully released in one wheel event. This keeps
   a small amount of resistance around the tree while making the exit feel smooth.
   Ctrl/Cmd + wheel remains zoom. */
const EDGE_HANDOFF_DISTANCE = 220;
const EDGE_HANDOFF_EVENT_CAP = 70;
const EDGE_HANDOFF_RESET_MS = 420;
const EDGE_HANDOFF_MIN_PAGE_SHARE = 0.10;
let edgeWheel = { direction: 0, distance: 0, time: 0, released: false };

function resetEdgeWheel(){
  edgeWheel.direction = 0;
  edgeWheel.distance = 0;
  edgeWheel.time = 0;
  edgeWheel.released = false;
}

/* Smoothstep makes the transition gentle at the start and end instead of a
   linear jump. 0 = almost all wheel motion stays "held" by the tree, 1 = the
   page receives the full wheel delta. */
function edgeHandoffShare(progress){
  const t=Math.max(0,Math.min(1,progress));
  const smooth=t*t*(3-2*t);
  return EDGE_HANDOFF_MIN_PAGE_SHARE+(1-EDGE_HANDOFF_MIN_PAGE_SHARE)*smooth;
}

desktop.addEventListener('pointerleave',resetEdgeWheel);

desktop.addEventListener('wheel',e=>{
  if(e.ctrlKey||e.metaKey){
    resetEdgeWheel();
    const rect=desktop.getBoundingClientRect();
    setZoom(zoom+(e.deltaY<0?ZOOM_STEP:-ZOOM_STEP),{anchorX:e.clientX-rect.left,anchorY:e.clientY-rect.top});
    e.preventDefault();
    return;
  }

  if(e.shiftKey){
    resetEdgeWheel();
    desktop.scrollLeft += e.deltaY || e.deltaX;
    e.preventDefault();
    return;
  }

  const maxTop=Math.max(0,desktop.scrollHeight-desktop.clientHeight);
  const maxLeft=Math.max(0,desktop.scrollWidth-desktop.clientWidth);

  /* If this family already fits vertically, there is nothing useful for the
     wheel to pan. Leave normal document scrolling completely untouched. */
  if(maxTop<=1){
    resetEdgeWheel();
    if(Math.abs(e.deltaX)>Math.abs(e.deltaY) && maxLeft>1){
      desktop.scrollLeft += e.deltaX;
      e.preventDefault();
    }
    return;
  }

  const beforeTop=desktop.scrollTop;
  const direction=e.deltaY>0?1:e.deltaY<0?-1:0;
  const atTop=beforeTop<=1;
  const atBottom=beforeTop>=maxTop-1;
  const pushingEdge=(direction<0&&atTop)||(direction>0&&atBottom);

  if(!pushingEdge){
    resetEdgeWheel();
    desktop.scrollTop += e.deltaY;
    desktop.scrollLeft += e.deltaX;
    e.preventDefault();
    return;
  }

  const now=performance.now();
  if(edgeWheel.direction!==direction || now-edgeWheel.time>EDGE_HANDOFF_RESET_MS){
    edgeWheel.direction=direction;
    edgeWheel.distance=0;
    edgeWheel.released=false;
  }
  edgeWheel.time=now;

  /* Once the handoff has completed, leave subsequent wheel events alone until
     direction changes, the gesture pauses, or the pointer leaves the viewport. */
  if(edgeWheel.released)return;

  edgeWheel.distance += Math.min(Math.abs(e.deltaY),EDGE_HANDOFF_EVENT_CAP);
  const progress=Math.min(1,edgeWheel.distance/EDGE_HANDOFF_DISTANCE);
  const pageShare=edgeHandoffShare(progress);

  /* We prevent the browser's full wheel jump and manually pass only a growing
     fraction of it to the document. This is what removes the abrupt release. */
  window.scrollBy({top:e.deltaY*pageShare,left:0,behavior:'auto'});
  e.preventDefault();

  if(progress>=1)edgeWheel.released=true;
},{passive:false});

zoomOut.addEventListener('click',()=>setZoom(zoom-ZOOM_STEP));
zoomIn.addEventListener('click',()=>setZoom(zoom+ZOOM_STEP));
zoomLevel.addEventListener('click',()=>setZoom(1));
zoomFit.addEventListener('click',fitTree);
updateZoomUI();

let resizeTimer=0;
window.addEventListener('resize',()=>{
  clearTimeout(resizeTimer);
  resizeTimer=setTimeout(()=>{
    if(!MEMBERS.length)return;
    if(isCompactViewport()){ fitTree({mobileAuto:true}); return; }
    /* Desktop keeps the user's pan/zoom state. Only enforce the desktop-specific
       zoom bounds instead of auto-fitting the whole family after every resize. */
    const bounded=clampZoom(zoom);
    if(Math.abs(bounded-zoom)>0.0005){ zoom=bounded; applyZoomToDOM(); }
  },140);
});

query('#closeDialog').addEventListener('click',()=>query('#memberDialog').close());
detailsButton.addEventListener('click',()=>showMemberDetails());
query('#reset').addEventListener('click',()=>{selected=null;view='tree';syncViewButtons();render();requestAnimationFrame(()=>parkAtCanvasTop());});
queryAll('[data-view]').forEach(b=>b.addEventListener('click',()=>{const requested=b.dataset.view;if(requested!=='tree'&&!selected){view='tree';syncViewButtons();updateStatus('Select a member first, then choose Lineage or Descendants.');return;}view=requested;syncViewButtons();render();requestAnimationFrame(centerSelected);}));
familySelect.addEventListener('change',()=>switchFamily(familySelect.value));
function rankedSearch(query) {
  const q=String(query||'').trim().toLowerCase().replace(/\s+/g,' ');
  if(!q)return [];
  const rosterMatch=q.match(/^(?:roster\s*#?\s*|#\s*)?(\d+)$/i);
  return ALL_MEMBERS.map(m=>{
    const name=m.name.toLowerCase().replace(/\s+/g,' '),memberRoster=String(m.roster).trim().toLowerCase(),memberId=m.id.toLowerCase();
    let score=0;
    if(rosterMatch){
      const rq=rosterMatch[1];
      if(memberRoster===rq)score=1200;
      else if(memberRoster.startsWith(rq))score=800;
      else if(memberRoster.includes(rq))score=600;
    }else{
      if(memberId===q&&/^[a-z]{2}\d+$/i.test(q))score=1100;
      else if(name===q)score=1000;
      else if(name.startsWith(q))score=900;
      else if(name.split(/\s+/).some(part=>part.startsWith(q)))score=800;
      else if(name.includes(q))score=700;
    }
    return {m,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.m.name.localeCompare(b.m.name)).slice(0,10).map(x=>x.m);
}
search.addEventListener('input',()=>{const q=search.value.trim();if(!q){results.hidden=true;return;}const hits=rankedSearch(q);results.innerHTML=hits.map(m=>`<button data-result="${escapeHtml(m.id)}" data-family="${escapeHtml(m.family)}" type="button"><strong>${escapeHtml(m.name)}</strong><br><small>${escapeHtml(m.family)} · ${escapeHtml(roster(m))}</small></button>`).join('')||'<button disabled>No matches</button>';results.hidden=false;});
results.addEventListener('click',e=>{const result=e.target.closest('[data-result]');if(!result)return;search.value='';results.hidden=true;if(result.dataset.family!==currentFamily){familySelect.value=result.dataset.family;switchFamily(result.dataset.family,false);}selectMember(result.dataset.result,{center:true});});

function showLoadError(err){
  console.error(err);
  sourceStatus.textContent=`Live database not loaded: ${err.message||err}`;
  sourceStatus.className='error';
  validationStatus.textContent='No live data is currently loaded.';
  validationStatus.className='validation warn';
  desktop.innerHTML='<div style="padding:1rem"><strong>The family tree is temporarily unavailable.</strong><br><small>Please try again later.</small></div>';
  mobile.innerHTML=''; statusText.textContent='The family database could not be loaded.';
}

async function loadConfiguredData(url = configuredLiveUrl(), {allowFallback=false} = {}) {
  try {
    sourceStatus.textContent='Loading live family database…'; sourceStatus.className='';
    const records = await loadFromGoogle(url); setData(records, 'Google Sheets live data');
  } catch (err) {
    if (allowFallback && (cfg.fallbackWorkbookUrl || cfg.workbookUrl)) {
      try {
        sourceStatus.textContent='Live source unavailable; loading bundled Excel fallback…';
        setData(await loadFromWorkbookUrl(), 'bundled Excel fallback');
        return;
      } catch (_) {}
    }
    showLoadError(err);
  }
}

(async function boot(){
  const live = configuredLiveUrl();
  if (live) await loadConfiguredData(live,{allowFallback:true});
  else {
    try { sourceStatus.textContent='No live Google Sheet configured; loading bundled Excel demo…'; setData(await loadFromWorkbookUrl(), 'bundled Excel demo'); }
    catch(err) { showLoadError(err); }
  }
})();

})();
