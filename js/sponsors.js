(function () {
  'use strict';

  const PDF_URL = 'assets/docs/OX-Sponsorship Opportunities.pdf';
  const pagesRoot = document.getElementById('pdfPages');
  const statusRoot = document.getElementById('viewerStatus');
  const actionsRoot = document.getElementById('viewerActions');

  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, function (char) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char];
    });
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

  async function renderPdf() {
    if (!window.pdfjsLib) throw new Error('PDF.js did not load.');

    const task = window.pdfjsLib.getDocument({
      url: PDF_URL,
      withCredentials: false,
      disableAutoFetch: false,
      disableStream: false
    });

    task.onProgress = function (progress) {
      if (progress && progress.total) {
        setProgress('Loading sponsorship opportunities…', progress.loaded / progress.total);
      }
    };

    const pdf = await task.promise;
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
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
      canvas.setAttribute('aria-label', `Page ${pageNumber} of ${pdf.numPages}`);

      wrapper.appendChild(canvas);
      pagesRoot.appendChild(wrapper);

      const context = canvas.getContext('2d', { alpha: false });
      await page.render({ canvasContext: context, viewport: renderViewport }).promise;
    }

    statusRoot.hidden = true;
    actionsRoot.hidden = false;
  }

  function showError() {
    pagesRoot.hidden = true;
    actionsRoot.hidden = false;
    statusRoot.hidden = false;
    statusRoot.innerHTML = '<strong>Unable to display the sponsorship packet.</strong><br>Please use the Download PDF or Open Original button below.';
  }

  setProgress('Loading sponsorship opportunities…', 0.04);
  renderPdf().catch(function (error) {
    console.error(error);
    showError();
  });
})();
