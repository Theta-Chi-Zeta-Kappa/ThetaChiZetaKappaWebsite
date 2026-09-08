(function () {
  'use strict';
  const status = document.getElementById('newsletterStatus');

  TCZKPosts.load().then((rows) => {
    const newsletter = TCZKPosts.getFeaturedNewsletter(rows);
    if (!newsletter) {
      status.innerHTML = '<strong>No newsletter is currently featured.</strong><br>Published newsletters can still be found in the Blog.';
      return;
    }
    window.location.replace(TCZKPosts.getViewerUrl(newsletter));
  }).catch((error) => {
    console.error(error);
    status.innerHTML = '<strong>The newsletter is temporarily unavailable.</strong><br>Please try again in a few minutes.';
  });
})();
