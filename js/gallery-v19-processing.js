/* TCZK Gallery browser image processor — 2026-11-17 iOS WebP compatibility update.
 * Production pipeline: decode + resize + encode ON DEVICE, upload ONLY genuine WebP.
 * No processing work is added to Cloudflare Workers.
 * Safari's canvas.toBlob('image/webp') may return PNG; when that happens this loads
 * @jsquash/webp@1.5.0 from esm.sh and runs its WebAssembly encoder IN THE BROWSER.
 * Until vendored, the Safari fallback requires an internet connection to esm.sh.
 * https://github.com/jamsinclair/jSquash — Apache-2.0 (libwebp BSD-3-Clause).
 */
(function () {
  'use strict';

  const MAX_BYTES = 30 * 1024 * 1024;
  const MAX_ENCODED_BYTES = 8 * 1024 * 1024;
  const WASM_MODULE_URL = 'https://esm.sh/@jsquash/webp@1.5.0';
  let fallbackEncoderPromise = null;
  let nativeWebpUnsupported = false;

  function hex(buffer) {
    return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function hash(buffer, algorithm = 'SHA-256') {
    return hex(await crypto.subtle.digest(algorithm, buffer));
  }
  async function isRealWebp(blob) {
    if (!blob || blob.size < 12) return false;
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    return header[0] === 82 && header[1] === 73 && header[2] === 70 && header[3] === 70 &&
           header[8] === 87 && header[9] === 69 && header[10] === 66 && header[11] === 80;
  }
  function isHeic(file) {
    return /\.(heic|heif)$/i.test(file.name) || /image\/hei[cf]/i.test(file.type || '');
  }
  async function getImageSource(file) {
    // Prefer createImageBitmap, but some iOS Safari versions fail its options
    // despite being able to display the image via an HTMLImageElement.
    if (typeof createImageBitmap === 'function') {
      try {
        const result = await createImageBitmap(file, { imageOrientation: 'from-image' });
        if (result.width && result.height) return { image: result, release: () => result.close?.() };
      } catch (_) {
        try {
          const result = await createImageBitmap(file);
          if (result.width && result.height) return { image: result, release: () => result.close?.() };
        } catch (_) { /* Fall through to img-element decoding. */ }
      }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    try {
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error(
          isHeic(file)
            ? 'This phone cannot decode the HEIC/HEIF photo. Try saving it as JPEG and uploading again.'
            : 'This browser could not decode ' + file.name + '. Please try a JPEG or PNG image.'
        ));
        img.src = url;
      });
      if (!img.naturalWidth || !img.naturalHeight) throw new Error('Invalid image dimensions.');
      return { image: img, release: () => { img.removeAttribute('src'); URL.revokeObjectURL(url); } };
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
  }
  async function getWasmEncoder() {
    if (!fallbackEncoderPromise) {
      fallbackEncoderPromise = import(WASM_MODULE_URL).then(module => {
        const fn = module.encode || module.default?.encode || module.default;
        if (typeof fn !== 'function') throw new Error('WebP fallback encoder is unavailable.');
        return fn;
      }).catch(error => {
        fallbackEncoderPromise = null;
        throw new Error('Could not load the browser WebP encoder. Check your internet connection or content blockers and retry. (' + error.message + ')');
      });
    }
    return fallbackEncoderPromise;
  }
  async function webp(source, maxW, maxH, quality) {
    const sourceWidth = source.naturalWidth || source.width;
    const sourceHeight = source.naturalHeight || source.height;
    if (!sourceWidth || !sourceHeight) throw new Error('Image dimensions are missing.');
    const scale = Math.min(1, maxW / sourceWidth, maxH / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('This browser cannot initialize an image canvas.');
      ctx.drawImage(source, 0, 0, width, height);
      let blob = null;
      if (!nativeWebpUnsupported && typeof canvas.toBlob === 'function') {
        try {
          blob = await new Promise((resolve, reject) => {
            canvas.toBlob(result => result ? resolve(result) : reject(new Error('Image encoding returned no data.')), 'image/webp', quality);
          });
          if (!await isRealWebp(blob)) {
            nativeWebpUnsupported = true;
            blob = null;
          } else if (blob.type !== 'image/webp') {
            // Trust the bytes, not a browser-supplied MIME type.
            blob = new Blob([blob], { type: 'image/webp' });
          }
        } catch (_) { nativeWebpUnsupported = true; blob = null; }
      }
      if (!blob) {
        const encode = await getWasmEncoder();
        let raw;
        try {
          raw = await encode(ctx.getImageData(0, 0, width, height), { quality: Math.round(quality * 100) });
        } catch (error) {
          throw new Error('Browser WebP fallback could not encode this image: ' + error.message);
        }
        blob = raw instanceof Blob ? raw : new Blob([raw], { type: 'image/webp' });
        if (!await isRealWebp(blob)) throw new Error('Browser WebP fallback produced invalid WebP data.');
        if (blob.type !== 'image/webp') blob = new Blob([blob], { type: 'image/webp' });
      }
      if (blob.size > MAX_ENCODED_BYTES) throw new Error('Processed image exceeds 8 MiB. Try a smaller photograph.');
      return { blob, width, height };
    } finally {
      // Release decoded pixel buffers promptly (especially important on iPhone).
      canvas.width = 0;
      canvas.height = 0;
    }
  }
  async function process(file) {
    if (!file || !file.size) throw new Error('Please select a photograph.');
    if (file.size > MAX_BYTES) throw new Error('File exceeds 30 MiB: ' + file.name);
    // Hash the ORIGINAL image to preserve current duplicate-detection behavior.
    const bytes = await file.arrayBuffer();
    const originalSha256 = await hash(bytes);
    const originalSha1 = await hash(bytes, 'SHA-1');
    const decoded = await getImageSource(file);
    try {
      const display = await webp(decoded.image, 1800, 1800, .82);
      const thumb = await webp(decoded.image, 450, 600, .72);
      return {
        originalName: file.name,
        originalSha256, originalSha1,
        width: display.width, height: display.height,
        year: null, decade: null,
        display: display.blob, thumb: thumb.blob
      };
    } finally {
      decoded.release();
    }
  }
  window.TCZKGalleryProcess = { process };
})();
