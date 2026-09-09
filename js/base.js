(function () {
  function toggleSidebar(button) {
    var sidebar = document.getElementById('sidebar');
    if (!sidebar || !button) return;
    var isOpen = sidebar.classList.toggle('active');
    button.classList.toggle('open', isOpen);
    if (button.hasAttribute('aria-expanded')) {
      button.setAttribute('aria-expanded', String(isOpen));
    }
    if (button.hasAttribute('aria-label')) {
      button.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
    }
  }

  window.toggleSidebar = toggleSidebar;

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.hamburger').forEach(function (button) {
      if (!button.hasAttribute('role')) button.setAttribute('role', 'button');
      if (!button.hasAttribute('tabindex')) button.setAttribute('tabindex', '0');
      if (!button.hasAttribute('aria-controls')) button.setAttribute('aria-controls', 'sidebar');
      if (!button.hasAttribute('aria-expanded')) button.setAttribute('aria-expanded', 'false');
      if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', 'Open navigation');
      button.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleSidebar(button);
        }
      });
    });

    // Desktop browsers often have no handler for tel: links. On desktop,
    // copy the chapter phone number instead; phones retain normal tap-to-call.
    document.querySelectorAll('.branding-header a[href^="tel:"]').forEach(function (link) {
      link.setAttribute('title', '(567) 525-2962');
      link.setAttribute('aria-label', 'Call Theta Chi Zeta Kappa at (567) 525-2962');

      link.addEventListener('click', function (event) {
        var desktopPointer = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        if (!desktopPointer) return;

        event.preventDefault();
        var label = document.querySelector('.branding-header .contact-us');
        var original = label ? label.textContent : '';

        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText('(567) 525-2962').then(function () {
            if (label) label.textContent = 'Phone copied!';
            window.setTimeout(function () {
              if (label) label.textContent = original;
            }, 1600);
          });
        } else {
          window.prompt('Chapter phone number:', '(567) 525-2962');
        }
      });
    });
  });
})();
