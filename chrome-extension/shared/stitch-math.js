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
  'html',
  'body',
  'head',
  'main',
  'article',
  'section',
  ':root',
  'div',
  'span',
  'p',
  'a'
]);

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
    const sh = Math.min(slice.imageHeight - sy, Math.max(1, Math.round(drawCss * pxPerCssY)));
    const dy = Math.round(destCssY * pxPerCssY);

    if (sh <= 0) continue;

    rawPlacements.push({
      index: i,
      sx: 0,
      sy,
      sw: slice.imageWidth,
      sh,
      dx: 0,
      dy,
      dw: baseWidth,
      dh: sh
    });

    coveredCssY = destCssY + drawCss;
    maxBottomPx = Math.max(maxBottomPx, dy + sh);
  }

  const unscaledHeight = Math.max(1, maxBottomPx);
  const scale = computeSafeCanvasScale(baseWidth, unscaledHeight, {
    maxCanvasWidth,
    maxCanvasHeight,
    maxCanvasArea
  });

  const width = Math.max(1, Math.floor(baseWidth * scale));
  const height = Math.max(1, Math.floor(unscaledHeight * scale));

  const placements = rawPlacements.map((p) => ({
    index: p.index,
    sx: p.sx,
    sy: p.sy,
    sw: p.sw,
    sh: p.sh,
    dx: Math.round(p.dx * scale),
    dy: Math.round(p.dy * scale),
    dw: Math.max(1, Math.round(p.dw * scale)),
    dh: Math.max(1, Math.round(p.dh * scale))
  }));

  return { width, height, scale, placements };
}

/**
 * Compute vertical stacking layout for multiple captured page images.
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
    dimensions.reduce((sum, d) => sum + Math.round(d.height), 0) + totalGap
  );

  const scale = computeSafeCanvasScale(unscaledWidth, unscaledHeight, {
    maxCanvasWidth,
    maxCanvasHeight,
    maxCanvasArea
  });

  const width = Math.max(1, Math.floor(unscaledWidth * scale));
  const height = Math.max(1, Math.floor(unscaledHeight * scale));

  let cursorY = 0;
  const placements = dimensions.map((d, index) => {
    const scaledW = Math.max(1, Math.round(d.width * scale));
    const scaledH = Math.max(1, Math.round(d.height * scale));
    const x = Math.max(0, Math.floor((width - scaledW) / 2));
    const y = cursorY;
    cursorY += scaledH + Math.round(gapPx * scale);
    return { index, x, y, width: scaledW, height: scaledH };
  });

  return { width, height, scale, placements };
}

/**
 * Extract trailing or query page integer from a URL if present.
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
  const pathMatch = urlObj.pathname.match(/(?:\/page\/|\/p\/|-page-|\/)(\d+)(?:\/|\.html?)?$/i);
  if (pathMatch) {
    return Number.parseInt(pathMatch[1], 10);
  }
  return null;
}

/**
 * Score candidate pagination links heuristically and pick the best next-page URL.
 * @param {Array<{ href: string, text?: string, rel?: string, ariaLabel?: string, className?: string, id?: string }>} candidates
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

    const rel = String(item.rel || '').toLowerCase();
    const text = String(item.text || '').trim();
    const textLower = text.toLowerCase();
    const ariaLower = String(item.ariaLabel || '').toLowerCase();
    const metaLower = `${item.className || ''} ${item.id || ''}`.toLowerCase();

    if (rel.split(/\s+/).includes('next')) {
      score += 100;
      reasons.push('rel=next');
    }

    if (resolved.origin === current.origin) {
      score += 20;
      reasons.push('same-origin');
    } else {
      score -= 60;
    }

    if (/^(next(\s+page)?|older(\s+posts)?|continue(\s+reading)?|more|→|›|»|>)$/i.test(text)) {
      score += 60;
      reasons.push('exact-next-text');
    } else if (/\bnext\b/i.test(textLower) || /\bnext\b/i.test(ariaLower)) {
      score += 40;
      reasons.push('contains-next');
    } else if (/\bnext\b/i.test(metaLower)) {
      score += 25;
      reasons.push('next-class-or-id');
    }

    if (/\b(prev|previous|back|older\s+than|first|login|sign\s*in|share|comment)\b/i.test(`${textLower} ${ariaLower} ${metaLower}`)) {
      score -= 100;
      reasons.push('negative-keyword');
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
        score -= 50;
      }
    }

    if (score >= 30) {
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
 * Filter CSS selectors to safe, non-destructive element/class/id selectors.
 * @param {unknown} selectors
 * @returns {string[]}
 */
export function sanitizeCssSelectors(selectors) {
  if (!Array.isArray(selectors)) return [];
  const valid = [];
  const seen = new Set();

  for (const raw of selectors) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (!s || s.length > 180) continue;
    if (/[{};<>`]/.test(s)) continue;
    if (FORBIDDEN_SELECTORS.has(s.toLowerCase())) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    valid.push(s);
  }

  return valid.slice(0, 30);
}
