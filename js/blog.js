(function () {
  'use strict';

  const featuredRoot = document.getElementById('featuredPost');
  const postsRoot = document.getElementById('postsGrid');
  const statusRoot = document.getElementById('blogStatus');
  const filterRoot = document.getElementById('categoryFilters');
  const searchInput = document.getElementById('postSearch');
  let allPosts = [];
  const requestedCategory = new URLSearchParams(window.location.search).get('category');
  let activeCategory = requestedCategory || 'All';

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function categoryPills(categories) {
    if (!categories || !categories.length) return '';
    return `<div class="post-categories">${categories.map((category) => `<span class="category-pill">${escapeHtml(category)}</span>`).join('')}</div>`;
  }

  function imageMarkup(post, className) {
    const src = TCZKPosts.getImageUrl(post.featuredImage);
    if (!src) {
      return `<div class="${className} post-image-placeholder"><span>${post.type === 'Newsletter' ? 'Newsletter' : 'Chapter Update'}</span></div>`;
    }
    return `<img class="${className}" src="${escapeHtml(src)}" alt="${escapeHtml(post.title)}" loading="lazy">`;
  }


  function authorMarkup(post) {
    if (!post.author) return '';

    const authorImage = TCZKPosts.getImageUrl(post.authorImage);
    const image = authorImage
      ? `<img class="post-author-image" src="${escapeHtml(authorImage)}" alt="${escapeHtml(post.author)}" loading="lazy" onerror="this.style.display='none'">`
      : '';

    return `<span class="post-author">${image}<span class="post-author-name">${escapeHtml(post.author)}</span></span>`;
  }

  function renderFeatured(post) {
    if (!post) {
      featuredRoot.hidden = true;
      return;
    }

    featuredRoot.hidden = false;
    featuredRoot.innerHTML = `
      <a class="featured-card" href="${TCZKPosts.getViewerUrl(post)}">
        <div class="featured-media">${imageMarkup(post, 'featured-image')}</div>
        <div class="featured-content">
          <div class="featured-kicker">Featured ${escapeHtml(post.type)}</div>
          ${categoryPills(post.categories)}
          <h2>${escapeHtml(post.title)}</h2>
          ${post.summary ? `<p>${escapeHtml(post.summary)}</p>` : ''}
          <div class="post-meta">
            ${post.publishDate ? `<span>${TCZKPosts.formatDate(post.publishDate)}</span>` : ''}
            ${authorMarkup(post)}
          </div>
          <span class="read-action">Read ${post.type === 'Newsletter' ? 'Newsletter' : 'Post'} <span aria-hidden="true">→</span></span>
        </div>
      </a>`;
  }

  function postCard(post) {
    const typeClass = post.type === 'Newsletter' ? 'type-newsletter' : 'type-blog';
    return `
      <article class="post-card ${typeClass}" data-categories="${escapeHtml(post.categories.join('|').toLowerCase())}">
        <a href="${TCZKPosts.getViewerUrl(post)}" class="post-card-link">
          <div class="post-card-media">
            ${imageMarkup(post, 'post-card-image')}
            <span class="post-type-badge">${escapeHtml(post.type)}</span>
          </div>
          <div class="post-card-body">
            ${categoryPills(post.categories)}
            <h3>${escapeHtml(post.title)}</h3>
            ${post.summary ? `<p>${escapeHtml(post.summary)}</p>` : ''}
            <div class="post-meta">
              ${post.publishDate ? `<span>${TCZKPosts.formatDate(post.publishDate, { month: 'short', day: 'numeric', year: 'numeric' })}</span>` : ''}
              ${authorMarkup(post)}
            </div>
            <span class="read-action">Read ${post.type === 'Newsletter' ? 'Newsletter' : 'Post'} <span aria-hidden="true">→</span></span>
          </div>
        </a>
      </article>`;
  }

  function buildFilters(posts) {
    const categories = [...new Set(posts.flatMap((post) => post.categories))].sort((a, b) => a.localeCompare(b));
    filterRoot.innerHTML = ['All', ...categories].map((category) => `
      <button class="filter-pill${category === activeCategory ? ' active' : ''}" type="button" data-category="${escapeHtml(category)}">
        ${escapeHtml(category)}
      </button>`).join('');

    filterRoot.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        activeCategory = button.dataset.category;
        buildFilters(allPosts);
        renderGrid();
      });
    });
  }

  function renderGrid() {
    const search = (searchInput.value || '').trim().toLowerCase();
    const filtered = allPosts.filter((post) => {
      const categoryMatch = activeCategory === 'All' || post.categories.includes(activeCategory);
      const haystack = [post.title, post.summary, post.author, post.type, post.categories.join(' ')].join(' ').toLowerCase();
      return categoryMatch && (!search || haystack.includes(search));
    });

    if (!filtered.length) {
      postsRoot.innerHTML = '<div class="empty-state">No published posts match this filter yet.</div>';
      return;
    }
    postsRoot.innerHTML = filtered.map(postCard).join('');
  }

  async function init() {
    try {
      statusRoot.textContent = 'Loading chapter posts…';
      const rows = await TCZKPosts.load();
      const published = TCZKPosts.getPublished(rows);
      const featured = TCZKPosts.getFeaturedNewsletter(published);
      allPosts = published.filter((post) => !featured || post.slug !== featured.slug);
      if (activeCategory !== 'All' && !allPosts.some((post) => post.categories.includes(activeCategory))) {
        activeCategory = 'All';
      }

      renderFeatured(featured);
      buildFilters(allPosts);
      renderGrid();
      statusRoot.textContent = '';
      statusRoot.hidden = true;
    } catch (error) {
      console.error(error);
      featuredRoot.hidden = true;
      postsRoot.innerHTML = '';
      statusRoot.hidden = false;
      statusRoot.innerHTML = '<strong>Posts are temporarily unavailable.</strong><br>Please try again in a few minutes.';
    }
  }

  searchInput.addEventListener('input', renderGrid);
  init();
})();
