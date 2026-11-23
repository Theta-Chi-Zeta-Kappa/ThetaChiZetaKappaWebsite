(() => {
  'use strict';

  const api = 'https://tczk-newsletter-api.jackkinn13.workers.dev';
  const form = document.getElementById('newsletterSignup');
  const notice = document.getElementById('signupStatus');
  const submit = form.querySelector('button');
  let settings;
  let widget;
  let token = '';
  let sending = false;

  function setToken(value = '') {
    token = value;
    submit.disabled = sending || !token;
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending || !token || !settings) return;
    const fields = new FormData(form);
    const categories = fields.getAll('category');
    if (!categories.length) {
      notice.textContent = 'Choose at least one category.';
      return;
    }
    sending = true;
    submit.disabled = true;
    notice.textContent = 'Requesting a confirmation email…';
    try {
      const response = await fetch(api + '/api/v1/subscriptions', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          email:fields.get('email').trim(), categories, consent:fields.has('consent'),
          consent_version:settings.consent.id, turnstile_token:token
        })
      });
      const result = await response.json();
      if (response.status === 409) {
        form.hidden = true;
        notice.textContent = 'The consent text changed. Reload this page to review it.';
        return;
      }
      if (!response.ok || !result.ok) throw new Error(result.error || 'Signup is unavailable.');
      form.hidden = true;
      notice.textContent = 'If eligible, you’ll receive a confirmation email. The link expires after 48 hours.';
    } catch (error) {
      notice.textContent = error.message || 'Signup is unavailable. Please try again.';
      setToken();
      window.turnstile.reset(widget);
    } finally {
      sending = false;
      submit.disabled = !token;
    }
  });

  async function load() {
    try {
      const response = await fetch(api + '/api/v1/signup-settings', {cache:'no-store'});
      settings = await response.json();
      if (!response.ok || !settings.enabled || !settings.sitekey || !settings.consent?.id) {
        notice.textContent = 'Newsletter signup is currently closed.';
        return;
      }
      document.getElementById('signupDisclosure').textContent = settings.consent.disclosure_text;
      document.getElementById('signupPilot').hidden = settings.mode !== 'pilot';
      form.hidden = false;
      notice.textContent = 'Confirm your address using the link in the email we send.';
      const loader = document.createElement('script');
      loader.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      loader.onerror = () => {notice.textContent = 'Verification could not load. Reload the page to try again.';};
      loader.onload = () => {
        widget = window.turnstile.render('#turnstile',{
          sitekey:settings.sitekey, action:'newsletter_signup', callback:setToken,
          'expired-callback':() => setToken(),
          'error-callback':() => {
            setToken();
            notice.textContent = 'Verification failed. Please try again.';
          }
        });
      };
      document.head.append(loader);
    } catch {
      notice.textContent = 'Signup is unavailable. Please try again later.';
    }
  }

  load();
})();
