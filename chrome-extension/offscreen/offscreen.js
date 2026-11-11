import { computeViewportStitchPlan, computeMultiPageLayout } from '../shared/stitch-math.js';

const SESSION_STALE_MS = 10 * 60 * 1000;
const BLOB_URL_TTL_MS = 5 * 60 * 1000;

/** @type {Map<string, { mode: 'viewports' | 'pages', slices: Array<{ bitmap: ImageBitmap, actualScrollY: number, imageWidth: number, imageHeight: number }>, pages: ImageBitmap[], createdAt: number }>} */
const stitchSessions = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} */
const activeBlobTimers = new Map();

/** @type {Blob | null} */
let lastEncodedBlob = null;

/**
 * Release a canvas's backing GPU/RAM buffer immediately.
 * @param {HTMLCanvasElement | null} canvas
 */
function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

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
 * Request a Blob from an HTMLCanvasElement. Returns null if the browser refuses encoding.
 * @param {HTMLCanvasElement} canvas
 * @param {string} mimeType
 * @param {number} [quality]
 * @returns {Promise<Blob | null>}
 */
function tryCanvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(
        (result) => {
          resolve(result || null);
        },
        mimeType,
        mimeType === 'image/jpeg' ? quality : undefined
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Convert a Blob to a data URL via FileReader.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Encode a canvas to a Blob + data URL with automatic downscale fallback if toBlob returns null.
 * @param {HTMLCanvasElement} canvas
 * @param {'png' | 'jpeg'} [format]
 * @param {number} [quality]
 * @param {boolean} [storeAsLastBlob]
 * @returns {Promise<{ dataUrl: string, mimeType: string, width: number, height: number }>}
 */
async function encodeCanvasWithFallback(
  canvas,
  format = 'png',
  quality = 0.92,
  storeAsLastBlob = false
) {
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  let blob = await tryCanvasToBlob(canvas, mimeType, quality);
  let encodedWidth = canvas.width;
  let encodedHeight = canvas.height;

  if (!blob) {
    for (const factor of [0.75, 0.5]) {
      const fallbackCanvas = document.createElement('canvas');
      try {
        const nextW = Math.max(1, Math.round(canvas.width * factor));
        const nextH = Math.max(1, Math.round(canvas.height * factor));
        fallbackCanvas.width = nextW;
        fallbackCanvas.height = nextH;
        const fCtx = fallbackCanvas.getContext('2d');
        if (format === 'jpeg') {
          fCtx.fillStyle = '#ffffff';
          fCtx.fillRect(0, 0, nextW, nextH);
        }
        fCtx.imageSmoothingEnabled = true;
        fCtx.imageSmoothingQuality = 'high';
        fCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, nextW, nextH);

        blob = await tryCanvasToBlob(fallbackCanvas, mimeType, quality);
        if (blob) {
          encodedWidth = nextW;
          encodedHeight = nextH;
          break;
        }
      } finally {
        releaseCanvas(fallbackCanvas);
      }
    }
  }

  if (!blob) {
    throw new Error('Canvas encoding produced null blob');
  }

  if (storeAsLastBlob) {
    lastEncodedBlob = blob;
  }

  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, mimeType, width: encodedWidth, height: encodedHeight };
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
  try {
    thumbCanvas.width = thumbW;
    thumbCanvas.height = thumbH;
    const ctx = thumbCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, thumbW, thumbH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(sourceCanvas, 0, 0, srcW, srcH, 0, 0, thumbW, thumbH);

    const { dataUrl } = await encodeCanvasWithFallback(thumbCanvas, 'jpeg', 0.85, false);
    return dataUrl;
  } finally {
    releaseCanvas(thumbCanvas);
  }
}

/**
 * Render already-decoded viewport slice ImageBitmaps onto a single stitched canvas.
 */
async function renderViewportBitmaps(
  bitmaps,
  { scrollHeight, viewportHeight, dpr = 1, format = 'png', quality = 0.92 }
) {
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
  try {
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

    const thumbnailDataUrl = await createThumbnail(canvas);
    const { dataUrl, mimeType, width, height } = await encodeCanvasWithFallback(
      canvas,
      format,
      quality,
      true
    );

    return {
      dataUrl,
      thumbnailDataUrl,
      width,
      height,
      mimeType
    };
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * Render already-decoded full-page ImageBitmaps vertically onto a single continuous canvas.
 */
async function renderPageBitmaps(bitmaps, { format = 'png', quality = 0.92, gapPx = 0 }) {
  const layout = computeMultiPageLayout(
    bitmaps.map((b) => ({ width: b.width, height: b.height })),
    { gapPx }
  );

  const hasSideMargins = layout.placements.some((p) => p.x > 0 || p.width < layout.width);

  const canvas = document.createElement('canvas');
  try {
    canvas.width = layout.width;
    canvas.height = layout.height;
    const ctx = canvas.getContext('2d');
    if (format === 'jpeg' || gapPx > 0 || hasSideMargins) {
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

    const thumbnailDataUrl = await createThumbnail(canvas);
    const { dataUrl, mimeType, width, height } = await encodeCanvasWithFallback(
      canvas,
      format,
      quality,
      true
    );

    return {
      dataUrl,
      thumbnailDataUrl,
      width,
      height,
      mimeType
    };
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * Stitch viewport screenshot slices passed in a single payload.
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
    return await renderViewportBitmaps(bitmaps, {
      scrollHeight,
      viewportHeight,
      dpr,
      format,
      quality
    });
  } finally {
    for (const entry of bitmaps) {
      entry.bitmap.close();
    }
  }
}

/**
 * Vertically stack multiple captured full-page images passed in a single payload.
 */
async function stitchPages({ pages, format = 'png', quality = 0.92, gapPx = 0 }) {
  const bitmaps = [];
  try {
    for (const page of pages) {
      const bitmap = await dataUrlToBitmap(page.dataUrl);
      bitmaps.push(bitmap);
    }
    return await renderPageBitmaps(bitmaps, { format, quality, gapPx });
  } finally {
    for (const bitmap of bitmaps) {
      bitmap.close();
    }
  }
}

/**
 * Close all ImageBitmaps held by a streaming stitch session and remove it.
 * @param {string} sessionId
 */
function cleanupSession(sessionId) {
  const session = stitchSessions.get(sessionId);
  if (!session) return;
  for (const entry of session.slices) {
    try {
      entry.bitmap.close();
    } catch {
      // Ignore already-closed bitmap
    }
  }
  for (const bmp of session.pages) {
    try {
      bmp.close();
    } catch {
      // Ignore already-closed bitmap
    }
  }
  stitchSessions.delete(sessionId);
}

/**
 * Start a streaming stitch session to avoid large single-message IPC payloads.
 */
function beginStitch({ sessionId, mode = 'viewports' } = {}) {
  if (!sessionId) {
    throw new Error('sessionId is required for BEGIN_STITCH');
  }
  const now = Date.now();
  for (const [id, existing] of stitchSessions.entries()) {
    if (id === sessionId || now - existing.createdAt > SESSION_STALE_MS) {
      cleanupSession(id);
    }
  }
  stitchSessions.set(sessionId, {
    mode: mode === 'pages' ? 'pages' : 'viewports',
    slices: [],
    pages: [],
    createdAt: now
  });
  return { sessionId };
}

/**
 * Push a single viewport slice into an active streaming stitch session.
 */
async function pushSlice({ sessionId, dataUrl, actualScrollY = 0 } = {}) {
  const session = stitchSessions.get(sessionId);
  if (!session || session.mode !== 'viewports') {
    throw new Error(`Active viewport stitch session not found: ${sessionId}`);
  }
  const bitmap = await dataUrlToBitmap(dataUrl);
  session.slices.push({
    bitmap,
    actualScrollY,
    imageWidth: bitmap.width,
    imageHeight: bitmap.height
  });
  return {
    count: session.slices.length,
    width: bitmap.width,
    height: bitmap.height
  };
}

/**
 * Push a single full-page image into an active multi-page stitch session.
 */
async function pushPage({ sessionId, dataUrl } = {}) {
  const session = stitchSessions.get(sessionId);
  if (!session || session.mode !== 'pages') {
    throw new Error(`Active page stitch session not found: ${sessionId}`);
  }
  const bitmap = await dataUrlToBitmap(dataUrl);
  session.pages.push(bitmap);
  return {
    count: session.pages.length,
    width: bitmap.width,
    height: bitmap.height
  };
}

/**
 * Finalize and render an active streaming stitch session.
 */
async function commitStitch({
  sessionId,
  scrollHeight,
  viewportHeight,
  dpr = 1,
  format = 'png',
  quality = 0.92,
  gapPx = 0
} = {}) {
  const session = stitchSessions.get(sessionId);
  if (!session) {
    throw new Error(`Stitch session not found: ${sessionId}`);
  }

  try {
    if (session.mode === 'pages') {
      if (session.pages.length === 0) {
        throw new Error('No pages pushed to stitch session');
      }
      return await renderPageBitmaps(session.pages, { format, quality, gapPx });
    }

    if (session.slices.length === 0) {
      throw new Error('No slices pushed to stitch session');
    }
    return await renderViewportBitmaps(session.slices, {
      scrollHeight,
      viewportHeight,
      dpr,
      format,
      quality
    });
  } finally {
    cleanupSession(sessionId);
  }
}

/**
 * Create a short blob: URL from a data URL or the most recently encoded Blob.
 */
async function createBlobUrl({ dataUrl } = {}) {
  let blob = null;
  if (typeof dataUrl === 'string' && dataUrl) {
    const res = await fetch(dataUrl);
    blob = await res.blob();
  } else if (lastEncodedBlob) {
    blob = lastEncodedBlob;
  }

  if (!blob) {
    throw new Error('No image data available to create Blob URL');
  }

  const blobUrl = URL.createObjectURL(blob);
  const timer = setTimeout(() => {
    activeBlobTimers.delete(blobUrl);
    URL.revokeObjectURL(blobUrl);
  }, BLOB_URL_TTL_MS);
  activeBlobTimers.set(blobUrl, timer);

  return { blobUrl };
}

/**
 * Revoke a previously created blob: URL immediately.
 */
function revokeBlobUrl({ blobUrl } = {}) {
  if (typeof blobUrl === 'string' && blobUrl) {
    const timer = activeBlobTimers.get(blobUrl);
    if (timer) {
      clearTimeout(timer);
      activeBlobTimers.delete(blobUrl);
    }
    URL.revokeObjectURL(blobUrl);
  }
  return { revoked: true };
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
        case 'BEGIN_STITCH':
          sendResponse({ ok: true, data: beginStitch(message.payload) });
          break;
        case 'PUSH_SLICE':
          sendResponse({ ok: true, data: await pushSlice(message.payload) });
          break;
        case 'PUSH_PAGE':
          sendResponse({ ok: true, data: await pushPage(message.payload) });
          break;
        case 'COMMIT_STITCH':
          sendResponse({ ok: true, data: await commitStitch(message.payload) });
          break;
        case 'ABORT_STITCH':
          cleanupSession(message.payload?.sessionId);
          sendResponse({ ok: true, data: { aborted: true } });
          break;
        case 'CREATE_BLOB_URL':
          sendResponse({ ok: true, data: await createBlobUrl(message.payload) });
          break;
        case 'REVOKE_BLOB_URL':
          sendResponse({ ok: true, data: revokeBlobUrl(message.payload) });
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
