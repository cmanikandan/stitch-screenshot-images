import { computeScrollOffsets, scoreNextPageCandidates, sanitizeCssSelectors } from '../shared/stitch-math.js';
import {
  detectClutterSelectors,
  detectNextPageUrl,
  getCachedSelectorsForDomain,
  setCachedSelectorsForDomain,
  clearDomainSelectorCache
} from '../shared/gemini-client.js';

const DEFAULT_SETTINGS = {
  apiKey: '',
  format: 'png',
  jpegQuality: 0.92,
  autoCleanClutter: true,
  maxAutoPages: 5
};

const HEURISTIC_CLUTTER_SELECTORS = [
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '.cc-window',
  '.cookie-banner',
  '.cookie-consent',
  '#intercom-container',
  '#hubspot-messages-iframe-container',
  '.drift-frame-controller',
  '[aria-label*="cookie" i][role="dialog"]',
  '[aria-label*="consent" i][role="dialog"]'
];

const OVERLAY_CLUTTER_RE =
  /\b(cookie|consent|gdpr|onetrust|cookiebot|newsletter|subscribe|intercom|hubspot|drift|chat-widget|promo-bar|toast|snackbar|ad-banner|advert)\b/i;

const CAPTURE_MIN_INTERVAL_MS = 560;

/**
 * Pause execution for a given number of milliseconds.
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read persisted extension settings with defaults.
 */
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/**
 * Update session capture progress/lock state.
 * @param {object} status
 */
async function setCaptureStatus(status) {
  await chrome.storage.session.set({
    captureStatus: {
      state: 'idle',
      message: '',
      currentPage: 0,
      totalPages: 0,
      ...status
    }
  });
}

/**
 * Read current capture status from session storage.
 */
async function getCaptureStatus() {
  const { captureStatus } = await chrome.storage.session.get('captureStatus');
  return (
    captureStatus || {
      state: 'idle',
      message: '',
      currentPage: 0,
      totalPages: 0
    }
  );
}

/**
 * Ensure the offscreen canvas document is open.
 */
async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');

  if (typeof chrome.runtime.getContexts === 'function') {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (existing.length > 0) return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Stitch full-page and multi-page screenshots onto an offscreen canvas.'
    });
  } catch (err) {
    if (!String(err?.message || err).includes('Only a single offscreen document')) {
      throw err;
    }
  }
}

/**
 * Send a message to the offscreen document and verify response.
 * @param {string} type
 * @param {object} payload
 */
async function sendToOffscreen(type, payload) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type,
    payload
  });
  if (!response?.ok) {
    throw new Error(response?.error || `Offscreen command ${type} failed`);
  }
  return response.data;
}

/**
 * Validate that a tab can be scripted and captured.
 * @param {chrome.tabs.Tab} tab
 */
function assertCapturableTab(tab) {
  if (!tab?.id || !tab.url) {
    throw new Error('No active browser tab found.');
  }
  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    throw new Error('Active tab URL is not valid.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Cannot capture ${parsed.protocol} pages. Open a standard http/https webpage.`);
  }
  if (
    parsed.hostname === 'chromewebstore.google.com' ||
    parsed.hostname === 'chrome.google.com'
  ) {
    throw new Error('Chrome Web Store pages cannot be scripted by extensions.');
  }
}

/**
 * Ensure content/page-inspector.js is injected into the target tab.
 * @param {number} tabId
 */
async function ensureInspectorInjected(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (pong?.ok) return;
  } catch {
    // Content script not present yet; inject below.
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/page-inspector.js']
  });
}

/**
 * Send a command to the page inspector content script.
 * @param {number} tabId
 * @param {string} type
 * @param {object} [payload]
 */
async function sendToInspector(tabId, type, payload = {}) {
  const response = await chrome.tabs.sendMessage(tabId, { type, payload });
  if (!response?.ok) {
    throw new Error(response?.error || `Page inspector ${type} failed`);
  }
  return response.data;
}

/**
 * Enforce Chrome's captureVisibleTab rate limit using session storage timestamp.
 * @param {number} windowId
 */
async function captureVisibleTabRateLimited(windowId) {
  const { lastVisibleCaptureAt = 0 } = await chrome.storage.session.get('lastVisibleCaptureAt');
  const elapsed = Date.now() - lastVisibleCaptureAt;
  if (elapsed < CAPTURE_MIN_INTERVAL_MS) {
    await delay(CAPTURE_MIN_INTERVAL_MS - elapsed);
  }
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  await chrome.storage.session.set({ lastVisibleCaptureAt: Date.now() });
  return dataUrl;
}

/**
 * Determine temporary CSS clutter selectors using heuristics + optional Gemini domain cache.
 * @param {object} inspection
 * @param {object} settings
 * @returns {Promise<string[]>}
 */
async function resolveClutterSelectors(inspection, settings) {
  if (!settings.autoCleanClutter) return [];

  const overlays = Array.isArray(inspection?.overlays) ? inspection.overlays : [];
  const hostname = inspection?.pageMetrics?.hostname || '';
  const heuristicMatches = new Set(HEURISTIC_CLUTTER_SELECTORS);

  for (const ov of overlays) {
    const meta = `${ov.id || ''} ${ov.classes || ''} ${ov.textSample || ''}`;
    if (OVERLAY_CLUTTER_RE.test(meta) && ov.selector) {
      heuristicMatches.add(ov.selector);
    }
  }

  let geminiSelectors = [];
  if (settings.apiKey && hostname && overlays.length > 0) {
    try {
      const cached = await getCachedSelectorsForDomain(chrome.storage.local, hostname);
      if (cached) {
        geminiSelectors = cached;
      } else {
        geminiSelectors = await detectClutterSelectors(settings.apiKey, {
          hostname,
          viewportWidth: inspection.pageMetrics.viewportWidth,
          viewportHeight: inspection.pageMetrics.viewportHeight,
          overlays
        });
        await setCachedSelectorsForDomain(chrome.storage.local, hostname, geminiSelectors);
      }
    } catch (err) {
      console.warn('Gemini clutter detection failed, continuing with heuristics:', err.message);
    }
  }

  return sanitizeCssSelectors([...heuristicMatches, ...geminiSelectors]);
}

/**
 * Capture a full scrollable tab and return its stitched image + page metadata.
 * @param {object} params
 * @param {number} params.tabId
 * @param {number} params.windowId
 * @param {object} params.settings
 * @param {'png' | 'jpeg'} [params.outputFormat]
 * @param {number} [params.pageNumber]
 */
async function captureFullTab({ tabId, windowId, settings, outputFormat = 'png', pageNumber = 1 }) {
  await ensureInspectorInjected(tabId);
  const inspection = await sendToInspector(tabId, 'INSPECT_PAGE');
  const cleanupSelectors = await resolveClutterSelectors(inspection, settings);

  let stitched;
  try {
    const preparedMetrics = await sendToInspector(tabId, 'PREPARE_CAPTURE', {
      cleanupSelectors,
      hideScrollbars: true
    });

    const { offsets } = computeScrollOffsets({
      scrollHeight: preparedMetrics.scrollHeight,
      viewportHeight: preparedMetrics.viewportHeight
    });

    const slices = [];
    for (let i = 0; i < offsets.length; i++) {
      const targetY = offsets[i];
      const scrollResult = await sendToInspector(tabId, 'SCROLL_AND_HIDE_FIXED', {
        y: targetY,
        hideFixed: i > 0
      });

      const dataUrl = await captureVisibleTabRateLimited(windowId);
      slices.push({
        dataUrl,
        actualScrollY: scrollResult.actualScrollY
      });
    }

    stitched = await sendToOffscreen('STITCH_VIEWPORTS', {
      slices,
      scrollHeight: preparedMetrics.scrollHeight,
      viewportHeight: preparedMetrics.viewportHeight,
      dpr: preparedMetrics.dpr,
      format: outputFormat,
      quality: settings.jpegQuality
    });
  } finally {
    try {
      await sendToInspector(tabId, 'RESTORE_PAGE', { restoreScroll: pageNumber === 1 });
    } catch {
      // Tab may have navigated or closed.
    }
  }

  return {
    ...stitched,
    url: inspection.pageMetrics.url,
    nextCandidates: inspection.nextCandidates
  };
}

/**
 * Build a safe export filename for the captured image.
 * @param {string} rawUrl
 * @param {'png' | 'jpeg'} format
 * @param {boolean} [isMulti]
 */
function buildFilename(rawUrl, format, isMulti = false) {
  let host = 'page';
  try {
    host = new URL(rawUrl).hostname.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-|-$/g, '') || 'page';
  } catch {
    host = 'page';
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const suffix = isMulti ? '-stitched' : '';
  return `pagestitch-${host}${suffix}-${stamp}.${ext}`;
}

/**
 * Navigate a tab to a URL and wait until load completes.
 * @param {number} tabId
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function navigateAndWait(tabId, url, timeoutMs = 25000) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Timed out waiting for ${url} to load`));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete' && !settled) {
        settled = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    (async () => {
      try {
        await chrome.tabs.update(tabId, { url });
      } catch (err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          reject(err);
        }
      }
    })();
  });

  // Brief settle for post-load layout/lazy images
  await delay(650);
}

/**
 * Resolve the next-page URL using Gemini (when API key configured) with heuristic fallback.
 * @param {object} params
 */
async function resolveNextPage({ settings, currentUrl, pageNumber, nextCandidates }) {
  if (settings.apiKey && Array.isArray(nextCandidates) && nextCandidates.length > 0) {
    try {
      const aiResult = await detectNextPageUrl(settings.apiKey, {
        currentUrl,
        pageNumber,
        nextCandidates
      });
      if (aiResult?.nextPageUrl && aiResult.confidence !== 'low') {
        return aiResult.nextPageUrl;
      }
    } catch (err) {
      console.warn('Gemini next-page detection failed, falling back to heuristics:', err.message);
    }
  }

  const heuristic = scoreNextPageCandidates(nextCandidates, currentUrl);
  return heuristic?.url || null;
}

/**
 * Get the currently active tab in the last focused normal window.
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  assertCapturableTab(tab);
  return tab;
}

/**
 * Run single full-page capture workflow.
 */
async function handleCaptureFullPage() {
  const currentStatus = await getCaptureStatus();
  if (currentStatus.state === 'capturing') {
    throw new Error('A capture is already in progress.');
  }

  const tab = await getActiveTab();
  const settings = await getSettings();

  await setCaptureStatus({
    state: 'capturing',
    message: 'Capturing full page…',
    currentPage: 1,
    totalPages: 1
  });

  try {
    const result = await captureFullTab({
      tabId: tab.id,
      windowId: tab.windowId,
      settings,
      outputFormat: settings.format,
      pageNumber: 1
    });

    const lastCapture = {
      dataUrl: result.dataUrl,
      thumbnailDataUrl: result.thumbnailDataUrl,
      width: result.width,
      height: result.height,
      mimeType: result.mimeType,
      filename: buildFilename(result.url, settings.format, false),
      timestamp: Date.now()
    };

    await chrome.storage.local.set({ lastCapture });
    return lastCapture;
  } finally {
    await setCaptureStatus({ state: 'idle', message: '', currentPage: 0, totalPages: 0 });
  }
}

/**
 * Capture current tab and append it to staged multi-page session in chrome.storage.local.
 */
async function handleAppendCurrentPage() {
  const currentStatus = await getCaptureStatus();
  if (currentStatus.state === 'capturing') {
    throw new Error('A capture is already in progress.');
  }

  const tab = await getActiveTab();
  const settings = await getSettings();

  await setCaptureStatus({
    state: 'capturing',
    message: 'Capturing page for multi-page session…',
    currentPage: 1,
    totalPages: 1
  });

  try {
    const result = await captureFullTab({
      tabId: tab.id,
      windowId: tab.windowId,
      settings,
      outputFormat: 'png',
      pageNumber: 1
    });

    const { stagedPages = [] } = await chrome.storage.local.get('stagedPages');
    const updated = [
      ...stagedPages,
      {
        id: `${Date.now()}-${stagedPages.length + 1}`,
        url: result.url,
        width: result.width,
        height: result.height,
        dataUrl: result.dataUrl
      }
    ];

    await chrome.storage.local.set({ stagedPages: updated });
    await chrome.action.setBadgeText({ text: String(updated.length) });
    await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });

    return {
      stagedCount: updated.length,
      thumbnailDataUrl: result.thumbnailDataUrl
    };
  } finally {
    await setCaptureStatus({ state: 'idle', message: '', currentPage: 0, totalPages: 0 });
  }
}

/**
 * Stitch all staged pages into one vertical PNG/JPEG image.
 */
async function handleStitchStagedPages() {
  const currentStatus = await getCaptureStatus();
  if (currentStatus.state === 'capturing') {
    throw new Error('A capture is already in progress.');
  }

  const { stagedPages = [] } = await chrome.storage.local.get('stagedPages');
  if (stagedPages.length === 0) {
    throw new Error('No staged pages to stitch.');
  }

  const settings = await getSettings();
  await setCaptureStatus({
    state: 'capturing',
    message: `Stitching ${stagedPages.length} staged pages…`,
    currentPage: stagedPages.length,
    totalPages: stagedPages.length
  });

  try {
    const stitched = await sendToOffscreen('STITCH_PAGES', {
      pages: stagedPages.map((p) => ({
        dataUrl: p.dataUrl,
        width: p.width,
        height: p.height
      })),
      format: settings.format,
      quality: settings.jpegQuality,
      gapPx: 0
    });

    const lastCapture = {
      dataUrl: stitched.dataUrl,
      thumbnailDataUrl: stitched.thumbnailDataUrl,
      width: stitched.width,
      height: stitched.height,
      mimeType: stitched.mimeType,
      filename: buildFilename(stagedPages[0].url, settings.format, stagedPages.length > 1),
      timestamp: Date.now()
    };

    await chrome.storage.local.set({ lastCapture });
    return lastCapture;
  } finally {
    await setCaptureStatus({ state: 'idle', message: '', currentPage: 0, totalPages: 0 });
  }
}

/**
 * Clear staged pages session.
 */
async function handleClearStagedPages() {
  await chrome.storage.local.set({ stagedPages: [] });
  await chrome.action.setBadgeText({ text: '' });
  return { stagedCount: 0 };
}

/**
 * Auto-capture a multi-page paginated article into one continuous stitched image.
 */
async function handleCaptureMultiPage() {
  const currentStatus = await getCaptureStatus();
  if (currentStatus.state === 'capturing') {
    throw new Error('A capture is already in progress.');
  }

  const tab = await getActiveTab();
  const settings = await getSettings();
  const maxPages = Math.max(2, Math.min(15, Number(settings.maxAutoPages) || 5));
  const startOrigin = new URL(tab.url).origin;

  const capturedPages = [];
  const visitedUrls = new Set();

  await setCaptureStatus({
    state: 'capturing',
    message: `Capturing page 1 of up to ${maxPages}…`,
    currentPage: 1,
    totalPages: maxPages
  });

  try {
    let currentUrl = tab.url;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const normalizedCurrent = currentUrl.split('#')[0];
      if (visitedUrls.has(normalizedCurrent)) break;
      visitedUrls.add(normalizedCurrent);

      await setCaptureStatus({
        state: 'capturing',
        message: `Capturing page ${pageNum} (max ${maxPages})…`,
        currentPage: pageNum,
        totalPages: maxPages
      });

      const pageCapture = await captureFullTab({
        tabId: tab.id,
        windowId: tab.windowId,
        settings,
        outputFormat: 'png',
        pageNumber: pageNum
      });

      capturedPages.push({
        url: pageCapture.url,
        width: pageCapture.width,
        height: pageCapture.height,
        dataUrl: pageCapture.dataUrl
      });

      if (pageNum >= maxPages) break;

      const nextUrl = await resolveNextPage({
        settings,
        currentUrl: pageCapture.url,
        pageNumber: pageNum,
        nextCandidates: pageCapture.nextCandidates
      });

      if (!nextUrl) break;

      let nextOrigin = '';
      try {
        nextOrigin = new URL(nextUrl).origin;
      } catch {
        break;
      }

      if (nextOrigin !== startOrigin) break;
      if (visitedUrls.has(nextUrl.split('#')[0])) break;

      await setCaptureStatus({
        state: 'capturing',
        message: `Loading page ${pageNum + 1}…`,
        currentPage: pageNum + 1,
        totalPages: maxPages
      });

      await navigateAndWait(tab.id, nextUrl);
      currentUrl = nextUrl;
    }

    await setCaptureStatus({
      state: 'capturing',
      message: `Stitching ${capturedPages.length} page(s) into final image…`,
      currentPage: capturedPages.length,
      totalPages: capturedPages.length
    });

    const stitched = await sendToOffscreen('STITCH_PAGES', {
      pages: capturedPages.map((p) => ({
        dataUrl: p.dataUrl,
        width: p.width,
        height: p.height
      })),
      format: settings.format,
      quality: settings.jpegQuality,
      gapPx: 0
    });

    const lastCapture = {
      dataUrl: stitched.dataUrl,
      thumbnailDataUrl: stitched.thumbnailDataUrl,
      width: stitched.width,
      height: stitched.height,
      mimeType: stitched.mimeType,
      filename: buildFilename(capturedPages[0].url, settings.format, capturedPages.length > 1),
      pagesCaptured: capturedPages.length,
      timestamp: Date.now()
    };

    await chrome.storage.local.set({ lastCapture });
    return lastCapture;
  } finally {
    await setCaptureStatus({ state: 'idle', message: '', currentPage: 0, totalPages: 0 });
  }
}

/**
 * Trigger chrome.downloads.download for the latest captured image.
 */
async function handleDownloadLastCapture() {
  const { lastCapture } = await chrome.storage.local.get('lastCapture');
  if (!lastCapture?.dataUrl) {
    throw new Error('No captured image available to download.');
  }

  const downloadId = await chrome.downloads.download({
    url: lastCapture.dataUrl,
    filename: lastCapture.filename || 'pagestitch-capture.png',
    saveAs: true
  });

  return { downloadId };
}

/**
 * Return current UI state from chrome.storage.
 */
async function handleGetState() {
  const settings = await getSettings();
  const { stagedPages = [], lastCapture = null } = await chrome.storage.local.get([
    'stagedPages',
    'lastCapture'
  ]);
  const captureStatus = await getCaptureStatus();

  return {
    settings,
    stagedCount: stagedPages.length,
    captureStatus,
    lastCapture: lastCapture
      ? {
          thumbnailDataUrl: lastCapture.thumbnailDataUrl || lastCapture.dataUrl,
          dataUrl: lastCapture.dataUrl,
          width: lastCapture.width,
          height: lastCapture.height,
          mimeType: lastCapture.mimeType,
          filename: lastCapture.filename,
          pagesCaptured: lastCapture.pagesCaptured || 1,
          timestamp: lastCapture.timestamp
        }
      : null
  };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      settings: DEFAULT_SETTINGS,
      stagedPages: []
    });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen') return undefined;

  (async () => {
    try {
      switch (message?.type) {
        case 'GET_STATE':
          sendResponse({ ok: true, data: await handleGetState() });
          break;
        case 'CAPTURE_FULL_PAGE':
          sendResponse({ ok: true, data: await handleCaptureFullPage() });
          break;
        case 'CAPTURE_MULTI_PAGE':
          sendResponse({ ok: true, data: await handleCaptureMultiPage() });
          break;
        case 'APPEND_CURRENT_PAGE':
          sendResponse({ ok: true, data: await handleAppendCurrentPage() });
          break;
        case 'STITCH_STAGED_PAGES':
          sendResponse({ ok: true, data: await handleStitchStagedPages() });
          break;
        case 'CLEAR_STAGED_PAGES':
          sendResponse({ ok: true, data: await handleClearStagedPages() });
          break;
        case 'DOWNLOAD_LAST_CAPTURE':
          sendResponse({ ok: true, data: await handleDownloadLastCapture() });
          break;
        case 'UPDATE_SETTINGS': {
          const current = await getSettings();
          const next = {
            ...current,
            ...(message.payload || {}),
            maxAutoPages: Math.max(
              2,
              Math.min(15, Number(message.payload?.maxAutoPages ?? current.maxAutoPages) || 5)
            )
          };
          await chrome.storage.local.set({ settings: next });
          sendResponse({ ok: true, data: next });
          break;
        }
        case 'CLEAR_DOMAIN_CACHE':
          await clearDomainSelectorCache(chrome.storage.local);
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();

  return true;
});
