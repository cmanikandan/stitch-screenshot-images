const btnCaptureFull = document.getElementById('btn-capture-full');
const btnCaptureMulti = document.getElementById('btn-capture-multi');
const btnAppendPage = document.getElementById('btn-append-page');
const btnStitchStaged = document.getElementById('btn-stitch-staged');
const btnClearStaged = document.getElementById('btn-clear-staged');
const btnDownload = document.getElementById('btn-download');
const btnCopy = document.getElementById('btn-copy');
const btnClearCache = document.getElementById('btn-clear-cache');
const btnToggleApiKey = document.getElementById('toggle-api-key');

const stagedCountBadge = document.getElementById('staged-count');
const captureProgress = document.getElementById('capture-progress');
const statusBanner = document.getElementById('status-banner');
const previewSection = document.getElementById('preview-section');
const previewImage = document.getElementById('preview-image');
const previewMeta = document.getElementById('preview-meta');

const settingsForm = document.getElementById('settings-form');
const fmtPng = document.getElementById('fmt-png');
const fmtJpeg = document.getElementById('fmt-jpeg');
const autoCleanCheckbox = document.getElementById('auto-clean');
const maxPagesInput = document.getElementById('max-pages');
const apiKeyInput = document.getElementById('api-key');

let currentLastCapture = null;

/**
 * Send a command message to the background service worker.
 * @param {string} type
 * @param {object} [payload]
 */
async function sendCommand(type, payload) {
  const response = await chrome.runtime.sendMessage({ type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || `Action ${type} failed`);
  }
  return response.data;
}

/**
 * Show a polite status banner message.
 * @param {string} text
 * @param {'info' | 'success' | 'error'} [tone]
 */
function setStatus(text, tone = 'info') {
  if (!text) {
    statusBanner.hidden = true;
    statusBanner.textContent = '';
    delete statusBanner.dataset.tone;
    return;
  }
  statusBanner.hidden = false;
  statusBanner.dataset.tone = tone;
  statusBanner.textContent = text;
}

/**
 * Update busy/progress state across capture action buttons.
 * @param {object} captureStatus
 */
function renderCaptureStatus(captureStatus) {
  const busy = captureStatus?.state === 'capturing';
  btnCaptureFull.disabled = busy;
  btnCaptureMulti.disabled = busy;
  btnAppendPage.disabled = busy;

  if (busy) {
    captureProgress.hidden = false;
    if (captureStatus.totalPages > 1 && captureStatus.currentPage > 0) {
      captureProgress.max = captureStatus.totalPages;
      captureProgress.value = captureStatus.currentPage;
    } else {
      captureProgress.removeAttribute('value');
    }
    if (captureStatus.message) {
      setStatus(captureStatus.message, 'info');
    }
  } else {
    captureProgress.hidden = true;
  }
}

/**
 * Update staged session count badge and buttons.
 * @param {number} count
 * @param {boolean} [busy]
 */
function renderStagedCount(count, busy = false) {
  stagedCountBadge.textContent = `${count} staged`;
  btnStitchStaged.disabled = busy || count === 0;
  btnClearStaged.disabled = busy || count === 0;
}

/**
 * Render preview thumbnail and metadata for the latest captured image.
 * @param {object | null} lastCapture
 */
function renderPreview(lastCapture) {
  currentLastCapture = lastCapture || null;
  if (!lastCapture?.dataUrl) {
    previewSection.hidden = true;
    previewImage.removeAttribute('src');
    previewMeta.textContent = '';
    return;
  }

  previewSection.hidden = false;
  previewImage.src = lastCapture.thumbnailDataUrl || lastCapture.dataUrl;
  const formatLabel = lastCapture.mimeType === 'image/jpeg' ? 'JPEG' : 'PNG';
  const pagesLabel =
    lastCapture.pagesCaptured > 1 ? ` · ${lastCapture.pagesCaptured} pages` : '';
  previewMeta.textContent = `${lastCapture.width}×${lastCapture.height} · ${formatLabel}${pagesLabel}`;
}

/**
 * Populate settings form from stored settings.
 * @param {object} settings
 */
function renderSettings(settings) {
  if (!settings) return;
  fmtPng.checked = settings.format !== 'jpeg';
  fmtJpeg.checked = settings.format === 'jpeg';
  autoCleanCheckbox.checked = settings.autoCleanClutter !== false;
  maxPagesInput.value = String(settings.maxAutoPages ?? 5);
  apiKeyInput.value = settings.apiKey || '';
}

/**
 * Synchronize aria-invalid and aria-describedby error ID with :user-invalid state.
 * @param {HTMLInputElement} el
 */
function syncFieldAria(el) {
  const invalid = el.matches(':user-invalid') || !el.validity.valid;
  const errorId = el.dataset.error;
  const isUserInvalid = el.matches(':user-invalid');

  el.setAttribute('aria-invalid', isUserInvalid ? 'true' : 'false');
  if (errorId) {
    const ids = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (isUserInvalid && invalid) ids.push(errorId);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }
}

/**
 * Convert any image data URL into a PNG Blob suitable for navigator.clipboard.write.
 * @param {string} dataUrl
 * @returns {Promise<Blob>}
 */
async function dataUrlToPngBlob(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;

  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise((resolve, reject) => {
      canvas.toBlob((out) => {
        if (out) resolve(out);
        else reject(new Error('Failed to convert image to PNG for clipboard'));
      }, 'image/png');
    });
  } finally {
    bitmap.close();
  }
}

async function refreshState() {
  const state = await sendCommand('GET_STATE');
  renderSettings(state.settings);
  renderCaptureStatus(state.captureStatus);
  renderStagedCount(state.stagedCount, state.captureStatus?.state === 'capturing');
  renderPreview(state.lastCapture);
}

btnCaptureFull.addEventListener('click', async () => {
  try {
    renderCaptureStatus({ state: 'capturing', message: 'Capturing full page…' });
    const capture = await sendCommand('CAPTURE_FULL_PAGE');
    renderPreview(capture);
    setStatus(`Captured ${capture.width}×${capture.height} image.`, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    await refreshState().catch(() => {});
  }
});

btnCaptureMulti.addEventListener('click', async () => {
  try {
    renderCaptureStatus({ state: 'capturing', message: 'Starting multi-page capture…' });
    const capture = await sendCommand('CAPTURE_MULTI_PAGE');
    renderPreview(capture);
    setStatus(
      `Stitched ${capture.pagesCaptured} page(s) into ${capture.width}×${capture.height} image.`,
      'success'
    );
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    await refreshState().catch(() => {});
  }
});

btnAppendPage.addEventListener('click', async () => {
  try {
    renderCaptureStatus({ state: 'capturing', message: 'Appending current page…' });
    const result = await sendCommand('APPEND_CURRENT_PAGE');
    renderStagedCount(result.stagedCount, false);
    setStatus(`Added page (${result.stagedCount} staged). Navigate to next page or Stitch & Save.`, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    await refreshState().catch(() => {});
  }
});

btnStitchStaged.addEventListener('click', async () => {
  try {
    renderCaptureStatus({ state: 'capturing', message: 'Stitching staged pages…' });
    const capture = await sendCommand('STITCH_STAGED_PAGES');
    renderPreview(capture);
    setStatus(`Stitched staged pages into ${capture.width}×${capture.height} image.`, 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    await refreshState().catch(() => {});
  }
});

btnClearStaged.addEventListener('click', async () => {
  try {
    await sendCommand('CLEAR_STAGED_PAGES');
    renderStagedCount(0, false);
    setStatus('Cleared staged pages.', 'info');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

btnDownload.addEventListener('click', async () => {
  try {
    await sendCommand('DOWNLOAD_LAST_CAPTURE');
    setStatus('Download started.', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

btnCopy.addEventListener('click', async () => {
  if (!currentLastCapture?.dataUrl) return;
  try {
    const pngBlob = await dataUrlToPngBlob(currentLastCapture.dataUrl);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    setStatus('Image copied to clipboard.', 'success');
  } catch (err) {
    setStatus(`Clipboard copy failed: ${err.message}`, 'error');
  }
});

btnToggleApiKey.addEventListener('click', () => {
  const showing = apiKeyInput.type === 'text';
  apiKeyInput.type = showing ? 'password' : 'text';
  btnToggleApiKey.setAttribute('aria-pressed', showing ? 'false' : 'true');
  btnToggleApiKey.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
  btnToggleApiKey.textContent = showing ? 'Show' : 'Hide';
});

maxPagesInput.addEventListener('blur', () => syncFieldAria(maxPagesInput));
maxPagesInput.addEventListener('input', () => syncFieldAria(maxPagesInput));

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!settingsForm.checkValidity()) {
    syncFieldAria(maxPagesInput);
    maxPagesInput.focus();
    setStatus('Please fix invalid settings before saving.', 'error');
    return;
  }

  try {
    const format = fmtJpeg.checked ? 'jpeg' : 'png';
    const autoCleanClutter = autoCleanCheckbox.checked;
    const maxAutoPages = Number.parseInt(maxPagesInput.value, 10);
    const apiKey = apiKeyInput.value.trim();

    await sendCommand('UPDATE_SETTINGS', {
      format,
      autoCleanClutter,
      maxAutoPages,
      apiKey
    });
    setStatus('Settings saved.', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

btnClearCache.addEventListener('click', async () => {
  try {
    await sendCommand('CLEAR_DOMAIN_CACHE');
    setStatus('Cleared cached domain clutter selectors.', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'session' && changes.captureStatus) {
    renderCaptureStatus(changes.captureStatus.newValue);
  }
  if (areaName === 'local' && changes.stagedPages) {
    const count = Array.isArray(changes.stagedPages.newValue)
      ? changes.stagedPages.newValue.length
      : 0;
    renderStagedCount(count, !captureProgress.hidden);
  }
  if (areaName === 'local' && changes.lastCapture) {
    renderPreview(changes.lastCapture.newValue);
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await refreshState();
  } catch (err) {
    setStatus(err.message, 'error');
  }
});
