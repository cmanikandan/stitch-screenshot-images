import { sanitizeCssSelectors, filterCacheableSelectors } from './stitch-math.js';

export const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const GEMINI_API_REVISION = '2026-05-20';
export const GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_TIMEOUT_MS = 20000;
export const DOMAIN_CACHE_KEY = 'domainSelectorCache';
export const DOMAIN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_CACHED_DOMAINS = 100;

/**
 * Extract JSON payload from a Gemini Interactions API response.
 * Checks `steps` (`model_output` -> string or array `content`) first, then falls back to `outputs`.
 * @param {object} responseJson
 * @returns {any}
 */
export function extractInteractionJson(responseJson) {
  if (!responseJson || typeof responseJson !== 'object') {
    throw new Error('Invalid Gemini response object');
  }

  let rawText = '';

  if (Array.isArray(responseJson.steps)) {
    for (let i = responseJson.steps.length - 1; i >= 0; i--) {
      const step = responseJson.steps[i];
      if (step?.type !== 'model_output') continue;

      if (typeof step.content === 'string' && step.content.trim()) {
        rawText = step.content.trim();
        break;
      }

      if (Array.isArray(step.content)) {
        const textParts = step.content
          .map((item) => {
            if (typeof item === 'string') return item;
            if (item?.type === 'text' && typeof item.text === 'string') return item.text;
            if (typeof item?.text === 'string') return item.text;
            return '';
          })
          .filter(Boolean);
        if (textParts.length > 0) {
          rawText = textParts.join('\n').trim();
          break;
        }
      }
    }
  }

  if (!rawText && Array.isArray(responseJson.outputs)) {
    const textParts = responseJson.outputs
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text' && typeof item.text === 'string') return item.text;
        return '';
      })
      .filter(Boolean);
    rawText = textParts.join('\n').trim();
  }

  if (!rawText) {
    throw new Error('Gemini response contained no text output');
  }

  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse Gemini JSON output: ${err.message}`);
  }
}

/**
 * Call Gemini 3.8 Flash Interactions API with structured JSON output schema and AbortController timeout.
 * @param {object} params
 * @param {string} params.apiKey
 * @param {string} params.input
 * @param {object} params.schema
 * @param {typeof fetch} [params.fetchImpl]
 * @param {number} [params.timeoutMs]
 * @returns {Promise<any>}
 */
export async function callGeminiStructured({
  apiKey,
  input,
  schema,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_GEMINI_TIMEOUT_MS
}) {
  const key = String(apiKey || '').trim();
  if (!key) {
    throw new Error('Gemini API key is required');
  }

  const controller = new AbortController();
  const effectiveTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_GEMINI_TIMEOUT_MS;
  const timer = setTimeout(() => {
    controller.abort();
  }, effectiveTimeout);

  let response;
  try {
    response = await fetchImpl(GEMINI_INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
        'Api-Revision': GEMINI_API_REVISION
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: GEMINI_MODEL,
        input,
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema
        }
      })
    });
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      throw new Error(`Gemini API request timed out after ${effectiveTimeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      errorBody = '';
    }
    throw new Error(`Gemini API HTTP ${response.status}: ${errorBody.slice(0, 240)}`);
  }

  const data = await response.json();
  return extractInteractionJson(data);
}

/**
 * Identify CSS selectors of clutter overlays, banners, and inline ad containers to temporarily hide.
 * @param {string} apiKey
 * @param {object} domSummary
 * @param {object} [options]
 * @returns {Promise<string[]>}
 */
export async function detectClutterSelectors(apiKey, domSummary, options = {}) {
  const overlays = Array.isArray(domSummary?.overlays) ? domSummary.overlays.slice(0, 50) : [];
  if (overlays.length === 0) return [];

  const schema = {
    type: 'object',
    properties: {
      selectors: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Specific CSS selectors for overlays, cookie banners, sticky promo bars, chat widgets, inline/in-between article ad containers, or sponsored widgets to hide before screenshot capture.'
      }
    },
    required: ['selectors']
  };

  const input = [
    'You are inspecting compact DOM element metadata from a webpage prior to taking a clean full-page screenshot.',
    'Return ONLY specific CSS selectors (from the provided candidates) for non-content clutter to temporarily hide:',
    '- Cookie/consent banners, newsletter popups, paywall/login modals, floating chat widgets, sticky promo bars, and fixed ad banners.',
    '- Inline/in-between article ad containers, ad-slot reserve wrappers, and sponsored recommendation widgets (e.g., AdSense/GPT slots, Taboola, Outbrain).',
    '- NEVER return broad structural or content tags like html, body, main, article, section, header, footer, nav, div, img, h1-h6, or primary site navigation headers / article content / legitimate media embeds.',
    '- Only return selectors that appear in or uniquely target the provided clutter candidates.',
    '',
    `Page info: ${JSON.stringify({
      hostname: domSummary.hostname,
      viewportWidth: domSummary.viewportWidth,
      viewportHeight: domSummary.viewportHeight,
      overlays
    })}`
  ].join('\n');

  const result = await callGeminiStructured({
    apiKey,
    input,
    schema,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  });

  return sanitizeCssSelectors(result?.selectors);
}

/**
 * Identify the exact next-page URL from candidate pagination links on a webpage.
 * Verifies the returned URL against resolved candidate URLs to prevent hallucinated URLs.
 * @param {string} apiKey
 * @param {object} pageContext
 * @param {object} [options]
 * @returns {Promise<{ nextPageUrl: string | null, confidence: string }>}
 */
export async function detectNextPageUrl(apiKey, pageContext, options = {}) {
  const candidates = Array.isArray(pageContext?.nextCandidates)
    ? pageContext.nextCandidates.slice(0, 40)
    : [];

  if (candidates.length === 0) {
    return { nextPageUrl: null, confidence: 'high' };
  }

  let current;
  try {
    current = new URL(pageContext.currentUrl);
  } catch {
    return { nextPageUrl: null, confidence: 'low' };
  }

  const currentNormalized = `${current.origin}${current.pathname}${current.search}`;
  const candidateUrlMap = new Map();
  for (const item of candidates) {
    if (!item?.href) continue;
    try {
      const resolvedCandidate = new URL(item.href, current);
      if (resolvedCandidate.protocol !== 'http:' && resolvedCandidate.protocol !== 'https:') {
        continue;
      }
      const norm = `${resolvedCandidate.origin}${resolvedCandidate.pathname}${resolvedCandidate.search}`;
      if (norm !== currentNormalized && !candidateUrlMap.has(norm)) {
        candidateUrlMap.set(norm, resolvedCandidate.href);
      }
    } catch {
      // Ignore malformed candidate href
    }
  }

  if (candidateUrlMap.size === 0) {
    return { nextPageUrl: null, confidence: 'high' };
  }

  const schema = {
    type: 'object',
    properties: {
      nextPageUrl: {
        type: ['string', 'null'],
        description:
          'Absolute or relative URL from the provided candidates representing the next page in this paginated article/sequence, or null if there is no next page.'
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low']
      }
    },
    required: ['nextPageUrl', 'confidence']
  };

  const input = [
    'You are determining whether a webpage is part of a multi-page article or paginated sequence and finding the exact Next Page URL.',
    'Rules:',
    '- Pick ONLY the immediate next page (e.g., page N+1, "Next", "Next Page", "Continue reading", "Older posts"), never "Previous", "First", "Last", "/more" navigation menus, or unrelated "What\'s Next in..." related-article cards.',
    '- Return null if this appears to be a single-page article or the final page.',
    '- The returned URL MUST match one of the provided candidate URLs.',
    '',
    `Context: ${JSON.stringify({
      currentUrl: pageContext.currentUrl,
      pageNumber: pageContext.pageNumber,
      candidates
    })}`
  ].join('\n');

  const result = await callGeminiStructured({
    apiKey,
    input,
    schema,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs
  });

  const rawUrl = result?.nextPageUrl;
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { nextPageUrl: null, confidence: result?.confidence || 'low' };
  }

  try {
    const resolved = new URL(rawUrl, current);
    const resolvedNormalized = `${resolved.origin}${resolved.pathname}${resolved.search}`;
    if (
      (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') ||
      resolvedNormalized === currentNormalized ||
      !candidateUrlMap.has(resolvedNormalized)
    ) {
      return { nextPageUrl: null, confidence: 'low' };
    }
    return {
      nextPageUrl: candidateUrlMap.get(resolvedNormalized) || resolved.href,
      confidence: result?.confidence || 'medium'
    };
  } catch {
    return { nextPageUrl: null, confidence: 'low' };
  }
}

/**
 * Retrieve cached clutter CSS selectors for a domain if still fresh.
 * @param {chrome.storage.StorageArea} storage
 * @param {string} hostname
 * @param {number} [now]
 * @returns {Promise<string[] | null>}
 */
export async function getCachedSelectorsForDomain(storage, hostname, now = Date.now()) {
  if (!storage || !hostname) return null;
  const data = await storage.get({ [DOMAIN_CACHE_KEY]: {} });
  const cache = data[DOMAIN_CACHE_KEY] || {};
  const entry = cache[hostname];
  if (!entry || !Array.isArray(entry.selectors)) return null;
  if (typeof entry.updatedAt === 'number' && now - entry.updatedAt > DOMAIN_CACHE_TTL_MS) {
    return null;
  }
  return filterCacheableSelectors(entry.selectors);
}

/**
 * Cache clutter CSS selectors for a domain in chrome.storage.local after stripping dynamic instance IDs.
 * @param {chrome.storage.StorageArea} storage
 * @param {string} hostname
 * @param {string[]} selectors
 * @param {number} [now]
 */
export async function setCachedSelectorsForDomain(storage, hostname, selectors, now = Date.now()) {
  if (!storage || !hostname) return;
  const cacheable = filterCacheableSelectors(selectors);
  if (cacheable.length === 0) return;

  const data = await storage.get({ [DOMAIN_CACHE_KEY]: {} });
  const cache = { ...(data[DOMAIN_CACHE_KEY] || {}) };
  cache[hostname] = {
    selectors: cacheable,
    updatedAt: now
  };

  // Prune oldest entries if cache grows beyond limit
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHED_DOMAINS) {
    keys.sort((a, b) => (cache[a]?.updatedAt || 0) - (cache[b]?.updatedAt || 0));
    for (const oldKey of keys.slice(0, keys.length - MAX_CACHED_DOMAINS)) {
      delete cache[oldKey];
    }
  }

  await storage.set({ [DOMAIN_CACHE_KEY]: cache });
}

/**
 * Clear all cached per-domain clutter selectors.
 * @param {chrome.storage.StorageArea} storage
 */
export async function clearDomainSelectorCache(storage) {
  if (!storage) return;
  await storage.remove(DOMAIN_CACHE_KEY);
}
