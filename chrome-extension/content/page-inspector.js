(() => {
  if (globalThis.__pageStitchInspectorLoaded) return;
  globalThis.__pageStitchInspectorLoaded = true;

  const CLEANUP_STYLE_ATTR = 'data-stitch-cleanup';
  const TIME_SLICE_BUDGET_MS = 10;

  const PROTECTED_TAGS = new Set(['html', 'body', 'head', 'main', 'article', 'nav']);
  const PROTECTED_ROLES = new Set(['main', 'article', 'navigation']);
  const SKIP_INSPECT_TAGS = new Set([
    'script',
    'style',
    'link',
    'meta',
    'noscript',
    'template',
    'svg',
    'path',
    'g',
    'defs',
    'clippath',
    'use',
    'symbol',
    'br',
    'hr',
    'wbr'
  ]);

  const LEGITIMATE_EMBED_RE =
    /(?:^|\.|\/)(?:youtube\.com|youtu\.be|youtube-nocookie\.com|player\.vimeo\.com|open\.spotify\.com|codepen\.io|jsfiddle\.net|figma\.com|platform\.twitter\.com|x\.com|instagram\.com|soundcloud\.com)(?:\/|$)|google\.com\/maps/i;

  const AD_IFRAME_SRC_RE =
    /(?:googlesyndication\.com|doubleclick\.net|2mdn\.net|adservice\.google\.|criteo\.|amazon-adsystem\.com|adnxs\.com|rubiconproject\.com|pubmatic\.com|openx\.net|taboola\.com|outbrain\.com)/i;

  const AD_TOKEN_RE =
    /(?:^|[-_\s])(ad|ads|advert|advertisement|adslot|adunit|adsbygoogle|dfp|gpt|sponsored|outbrain|taboola|inline-ad|in-article-ad|banner-ad)(?:$|[-_\s\d])/i;

  const AD_DATA_ATTR_RE =
    /^data-(?:ad(?:$|[-_])|google-query-id|freestar-ad|taboola|outbrain|ez-ph)/i;

  const AD_LABEL_ONLY_RE =
    /^(advertisement|advertisements|advertising|sponsored|sponsored content|paid advertisement|paid partner|ad|ads|article continues below|story continues below|continue reading below)$/i;

  const CLUTTER_HINT_RE =
    /\b(cookie|consent|gdpr|privacy|onetrust|cookiebot|didomi|newsletter|subscribe|promo|banner|modal|popup|dialog|intercom|drift|hubspot|chat-widget|toast|snackbar|ad-slot|advert|sponsored|taboola|outbrain)\b/i;

  const UTILITY_CLASS_EXACT = new Set([
    'flex',
    'inline-flex',
    'grid',
    'inline-grid',
    'block',
    'inline-block',
    'inline',
    'hidden',
    'contents',
    'table',
    'relative',
    'absolute',
    'fixed',
    'sticky',
    'static',
    'items-start',
    'items-end',
    'items-center',
    'items-baseline',
    'items-stretch',
    'justify-start',
    'justify-end',
    'justify-center',
    'justify-between',
    'justify-around',
    'justify-evenly',
    'content-center',
    'self-center',
    'place-items-center',
    'flex-row',
    'flex-col',
    'flex-wrap',
    'flex-nowrap',
    'flex-1',
    'flex-auto',
    'flex-initial',
    'flex-none',
    'grow',
    'shrink',
    'shrink-0',
    'w-full',
    'w-screen',
    'w-auto',
    'h-full',
    'h-screen',
    'h-auto',
    'min-h-screen',
    'max-w-full',
    'overflow-hidden',
    'overflow-auto',
    'overflow-scroll',
    'overflow-visible',
    'overflow-x-hidden',
    'overflow-y-auto',
    'pointer-events-none',
    'pointer-events-auto',
    'select-none',
    'mx-auto',
    'my-auto',
    'inset-0',
    'top-0',
    'bottom-0',
    'left-0',
    'right-0',
    'rounded',
    'border',
    'shadow',
    'transition',
    'transform',
    'container',
    'prose',
    'clearfix',
    'row',
    'col',
    'wrapper',
    'inner',
    'content'
  ]);

  const UTILITY_CLASS_PREFIX_RE =
    /^(?:p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|w|h|min-w|max-w|min-h|max-h|size|text|font|leading|tracking|bg|from|via|to|border|rounded|shadow|ring|opacity|z|top|right|bottom|left|inset|translate-x|translate-y|scale|rotate|duration|delay|ease|col-span|row-span|grid-cols|grid-rows|order|aspect)-[\w./[\]%+-]+$/;

  const EXPLICIT_PAGINATION_CONTAINER_SELECTOR =
    '.pagination, .pager, .page-numbers, .pagenavi, .wp-pagenavi, nav[aria-label*="pag" i], [role="navigation"][aria-label*="pag" i]';

  let savedScrollY = 0;
  let capturePrepared = false;

  /** @type {Map<Element, { hadStyle: boolean, origStyle: string | null }>} */
  const styleSnapshots = new Map();

  /** @type {Map<HTMLImageElement, { hadLoading: boolean, loading: string | null, hadDecoding: boolean, decoding: string | null }>} */
  const imgAttrSnapshots = new Map();

  /** @type {Set<Element>} */
  const capturedStickyElements = new Set();

  /**
   * Yield to a macrotask so main thread stays responsive without blocking on occluded rAF.
   */
  async function yieldTimeSlice() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /**
   * Race requestAnimationFrame with a 35ms timer so background/occluded windows never hang.
   */
  async function nextFrame() {
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(resolve)),
      new Promise((resolve) => setTimeout(resolve, 35))
    ]);
    if (typeof globalThis.scheduler?.yield === 'function') {
      await globalThis.scheduler.yield();
    }
  }

  /**
   * Wait two frame boundaries plus an optional settle delay.
   * @param {number} [delayMs]
   */
  async function waitForPaint(delayMs = 0) {
    await nextFrame();
    await nextFrame();
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /**
   * Snapshot original style attribute once before any mutation so restoration is byte-exact.
   * @param {Element} el
   */
  function snapshotElementStyle(el) {
    if (!el || styleSnapshots.has(el)) return;
    styleSnapshots.set(el, {
      hadStyle: el.hasAttribute('style'),
      origStyle: el.getAttribute('style')
    });
  }

  /**
   * Apply an !important inline CSS property after snapshotting the element's original style.
   * @param {Element} el
   * @param {string} prop
   * @param {string} value
   */
  function setImportantStyle(el, prop, value) {
    if (!el || !('style' in el) || !el.style) return;
    snapshotElementStyle(el);
    el.style.setProperty(prop, value, 'important');
  }

  /**
   * Escape a CSS identifier safely.
   * @param {string} value
   * @returns {string}
   */
  function escapeCssIdent(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return String(value).replace(/([^\w-])/g, '\\$1');
  }

  /**
   * Escape an attribute value for inside double quotes in a CSS selector.
   * @param {string} value
   * @returns {string}
   */
  function escapeCssAttrValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Check whether a class name is a generic layout/Tailwind utility class.
   * @param {string} cls
   * @returns {boolean}
   */
  function isUtilityClass(cls) {
    if (!cls || cls.length > 56) return true;
    if (/[:/[\]!%]/.test(cls)) return true;
    const lower = cls.toLowerCase();
    if (UTILITY_CLASS_EXACT.has(lower)) return true;
    if (UTILITY_CLASS_PREFIX_RE.test(lower)) return true;
    return false;
  }

  /**
   * Check whether an element is or contains a legitimate embedded media player/widget.
   * @param {Element} el
   * @returns {boolean}
   */
  function isLegitimateEmbed(el) {
    const tag = el.tagName?.toLowerCase();
    if (!tag) return false;

    if (tag === 'iframe' || tag === 'embed' || tag === 'object') {
      const src = el.getAttribute('src') || el.getAttribute('data') || '';
      if (src && LEGITIMATE_EMBED_RE.test(src)) return true;
    }

    if (
      tag === 'blockquote' &&
      (el.classList.contains('twitter-tweet') || el.classList.contains('instagram-media'))
    ) {
      return true;
    }

    const childEmbeds = el.querySelectorAll(
      'iframe[src], embed[src], blockquote.twitter-tweet, blockquote.instagram-media'
    );
    for (const child of childEmbeds) {
      if (child.tagName.toLowerCase() === 'blockquote') return true;
      const src = child.getAttribute('src') || '';
      if (src && LEGITIMATE_EMBED_RE.test(src)) return true;
    }

    return false;
  }

  /**
   * Guard against hiding/collapsing primary content, navigation landmarks, headings, prose, or embeds.
   * @param {Element} el
   * @param {CSSStyleDeclaration} [computedStyle]
   * @param {DOMRect} [rect]
   * @returns {boolean}
   */
  function isProtectedContent(el, computedStyle, rect) {
    if (!el || el.nodeType !== 1) return true;
    const tag = el.tagName.toLowerCase();
    if (PROTECTED_TAGS.has(tag)) return true;

    const role = (el.getAttribute('role') || '').toLowerCase().trim();
    if (PROTECTED_ROLES.has(role)) return true;

    if (el.querySelector('main, article, [role="main"], [role="article"], h1')) {
      return true;
    }

    if (isLegitimateEmbed(el)) {
      return true;
    }

    const style = computedStyle || window.getComputedStyle(el);
    const box = rect || el.getBoundingClientRect();
    const zIndex = Number.parseInt(style.zIndex, 10) || 0;
    const isFixedModalDialog =
      style.position === 'fixed' &&
      box.height > 0 &&
      box.height < window.innerHeight * 0.85 &&
      (zIndex >= 50 ||
        role === 'dialog' ||
        role === 'alertdialog' ||
        el.getAttribute('aria-modal') === 'true');

    if (!isFixedModalDialog) {
      if (el.getElementsByTagName('p').length >= 3) return true;
      const proseLen = (el.textContent || '').replace(/\s+/g, ' ').trim().length;
      if (proseLen > 500) return true;
    }

    return false;
  }

  /**
   * Guard against hiding full-page layout containers on Slice 1+ fixed/sticky suppression.
   * Allows hiding already-captured sticky/fixed top headers and nav bars on Slice 1+.
   * @param {Element} el
   * @param {DOMRect} rect
   * @returns {boolean}
   */
  function isPrimaryLayoutContainer(el, rect) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body' || tag === 'head' || tag === 'main' || tag === 'article') {
      return true;
    }
    const role = (el.getAttribute('role') || '').toLowerCase().trim();
    if (role === 'main' || role === 'article') return true;
    if (el.querySelector('main, article, [role="main"], [role="article"]')) return true;
    if (
      rect.width >= window.innerWidth * 0.9 &&
      rect.height >= window.innerHeight * 0.9 &&
      (el.getElementsByTagName('p').length >= 3 ||
        (el.textContent || '').replace(/\s+/g, ' ').trim().length > 500)
    ) {
      return true;
    }
    return false;
  }

  /**
   * Build a specific, non-utility CSS selector for an element; never returns bare tags.
   * @param {Element} el
   * @returns {string}
   */
  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (PROTECTED_TAGS.has(tag)) {
      return '';
    }

    if (el.id && el.id.length <= 100) {
      return `#${escapeCssIdent(el.id)}`;
    }

    for (const attr of ['data-ad-slot', 'data-ad-unit', 'data-ad-name', 'data-ad-region', 'data-freestar-ad']) {
      if (el.hasAttribute(attr)) {
        const val = (el.getAttribute(attr) || '').trim();
        if (val && val.length <= 80 && !/[\r\n]/.test(val)) {
          return `${tag}[${attr}="${escapeCssAttrValue(val)}"]`;
        }
        return `${tag}[${attr}]`;
      }
    }

    const testId = (el.getAttribute('data-testid') || '').trim();
    if (testId && testId.length <= 64 && !/[\r\n]/.test(testId)) {
      return `${tag}[data-testid="${escapeCssAttrValue(testId)}"]`;
    }

    const classes = Array.from(el.classList || [])
      .filter((c) => !isUtilityClass(c))
      .slice(0, 3)
      .map((c) => `.${escapeCssIdent(c)}`);
    if (classes.length > 0) {
      return `${tag}${classes.join('')}`;
    }

    const ariaLabel = (el.getAttribute('aria-label') || '').trim();
    if (ariaLabel && ariaLabel.length <= 64 && !/[\r\n]/.test(ariaLabel) && CLUTTER_HINT_RE.test(ariaLabel)) {
      const role = (el.getAttribute('role') || '').trim();
      if (role && !PROTECTED_ROLES.has(role.toLowerCase())) {
        return `${tag}[role="${escapeCssAttrValue(role)}"][aria-label="${escapeCssAttrValue(ariaLabel)}"]`;
      }
      return `${tag}[aria-label="${escapeCssAttrValue(ariaLabel)}"]`;
    }

    return '';
  }

  /**
   * Read normalized visible text inside an element (excluding display:none descendants).
   * @param {Element} el
   * @returns {string}
   */
  function getNormalizedVisibleText(el) {
    const raw =
      el instanceof HTMLElement && typeof el.innerText === 'string'
        ? el.innerText
        : el.textContent || '';
    return raw.replace(/\s+/g, ' ').trim();
  }

  /**
   * Count visible prose <p> elements inside el (ignoring empty or "Advertisement"-only labels).
   * @param {Element} el
   * @returns {number}
   */
  function countProseParagraphs(el) {
    const paragraphs = el.getElementsByTagName('p');
    let count = 0;
    for (const p of paragraphs) {
      const style = window.getComputedStyle(p);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const txt = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt && !AD_LABEL_ONLY_RE.test(txt)) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Check whether el contains any visible non-ad content media larger than 40x40.
   * @param {Element} el
   * @returns {boolean}
   */
  function hasVisibleContentMedia(el) {
    const mediaNodes = el.querySelectorAll('img, video, canvas, svg, iframe');
    for (const node of mediaNodes) {
      let cur = node;
      let hidden = false;
      while (cur && cur !== el) {
        const st = window.getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') {
          hidden = true;
          break;
        }
        cur = cur.parentElement;
      }
      if (hidden) continue;

      if (node.tagName.toLowerCase() === 'iframe') {
        const src = node.getAttribute('src') || '';
        if (!src || src === 'about:blank' || AD_IFRAME_SRC_RE.test(src)) {
          continue;
        }
      }

      const mRect = node.getBoundingClientRect();
      if (mRect.width > 40 && mRect.height > 40) {
        return true;
      }
    }
    return false;
  }

  /**
   * Determine if an element has explicit ad token attributes/classes or is a standalone ad placeholder.
   * @param {Element} el
   * @param {CSSStyleDeclaration} style
   * @param {DOMRect} rect
   * @returns {boolean}
   */
  function isInFlowAdOrPlaceholder(el, style, rect) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'amp-ad' || tag === 'amp-sticky-ad') return true;
    if (tag === 'ins' && el.classList.contains('adsbygoogle')) return true;

    if (tag === 'iframe') {
      const src = el.getAttribute('src') || '';
      const id = el.id || '';
      if (AD_IFRAME_SRC_RE.test(src) || /^google_ads_iframe/i.test(id)) {
        return true;
      }
    }

    const attrNames = typeof el.getAttributeNames === 'function' ? el.getAttributeNames() : [];
    for (const attr of attrNames) {
      if (AD_DATA_ATTR_RE.test(attr)) return true;
    }

    const idStr = el.id || '';
    const clsStr = typeof el.className === 'string' ? el.className : '';
    const testId = el.getAttribute('data-testid') || '';
    const ariaLabel = el.getAttribute('aria-label') || '';

    if (
      (idStr && AD_TOKEN_RE.test(idStr)) ||
      (clsStr && AD_TOKEN_RE.test(clsStr)) ||
      (testId && AD_TOKEN_RE.test(testId)) ||
      (ariaLabel && AD_TOKEN_RE.test(ariaLabel))
    ) {
      return true;
    }

    // Standalone empty "Advertisement" / "Sponsored" placeholder box check
    if (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.height > 0 &&
      rect.height <= 650 &&
      countProseParagraphs(el) === 0 &&
      !hasVisibleContentMedia(el)
    ) {
      const visText = getNormalizedVisibleText(el);
      if (visText && AD_LABEL_ONLY_RE.test(visText)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Walk up to 4 ancestors of a collapsed ad element to collapse empty/"Advertisement"-only
   * CLS min-height reserve wrappers without harming surrounding content or shifting above coveredCssY.
   * @param {Element} adEl
   * @param {number} [coveredCssY]
   */
  function collapseAdAncestors(adEl, coveredCssY = 0) {
    let parent = adEl?.parentElement || null;
    for (let depth = 0; depth < 4 && parent; depth++) {
      const pTag = parent.tagName.toLowerCase();
      if (pTag === 'header' || pTag === 'footer') break;
      if (isProtectedContent(parent)) break;

      const pRect = parent.getBoundingClientRect();
      const parentDocTop = pRect.top + window.scrollY;
      if (coveredCssY > 0 && parentDocTop < coveredCssY - 2) {
        break;
      }

      if (countProseParagraphs(parent) > 0) break;
      if (hasVisibleContentMedia(parent)) break;

      const remText = getNormalizedVisibleText(parent);
      if (remText !== '' && !AD_LABEL_ONLY_RE.test(remText)) {
        break;
      }

      setImportantStyle(parent, 'display', 'none');
      parent = parent.parentElement;
    }
  }

  /**
   * Collapse in-flow ads and CLS reserve wrappers safely.
   * On Slice 1+ (coveredCssY > 0), elements above coveredCssY - 2 use visibility:hidden
   * so already-captured coordinates do not shift.
   * @param {object} [options]
   * @param {number} [options.coveredCssY]
   */
  async function collapseInlineAds({ coveredCssY = 0 } = {}) {
    const allElements = Array.from(document.querySelectorAll('body *'));
    let sliceStart = performance.now();

    for (let i = 0; i < allElements.length; i++) {
      if ((i & 31) === 31 && performance.now() - sliceStart > TIME_SLICE_BUDGET_MS) {
        await yieldTimeSlice();
        sliceStart = performance.now();
      }

      const el = allElements[i];
      if (!el.isConnected) continue;
      const tag = el.tagName.toLowerCase();
      if (SKIP_INSPECT_TAGS.has(tag)) continue;

      const style = window.getComputedStyle(el);
      if (style.position === 'fixed') continue;

      if (style.display === 'none') {
        const parent = el.parentElement;
        if (
          parent &&
          !styleSnapshots.has(parent) &&
          window.getComputedStyle(parent).display !== 'none' &&
          !isProtectedContent(el, style) &&
          isInFlowAdOrPlaceholder(el, style, el.getBoundingClientRect())
        ) {
          collapseAdAncestors(el, coveredCssY);
        }
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (isProtectedContent(el, style, rect)) continue;

      if (!isInFlowAdOrPlaceholder(el, style, rect)) continue;

      const docTop = rect.top + window.scrollY;
      if (coveredCssY <= 0 || docTop >= coveredCssY - 2) {
        setImportantStyle(el, 'display', 'none');
        collapseAdAncestors(el, coveredCssY);
      } else {
        setImportantStyle(el, 'visibility', 'hidden');
      }
    }
  }

  /**
   * Switch native lazy images to eager/sync so scrolling captures decoded bitmaps instead of blanks.
   */
  function promoteLazyImages() {
    const images = document.querySelectorAll('img');
    for (const img of images) {
      const loadingAttr = img.getAttribute('loading');
      const decodingAttr = img.getAttribute('decoding');
      if ((loadingAttr && loadingAttr.toLowerCase() === 'lazy') || img.loading === 'lazy') {
        if (!imgAttrSnapshots.has(img)) {
          imgAttrSnapshots.set(img, {
            hadLoading: img.hasAttribute('loading'),
            loading: loadingAttr,
            hadDecoding: img.hasAttribute('decoding'),
            decoding: decodingAttr
          });
        }
        img.loading = 'eager';
        img.decoding = 'sync';
      }
    }
  }

  /**
   * Wait up to timeoutMs for visible viewport <img> elements to finish decoding.
   * @param {number} [timeoutMs]
   */
  async function waitForVisibleImages(timeoutMs = 250) {
    const images = Array.from(document.querySelectorAll('img'));
    const decodeTasks = [];

    for (const img of images) {
      const rect = img.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < -80 || rect.top > window.innerHeight + 80) continue;

      if (img.loading === 'lazy') {
        img.loading = 'eager';
      }
      if (typeof img.decode === 'function' && (!img.complete || img.naturalWidth === 0)) {
        decodeTasks.push(
          (async () => {
            try {
              await img.decode();
            } catch {
              // Ignore broken or cross-origin decode errors
            }
          })()
        );
      }
    }

    if (decodeTasks.length === 0) return;

    await Promise.race([
      Promise.all(decodeTasks),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  }

  /**
   * Record any currently visible sticky elements in the viewport as captured.
   */
  function markVisibleStickyElementsCaptured() {
    const allElements = document.querySelectorAll('body *');
    for (const el of allElements) {
      const style = window.getComputedStyle(el);
      if (style.position !== 'sticky') continue;
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom > 0 && rect.top < window.innerHeight) {
        capturedStickyElements.add(el);
      }
    }
  }

  /**
   * Read current document scroll and viewport dimensions.
   */
  function readPageMetrics() {
    const docEl = document.documentElement;
    const body = document.body;
    const scrollHeight = Math.max(
      docEl ? docEl.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      window.innerHeight
    );
    const scrollWidth = Math.max(
      docEl ? docEl.scrollWidth : 0,
      body ? body.scrollWidth : 0,
      window.innerWidth
    );

    return {
      scrollHeight,
      scrollWidth,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      url: window.location.href,
      hostname: window.location.hostname
    };
  }

  /**
   * Inspect DOM in fast time-sliced passes for overlays, inline ad clutter, and pagination links.
   */
  async function inspectPage() {
    const allElements = Array.from(document.querySelectorAll('body *'));
    const overlayCandidates = [];
    const inlineClutterCandidates = [];
    const seenSelectors = new Set();

    let sliceStart = performance.now();

    for (let i = 0; i < allElements.length; i++) {
      if ((i & 31) === 31 && performance.now() - sliceStart > TIME_SLICE_BUDGET_MS) {
        await yieldTimeSlice();
        sliceStart = performance.now();
      }

      if (overlayCandidates.length >= 30 && inlineClutterCandidates.length >= 25) {
        break;
      }

      const el = allElements[i];
      const tag = el.tagName.toLowerCase();
      if (SKIP_INSPECT_TAGS.has(tag)) continue;

      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      if (isProtectedContent(el, style, rect)) continue;

      const pos = style.position;
      const zIndex = Number.parseInt(style.zIndex, 10) || 0;
      const cls = typeof el.className === 'string' ? el.className : '';
      const ariaLabel = el.getAttribute('aria-label') || '';
      const meta = `${el.id || ''} ${cls} ${ariaLabel}`;

      const isFixedOrSticky = pos === 'fixed' || pos === 'sticky';
      const isOverlayHint = CLUTTER_HINT_RE.test(meta) && (isFixedOrSticky || zIndex >= 100);
      const isInlineAd = !isFixedOrSticky && isInFlowAdOrPlaceholder(el, style, rect);

      if (!isFixedOrSticky && !isOverlayHint && !isInlineAd) continue;

      if (
        rect.height > window.innerHeight * 0.9 &&
        rect.width > window.innerWidth * 0.9 &&
        !isOverlayHint &&
        !isInlineAd
      ) {
        continue;
      }

      const selector = buildSelector(el);
      if (!selector || seenSelectors.has(selector)) continue;
      seenSelectors.add(selector);

      const candidate = {
        selector,
        kind: isFixedOrSticky || isOverlayHint ? 'overlay' : 'inline-clutter',
        tag,
        id: el.id || '',
        classes: cls.slice(0, 80),
        position: pos,
        zIndex,
        rect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        textSample: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
      };

      if (candidate.kind === 'overlay') {
        if (overlayCandidates.length < 30) overlayCandidates.push(candidate);
      } else if (inlineClutterCandidates.length < 25) {
        inlineClutterCandidates.push(candidate);
      }
    }

    const overlays = [...overlayCandidates, ...inlineClutterCandidates].slice(0, 50);

    // Collect candidate pagination links across the ENTIRE document without starving on <header><nav>
    const highPriorityLinks = [];
    const standardLinks = [];
    const seenHrefs = new Set();

    const relNextLinks = Array.from(
      document.querySelectorAll('link[rel~="next"][href], a[rel~="next"][href]')
    );
    for (const link of relNextLinks) {
      const href = link.href || link.getAttribute('href');
      if (!href || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      highPriorityLinks.push({
        href,
        text: (link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        rel: link.getAttribute('rel') || 'next',
        ariaLabel: (link.getAttribute('aria-label') || '').slice(0, 60),
        className: typeof link.className === 'string' ? link.className.slice(0, 60) : '',
        id: link.id || '',
        inPagination: true
      });
    }

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const PAGINATION_TEXT_OR_META_RE =
      /\b(next|older\s+posts|older\s+entries|continue\s+reading|page|pager|pagination|pagenavi)\b|^(?:→|›|»|>)$/i;
    const PAGINATION_URL_RE =
      /[?&](?:page|p|pg|paged)=\d+|(?:\/page\/|\/p\/|\/part\/|-page-|-part-|_page_|_part_)\d+/i;

    sliceStart = performance.now();
    for (let i = 0; i < anchors.length; i++) {
      if ((i & 63) === 63 && performance.now() - sliceStart > TIME_SLICE_BUDGET_MS) {
        await yieldTimeSlice();
        sliceStart = performance.now();
      }

      const a = anchors[i];
      const href = a.href || a.getAttribute('href');
      if (!href || seenHrefs.has(href)) continue;
      if (href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
        continue;
      }

      const inPagination = Boolean(a.closest(EXPLICIT_PAGINATION_CONTAINER_SELECTOR));
      const inSiteHeaderNav = !inPagination && Boolean(a.closest('header, header nav'));
      if (inSiteHeaderNav) continue;

      const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const aria = a.getAttribute('aria-label') || '';
      const rel = a.getAttribute('rel') || '';
      const cls = typeof a.className === 'string' ? a.className : '';
      const combined = `${text} ${aria} ${rel} ${cls} ${a.id || ''}`;

      const isNumericPageLink = /^\d{1,3}$/.test(text) && (inPagination || PAGINATION_URL_RE.test(href));
      const hasUrlHint = PAGINATION_URL_RE.test(href);
      const hasMetaHint = PAGINATION_TEXT_OR_META_RE.test(combined);

      if (inPagination || isNumericPageLink || hasUrlHint || hasMetaHint) {
        seenHrefs.add(href);
        const entry = {
          href,
          text,
          rel,
          ariaLabel: aria.slice(0, 60),
          className: cls.slice(0, 60),
          id: a.id || '',
          inPagination
        };
        if (inPagination || hasUrlHint) {
          highPriorityLinks.push(entry);
        } else {
          standardLinks.push(entry);
        }
      }
    }

    const nextCandidates = [...highPriorityLinks, ...standardLinks].slice(0, 40);

    return {
      pageMetrics: readPageMetrics(),
      overlays,
      nextCandidates
    };
  }

  /**
   * Inject temporary cleanup stylesheet, scroll to top, collapse in-flow ads & wrappers,
   * suppress Slice-0 bottom fixed/sticky bars on scrollable pages, and measure dimensions.
   * @param {object} [options]
   * @param {string[]} [options.cleanupSelectors]
   * @param {boolean} [options.hideScrollbars]
   * @param {boolean} [options.autoCleanClutter]
   */
  async function prepareCapture({
    cleanupSelectors = [],
    hideScrollbars = true,
    autoCleanClutter = true
  } = {}) {
    if (
      capturePrepared ||
      styleSnapshots.size > 0 ||
      imgAttrSnapshots.size > 0 ||
      document.querySelector(`style[${CLEANUP_STYLE_ATTR}="true"]`)
    ) {
      await restorePage({ restoreScroll: false });
    }

    savedScrollY = window.scrollY;
    capturePrepared = true;
    capturedStickyElements.clear();

    const rules = [
      'html, body, *, *::before, *::after { scroll-behavior: auto !important; }'
    ];

    if (hideScrollbars) {
      rules.push(
        'html { scrollbar-width: none !important; }',
        'html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }'
      );
    }

    const safeSelectors = (Array.isArray(cleanupSelectors) ? cleanupSelectors : []).filter(
      (s) => typeof s === 'string' && s.trim() && !/[{};<>`@]/.test(s)
    );

    /** @type {Array<{ sel: string, matches: Element[], hitsProtected: boolean }>} */
    const evaluatedSelectors = [];
    if (autoCleanClutter) {
      for (const rawSel of safeSelectors) {
        const sel = rawSel.trim();
        let matches = [];
        try {
          matches = Array.from(document.querySelectorAll(sel));
        } catch {
          // Invalid CSS selector syntax; skip safely
          continue;
        }
        const hitsProtected = matches.some((el) => isProtectedContent(el));
        evaluatedSelectors.push({ sel, matches, hitsProtected });
        if (!hitsProtected) {
          // Emit one CSS rule per selector so an unsupported selector never invalidates others
          rules.push(`${sel} { display: none !important; visibility: hidden !important; }`);
        }
      }
    }

    const styleEl = document.createElement('style');
    styleEl.setAttribute(CLEANUP_STYLE_ATTR, 'true');
    styleEl.textContent = rules.join('\n');
    (document.head || document.documentElement).appendChild(styleEl);

    // Scroll to top BEFORE measuring and hiding bottom bars so sticky headers sit at their natural top state
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    promoteLazyImages();

    if (autoCleanClutter) {
      // Hide non-protected matches when a selector partially overlapped a protected wrapper,
      // and collapse empty CLS reserve wrappers around all hidden ad/clutter matches.
      for (const { matches, hitsProtected } of evaluatedSelectors) {
        for (const el of matches) {
          if (!isProtectedContent(el)) {
            if (hitsProtected) {
              setImportantStyle(el, 'display', 'none');
            }
            collapseAdAncestors(el, 0);
          }
        }
      }

      // Collapse remaining heuristic in-flow ads & standalone "Advertisement" placeholder boxes
      await collapseInlineAds({ coveredCssY: 0 });
    }

    await waitForPaint(35);
    const initialMetrics = readPageMetrics();

    // Suppress bottom-anchored fixed/sticky bars BEFORE Slice 0 on scrollable pages
    if (autoCleanClutter && initialMetrics.scrollHeight > initialMetrics.viewportHeight + 20) {
      const allElements = Array.from(document.querySelectorAll('body *'));
      let sliceStart = performance.now();
      for (let i = 0; i < allElements.length; i++) {
        if ((i & 31) === 31 && performance.now() - sliceStart > TIME_SLICE_BUDGET_MS) {
          await yieldTimeSlice();
          sliceStart = performance.now();
        }
        const el = allElements[i];
        const tag = el.tagName.toLowerCase();
        if (SKIP_INSPECT_TAGS.has(tag)) continue;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (style.position !== 'fixed' && style.position !== 'sticky') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (isProtectedContent(el, style, rect)) continue;

        if (
          rect.bottom >= window.innerHeight - 120 &&
          rect.top >= window.innerHeight * 0.38 &&
          rect.height < window.innerHeight * 0.48
        ) {
          setImportantStyle(el, 'visibility', 'hidden');
        }
      }
      await nextFrame();
    }

    return readPageMetrics();
  }

  /**
   * Scroll to Y, suppress fixed / already-captured sticky elements on Slice 1+,
   * run seam-safe lazy ad cleanup, and wait for visible images to decode.
   * @param {object} params
   * @param {number} params.y
   * @param {boolean} [params.hideFixed]
   * @param {number} [params.coveredCssY]
   * @param {boolean} [params.autoCleanClutter]
   */
  async function scrollAndHideFixed({
    y,
    hideFixed = false,
    coveredCssY = 0,
    autoCleanClutter = true
  }) {
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    await nextFrame();
    promoteLazyImages();

    if (hideFixed) {
      const candidates = Array.from(document.querySelectorAll('body *'));
      let sliceStart = performance.now();

      for (let i = 0; i < candidates.length; i++) {
        if ((i & 31) === 31 && performance.now() - sliceStart > TIME_SLICE_BUDGET_MS) {
          await yieldTimeSlice();
          sliceStart = performance.now();
        }

        const el = candidates[i];
        const tag = el.tagName.toLowerCase();
        if (SKIP_INSPECT_TAGS.has(tag)) continue;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;

        const pos = style.position;
        if (pos !== 'fixed' && pos !== 'sticky') continue;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (isPrimaryLayoutContainer(el, rect)) continue;

        if (pos === 'fixed') {
          setImportantStyle(el, 'visibility', 'hidden');
          continue;
        }

        // pos === 'sticky': only hide if already captured in an earlier slice or stuck from above coveredCssY
        if (capturedStickyElements.has(el)) {
          setImportantStyle(el, 'visibility', 'hidden');
          continue;
        }

        const rawTop = style.top;
        const parsedTop = rawTop && rawTop.endsWith('px') ? Number.parseFloat(rawTop) || 0 : 0;
        const parentRect = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
        const containerDocTop = parentRect ? parentRect.top + window.scrollY : 0;
        const isStuckAtTopEdge =
          style.top !== 'auto' &&
          rect.top <= parsedTop + 4 &&
          containerDocTop < coveredCssY - 2;

        if (isStuckAtTopEdge) {
          setImportantStyle(el, 'visibility', 'hidden');
        }
      }

      if (autoCleanClutter) {
        await collapseInlineAds({ coveredCssY });
      }
    }

    await waitForPaint(40);
    await waitForVisibleImages(250);

    // Record sticky elements visible in this slice so subsequent slices do not repeat them
    markVisibleStickyElementsCaptured();

    return {
      actualScrollY: window.scrollY,
      viewportHeight: window.innerHeight,
      scrollHeight: readPageMetrics().scrollHeight
    };
  }

  function restoreCleanupStyle() {
    document.querySelectorAll(`style[${CLEANUP_STYLE_ATTR}="true"]`).forEach((el) => el.remove());
  }

  /**
   * Restore all modified inline styles byte-for-byte, cleanup stylesheets, lazy image attributes, and scroll.
   * @param {object} [options]
   * @param {boolean} [options.restoreScroll]
   */
  async function restorePage({ restoreScroll = true } = {}) {
    restoreCleanupStyle();

    if (styleSnapshots.size > 0) {
      const entries = Array.from(styleSnapshots.entries());
      styleSnapshots.clear();
      let sliceStart = performance.now();

      for (let i = 0; i < entries.length; i++) {
        if ((i & 63) === 63 && performance.now() - sliceStart > TIME_SLICE_BUDGET_MS) {
          await yieldTimeSlice();
          sliceStart = performance.now();
        }
        const [el, snap] = entries[i];
        if (!el) continue;
        if (snap.hadStyle && snap.origStyle !== null) {
          el.setAttribute('style', snap.origStyle);
        } else {
          el.removeAttribute('style');
        }
      }
    }

    if (imgAttrSnapshots.size > 0) {
      for (const [img, snap] of imgAttrSnapshots.entries()) {
        if (!img) continue;
        if (snap.hadLoading && snap.loading !== null) {
          img.setAttribute('loading', snap.loading);
        } else {
          img.removeAttribute('loading');
        }
        if (snap.hadDecoding && snap.decoding !== null) {
          img.setAttribute('decoding', snap.decoding);
        } else {
          img.removeAttribute('decoding');
        }
      }
      imgAttrSnapshots.clear();
    }

    capturedStickyElements.clear();
    capturePrepared = false;

    if (restoreScroll) {
      window.scrollTo({ top: savedScrollY, left: 0, behavior: 'instant' });
    }

    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    (async () => {
      try {
        switch (message?.type) {
          case 'PING':
            sendResponse({ ok: true });
            break;
          case 'INSPECT_PAGE':
            sendResponse({ ok: true, data: await inspectPage() });
            break;
          case 'PREPARE_CAPTURE':
            sendResponse({ ok: true, data: await prepareCapture(message.payload) });
            break;
          case 'SCROLL_AND_HIDE_FIXED':
            sendResponse({ ok: true, data: await scrollAndHideFixed(message.payload) });
            break;
          case 'RESTORE_PAGE':
            sendResponse({ ok: true, data: await restorePage(message.payload) });
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
})();
