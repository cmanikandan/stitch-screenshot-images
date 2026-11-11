import {
  DEFAULT_MAX_SCROLL_CSS_HEIGHT,
  scoreNextPageCandidates,
  sanitizeCssSelectors
} from '../shared/stitch-math.js';
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
  // Google AdSense / GPT / DoubleClick
  'ins.adsbygoogle',
  '.adsbygoogle',
  '.google-auto-placed',
  '[id^="div-gpt-ad"]',
  '[id^="google_ads_iframe"]',
  'iframe[id^="google_ads_iframe"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="2mdn.net"]',
  'iframe[src*="adservice.google."]',
  '[data-google-query-id]',
  '[data-ad-client]',
  '[data-ad-slot]',
  // Native & programmatic ad widgets
  '[id^="taboola-"]',
  '[class*="taboola-"]',
  '.trc_rbox_container',
  '.OUTBRAIN',
  '[data-widget-id^="outbrain"]',
  '[id^="outbrain_widget"]',
  '[id^="mgid"]',
  'iframe[src*="criteo."]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="rubiconproject.com"]',
  'iframe[src*="pubmatic.com"]',
  'iframe[src*="openx.net"]',
  'iframe[src*="taboola.com"]',
  'iframe[src*="outbrain.com"]',
  // Publisher ad wrappers
  '.mv-ad-box',
  '[class*="mv-ad-"]',
  '.adthrive-ad',
  '[class*="adthrive-"]',
  '[data-freestar-ad]',
  '[id^="ezoic-pub-ad-placeholder"]',
  '.ezoic-ad',
  'amp-ad',
  'amp-sticky-ad',
  '[data-ad-unit]',
  '[data-ad-name]',
  '[data-ad-region]',
  '[data-testid="ad-slot"]',
  '[data-testid="ad-container"]',
  '[aria-label="Advertisement" i]',
  '[aria-label="Sponsored" i]',
  // Cookie, consent & chat overlays
  '#onetrust-banner-sdk',
  '#onetrust-consent-sdk',
  '#CybotCookiebotDialog',
  '.cc-window',
  '.cookie-banner',
  '.cookie-consent',
  '#didomi-host',
  '#sp_message_container',
  '[id^="sp_message_container"]',
  '.qc-cmp2-container',
  '#intercom-container',
  '#hubspot-messages-iframe-container',
  '.drift-frame-controller',
  '[aria-label*="cookie" i][role="dialog"]',
  '[aria-label*="consent" i][role="dialog"]'
];

const OVERLAY_CLUTTER_RE =
  /\b(cookie|consent|gdpr|onetrust|cookiebot|didomi|newsletter|subscribe|intercom|hubspot|drift|chat-widget|promo-bar|toast|snackbar|ad-banner|ad-slot|advert|sponsored|taboola|outbrain)\b/i;

const HEADER_SAFE_CLUTTER_RE =
  /\b(cookie|consent|gdpr|onetrust|cookiebot|didomi|promo-bar|ad-banner)\b/i;

const CAPTURE_MIN_INTERVAL_MS = 560;
const CAPTURE_LOCK_STALE_MS = 45000;
const STAGED_PAGE_KEY_PREFIX = 'stagedPage:';

/**
 * Pause execution for a given number of milliseconds.
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a unique streaming session ID for offscreen stitching.
 * @param {string} prefix
 */
function makeSessionId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize a URL without fragment for visited-page loop detection.
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeUrlKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const cleanPath = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    return `${u.origin}${cleanPath}${u.search}`;
  } catch {
    return String(rawUrl || '').split('#')[0];
  }
}

/**
 * Read persisted extension settings with defaults.
 */
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

/**
 * Read lightweight staged page count without loading multi-megabyte data URLs.
 * @returns {Promise<number>}
 */
async function getStagedCount() {
  const data = await chrome.storage.local.get('stagedMeta');
  if (Array.isArray(data.stagedMeta)) {
    return data.stagedMeta.length;
  }
  const legacy = await chrome.storage.local.get('stagedPages');
  return Array.isArray(legacy.stagedPages) ? legacy.stagedPages.length : 0;
}

/**
 * Sync toolbar badge text/color with active capture progress, error state, or staged page count.
 * @param {object} [status]
 */
async function syncActionBadge(status) {
  try {
    if (status?.state === 'capturing') {
      const badgeText =
        status.totalPages > 1 && status.currentPage > 0
          ? `${status.currentPage}/${status.totalPages}`
          : '…';
      await chrome.action.setBadgeText({ text: badgeText });
      await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
      return;
    }

    if (status?.state === 'error') {
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' });
      return;
    }

    const stagedCount = await getStagedCount();
    if (stagedCount > 0) {
      await chrome.action.setBadgeText({ text: String(stagedCount) });
      await chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
    } else {
      await chrome.action.setBadgeText({ text: '' });
    }
  } catch {
    // Ignore badge errors during browser shutdown
  }
}

/**
 * Update session capture progress/lock state with an updatedAt heartbeat.
 * @param {object} status
 */
async function setCaptureStatus(status) {
  const nextStatus = {
    state: 'idle',
    message: '',
    currentPage: 0,
    totalPages: 0,
    updatedAt: Date.now(),
    ...status
  };
  await chrome.storage.session.set({ captureStatus: nextStatus });
  await syncActionBadge(nextStatus);
}

/**
 * Refresh the updatedAt heartbeat on an active capture lock.
 * @param {string} [message]
 */
async function touchCaptureHeartbeat(message) {
  const { captureStatus } = await chrome.storage.session.get('captureStatus');
  if (captureStatus?.state !== 'capturing') return;
  const updated = {
    ...captureStatus,
    ...(typeof message === 'string' && message ? { message } : {}),
    updatedAt: Date.now()
  };
  await chrome.storage.session.set({ captureStatus: updated });
}

/**
 * Read current capture status from session storage, auto-expiring stale capturing locks > 45s.
 */
async function getCaptureStatus() {
  const { captureStatus } = await chrome.storage.session.get('captureStatus');
  if (!captureStatus) {
    return {
      state: 'idle',
      message: '',
      currentPage: 0,
      totalPages: 0,
      updatedAt: 0
    };
  }

  if (
    captureStatus.state === 'capturing' &&
    Date.now() - (captureStatus.updatedAt || 0) > CAPTURE_LOCK_STALE_MS
  ) {
    const expiredStatus = {
      state: 'idle',
      message: '',
      currentPage: 0,
      totalPages: 0,
      updatedAt: Date.now()
    };
    await chrome.storage.session.set({
      captureStatus: expiredStatus,
      cancelRequested: false
    });
    await syncActionBadge(expiredStatus);
    return expiredStatus;
  }

  return captureStatus;
}

/**
 * Acquire capture lock or throw if a live capture is already running.
 * @param {object} initialStatus
 */
async function acquireCaptureLock(initialStatus) {
  const currentStatus = await getCaptureStatus();
  if (currentStatus.state === 'capturing') {
    throw new Error('A capture is already in progress.');
  }
  await chrome.storage.session.set({ cancelRequested: false });
  await setCaptureStatus({
    state: 'capturing',
    ...initialStatus
  });
}

/**
 * Release capture lock cleanly, persisting error messages when an uncancelled error occurred.
 * @param {any} [err]
 */
async function finalizeCaptureLock(err = null) {
  await chrome.storage.session.set({ cancelRequested: false });
  if (!err || err?.isCancelled) {
    await setCaptureStatus({
      state: 'idle',
      message: '',
      currentPage: 0,
      totalPages: 0
    });
    return;
  }

  await setCaptureStatus({
    state: 'error',
    message: err?.message || 'Capture failed.',
    currentPage: 0,
    totalPages: 0
  });
}

/**
 * Throw a cancellation error if the user clicked Cancel Capture.
 */
async function throwIfCancelled() {
  const { cancelRequested = false } = await chrome.storage.session.get('cancelRequested');
  if (cancelRequested) {
    const err = new Error('Capture cancelled.');
    err.isCancelled = true;
    throw err;
  }
}

/**
 * Request cancellation of the currently running capture.
 */
async function handleCancelCapture() {
  await chrome.storage.session.set({ cancelRequested: true });
  const current = await getCaptureStatus();
  if (current.state === 'capturing') {
    await setCaptureStatus({
      ...current,
      message: 'Cancelling capture…'
    });
  }
  return { cancelled: true };
}

/**
 * Persist latest capture along with lightweight metadata (omitting heavy dataUrl for GET_STATE).
 * @param {object} fullCapture
 */
async function saveLastCapture(fullCapture) {
  const lastCaptureMeta = {
    thumbnailDataUrl: fullCapture.thumbnailDataUrl || '',
    width: fullCapture.width,
    height: fullCapture.height,
    mimeType: fullCapture.mimeType,
    filename: fullCapture.filename,
    pagesCaptured: fullCapture.pagesCaptured || 1,
    timestamp: fullCapture.timestamp
  };
  await chrome.storage.local.set({
    lastCapture: fullCapture,
    lastCaptureMeta
  });
  await chrome.storage.session.set({ lastCaptureMeta });
  return lastCaptureMeta;
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
 * Verify target tab is still active, enforce Chrome's captureVisibleTab rate limit,
 * and retry transient rate-limit / tab-dragging failures up to 3 attempts.
 * @param {number} tabId
 * @param {number} fallbackWindowId
 */
async function captureVisibleTabSafe(tabId, fallbackWindowId) {
  const currentTab = await chrome.tabs.get(tabId);
  if (!currentTab?.active) {
    throw new Error('Target tab is no longer active. Keep the tab focused during capture.');
  }
  const targetWindowId = currentTab.windowId ?? fallbackWindowId;

  const { lastVisibleCaptureAt = 0 } = await chrome.storage.session.get('lastVisibleCaptureAt');
  const elapsed = Date.now() - lastVisibleCaptureAt;
  if (elapsed < CAPTURE_MIN_INTERVAL_MS) {
    await delay(CAPTURE_MIN_INTERVAL_MS - elapsed);
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(targetWindowId, { format: 'png' });
      await chrome.storage.session.set({ lastVisibleCaptureAt: Date.now() });
      return dataUrl;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err);
      const isTransient =
        /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND|quota|dragging|cannot be edited right now/i.test(
          msg
        );
      if (!isTransient || attempt === 2) {
        throw err;
      }
      await delay(650 * (attempt + 1));
    }
  }

  throw lastErr || new Error('Failed to capture visible tab');
}

/**
 * Determine temporary CSS clutter selectors using heuristics + optional Gemini domain cache.
 * Never matches OVERLAY_CLUTTER_RE against textSample on sticky <header>/<nav> elements.
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
    if (!ov?.selector) continue;
    if (ov.kind === 'inline-clutter') {
      heuristicMatches.add(ov.selector);
      continue;
    }

    const isHeaderOrNav = ov.tag === 'header' || ov.tag === 'nav';
    if (isHeaderOrNav) {
      const idAndClasses = `${ov.id || ''} ${ov.classes || ''}`;
      if (HEADER_SAFE_CLUTTER_RE.test(idAndClasses)) {
        heuristicMatches.add(ov.selector);
      }
      continue;
    }

    const meta = `${ov.id || ''} ${ov.classes || ''} ${ov.textSample || ''}`;
    if (OVERLAY_CLUTTER_RE.test(meta)) {
      heuristicMatches.add(ov.selector);
    }
  }

  let geminiSelectors = [];
  if (settings.apiKey && hostname && overlays.length > 0) {
    try {
      const cached = await getCachedSelectorsForDomain(chrome.storage.local, hostname);
      if (cached && cached.length > 0) {
        geminiSelectors = cached;
      } else {
        geminiSelectors = await detectClutterSelectors(settings.apiKey, {
          hostname,
          viewportWidth: inspection.pageMetrics.viewportWidth,
          viewportHeight: inspection.pageMetrics.viewportHeight,
          overlays
        });
        if (geminiSelectors.length > 0) {
          await setCachedSelectorsForDomain(chrome.storage.local, hostname, geminiSelectors);
        }
      }
    } catch (err) {
      console.warn('Gemini clutter detection failed, continuing with heuristics:', err.message);
    }
  }

  return sanitizeCssSelectors([...heuristicMatches, ...geminiSelectors]);
}

/**
 * Capture a full scrollable tab using dynamic scroll heights and streaming offscreen slice IPC.
 * @param {object} params
 * @param {number} params.tabId
 * @param {number} params.windowId
 * @param {object} params.settings
 * @param {'png' | 'jpeg'} [params.outputFormat]
 */
async function captureFullTab({ tabId, windowId, settings, outputFormat = 'png' }) {
  await throwIfCancelled();
  await ensureInspectorInjected(tabId);
  const inspection = await sendToInspector(tabId, 'INSPECT_PAGE');
  const cleanupSelectors = await resolveClutterSelectors(inspection, settings);

  const sessionId = makeSessionId(`vp-${tabId}`);
  let stitchSessionOpen = false;
  let stitched = null;
  let finalUrl = inspection.pageMetrics.url;

  try {
    const preparedMetrics = await sendToInspector(tabId, 'PREPARE_CAPTURE', {
      cleanupSelectors,
      hideScrollbars: true,
      autoCleanClutter: settings.autoCleanClutter
    });
    finalUrl = preparedMetrics.url || finalUrl;

    await sendToOffscreen('BEGIN_STITCH', { sessionId, mode: 'viewports' });
    stitchSessionOpen = true;

    const viewportHeight = Math.max(1, preparedMetrics.viewportHeight);
    let liveScrollHeight = Math.min(
      Math.max(preparedMetrics.scrollHeight, viewportHeight),
      DEFAULT_MAX_SCROLL_CSS_HEIGHT
    );
    const maxSlices = Math.max(2, Math.ceil(DEFAULT_MAX_SCROLL_CSS_HEIGHT / viewportHeight) + 2);

    let coveredCssY = 0;
    let sliceIndex = 0;

    while (coveredCssY < liveScrollHeight - 0.5 && sliceIndex < maxSlices) {
      await throwIfCancelled();
      await touchCaptureHeartbeat();

      const maxStart = Math.max(0, liveScrollHeight - viewportHeight);
      const targetY = sliceIndex === 0 ? 0 : Math.min(Math.round(coveredCssY), Math.round(maxStart));

      const scrollResult = await sendToInspector(tabId, 'SCROLL_AND_HIDE_FIXED', {
        y: targetY,
        hideFixed: sliceIndex > 0,
        coveredCssY,
        autoCleanClutter: settings.autoCleanClutter
      });

      if (Number.isFinite(scrollResult.scrollHeight) && scrollResult.scrollHeight > 0) {
        liveScrollHeight = Math.min(
          Math.max(scrollResult.scrollHeight, viewportHeight),
          DEFAULT_MAX_SCROLL_CSS_HEIGHT
        );
      }

      const dataUrl = await captureVisibleTabSafe(tabId, windowId);
      await sendToOffscreen('PUSH_SLICE', {
        sessionId,
        dataUrl,
        actualScrollY: scrollResult.actualScrollY
      });

      const sliceViewportH = scrollResult.viewportHeight || viewportHeight;
      const nextCoveredCssY = Math.max(coveredCssY, scrollResult.actualScrollY + sliceViewportH);
      if (sliceIndex > 0 && nextCoveredCssY <= coveredCssY + 0.5) {
        break;
      }

      coveredCssY = nextCoveredCssY;
      sliceIndex += 1;
    }

    await throwIfCancelled();
    await touchCaptureHeartbeat();

    stitched = await sendToOffscreen('COMMIT_STITCH', {
      sessionId,
      scrollHeight: liveScrollHeight,
      viewportHeight,
      dpr: preparedMetrics.dpr,
      format: outputFormat,
      quality: settings.jpegQuality
    });
    stitchSessionOpen = false;
  } finally {
    if (stitchSessionOpen) {
      try {
        await sendToOffscreen('ABORT_STITCH', { sessionId });
      } catch {
        // Ignore cleanup failure
      }
    }
    try {
      await sendToInspector(tabId, 'RESTORE_PAGE', { restoreScroll: true });
    } catch {
      // Tab may have navigated or closed.
    }
  }

  return {
    ...stitched,
    url: finalUrl,
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
 * Navigate a tab to a URL and wait until load completes, failing cleanly if the tab is closed.
 * @param {number} tabId
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function navigateAndWait(tabId, url, timeoutMs = 25000) {
  await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Timed out waiting for ${url} to load`));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete' && !settled) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId && !settled) {
        settled = true;
        cleanup();
        reject(new Error('Target tab was closed during multi-page capture.'));
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    (async () => {
      try {
        await chrome.tabs.update(tabId, { url });
      } catch (err) {
        if (!settled) {
          settled = true;
          cleanup();
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
  const tab = await getActiveTab();
  const settings = await getSettings();

  await acquireCaptureLock({
    message: 'Capturing full page…',
    currentPage: 1,
    totalPages: 1
  });

  let failure = null;
  try {
    const result = await captureFullTab({
      tabId: tab.id,
      windowId: tab.windowId,
      settings,
      outputFormat: settings.format
    });

    const lastCapture = {
      dataUrl: result.dataUrl,
      thumbnailDataUrl: result.thumbnailDataUrl,
      width: result.width,
      height: result.height,
      mimeType: result.mimeType,
      filename: buildFilename(result.url, settings.format, false),
      pagesCaptured: 1,
      timestamp: Date.now()
    };

    return await saveLastCapture(lastCapture);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    await finalizeCaptureLock(failure);
  }
}

/**
 * Capture current tab and append it to staged multi-page session using per-page storage keys.
 */
async function handleAppendCurrentPage() {
  const tab = await getActiveTab();
  const settings = await getSettings();

  await acquireCaptureLock({
    message: 'Capturing page for multi-page session…',
    currentPage: 1,
    totalPages: 1
  });

  let failure = null;
  try {
    const result = await captureFullTab({
      tabId: tab.id,
      windowId: tab.windowId,
      settings,
      outputFormat: 'png'
    });

    const existingData = await chrome.storage.local.get(['stagedMeta', 'stagedPages']);
    let stagedMeta = Array.isArray(existingData.stagedMeta) ? [...existingData.stagedMeta] : [];

    // Migrate any legacy stagedPages entries seamlessly
    if (stagedMeta.length === 0 && Array.isArray(existingData.stagedPages) && existingData.stagedPages.length > 0) {
      const migratedItems = {};
      for (const legacyPage of existingData.stagedPages) {
        const legacyId = legacyPage.id || `${Date.now()}-${stagedMeta.length + 1}`;
        const storageKey = `${STAGED_PAGE_KEY_PREFIX}${legacyId}`;
        migratedItems[storageKey] = legacyPage.dataUrl;
        stagedMeta.push({
          id: legacyId,
          storageKey,
          url: legacyPage.url,
          width: legacyPage.width,
          height: legacyPage.height
        });
      }
      await chrome.storage.local.set(migratedItems);
      await chrome.storage.local.remove('stagedPages');
    }

    const id = `${Date.now()}-${stagedMeta.length + 1}`;
    const storageKey = `${STAGED_PAGE_KEY_PREFIX}${id}`;
    stagedMeta.push({
      id,
      storageKey,
      url: result.url,
      width: result.width,
      height: result.height
    });

    await chrome.storage.local.set({
      [storageKey]: result.dataUrl,
      stagedMeta
    });
    await chrome.storage.session.set({ stagedCount: stagedMeta.length });

    return {
      stagedCount: stagedMeta.length,
      thumbnailDataUrl: result.thumbnailDataUrl
    };
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    await finalizeCaptureLock(failure);
  }
}

/**
 * Stitch all staged pages into one vertical PNG/JPEG image via streaming offscreen IPC.
 */
async function handleStitchStagedPages() {
  const { stagedMeta = [], stagedPages = [] } = await chrome.storage.local.get([
    'stagedMeta',
    'stagedPages'
  ]);
  const entries = stagedMeta.length > 0 ? stagedMeta : stagedPages;
  if (entries.length === 0) {
    throw new Error('No staged pages to stitch.');
  }

  const settings = await getSettings();
  await acquireCaptureLock({
    message: `Stitching ${entries.length} staged pages…`,
    currentPage: entries.length,
    totalPages: entries.length
  });

  const sessionId = makeSessionId('staged');
  let stitchSessionOpen = false;
  let failure = null;

  try {
    await sendToOffscreen('BEGIN_STITCH', { sessionId, mode: 'pages' });
    stitchSessionOpen = true;

    for (const entry of entries) {
      await throwIfCancelled();
      await touchCaptureHeartbeat();

      let pageDataUrl = entry.dataUrl;
      if (!pageDataUrl && entry.storageKey) {
        const stored = await chrome.storage.local.get(entry.storageKey);
        pageDataUrl = stored[entry.storageKey];
      }
      if (!pageDataUrl) {
        throw new Error('Missing image data for a staged page. Clear and recapture staged pages.');
      }

      await sendToOffscreen('PUSH_PAGE', {
        sessionId,
        dataUrl: pageDataUrl
      });
    }

    const stitched = await sendToOffscreen('COMMIT_STITCH', {
      sessionId,
      format: settings.format,
      quality: settings.jpegQuality,
      gapPx: 0
    });
    stitchSessionOpen = false;

    const lastCapture = {
      dataUrl: stitched.dataUrl,
      thumbnailDataUrl: stitched.thumbnailDataUrl,
      width: stitched.width,
      height: stitched.height,
      mimeType: stitched.mimeType,
      filename: buildFilename(entries[0].url, settings.format, entries.length > 1),
      pagesCaptured: entries.length,
      timestamp: Date.now()
    };

    return await saveLastCapture(lastCapture);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (stitchSessionOpen) {
      try {
        await sendToOffscreen('ABORT_STITCH', { sessionId });
      } catch {
        // Ignore cleanup failure
      }
    }
    await finalizeCaptureLock(failure);
  }
}

/**
 * Clear staged pages session and remove all per-page storage keys.
 */
async function handleClearStagedPages() {
  const allData = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(allData).filter(
    (k) => k === 'stagedPages' || k.startsWith(STAGED_PAGE_KEY_PREFIX)
  );
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
  await chrome.storage.local.set({ stagedMeta: [] });
  await chrome.storage.session.set({ stagedCount: 0 });
  const status = await getCaptureStatus();
  await syncActionBadge(status);
  return { stagedCount: 0 };
}

/**
 * Auto-capture a multi-page paginated article into one continuous stitched image.
 */
async function handleCaptureMultiPage() {
  const tab = await getActiveTab();
  const settings = await getSettings();
  const maxPages = Math.max(2, Math.min(15, Number(settings.maxAutoPages) || 5));
  const startOrigin = new URL(tab.url).origin;

  await acquireCaptureLock({
    message: `Capturing page 1 of up to ${maxPages}…`,
    currentPage: 1,
    totalPages: maxPages
  });

  const multiSessionId = makeSessionId('multipage');
  let multiSessionOpen = false;
  const visitedUrls = new Set();
  let pagesCaptured = 0;
  let firstPageUrl = tab.url;
  let failure = null;

  try {
    await sendToOffscreen('BEGIN_STITCH', { sessionId: multiSessionId, mode: 'pages' });
    multiSessionOpen = true;

    let currentUrl = tab.url;

    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      await throwIfCancelled();

      const normalizedRequested = normalizeUrlKey(currentUrl);
      if (visitedUrls.has(normalizedRequested)) break;
      visitedUrls.add(normalizedRequested);

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
        outputFormat: 'png'
      });

      const normalizedActual = normalizeUrlKey(pageCapture.url);
      if (pageNum > 1 && normalizedActual !== normalizedRequested && visitedUrls.has(normalizedActual)) {
        break;
      }
      visitedUrls.add(normalizedActual);

      if (pagesCaptured === 0) {
        firstPageUrl = pageCapture.url;
      }

      await sendToOffscreen('PUSH_PAGE', {
        sessionId: multiSessionId,
        dataUrl: pageCapture.dataUrl
      });
      pagesCaptured += 1;

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
      if (visitedUrls.has(normalizeUrlKey(nextUrl))) break;

      await throwIfCancelled();
      await setCaptureStatus({
        state: 'capturing',
        message: `Loading page ${pageNum + 1}…`,
        currentPage: pageNum + 1,
        totalPages: maxPages
      });

      await navigateAndWait(tab.id, nextUrl);

      // Verify post-navigation URL did not redirect back to an already-captured page or external origin
      const loadedTab = await chrome.tabs.get(tab.id);
      const postNavUrl = loadedTab?.url || nextUrl;
      let postNavOrigin = '';
      try {
        postNavOrigin = new URL(postNavUrl).origin;
      } catch {
        break;
      }
      if (postNavOrigin !== startOrigin) break;
      if (
        normalizeUrlKey(postNavUrl) !== normalizeUrlKey(nextUrl) &&
        visitedUrls.has(normalizeUrlKey(postNavUrl))
      ) {
        break;
      }
      visitedUrls.add(normalizeUrlKey(nextUrl));
      currentUrl = postNavUrl;
    }

    if (pagesCaptured === 0) {
      throw new Error('No pages were captured.');
    }

    await throwIfCancelled();
    await setCaptureStatus({
      state: 'capturing',
      message: `Stitching ${pagesCaptured} page(s) into final image…`,
      currentPage: pagesCaptured,
      totalPages: pagesCaptured
    });

    const stitched = await sendToOffscreen('COMMIT_STITCH', {
      sessionId: multiSessionId,
      format: settings.format,
      quality: settings.jpegQuality,
      gapPx: 0
    });
    multiSessionOpen = false;

    const lastCapture = {
      dataUrl: stitched.dataUrl,
      thumbnailDataUrl: stitched.thumbnailDataUrl,
      width: stitched.width,
      height: stitched.height,
      mimeType: stitched.mimeType,
      filename: buildFilename(firstPageUrl, settings.format, pagesCaptured > 1),
      pagesCaptured,
      timestamp: Date.now()
    };

    return await saveLastCapture(lastCapture);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (multiSessionOpen) {
      try {
        await sendToOffscreen('ABORT_STITCH', { sessionId: multiSessionId });
      } catch {
        // Ignore cleanup failure
      }
    }
    await finalizeCaptureLock(failure);
  }
}

/**
 * Trigger chrome.downloads.download using an offscreen blob: URL so >2 MB images never fail.
 */
async function handleDownloadLastCapture() {
  const { lastCapture } = await chrome.storage.local.get('lastCapture');
  if (!lastCapture?.dataUrl) {
    throw new Error('No captured image available to download.');
  }

  const { blobUrl } = await sendToOffscreen('CREATE_BLOB_URL', {
    dataUrl: lastCapture.dataUrl
  });

  let revoked = false;
  const safeRevoke = async () => {
    if (revoked) return;
    revoked = true;
    try {
      await sendToOffscreen('REVOKE_BLOB_URL', { blobUrl });
    } catch {
      // Offscreen document may have closed
    }
  };

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: lastCapture.filename || 'pagestitch-capture.png',
      saveAs: true
    });
  } catch (err) {
    await safeRevoke();
    throw err;
  }

  const fallbackTimer = setTimeout(() => {
    chrome.downloads.onChanged.removeListener(onDownloadChanged);
    safeRevoke();
  }, 120000);

  function onDownloadChanged(delta) {
    if (delta.id !== downloadId) return;
    const state = delta.state?.current;
    if (state === 'complete' || state === 'interrupted') {
      clearTimeout(fallbackTimer);
      chrome.downloads.onChanged.removeListener(onDownloadChanged);
      safeRevoke();
    }
  }

  chrome.downloads.onChanged.addListener(onDownloadChanged);
  return { downloadId };
}

/**
 * Return the full-resolution data URL of the latest capture on demand (e.g., for clipboard copy).
 */
async function handleGetLastCaptureDataUrl() {
  const { lastCapture } = await chrome.storage.local.get('lastCapture');
  if (!lastCapture?.dataUrl) {
    throw new Error('No captured image available.');
  }
  return {
    dataUrl: lastCapture.dataUrl,
    mimeType: lastCapture.mimeType
  };
}

/**
 * Return lightweight current UI state from chrome.storage (omitting heavy lastCapture.dataUrl).
 */
async function handleGetState() {
  const settings = await getSettings();
  const stagedCount = await getStagedCount();
  const captureStatus = await getCaptureStatus();

  let { lastCaptureMeta = null } = await chrome.storage.local.get('lastCaptureMeta');
  if (!lastCaptureMeta) {
    const { lastCapture = null } = await chrome.storage.local.get('lastCapture');
    if (lastCapture) {
      lastCaptureMeta = {
        thumbnailDataUrl: lastCapture.thumbnailDataUrl || lastCapture.dataUrl,
        width: lastCapture.width,
        height: lastCapture.height,
        mimeType: lastCapture.mimeType,
        filename: lastCapture.filename,
        pagesCaptured: lastCapture.pagesCaptured || 1,
        timestamp: lastCapture.timestamp
      };
    }
  }

  return {
    settings,
    stagedCount,
    captureStatus,
    lastCapture: lastCaptureMeta
  };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      settings: DEFAULT_SETTINGS,
      stagedMeta: []
    });
  }
  const status = await getCaptureStatus();
  await syncActionBadge(status);
});

chrome.runtime.onStartup.addListener(async () => {
  const status = await getCaptureStatus();
  await syncActionBadge(status);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target === 'offscreen') return undefined;

  (async () => {
    try {
      switch (message?.type) {
        case 'GET_STATE':
          sendResponse({ ok: true, data: await handleGetState() });
          break;
        case 'GET_LAST_CAPTURE_DATA_URL':
          sendResponse({ ok: true, data: await handleGetLastCaptureDataUrl() });
          break;
        case 'CAPTURE_FULL_PAGE':
          sendResponse({ ok: true, data: await handleCaptureFullPage() });
          break;
        case 'CAPTURE_MULTI_PAGE':
          sendResponse({ ok: true, data: await handleCaptureMultiPage() });
          break;
        case 'CANCEL_CAPTURE':
          sendResponse({ ok: true, data: await handleCancelCapture() });
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
