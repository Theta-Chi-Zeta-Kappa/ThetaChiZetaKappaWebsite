(function () {
  'use strict';

  const worker = 'https://tczk-newsletter-api.jackkinn13.workers.dev';
  const campaignsPath = '/api/v1/admin/campaigns';
  const auth = window.TCZKAdminAuth;
  const notice = document.getElementById('campaignNotice');
  if (document.body.hasAttribute('data-campaign-report')) {
    document.addEventListener('DOMContentLoaded',initReport);
    return;
  }
  const controls = document.getElementById('campaignControls');
  const createForm = document.getElementById('newCampaign');
  const uploadForm = document.getElementById('campaignUpload');
  const htmlInput = document.getElementById('campaignHtml');
  const select = document.getElementById('campaignSelect');
  const validate = document.getElementById('validateCampaign');
  const send = document.getElementById('sendCampaignTest');
  const confirmation = document.getElementById('confirmCampaign');
  const audienceNotice = document.getElementById('campaignAudience');
  const create = createForm.querySelector('button');
  const upload = uploadForm.querySelector('button');
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
      await api(selectedCampaignPath() + '/html', {method: 'POST', contentType: 'text/html', body: await file.text()});
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
      confirmation.querySelector('button').textContent = 'Resume queueing';
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
      confirmation.querySelector('button').textContent = 'Queue campaign';
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
    return campaigns.length ? 'Select a campaign or create a draft.' : 'Create a draft to get started.';
  }));

  async function initReport() {
    const selectReport = document.getElementById('reportCampaign');
    const refresh = document.getElementById('refreshReport');
    const reportStatus = document.getElementById('reportStatus');
    const metrics = document.getElementById('reportMetrics');
    const deliveryActions = document.getElementById('campaignDeliveryActions');
    const pause = document.getElementById('pauseCampaign');
    const resume = document.getElementById('resumeCampaign');
    const uncertain = document.getElementById('uncertainCampaignJobs');
    const uncertainList = document.getElementById('uncertainCampaignList');
    const labels = [
      ['queued','Queued'],['submitted','Awaiting delivery feedback'],['delivered','Delivered'],
      ['bounced','Hard bounces'],['complained','Complaints'],['failed','Failed'],
      ['uncertain','Uncertain'],['skipped','Skipped']
    ];
    async function loadReport() {
      const id = selectReport.value;
      refresh.disabled = true;
      selectReport.disabled = true;
      metrics.replaceChildren();
      deliveryActions.hidden = true;
      uncertain.hidden = true;
      uncertainList.replaceChildren();
      reportStatus.textContent = id ? 'Loading delivery results…' : 'Select a campaign.';
      try {
        if (!id) return;
        const {campaign,counts,uncertain_jobs,delivery_controls_available} = await api(campaignsPath + '/' + encodeURIComponent(id) + '/report');
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
      } catch (error) {
        reportStatus.textContent = error.message;
      } finally {
        selectReport.disabled = false;
        refresh.disabled = !id;
      }
    }
    try {
      const session = await auth.requireAuth();
      if (!session || session.user?.role !== 'admin' || ![1,2].includes(Number(session.user.priority))) {
        notice.textContent = 'Campaign analytics requires P1 or P2 access.';
        return;
      }
      const result = await api(campaignsPath);
      for (const campaign of result.campaigns) selectReport.add(new Option(campaign.title,campaign.id));
      refresh.addEventListener('click',loadReport);
      selectReport.addEventListener('change',loadReport);
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
      document.getElementById('campaignReport').hidden = false;
      notice.hidden = true;
    } catch (error) {
      notice.textContent = error.message;
    }
  }
})();
