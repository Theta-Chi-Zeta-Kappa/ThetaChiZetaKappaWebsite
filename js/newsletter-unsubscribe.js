(() => {
  'use strict';

  const status = document.getElementById('unsubscribeStatus');
  const button = document.getElementById('unsubscribeButton');
  const apiOrigin = document.currentScript.dataset.apiOrigin;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (new URLSearchParams(location.search).get('preview') === '1') {
    status.textContent = 'This is the unsubscribe link preview for an officer test.';
    return;
  }
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;

  status.textContent = 'Select Unsubscribe to stop receiving the newsletter.';
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Unsubscribing…';
    try {
      const response = await fetch(apiOrigin + '/api/v1/unsubscribe', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token}),
        redirect: 'error'
      });
      if (response.status === 400) {
        status.textContent = 'This unsubscribe link is invalid.';
        button.hidden = true;
        return;
      }
      const result = await response.json();
      if (!response.ok || result.status !== 'unsubscribed') throw new Error('Unsubscribe unavailable');
      status.textContent = 'You’re unsubscribed from the newsletter.';
      button.hidden = true;
    } catch {
      status.textContent = 'We couldn’t unsubscribe you right now. Please try again.';
      button.disabled = false;
    }
  });
})();
