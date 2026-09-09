(function () {
  'use strict';

  const pdfFrame = document.getElementById('sponsorPdf');
  const actionsRoot = document.getElementById('viewerActions');

  if (pdfFrame) {
    pdfFrame.addEventListener('load', function () {
      if (actionsRoot) actionsRoot.hidden = false;
    });
  }

  // Keep the fallback actions available even if a browser cannot embed PDFs.
  if (actionsRoot) actionsRoot.hidden = false;
})();
