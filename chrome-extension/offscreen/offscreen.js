import { computeViewportStitchPlan, computeMultiPageLayout } from '../shared/stitch-math.js';

/**
 * Decode a PNG/JPEG data URL into an ImageBitmap.
 * @param {string} dataUrl
 * @returns {Promise<ImageBitmap>}
 */
async function dataUrlToBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

/**
 * Encode an HTMLCanvasElement or OffscreenCanvas to a data URL without blocking via Blob + FileReader.
 * @param {HTMLCanvasElement} canvas
 * @param {'png' | 'jpeg'} format
 * @param {number} [quality]
 * @returns {Promise<{ dataUrl: string, mimeType: string }>}
 */
async function canvasToDataUrl(canvas, format = 'png', quality = 0.92) {
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) resolve(result);
        else reject(new Error('Canvas encoding produced null blob'));
      },
      mimeType,
      format === 'jpeg' ? quality : undefined
    );
  });

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });

  return { dataUrl, mimeType };
}

/**
 * Create a lightweight thumbnail data URL for popup preview.
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {number} [maxWidth]
 * @param {number} [maxHeight]
 * @returns {Promise<string>}
 */
async function createThumbnail(sourceCanvas, maxWidth = 360, maxHeight = 240) {
  const srcW = sourceCanvas.width;
  const srcH = sourceCanvas.height;
  if (srcW <= 0 || srcH <= 0) return '';

  const scale = Math.min(1, maxWidth / srcW, maxHeight / srcH);
  const thumbW = Math.max(1, Math.round(srcW * scale));
  const thumbH = Math.max(1, Math.round(srcH * scale));

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbW;
  thumbCanvas.height = thumbH;
  const ctx = thumbCanvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, 0, 0, thumbW, thumbH);

  const { dataUrl } = await canvasToDataUrl(thumbCanvas, 'jpeg', 0.85);
  return dataUrl;
}

/**
 * Stitch viewport screenshot slices into a single full-page image.
 */
async function stitchViewports({
  slices,
  scrollHeight,
  viewportHeight,
  dpr = 1,
  format = 'png',
  quality = 0.92
}) {
  const bitmaps = [];
  try {
    for (const slice of slices) {
      const bitmap = await dataUrlToBitmap(slice.dataUrl);
      bitmaps.push({
        bitmap,
        actualScrollY: slice.actualScrollY,
        imageWidth: bitmap.width,
        imageHeight: bitmap.height
      });
    }

    const plan = computeViewportStitchPlan({
      slices: bitmaps.map((b) => ({
        actualScrollY: b.actualScrollY,
        imageWidth: b.imageWidth,
        imageHeight: b.imageHeight
      })),
      scrollHeight,
      viewportHeight,
      dpr
    });

    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    for (const p of plan.placements) {
      const entry = bitmaps[p.index];
      ctx.drawImage(entry.bitmap, p.sx, p.sy, p.sw, p.sh, p.dx, p.dy, p.dw, p.dh);
    }

    const { dataUrl, mimeType } = await canvasToDataUrl(canvas, format, quality);
    const thumbnailDataUrl = await createThumbnail(canvas);

    return {
      dataUrl,
      thumbnailDataUrl,
      width: plan.width,
      height: plan.height,
      mimeType
    };
  } finally {
    for (const entry of bitmaps) {
      entry.bitmap.close();
    }
  }
}

/**
 * Vertically stack multiple captured full-page images into one continuous image.
 */
async function stitchPages({ pages, format = 'png', quality = 0.92, gapPx = 0 }) {
  const bitmaps = [];
  try {
    for (const page of pages) {
      const bitmap = await dataUrlToBitmap(page.dataUrl);
      bitmaps.push(bitmap);
    }

    const layout = computeMultiPageLayout(
      bitmaps.map((b) => ({ width: b.width, height: b.height })),
      { gapPx }
    );

    const canvas = document.createElement('canvas');
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg' || gapPx > 0) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    for (const placement of layout.placements) {
      const bitmap = bitmaps[placement.index];
      ctx.drawImage(
        bitmap,
        0,
        0,
        bitmap.width,
        bitmap.height,
        placement.x,
        placement.y,
        placement.width,
        placement.height
      );
    }

    const { dataUrl, mimeType } = await canvasToDataUrl(canvas, format, quality);
    const thumbnailDataUrl = await createThumbnail(canvas);

    return {
      dataUrl,
      thumbnailDataUrl,
      width: layout.width,
      height: layout.height,
      mimeType
    };
  } finally {
    for (const bitmap of bitmaps) {
      bitmap.close();
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return undefined;

  (async () => {
    try {
      switch (message.type) {
        case 'STITCH_VIEWPORTS':
          sendResponse({ ok: true, data: await stitchViewports(message.payload) });
          break;
        case 'STITCH_PAGES':
          sendResponse({ ok: true, data: await stitchPages(message.payload) });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown offscreen message: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
