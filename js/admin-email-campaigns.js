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
  const create = createForm.querySelector('button');
  const upload = uploadForm.querySelector('button');
  let campaigns = [];
  let busy = false;

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
    updateControls();
  });

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
      return 'HTML imported.';
    });
  });

  validate.addEventListener('click', () => run('Checking draft…', async () => {
    const result = await api(selectedCampaignPath() + '/validate', {method: 'POST'});
    if (result.errors.includes('HTML_MISSING')) return 'Import the campaign HTML before testing.';
    if (result.errors.includes('SUBJECT_MISSING')) return 'The draft needs a subject.';
    if (!result.ok) return 'The draft could not be validated.';
    return 'The draft has a subject and HTML. You can request a sandbox test.';
  }));

  send.addEventListener('click', () => run('Submitting one test to SES…', async () => {
    const result = await api(selectedCampaignPath() + '/test', {method: 'POST'});
    return `SES accepted the test. Check your inbox. Test ID ${result.test_id}.`;
  }));

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
})();
