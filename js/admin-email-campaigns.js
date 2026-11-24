(function () {
  'use strict';

  const worker = 'https://tczk-newsletter-api.jackkinn13.workers.dev';
  const campaignsPath = '/api/v1/admin/campaigns';
  const auth = window.TCZKAdminAuth;
  const notice = document.getElementById('campaignNotice');
  const controls = document.getElementById('campaignControls');
  const createForm = document.getElementById('newCampaign');
  const uploadForm = document.getElementById('campaignUpload');
  const htmlInput = document.getElementById('campaignHtml');
  const select = document.getElementById('campaignSelect');
  const validate = document.getElementById('validateCampaign');
  const send = document.getElementById('sendCampaignTest');
  const confirmation = document.getElementById('confirmCampaign');
  const queueCampaignLabel = document.getElementById('queueCampaignLabel');
  const audienceNotice = document.getElementById('campaignAudience');
  const create = createForm.querySelector('button');
  const upload = uploadForm.querySelector('button');
  const preview = initPreview();
  const report = initReport();
  let campaigns = [];
  let busy = false;
  let reviewed = null;

  function selectedCampaignPath() {
    return campaignsPath + '/' + encodeURIComponent(select.value);
  }

  async function api(path, {method = 'GET', body, contentType} = {}) {
    const token = auth.token();
    if (!token) throw new Error('Your admin session has ended. Sign in again.');
    const headers = {Accept: 'application/json', Authorization: 'Bearer ' + token};
    if (contentType) headers['Content-Type'] = contentType;
    const response = await fetch(worker + path, {method, body, headers, redirect: 'error'});
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error(data?.error || `Request failed (HTTP ${response.status}).`);
    return data;
  }

  function updateControls() {
    const campaign = campaigns.find(item => item.id === select.value);
    create.disabled = busy;
    select.disabled = busy;
    upload.disabled = busy || campaign?.status !== 'draft';
    validate.disabled = busy || !campaign;
    send.disabled = busy || !campaign;
    confirmation.querySelector('button').disabled = busy;
  }

  async function run(message, action) {
    if (busy) return;
    busy = true;
    updateControls();
    notice.textContent = message;
    try {
      notice.textContent = await action();
    } catch (error) {
      notice.textContent = error.message || 'The request could not be completed.';
    } finally {
      busy = false;
      updateControls();
    }
  }

  function showCampaigns(selectedId = '') {
    select.replaceChildren(new Option('Select a campaign', ''));
    for (const campaign of campaigns) {
      select.add(new Option(`${campaign.title} (${campaign.status})`, campaign.id));
    }
    select.value = selectedId;
    updateControls();
  }

  select.addEventListener('change', () => {
    uploadForm.reset();
    resetReview();
    updateControls();
    preview.select(select.value);
    report.select(select.value);
  });

  function resetReview() {
    reviewed = null;
    confirmation.reset();
    confirmation.hidden = true;
    audienceNotice.textContent = 'Check the draft to review the eligible audience.';
  }

  createForm.addEventListener('submit', event => {
    event.preventDefault();
    const fields = new FormData(createForm);
    const categories = fields.getAll('category');
    if (!categories.length) {
      notice.textContent = 'Select at least one audience category.';
      return;
    }
    run('Creating draft…', async () => {
      const title = fields.get('title').trim();
      const result = await api(campaignsPath, {
        method: 'POST',
        contentType: 'application/json',
        body: JSON.stringify({title, subject: fields.get('subject').trim(), audience: {categories}})
      });
      campaigns.unshift({id: result.id, title, status: result.status});
      createForm.reset();
      uploadForm.reset();
      resetReview();
      showCampaigns(result.id);
      preview.select(result.id);
      report.updateCampaigns(campaigns);
      report.select(result.id);
      return 'Draft created. Import the campaign HTML to test it.';
    });
  });

  uploadForm.addEventListener('submit', event => {
    event.preventDefault();
    const file = htmlInput.files[0];
    if (!file || upload.disabled) return;
    if (file.size === 0 || file.size > 1024 * 1024) {
      notice.textContent = 'Choose a non-empty HTML file of 1 MB or less.';
      return;
    }
    run('Importing HTML…', async () => {
      const html=await file.text();
      await api(selectedCampaignPath() + '/html', {method: 'POST', contentType: 'text/html', body: html});
      preview.remember(select.value,html);
      uploadForm.reset();
      resetReview();
      return 'HTML imported.';
    });
  });

  validate.addEventListener('click', () => run('Checking draft…', async () => {
    resetReview();
    const result = await api(selectedCampaignPath() + '/validate', {method: 'POST'});
    if (result.errors.includes('HTML_MISSING')) return 'Import the campaign HTML before testing.';
    if (result.errors.includes('SUBJECT_MISSING')) return 'The draft needs a subject.';
    if (!result.ok) return 'The draft could not be validated.';
    if (result.frozen_audience_size > 0) {
      if (result.paused) {
        audienceNotice.textContent = 'This campaign is paused. Resume pending sends in Campaign Analytics.';
        return 'Paused campaign checked.';
      }
      reviewed = {revision_id:result.revision_id,eligible_subscribers:result.frozen_audience_size};
      audienceNotice.textContent = `Frozen audience: ${result.frozen_audience_size.toLocaleString()}. Resume queueing pending jobs if dispatch was interrupted.`;
      queueCampaignLabel.textContent = 'Resume queueing';
      confirmation.hidden = false;
      return 'Frozen campaign checked.';
    }
    const audience = await api(selectedCampaignPath() + '/audience');
    const count = audience.eligible_subscribers;
    audienceNotice.textContent = `${count.toLocaleString()} eligible recipient${count === 1 ? '' : 's'}.`;
    if (result.warnings.includes('BULK_SENDING_DISABLED')) {
      audienceNotice.textContent += ' Campaign sending is disabled.';
    } else if (result.warnings.includes('OFFICER_TEST_REQUIRED')) {
      audienceNotice.textContent += ' Send an officer test of this draft first.';
    }
    if (result.ready_to_send && count > 0) {
      reviewed = {revision_id:result.revision_id,eligible_subscribers:count};
      queueCampaignLabel.textContent = 'Queue campaign';
      confirmation.hidden = false;
    }
    return 'Draft check complete.';
  }));

  send.addEventListener('click', () => run('Submitting one test to SES…', async () => {
    const result = await api(selectedCampaignPath() + '/test', {method: 'POST'});
    return `SES accepted the test. Check your inbox. Test ID ${result.test_id}.`;
  }));

  confirmation.addEventListener('submit',event => {
    event.preventDefault();
    const typed = new FormData(confirmation).get('confirmation');
    if (!reviewed || typed !== 'SEND') return;
    run('Queueing the reviewed campaign…',async () => {
      const result = await api(selectedCampaignPath() + '/send',{
        method:'POST',contentType:'application/json',body:JSON.stringify({...reviewed,confirmation:typed})
      });
      resetReview();
      const listing=await api(campaignsPath).catch(()=>null);
      if(listing) {
        const id=select.value;
        campaigns=listing.campaigns;
        showCampaigns(id);
        report.updateCampaigns(campaigns);
      }
      report.select(select.value);
      return `${result.queued_jobs.toLocaleString()} delivery jobs queued. See Campaign Analytics for outcomes.`;
    });
  });

  document.addEventListener('DOMContentLoaded', () => run('Checking access…', async () => {
    const session = await auth.requireAuth();
    if (!session) return 'Sign in to continue.';
    if (session.user?.role !== 'admin' || ![1, 2].includes(Number(session.user.priority))) {
      return 'Email Campaigns requires P1 or P2 access.';
    }
    const result = await api(campaignsPath);
    campaigns = result.campaigns;
    showCampaigns();
    document.getElementById('campaignTestRecipient').textContent = `Sandbox tests go to your signed-in address, ${session.user.email}.`;
    controls.hidden = false;
    report.updateCampaigns(campaigns);
    report.show();
    return campaigns.length ? 'Select a campaign or create a draft.' : 'Create a draft to get started.';
  }));

  function initPreview() {
    const viewport=document.getElementById('previewViewport');
    const frame=document.getElementById('campaignPreviewFrame');
    const previewStatus=document.getElementById('previewStatus');
    const desktop=document.getElementById('previewDesktop');
    const mobile=document.getElementById('previewMobile');
    const expand=document.getElementById('expandPreview');
    const dialog=document.getElementById('expandedEmailPreview');
    const expanded=document.getElementById('expandedPreviewViewport');
    const parent=viewport.parentElement;
    const cache=new Map();
    let width=660;
    let request=0;

    function resize() {
      const scale=Math.min(1,Math.max(0.1,viewport.clientWidth/width));
      frame.style.width=width+'px';
      frame.style.zoom=scale;
      frame.style.height=Math.floor(viewport.clientHeight/scale)+'px';
    }
    new ResizeObserver(resize).observe(viewport);
    function render(html,message) {
      previewStatus.textContent=message;
      viewport.hidden=!html;
      expand.disabled=!html;
      if(!html) {
        frame.removeAttribute('srcdoc');
        return;
      }
      // Templates are inert. Strip navigation before placing the content in the sandbox.
      const template=document.createElement('template');
      template.innerHTML=html;
      template.content.querySelectorAll('script,base,meta,iframe,frame,object,embed,form,link,template,animate,animateMotion,animateTransform,set')
        .forEach(node=>node.remove());
      template.content.querySelectorAll('a,area').forEach(node=>{
        node.removeAttribute('href');
        node.removeAttribute('xlink:href');
      });
      frame.srcdoc=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${template.innerHTML}`;
      resize();
    }
    function choose(id) {
      request++;
      const html=cache.get(id);
      render(html,html?'Imported HTML preview. External images are blocked and the managed footer is added at send time.':
        'Choose an HTML file to preview it. For a saved draft, select its original HTML file again.');
    }
    htmlInput.addEventListener('change',async()=>{
      const file=htmlInput.files[0];
      if(!file) return choose(select.value);
      const current=++request;
      if(!file.size || file.size>1024*1024) {
        render(null,'Choose a non-empty HTML file of 1 MB or less.');
        return;
      }
      try {
        const html=await file.text();
        if(current===request) render(html,'Local file preview. External images are blocked and the managed footer is added at send time.');
      } catch {
        if(current===request) render(null,'This file could not be read.');
      }
    });
    for(const [button,size] of [[desktop,660],[mobile,360]]) {
      button.addEventListener('click',()=>{
        width=size;
        desktop.setAttribute('aria-pressed',String(button===desktop));
        mobile.setAttribute('aria-pressed',String(button===mobile));
        resize();
      });
    }
    expand.addEventListener('click',()=>{
      expanded.append(viewport);
      dialog.showModal();
      resize();
    });
    dialog.addEventListener('close',()=>{
      parent.append(viewport);
      resize();
      expand.focus();
    });
    return {select:choose,remember(id,html){
      if(!cache.has(id) && cache.size>=5) cache.delete(cache.keys().next().value);
      cache.set(id,html);
      choose(id);
    }};
  }

  function initReport() {
    const selectReport = document.getElementById('reportCampaign');
    const refresh = document.getElementById('refreshReport');
    const reportStatus = document.getElementById('reportStatus');
    const metrics = document.getElementById('reportMetrics');
    const deliveryActions = document.getElementById('campaignDeliveryActions');
    const pause = document.getElementById('pauseCampaign');
    const resume = document.getElementById('resumeCampaign');
    const uncertain = document.getElementById('uncertainCampaignJobs');
    const uncertainList = document.getElementById('uncertainCampaignList');
    const issues=document.getElementById('campaignIssuesStatus');
    const history=document.getElementById('campaignHistory');
    const showHistory=document.getElementById('showCampaignHistory');
    const metric=document.getElementById('campaignMetric');
    const chart=document.getElementById('campaignOutcomeChart');
    let listing=[];
    let counts=null;
    let reportRequest=0;
    const labels = [
      ['queued','Queued'],['submitted','Awaiting delivery feedback'],['delivered','Delivered'],
      ['bounced','Hard bounces'],['complained','Complaints'],['failed','Failed'],
      ['uncertain','Uncertain'],['skipped','Skipped']
    ];
    const countFor=key=> (counts?.[key] ?? 0)+(key==='queued'?(counts?.submitting ?? 0):0);
    function draw() {
      chart.replaceChildren();
      if(!counts || !Object.keys(counts).length) {
        const text=document.createElement('p');
        text.textContent=counts?'No delivery jobs to chart.':'Select a campaign to view outcomes.';
        chart.append(text);
        return;
      }
      const max=Math.max(1,...labels.map(([key])=>countFor(key)));
      for(const [key,label] of labels.filter(([key])=>!metric.value || key===metric.value)) {
        const row=document.createElement('div');
        const name=document.createElement('span');
        const bar=document.createElement('meter');
        const value=document.createElement('strong');
        name.textContent=label;
        bar.max=max;
        bar.value=countFor(key);
        bar.setAttribute('aria-label',label);
        value.textContent=countFor(key).toLocaleString();
        row.append(name,bar,value);
        chart.append(row);
      }
    }
    function drawHistory() {
      history.replaceChildren();
      const all=showHistory.getAttribute('aria-expanded')==='true';
      showHistory.hidden=listing.length<=6;
      for(const campaign of (all?listing:listing.slice(0,6))) {
        const row=history.insertRow();
        const button=document.createElement('button');
        button.type='button';
        button.className='campaign-history-link';
        button.textContent=campaign.title;
        button.setAttribute('aria-pressed',String(selectReport.value===campaign.id));
        button.addEventListener('click',()=>selectCampaign(campaign.id));
        row.insertCell().append(button);
        const date=new Date(String(campaign.created_at??'').replace(' ','T')+(campaign.created_at && !/[zZ]|[+-]\d\d:\d\d$/.test(campaign.created_at)?'Z':''));
        row.insertCell().textContent=Number.isNaN(+date)?'—':date.toLocaleDateString();
        row.insertCell().textContent=campaign.paused_at?'Paused':campaign.status.replaceAll('_',' ');
      }
    }
    async function loadReport() {
      const id = selectReport.value;
      const request=++reportRequest;
      refresh.disabled = true;
      selectReport.disabled = true;
      metrics.replaceChildren();
      deliveryActions.hidden = true;
      uncertain.hidden = true;
      uncertainList.replaceChildren();
      reportStatus.textContent = id ? 'Loading delivery results…' : 'Select a campaign.';
      issues.textContent=id?'Checking sending outcomes…':'Select a campaign to review sending issues.';
      counts=null;
      draw();
      try {
        if (!id) return;
        const result=await api(campaignsPath + '/' + encodeURIComponent(id) + '/report');
        if(request!==reportRequest) return;
        const {campaign,uncertain_jobs,delivery_controls_available}=result;
        counts=result.counts;
        const listed=listing.find(item=>item.id===id);
        if(listed) Object.assign(listed,{status:campaign.status,paused_at:campaign.paused_at});
        reportStatus.textContent = Object.keys(counts).length
          ? `${campaign.title} · ${campaign.paused_at?'paused':campaign.status.replaceAll('_',' ')}`
          : `${campaign.title} has no delivery jobs yet.`;
        deliveryActions.hidden = !delivery_controls_available;
        pause.hidden = Boolean(campaign.paused_at);
        resume.hidden = !campaign.paused_at;
        for (const job of uncertain_jobs ?? []) {
          const item = document.createElement('li');
          item.textContent = `${job.email} · ${job.attempt_count} attempt${job.attempt_count===1?'':'s'}`;
          uncertainList.append(item);
        }
        uncertain.hidden = !uncertainList.childElementCount;
        issues.textContent=Object.keys(counts).length
          ? `${countFor('failed')} failed · ${countFor('bounced')} hard bounces · ${countFor('complained')} complaints · ${countFor('uncertain')} uncertain`
          : 'No delivery jobs have been recorded.';
        for (const [key,label] of labels) {
          const card = document.createElement('div');
          const name = document.createElement('dt');
          name.textContent = label;
          const amount = document.createElement('dd');
          const count = (counts[key] ?? 0) + (key === 'queued' ? counts.submitting ?? 0 : 0);
          amount.textContent = count.toLocaleString();
          card.append(name,amount);
          metrics.append(card);
        }
        draw();
      } catch (error) {
        if(request===reportRequest) {
          reportStatus.textContent = error.message;
          issues.textContent='Sending outcomes could not be loaded.';
        }
      } finally {
        if(request===reportRequest) {
          selectReport.disabled = false;
          refresh.disabled = !id;
        }
      }
    }
    function selectCampaign(id) {
      selectReport.value=id;
      drawHistory();
      loadReport();
    }
    for(const [key,label] of labels) metric.add(new Option(label,key));
    metric.addEventListener('change',draw);
    showHistory.addEventListener('click',()=>{
      const open=showHistory.getAttribute('aria-expanded')!=='true';
      showHistory.setAttribute('aria-expanded',String(open));
      showHistory.textContent=open?'Show recent campaigns':'Show all loaded campaigns';
      drawHistory();
    });
      refresh.addEventListener('click',loadReport);
      selectReport.addEventListener('change',()=>selectCampaign(selectReport.value));
      for (const [button,action] of [[pause,'pause'],[resume,'resume']]) {
        button.addEventListener('click',async () => {
          const id=selectReport.value;
          if(!id || !window.confirm(`${action==='pause'?'Pause':'Resume'} pending sends for the selected campaign?`)) return;
          deliveryActions.hidden=true;
          selectReport.disabled=true;
          refresh.disabled=true;
          try {
            await api(campaignsPath+'/'+encodeURIComponent(id)+'/'+action,{
              method:'POST',contentType:'application/json',body:JSON.stringify({confirmation:action.toUpperCase()})
            });
            await loadReport();
          } catch(error) {
            reportStatus.textContent=error.message;
            selectReport.disabled=false;
            refresh.disabled=false;
            deliveryActions.hidden=false;
          }
        });
      }
    return {select:selectCampaign,show(){
      const section=document.getElementById('campaign-analytics');
      section.hidden=false;
      if(location.hash==='#campaign-analytics') section.scrollIntoView();
    },updateCampaigns(items){
      listing=items;
      const selected=selectReport.value;
      selectReport.replaceChildren(new Option('Select a campaign',''));
      for(const campaign of listing) selectReport.add(new Option(campaign.title,campaign.id));
      selectReport.value=selected;
      drawHistory();
    }};
  }
})();
