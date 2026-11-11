/**
 * Pure math and heuristic helpers for full-page scrolling, viewport stitching,
 * multi-page vertical stacking, CSS selector sanitization, and pagination scoring.
 */

export const DEFAULT_MAX_CANVAS_WIDTH = 16384;
export const DEFAULT_MAX_CANVAS_HEIGHT = 16384;
export const DEFAULT_MAX_CANVAS_AREA = 268435456; // 16384 * 16384
export const DEFAULT_MAX_SCROLL_CSS_HEIGHT = 60000;

const FORBIDDEN_SELECTORS = new Set([
  '*',
  ':root',
  'html',
  'body',
  'head',
  'main',
  'article',
  'section',
  'header',
  'footer',
  'nav',
  'aside',
  'div',
  'span',
  'p',
  'a',
  'img',
  'picture',
  'figure',
  'figcaption',
  'video',
  'audio',
  'canvas',
  'svg',
  'iframe',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'td',
  'th',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'pre',
  'code',
  'blockquote',
  '[role="main"]',
  "[role='main']",
  '[role=main]',
  '[role="article"]',
  "[role='article']",
  '[role=article]',
  '[role="navigation"]',
  "[role='navigation']",
  '[role=navigation]'
]);

const DYNAMIC_INSTANCE_ID_RE = /#[^\s.#\[]*(?:\d{3,}|[-_]\d+\b)/i;

/**
 * Compute uniform scale <= 1 so width, height, and pixel area fit safe canvas limits.
 * @param {number} width
 * @param {number} height
 * @param {object} [limits]
 * @returns {number}
 */
export function computeSafeCanvasScale(
  width,
  height,
  {
    maxCanvasWidth = DEFAULT_MAX_CANVAS_WIDTH,
    maxCanvasHeight = DEFAULT_MAX_CANVAS_HEIGHT,
    maxCanvasArea = DEFAULT_MAX_CANVAS_AREA
  } = {}
) {
  if (width <= 0 || height <= 0) return 1;
  let scale = 1;
  if (width > maxCanvasWidth) {
    scale = Math.min(scale, maxCanvasWidth / width);
  }
  if (height > maxCanvasHeight) {
    scale = Math.min(scale, maxCanvasHeight / height);
  }
  const area = width * scale * (height * scale);
  if (area > maxCanvasArea) {
    scale = Math.min(scale, Math.sqrt(maxCanvasArea / (width * height)));
  }

  // Guard against Math.round pushing scaled width * height past maxCanvasArea
  while (
    scale > 0 &&
    (Math.round(width * scale) > maxCanvasWidth ||
      Math.round(height * scale) > maxCanvasHeight ||
      Math.round(width * scale) * Math.round(height * scale) > maxCanvasArea)
  ) {
    scale *= 0.9999;
  }
  return scale;
}

/**
 * Compute vertical scroll Y offsets to cover [0, effectiveHeight] cleanly.
 * @param {object} params
 * @param {number} params.scrollHeight
 * @param {number} params.viewportHeight
 * @param {number} [params.maxCssHeight]
 * @returns {{ offsets: number[], effectiveHeight: number }}
 */
export function computeScrollOffsets({
  scrollHeight,
  viewportHeight,
  maxCssHeight = DEFAULT_MAX_SCROLL_CSS_HEIGHT
}) {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    throw new Error('viewportHeight must be a positive number');
  }
  if (!Number.isFinite(scrollHeight) || scrollHeight < 0) {
    throw new Error('scrollHeight must be a non-negative number');
  }

  const effectiveHeight = Math.min(Math.max(scrollHeight, viewportHeight), maxCssHeight);
  if (effectiveHeight <= viewportHeight) {
    return { offsets: [0], effectiveHeight };
  }

  const offsets = [];
  const maxStart = effectiveHeight - viewportHeight;
  let y = 0;

  while (y < maxStart) {
    offsets.push(Math.round(y));
    y += viewportHeight;
  }

  const finalOffset = Math.round(maxStart);
  if (offsets.length === 0 || offsets[offsets.length - 1] !== finalOffset) {
    offsets.push(finalOffset);
  }

  return { offsets, effectiveHeight };
}

/**
 * Compute source-crop and destination placements for stitching viewport captures.
 * Guarantees contiguous destination seams (dy[i] + dh[i] === dy[i+1]) even when
 * DPR is fractional (1.25, 1.5, 1.75) or canvas downscaling (scale < 1) is applied.
 * @param {object} params
 * @param {Array<{ actualScrollY: number, imageWidth: number, imageHeight: number }>} params.slices
 * @param {number} params.scrollHeight
 * @param {number} params.viewportHeight
 * @param {number} [params.dpr]
 * @param {number} [params.maxCanvasWidth]
 * @param {number} [params.maxCanvasHeight]
 * @param {number} [params.maxCanvasArea]
 * @returns {{ width: number, height: number, scale: number, placements: Array<object> }}
 */
export function computeViewportStitchPlan({
  slices,
  scrollHeight,
  viewportHeight,
  dpr = 1,
  maxCanvasWidth = DEFAULT_MAX_CANVAS_WIDTH,
  maxCanvasHeight = DEFAULT_MAX_CANVAS_HEIGHT,
  maxCanvasArea = DEFAULT_MAX_CANVAS_AREA
}) {
  if (!Array.isArray(slices) || slices.length === 0) {
    throw new Error('slices must be a non-empty array');
  }

  const first = slices[0];
  const baseWidth = Math.max(1, Math.round(first.imageWidth));
  const pxPerCssY =
    viewportHeight > 0 && first.imageHeight > 0 ? first.imageHeight / viewportHeight : dpr;
  const effectiveScrollHeight = Math.max(viewportHeight, scrollHeight);

  let coveredCssY = 0;
  const rawPlacements = [];
  let maxBottomPx = 0;

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    const startCssY = Math.max(0, slice.actualScrollY);
    const overlapCss = Math.max(0, coveredCssY - startCssY);
    const destCssY = Math.max(coveredCssY, startCssY);
    const availableCss = Math.max(0, viewportHeight - overlapCss);
    const remainingPageCss = Math.max(0, effectiveScrollHeight - destCssY);
    const drawCss = Math.min(availableCss, remainingPageCss);

    if (drawCss <= 0) continue;

    const sy = Math.min(slice.imageHeight, Math.max(0, Math.round(overlapCss * pxPerCssY)));
    const syEnd = Math.min(
      slice.imageHeight,
      Math.max(sy + 1, Math.round((overlapCss + drawCss) * pxPerCssY))
    );
    const sh = syEnd - sy;
    if (sh <= 0) continue;

    const dy = Math.round(destCssY * pxPerCssY);
    const nextUnscaledDy = Math.max(dy + 1, Math.round((destCssY + drawCss) * pxPerCssY));
    const unscaledDh = nextUnscaledDy - dy;

    rawPlacements.push({
      index: i,
      sx: 0,
      sy,
      sw: slice.imageWidth,
      sh,
      dx: 0,
      dy,
      dw: baseWidth,
      dh: unscaledDh
    });

    coveredCssY = destCssY + drawCss;
    maxBottomPx = Math.max(maxBottomPx, dy + unscaledDh);
  }

  const unscaledHeight = Math.max(1, maxBottomPx);
  const scale = computeSafeCanvasScale(baseWidth, unscaledHeight, {
    maxCanvasWidth,
    maxCanvasHeight,
    maxCanvasArea
  });

  const width = Math.min(maxCanvasWidth, Math.max(1, Math.round(baseWidth * scale)));

  const placements = rawPlacements.map((p) => {
    const dx = Math.round(p.dx * scale);
    const nextDx = Math.min(width, Math.max(dx + 1, Math.round((p.dx + p.dw) * scale)));
    const dw = Math.max(1, nextDx - dx);

    const dy = Math.min(maxCanvasHeight - 1, Math.max(0, Math.round(p.dy * scale)));
    const nextDy = Math.min(maxCanvasHeight, Math.max(dy + 1, Math.round((p.dy + p.dh) * scale)));
    const dh = Math.max(1, nextDy - dy);

    return {
      index: p.index,
      sx: p.sx,
      sy: p.sy,
      sw: p.sw,
      sh: p.sh,
      dx,
      dy,
      dw,
      dh
    };
  });

  const lastPlacement = placements[placements.length - 1];
  const height = lastPlacement
    ? Math.min(maxCanvasHeight, Math.max(1, lastPlacement.dy + lastPlacement.dh))
    : Math.min(maxCanvasHeight, Math.max(1, Math.round(unscaledHeight * scale)));

  return { width, height, scale, placements };
}

/**
 * Compute vertical stacking layout for multiple captured page images.
 * Uses cumulative scaled endpoints so zero-gap multi-page stitches never suffer
 * 1px transparent seams or bottom clipping/dead strips when scale < 1.
 * @param {Array<{ width: number, height: number }>} dimensions
 * @param {object} [options]
 * @returns {{ width: number, height: number, scale: number, placements: Array<{ index: number, x: number, y: number, width: number, height: number }> }}
 */
export function computeMultiPageLayout(
  dimensions,
  {
    gapPx = 0,
    maxCanvasWidth = DEFAULT_MAX_CANVAS_WIDTH,
    maxCanvasHeight = DEFAULT_MAX_CANVAS_HEIGHT,
    maxCanvasArea = DEFAULT_MAX_CANVAS_AREA
  } = {}
) {
  if (!Array.isArray(dimensions) || dimensions.length === 0) {
    throw new Error('dimensions must be a non-empty array');
  }

  const unscaledWidth = Math.max(1, ...dimensions.map((d) => Math.round(d.width)));
  const totalGap = Math.max(0, dimensions.length - 1) * gapPx;
  const unscaledHeight = Math.max(
    1,
    dimensions.reduce((sum, d) => sum + Math.max(1, Math.round(d.height)), 0) + totalGap
  );

  const scale = computeSafeCanvasScale(unscaledWidth, unscaledHeight, {
    maxCanvasWidth,
    maxCanvasHeight,
    maxCanvasArea
  });

  const width = Math.min(maxCanvasWidth, Math.max(1, Math.round(unscaledWidth * scale)));

  let unscaledCursorY = 0;
  const placements = dimensions.map((d, index) => {
    const rawPageH = Math.max(1, Math.round(d.height));
    const scaledW = Math.min(width, Math.max(1, Math.round(d.width * scale)));
    const y = Math.min(maxCanvasHeight - 1, Math.max(0, Math.round(unscaledCursorY * scale)));
    const nextY = Math.min(
      maxCanvasHeight,
      Math.max(y + 1, Math.round((unscaledCursorY + rawPageH) * scale))
    );
    const scaledH = Math.max(1, nextY - y);
    const x = Math.max(0, Math.floor((width - scaledW) / 2));
    unscaledCursorY += rawPageH + gapPx;
    return { index, x, y, width: scaledW, height: scaledH };
  });

  const lastPlacement = placements[placements.length - 1];
  const height = lastPlacement
    ? Math.min(maxCanvasHeight, Math.max(1, lastPlacement.y + lastPlacement.height))
    : Math.min(maxCanvasHeight, Math.max(1, Math.round(unscaledHeight * scale)));

  return { width, height, scale, placements };
}

/**
 * Extract trailing or query page/part integer from a URL if present.
 * Ignores YYYY/MM/DD calendar date URLs.
 * @param {URL} urlObj
 * @returns {number | null}
 */
function extractPageNumber(urlObj) {
  for (const key of ['page', 'p', 'pg', 'paged']) {
    const val = urlObj.searchParams.get(key);
    if (val && /^\d+$/.test(val)) {
      return Number.parseInt(val, 10);
    }
  }

  const pathname = urlObj.pathname;
  if (/\/\d{4}\/\d{1,2}\/\d{1,2}\/?$/.test(pathname)) {
    return null;
  }

  const explicitMatch = pathname.match(
    /(?:\/page\/|\/p\/|\/part\/|-page-|-part-|_page_|_part_)(\d+)(?:\/|\.html?)?$/i
  );
  if (explicitMatch) {
    return Number.parseInt(explicitMatch[1], 10);
  }

  const trailingMatch = pathname.match(/\/(\d{1,3})(?:\/|\.html?)?$/);
  if (trailingMatch) {
    return Number.parseInt(trailingMatch[1], 10);
  }
  return null;
}

/**
 * Score candidate pagination links heuristically and pick the best next-page URL.
 * Rejects header "/more" links and unrelated blog cards like "What's Next in..."
 * while reliably scoring rel="next", explicit pagination controls, and page N+1 URLs.
 * @param {Array<{ href: string, text?: string, rel?: string, ariaLabel?: string, className?: string, id?: string, inPagination?: boolean }>} candidates
 * @param {string} currentUrl
 * @returns {{ url: string, score: number, reason: string } | null}
 */
export function scoreNextPageCandidates(candidates, currentUrl) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  let current;
  try {
    current = new URL(currentUrl);
  } catch {
    return null;
  }

  const currentPageNum = extractPageNumber(current);
  const currentNoHash = `${current.origin}${current.pathname}${current.search}`;
  const seen = new Set();
  const scored = [];

  const EXACT_NEXT_TEXT_RE =
    /^(?:next(?:\s+(?:page|part|chapter|posts|entries))?(?:\s*[→›»>]+)?|[→›»>]+\s*next|older\s+(?:posts|entries)|continue\s+reading)$/i;
  const ARROW_ONLY_RE = /^(?:→|›|»|>)$/;
  const NEXT_ARIA_RE = /\b(?:next\s*(?:page|part|post|posts|entries|chapter)|go\s+to\s+next|pagination\s+next)\b|^next$/i;
  const NEXT_CLASS_TOKEN_RE =
    /(?:^|[\s_-])(?:pagination-next|pager-next|nav-next|page-next|next-page|next_page|nextpostslink)(?:$|[\s_-])/i;
  const PAGINATION_CLASS_RE = /(?:^|[\s_-])(?:pagination|pager|page-numbers|pagenavi|wp-pagenavi)(?:$|[\s_-])/i;
  const FALSE_NEXT_PHRASE_RE =
    /\b(?:what['’]?s\s+next|whats\s+next|up\s+next|read\s+next|watch\s+next|next\s+(?:gen|generation|level|week|month|year|step|steps|time|big\s+thing))\b/i;
  const NEGATIVE_META_RE =
    /\b(?:prev|previous|back|older\s+than|newer|first|last|login|log\s*in|sign\s*in|sign\s*up|register|subscribe|share|comment|comments|reply|author|category|tag|privacy|terms|pricing|about|contact)\b/i;
  const NON_PAGINATION_PATH_RE =
    /^\/(?:more|about|contact|login|signin|signup|register|subscribe|pricing|privacy|terms|search|tags?|categories|category|authors?|author)(?:\/|$)/i;

  for (const item of candidates) {
    if (!item?.href) continue;
    let resolved;
    try {
      resolved = new URL(item.href, current);
    } catch {
      continue;
    }

    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') continue;

    const normalized = `${resolved.origin}${resolved.pathname}${resolved.search}`;
    if (normalized === currentNoHash) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    let score = 0;
    const reasons = [];

    const relTokens = String(item.rel || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const text = String(item.text || '').replace(/\s+/g, ' ').trim();
    const textLower = text.toLowerCase();
    const aria = String(item.ariaLabel || '').replace(/\s+/g, ' ').trim();
    const ariaLower = aria.toLowerCase();
    const meta = `${item.className || ''} ${item.id || ''}`;
    const metaLower = meta.toLowerCase();
    const hasPaginationContext = Boolean(item.inPagination) || PAGINATION_CLASS_RE.test(meta);

    if (relTokens.includes('next')) {
      score += 100;
      reasons.push('rel=next');
    }

    if (resolved.origin === current.origin) {
      score += 15;
      reasons.push('same-origin');
    } else {
      score -= 80;
    }

    if (hasPaginationContext) {
      score += 20;
      reasons.push('pagination-container');
    }

    if (EXACT_NEXT_TEXT_RE.test(text)) {
      score += 60;
      reasons.push('exact-next-text');
    } else if (ARROW_ONLY_RE.test(text) && (hasPaginationContext || NEXT_ARIA_RE.test(aria))) {
      score += 50;
      reasons.push('pagination-arrow');
    } else if (NEXT_ARIA_RE.test(aria)) {
      score += 50;
      reasons.push('next-aria-label');
    } else if (
      text.length > 0 &&
      text.length <= 24 &&
      /\bnext\b/i.test(textLower) &&
      !FALSE_NEXT_PHRASE_RE.test(textLower)
    ) {
      score += 35;
      reasons.push('short-next-label');
    }

    if (NEXT_CLASS_TOKEN_RE.test(meta)) {
      score += 30;
      reasons.push('next-class-or-id');
    } else if (hasPaginationContext && /(?:^|[\s_-])next(?:$|[\s_-])/i.test(meta)) {
      score += 25;
      reasons.push('pagination-next-token');
    }

    if (FALSE_NEXT_PHRASE_RE.test(`${textLower} ${ariaLower}`)) {
      score -= 80;
      reasons.push('false-next-phrase');
    }

    if (NEGATIVE_META_RE.test(`${textLower} ${ariaLower} ${metaLower}`) || relTokens.includes('prev')) {
      score -= 100;
      reasons.push('negative-keyword');
    }

    if (NON_PAGINATION_PATH_RE.test(resolved.pathname) && !relTokens.includes('next')) {
      score -= 80;
      reasons.push('non-pagination-path');
    }

    const candidatePageNum = extractPageNumber(resolved);
    if (candidatePageNum !== null) {
      if (currentPageNum !== null && candidatePageNum === currentPageNum + 1) {
        score += 75;
        reasons.push(`page-${currentPageNum}-to-${candidatePageNum}`);
      } else if (currentPageNum === null && candidatePageNum === 2) {
        score += 55;
        reasons.push('page-2-from-1');
      } else if (currentPageNum !== null && candidatePageNum <= currentPageNum) {
        score -= 60;
        reasons.push('non-advancing-page');
      }
    }

    if (score >= 45) {
      scored.push({
        url: resolved.href,
        score,
        reason: reasons.join(', ')
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

/**
 * Filter CSS selectors to safe, non-destructive element/class/id/attribute selectors.
 * @param {unknown} selectors
 * @param {object} [options]
 * @param {number} [options.maxSelectors]
 * @returns {string[]}
 */
export function sanitizeCssSelectors(selectors, { maxSelectors = 200 } = {}) {
  if (!Array.isArray(selectors)) return [];
  const valid = [];
  const seen = new Set();

  for (const raw of selectors) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s || s.length > 220) continue;
    if (/[{};<>`@]/.test(s) || s.includes('/*') || s.includes('*/')) continue;

    const normalizedLower = s.toLowerCase().replace(/\s+/g, ' ');
    if (FORBIDDEN_SELECTORS.has(normalizedLower)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    valid.push(s);
  }

  return valid.slice(0, maxSelectors);
}

/**
 * Filter out selectors with dynamic per-impression numeric IDs before caching per domain.
 * @param {unknown} selectors
 * @returns {string[]}
 */
export function filterCacheableSelectors(selectors) {
  return sanitizeCssSelectors(selectors).filter((sel) => !DYNAMIC_INSTANCE_ID_RE.test(sel));
}
