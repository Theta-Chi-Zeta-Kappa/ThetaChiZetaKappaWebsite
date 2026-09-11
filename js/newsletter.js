(function () {
  'use strict';

  const statusRoot = document.getElementById('newsletterStatus');
  const featuredRoot = document.getElementById('currentNewsletter');
  const archiveRoot = document.getElementById('newsletterArchive');

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[char]));
  }

  function issueLabel(post) {
    const season = String(post.season || '').trim();
    const year = post.year || (post.publishDate ? post.publishDate.getFullYear() : '');
    return [season, year].filter(Boolean).join(' ') || 'Newsletter';
  }

  function cover(post, className) {
    const src = TCZKPosts.getCoverUrl(post);
    const placeholder = `<div class="${className} newsletter-cover-placeholder"><span>${escapeHtml(issueLabel(post))}</span></div>`;
    if (!src) return placeholder;
    return `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(post.title)} cover" loading="lazy" onerror="this.hidden=true;this.nextElementSibling.hidden=false"><div class="${className} newsletter-cover-placeholder" hidden><span>${escapeHtml(issueLabel(post))}</span></div>`;
  }

  function renderFeatured(post) {
    if (!post) {
      featuredRoot.innerHTML = '<div class="newsletter-empty"><strong>No newsletter is currently featured.</strong><span>Published issues are available in the archive below.</span></div>';
      return;
    }
    featuredRoot.innerHTML = `
      <a class="newsletter-featured-card" href="${TCZKPosts.getViewerUrl(post)}">
        <div class="newsletter-featured-media">${cover(post, 'newsletter-featured-image')}</div>
        <div class="newsletter-featured-copy">
          <div class="newsletter-eyebrow">Current Issue · ${escapeHtml(issueLabel(post))}</div>
          <h1>${escapeHtml(post.title)}</h1>
          ${post.summary ? `<p>${escapeHtml(post.summary)}</p>` : ''}
          <div class="newsletter-meta">
            ${post.publishDate ? `<span>${TCZKPosts.formatDate(post.publishDate)}</span>` : ''}
            ${post.author ? `<span>${escapeHtml(post.author)}</span>` : ''}
          </div>
          <span class="newsletter-read">Read Newsletter <span aria-hidden="true">→</span></span>
        </div>
      </a>`;
  }

  function archiveCard(post) {
    return `
      <article class="newsletter-card">
        <a href="${TCZKPosts.getViewerUrl(post)}">
          <div class="newsletter-card-media">${cover(post, 'newsletter-card-image')}</div>
          <div class="newsletter-card-copy">
            <span class="newsletter-issue-label">${escapeHtml(issueLabel(post))}</span>
            <h3>${escapeHtml(post.title)}</h3>
            ${post.summary ? `<p>${escapeHtml(post.summary)}</p>` : ''}
            <span class="newsletter-read">Open Issue <span aria-hidden="true">→</span></span>
          </div>
        </a>
      </article>`;
  }

  function renderArchive(posts, featured) {
    const archive = posts.filter((post) => !featured || post.slug !== featured.slug);
    if (!archive.length) {
      archiveRoot.innerHTML = '<div class="newsletter-empty compact"><strong>No past issues yet.</strong></div>';
      return;
    }

    const groups = new Map();
    archive.forEach((post) => {
      const year = String(post.year || (post.publishDate ? post.publishDate.getFullYear() : 'Earlier'));
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push(post);
    });

    archiveRoot.innerHTML = [...groups.entries()].map(([year, items]) => `
      <section class="newsletter-year-group" aria-labelledby="newsletter-year-${escapeHtml(year)}">
        <div class="newsletter-year-heading"><span>${escapeHtml(year)}</span></div>
        <div class="newsletter-grid">${items.map(archiveCard).join('')}</div>
      </section>`).join('');
  }

  async function init() {
    try {
      statusRoot.textContent = 'Loading newsletters…';
      const rows = await TCZKPosts.load();
      const newsletters = TCZKPosts.getPublished(rows).filter((post) => post.type === 'Newsletter');
      const featured = TCZKPosts.getCurrentNewsletter(newsletters);
      renderFeatured(featured);
      renderArchive(newsletters, featured);
      statusRoot.hidden = true;
    } catch (error) {
      console.error(error);
      featuredRoot.innerHTML = '';
      archiveRoot.innerHTML = '';
      statusRoot.hidden = false;
      statusRoot.innerHTML = '<strong>Newsletters are temporarily unavailable.</strong><br>Please try again in a few minutes.';
    }
  }

  init();
})();
