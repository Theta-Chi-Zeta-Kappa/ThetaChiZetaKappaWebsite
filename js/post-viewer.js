(function () {
  'use strict';

  const categoriesRoot = document.getElementById('viewerCategories');
  const pagesRoot = document.getElementById('pdfPages');
  const statusRoot = document.getElementById('viewerStatus');
  const downloadLink = document.getElementById('downloadPost');
  const openLink = document.getElementById('openPost');
  const backLink = document.getElementById('backToPosts');
  const actionsRoot = document.getElementById('viewerActions');

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function requestInfo() {
    const params = new URLSearchParams(window.location.search);
    const newsletterIssue = params.get('issue');
    const blogPost = params.get('post');
    if (newsletterIssue) return { slug: newsletterIssue, type: 'Newsletter' };
    if (blogPost) return { slug: blogPost, type: 'Blog' };
    return { slug: '', type: '' };
  }

  function renderCategories(categories) {
    categoriesRoot.innerHTML = (categories || []).map((category) =>
      `<a class="viewer-category-pill" href="/blog/?category=${encodeURIComponent(category)}">${escapeHtml(category)}</a>`
    ).join('');
    categoriesRoot.hidden = !(categories && categories.length);
  }

  function pdfSource(url) {
    return String(url || '').trim();
  }

  function setProgress(label, fraction) {
    const percent = Math.max(0, Math.min(100, Math.round((fraction || 0) * 100)));
    statusRoot.hidden = false;
    statusRoot.innerHTML = `
      <div class="viewer-progress">
        <span class="viewer-progress-label">${escapeHtml(label)}</span>
        <span class="viewer-progress-track" aria-hidden="true">
          <span class="viewer-progress-bar" style="width:${percent}%"></span>
        </span>
      </div>`;
  }

  async function loadPdf(url) {
    if (!window.pdfjsLib) throw new Error('PDF.js did not load.');

    const source = pdfSource(url);
    if (!source) throw new Error('No PDF URL was provided.');

    const task = window.pdfjsLib.getDocument({
      url: source,
      withCredentials: false,
      disableAutoFetch: false,
      disableStream: false
    });

    task.onProgress = (progress) => {
      if (progress && progress.total) {
        setProgress('Loading document…', progress.loaded / progress.total);
      }
    };

    return await task.promise;
  }

  async function renderPdf(pdf) {
    pagesRoot.innerHTML = '';
    pagesRoot.hidden = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      setProgress(`Rendering page ${pageNumber} of ${pdf.numPages}…`, pageNumber / pdf.numPages);

      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const cssWidth = Math.max(1, pagesRoot.clientWidth || document.documentElement.clientWidth || window.innerWidth || baseViewport.width);
      const cssScale = cssWidth / baseViewport.width;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2.25);
      const renderViewport = page.getViewport({ scale: cssScale * pixelRatio });

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrap';
      wrapper.dataset.page = String(pageNumber);

      const canvas = document.createElement('canvas');
      canvas.className = 'pdf-page';
      canvas.width = Math.ceil(renderViewport.width);
      canvas.height = Math.ceil(renderViewport.height);
      // Keep the rendered bitmap sharp, but let CSS scale the page responsively.
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.setAttribute('aria-label', `Page ${pageNumber} of ${pdf.numPages}`);

      wrapper.appendChild(canvas);
      pagesRoot.appendChild(wrapper);

      const context = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: context, viewport: renderViewport }).promise;
    }

    statusRoot.hidden = true;
  }

  async function init() {
    const request = requestInfo();
    backLink.href = '/blog/';

    if (!request.slug) {
      showError('No post was selected.');
      return;
    }

    try {
      const rows = await TCZKPosts.load();
      const post = TCZKPosts.getPostBySlug(rows, request.slug);
      if (!post || (request.type && post.type !== request.type)) {
        showError('That post could not be found or is not currently published.');
        return;
      }
      if (!post.pdfLink) {
        showError('This post does not have a PDF attached yet.');
        return;
      }

      document.title = `${post.title} | Theta Chi Zeta Kappa`;
      renderCategories(post.categories);

      downloadLink.href = TCZKPosts.getDownloadUrl(post.pdfLink);
      downloadLink.setAttribute('download', '');
      openLink.href = post.pdfLink;
      actionsRoot.hidden = false;

      setProgress('Loading document…', 0.04);

      try {
        const pdf = await loadPdf(post.pdfLink);
        await renderPdf(pdf);
      } catch (pdfError) {
        console.error('PDF.js render failed.', pdfError);
        showError('The publication could not be rendered. Confirm the R2 PDF URL is public and the bucket CORS policy allows this site.');
      }
    } catch (error) {
      console.error(error);
      showError('The post viewer could not connect to the website database. Please try again shortly.');
    }
  }

  function showError(message) {
    pagesRoot.hidden = true;
    categoriesRoot.hidden = true;
    actionsRoot.hidden = true;
    statusRoot.hidden = false;
    statusRoot.innerHTML = `<strong>Unable to open this post.</strong><br>${escapeHtml(message)}`;
  }

  init();
})();
