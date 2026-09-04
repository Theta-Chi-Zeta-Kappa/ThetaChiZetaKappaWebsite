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
  });
})();
