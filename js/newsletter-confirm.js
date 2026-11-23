(() => {
  'use strict';

  const status = document.getElementById('confirmationStatus');
  const button = document.getElementById('confirmSubscription');
  const apiOrigin = document.currentScript.dataset.apiOrigin;
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return;

  status.textContent = 'Select Confirm subscription to complete your signup.';
  button.hidden = false;
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Confirming your subscription…';
    try {
      const response = await fetch(apiOrigin + '/api/v1/subscriptions/confirm', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({token}),
        redirect: 'error'
      });
      if (response.status === 400) {
        status.textContent = 'This link is invalid, expired, or already used.';
        button.hidden = true;
        return;
      }
      const result = await response.json();
      if (!response.ok || result.status !== 'active') throw new Error('Confirmation unavailable');
      status.textContent = 'Your newsletter subscription is confirmed.';
      button.hidden = true;
    } catch {
      status.textContent = 'We couldn’t confirm your subscription right now. Please try again.';
      button.disabled = false;
    }
  });
})();
