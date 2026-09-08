(function () {
  'use strict';

  const SHEET_ID = '1PIvHi5eBVqoRF0vohF_jwWJG3e02tyaFg_Q2JDsfM00';
  const SHEET_NAME = 'Posts';
  const RANGE = 'A4:L';

  const COLUMN_MAP = {
    type: 0,
    title: 1,
    publishDate: 2,
    slug: 3,
    categories: 4,
    summary: 5,
    pdfLink: 6,
    featuredImage: 7,
    author: 8,
    authorImage: 9,
    published: 10,
    featured: 11
  };

  function cellValue(cell) {
    if (!cell) return '';
    if (typeof cell.v !== 'undefined' && cell.v !== null) return String(cell.v).trim();
    return '';
  }

  function parseGoogleDate(value) {
    if (!value) return null;
    const googleDate = String(value).match(/^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?\)$/);
    if (googleDate) {
      return new Date(
        Number(googleDate[1]),
        Number(googleDate[2]),
        Number(googleDate[3]),
        Number(googleDate[4] || 0),
        Number(googleDate[5] || 0),
        Number(googleDate[6] || 0)
      );
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function splitCategories(value) {
    return String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizeType(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'newsletter') return 'Newsletter';
    if (normalized === 'blog') return 'Blog';
    return value ? String(value).trim() : 'Blog';
  }

  function yes(value) {
    return String(value || '').trim().toLowerCase() === 'yes';
  }

  function normalizeRow(row) {
    const cells = row.c || [];
    const rawDate = cellValue(cells[COLUMN_MAP.publishDate]);
    const date = parseGoogleDate(rawDate);

    return {
      type: normalizeType(cellValue(cells[COLUMN_MAP.type])),
      title: cellValue(cells[COLUMN_MAP.title]),
      publishDateRaw: rawDate,
      publishDate: date,
      slug: cellValue(cells[COLUMN_MAP.slug]),
      categories: splitCategories(cellValue(cells[COLUMN_MAP.categories])),
      summary: cellValue(cells[COLUMN_MAP.summary]),
      pdfLink: cellValue(cells[COLUMN_MAP.pdfLink]),
      featuredImage: cellValue(cells[COLUMN_MAP.featuredImage]),
      author: cellValue(cells[COLUMN_MAP.author]),
      authorImage: cellValue(cells[COLUMN_MAP.authorImage]),
      published: yes(cellValue(cells[COLUMN_MAP.published])),
      featured: yes(cellValue(cells[COLUMN_MAP.featured]))
    };
  }

  function loadPosts() {
    return new Promise((resolve, reject) => {
      const callbackName = '__tczkPostsCallback_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('The Posts sheet took too long to respond.'));
      }, 15000);

      const script = document.createElement('script');
      const cleanup = () => {
        window.clearTimeout(timeout);
        if (script.parentNode) script.parentNode.removeChild(script);
        try { delete window[callbackName]; } catch (error) { window[callbackName] = undefined; }
      };

      window[callbackName] = (response) => {
        if (!response || response.status === 'error') {
          cleanup();
          reject(new Error('Google Sheets returned an error for the Posts tab.'));
          return;
        }

        const rows = (((response || {}).table || {}).rows || [])
          .map(normalizeRow)
          .filter((post) => post.title && post.slug);

        cleanup();
        resolve(rows);
      };

      const query = new URLSearchParams({
        sheet: SHEET_NAME,
        range: RANGE,
        tqx: 'out:json;responseHandler:' + callbackName,
        headers: '1'
      });
      script.src = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${query.toString()}`;
      script.async = true;
      script.onerror = () => {
        cleanup();
        reject(new Error('The Posts sheet could not be loaded.'));
      };
      document.head.appendChild(script);
    });
  }

  function sortNewest(posts) {
    return [...posts].sort((a, b) => {
      const aTime = a.publishDate ? a.publishDate.getTime() : 0;
      const bTime = b.publishDate ? b.publishDate.getTime() : 0;
      return bTime - aTime;
    });
  }

  function getPublished(posts) {
    return sortNewest(posts.filter((post) => post.published));
  }

  function getFeatured(posts) {
    return getPublished(posts).filter((post) => post.featured)[0] || null;
  }

  function getFeaturedNewsletter(posts) {
    return getPublished(posts).filter((post) => post.type === 'Newsletter' && post.featured)[0] || null;
  }

  function getPostBySlug(posts, slug) {
    const target = String(slug || '').trim().toLowerCase();
    return posts.find((post) => post.published && post.slug.toLowerCase() === target) || null;
  }

  function getViewerUrl(post) {
    if (!post) return '#';
    const slug = encodeURIComponent(post.slug);
    return post.type === 'Newsletter'
      ? `/newsletter/view/?issue=${slug}`
      : `/blog/view/?post=${slug}`;
  }

  function extractDriveFileId(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    const pathMatch = value.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (pathMatch) return pathMatch[1];
    const idMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) return idMatch[1];
    return '';
  }

  function getPdfPreviewUrl(url) {
    const fileId = extractDriveFileId(url);
    if (fileId) return `https://drive.google.com/file/d/${fileId}/preview`;
    return url;
  }

  function getDownloadUrl(url) {
    const fileId = extractDriveFileId(url);
    if (fileId) return `https://drive.google.com/uc?export=download&id=${fileId}`;
    return url;
  }

  function getImageUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    const fileId = extractDriveFileId(value);
    if (fileId) return `https://drive.google.com/thumbnail?id=${fileId}&sz=w1600`;
    if (value.startsWith('assets/')) return '/' + value;
    return value;
  }

  function formatDate(date, options) {
    if (!date) return '';
    return new Intl.DateTimeFormat('en-US', options || {
      month: 'long',
      day: 'numeric',
      year: 'numeric'
    }).format(date);
  }

  window.TCZKPosts = {
    load: loadPosts,
    getPublished,
    getFeatured,
    getFeaturedNewsletter,
    getPostBySlug,
    getViewerUrl,
    getPdfPreviewUrl,
    getDownloadUrl,
    getImageUrl,
    formatDate
  };
})();
