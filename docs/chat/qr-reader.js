'use strict';

(() => {
  const IMAGE_SIDE = 1400;
  const CAMERA_SIDE = 960;
  const MIN_SIDE = 24;
  const IMAGE_BYTES = 20 * 1024 * 1024;
  let canvas;
  let context;

  function fittedDimensions(sourceWidth, sourceHeight, limit) {
    if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) ||
        sourceWidth < MIN_SIDE || sourceHeight < MIN_SIDE) return null;
    const ratio = Math.min(1, limit / Math.max(sourceWidth, sourceHeight));
    const width = Math.round(sourceWidth * ratio);
    const height = Math.round(sourceHeight * ratio);
    return width >= MIN_SIDE && height >= MIN_SIDE ? { width, height } : null;
  }

  function resample(data, width, height) {
    const pixels = new ImageData(width, height);
    for (let y = 0; y < height; y++) {
      const sourceRow = Math.floor((y + 0.5) * data.height / height) * data.width;
      for (let x = 0; x < width; x++) {
        const offset = (sourceRow + Math.floor((x + 0.5) * data.width / width)) * 4;
        const target = (y * width + x) * 4;
        const alpha = data.data[offset + 3] / 255;
        for (let channel = 0; channel < 3; channel++) {
          pixels.data[target + channel] = data.data[offset + channel] * alpha + 255 * (1 - alpha);
        }
        pixels.data[target + 3] = 255;
      }
    }
    return pixels;
  }

  function extractPixels(source, fromCamera) {
    const sourceWidth = fromCamera ? source.videoWidth : source.naturalWidth ?? source.width;
    const sourceHeight = fromCamera ? source.videoHeight : source.naturalHeight ?? source.height;
    const fit = fittedDimensions(sourceWidth, sourceHeight, fromCamera ? CAMERA_SIDE : IMAGE_SIDE);
    if (!fit) return null;

    const { width, height } = fit;
    if (source instanceof ImageData) return resample(source, width, height);

    if (!canvas) {
      canvas = document.createElement('canvas');
      context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
      if (!context) throw new Error('浏览器无法读取二维码画面。');
    }
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, width, height);
    context.drawImage(source, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  }

  function scan(source, fromCamera = false) {
    const pixels = extractPixels(source, fromCamera);
    if (!pixels) return '';
    const options = { inversionAttempts: fromCamera ? 'dontInvert' : 'attemptBoth' };
    return window.jsQR(pixels.data, pixels.width, pixels.height, options)?.data || '';
  }

  async function scanFile(file) {
    if (file.size > IMAGE_BYTES) throw new Error('二维码图片需小于 20 MiB。');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error('无法读取这张图片，请选用二维码截图。'));
        image.src = url;
      });
      return scan(image);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Decodes a local screenshot or camera frame and returns the raw QR content.
  window.readLanChatQr = async source => {
    if (typeof window.jsQR !== 'function') throw new Error('二维码读取组件未加载，请重新打开网页。');
    if (source instanceof Blob) return scanFile(source);
    if (!source) return '';
    const fromCamera = source instanceof HTMLVideoElement;
    if (fromCamera && source.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return '';
    return scan(source, fromCamera);
  };
})();
