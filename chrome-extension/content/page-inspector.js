(() => {
  if (globalThis.__pageStitchInspectorLoaded) return;
  globalThis.__pageStitchInspectorLoaded = true;

  const CLEANUP_STYLE_ATTR = 'data-stitch-cleanup';
  const BATCH_SIZE = 40;

  let savedScrollBehavior = null;
  let savedScrollY = 0;
  /** @type {Array<{ el: Element, prevVisibility: string, prevPriority: string }>} */
  let hiddenFixedEntries = [];

  /**
   * Yield to next animation frame and optionally scheduler.yield().
   */
  async function nextFrame() {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (typeof globalThis.scheduler?.yield === 'function') {
      await globalThis.scheduler.yield();
    }
  }

  /**
   * Wait two animation frames plus an optional settle delay for lazy paint.
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
   * Build a reasonably specific CSS selector for an element.
   * @param {Element} el
   * @returns {string}
   */
  function buildSelector(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body' || tag === 'main' || tag === 'article') {
      return '';
    }
    if (el.id) {
      return `#${escapeCssIdent(el.id)}`;
    }
    const classes = Array.from(el.classList || [])
      .filter((c) => c && !c.includes(':') && c.length <= 48)
      .slice(0, 3)
      .map((c) => `.${escapeCssIdent(c)}`);
    if (classes.length > 0) {
      return `${tag}${classes.join('')}`;
    }
    const role = el.getAttribute('role');
    if (role) {
      return `${tag}[role="${role.replace(/"/g, '')}"]`;
    }
    return '';
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
   * Inspect DOM in rAF-batched passes for overlays/sticky clutter and pagination links.
   */
  async function inspectPage() {
    const allElements = Array.from(document.querySelectorAll('body *'));
    const overlays = [];
    const seenSelectors = new Set();

    const CLUTTER_HINT_RE =
      /\b(cookie|consent|gdpr|privacy|onetrust|cookiebot|newsletter|subscribe|promo|banner|modal|popup|dialog|intercom|drift|hubspot|chat-widget|toast|snackbar|ad-slot|advert)\b/i;

    for (let i = 0; i < allElements.length; i += BATCH_SIZE) {
      const batch = allElements.slice(i, i + BATCH_SIZE);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          for (const el of batch) {
            if (overlays.length >= 40) break;
            const tag = el.tagName.toLowerCase();
            if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path') continue;

            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              continue;
            }

            const pos = style.position;
            const zIndex = Number.parseInt(style.zIndex, 10) || 0;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;

            const meta = `${el.id || ''} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('aria-label') || ''}`;
            const isFixedOrSticky = pos === 'fixed' || pos === 'sticky';
            const isOverlayHint = CLUTTER_HINT_RE.test(meta) && (isFixedOrSticky || zIndex >= 100);

            if (!isFixedOrSticky && !isOverlayHint) continue;
            // Ignore huge wrappers that cover most of the page as primary layout
            if (rect.height > window.innerHeight * 0.9 && rect.width > window.innerWidth * 0.9 && !isOverlayHint) {
              continue;
            }

            const selector = buildSelector(el);
            if (!selector || seenSelectors.has(selector)) continue;
            seenSelectors.add(selector);

            overlays.push({
              selector,
              tag,
              id: el.id || '',
              classes: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
              position: pos,
              zIndex,
              rect: {
                top: Math.round(rect.top),
                left: Math.round(rect.left),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              textSample: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)
            });
          }
          resolve();
        })
      );
      if (typeof globalThis.scheduler?.yield === 'function') {
        await globalThis.scheduler.yield();
      }
      if (overlays.length >= 40) break;
    }

    // Collect candidate pagination links (batched via rAF)
    const nextCandidates = [];
    const seenHrefs = new Set();

    const relNextLinks = Array.from(document.querySelectorAll('link[rel~="next"][href], a[rel~="next"][href]'));
    for (const link of relNextLinks) {
      const href = link.getAttribute('href');
      if (!href || seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      nextCandidates.push({
        href: link.href || href,
        text: (link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        rel: link.getAttribute('rel') || 'next',
        ariaLabel: link.getAttribute('aria-label') || '',
        className: typeof link.className === 'string' ? link.className.slice(0, 60) : '',
        id: link.id || ''
      });
    }

    const anchors = Array.from(document.querySelectorAll('a[href]'));
    const PAGINATION_HINT_RE =
      /\b(next|older|more|continue|page|pager|pagination)\b|^(→|›|»|>|\d{1,3})$/i;

    for (let i = 0; i < anchors.length; i += BATCH_SIZE) {
      const batch = anchors.slice(i, i + BATCH_SIZE);
      await new Promise((resolve) =>
        requestAnimationFrame(() => {
          for (const a of batch) {
            if (nextCandidates.length >= 35) break;
            const href = a.href || a.getAttribute('href');
            if (!href || seenHrefs.has(href)) continue;

            const text = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
            const aria = a.getAttribute('aria-label') || '';
            const rel = a.getAttribute('rel') || '';
            const cls = typeof a.className === 'string' ? a.className : '';
            const inNav = Boolean(a.closest('nav, [role="navigation"], .pagination, .pager, .page-numbers'));
            const combined = `${text} ${aria} ${rel} ${cls} ${a.id || ''}`;

            if (inNav || PAGINATION_HINT_RE.test(combined) || /[?&](page|p|pg|paged)=\d+/i.test(href)) {
              seenHrefs.add(href);
              nextCandidates.push({
                href,
                text,
                rel,
                ariaLabel: aria.slice(0, 60),
                className: cls.slice(0, 60),
                id: a.id || ''
              });
            }
          }
          resolve();
        })
      );
      if (nextCandidates.length >= 35) break;
    }

    return {
      pageMetrics: readPageMetrics(),
      overlays,
      nextCandidates
    };
  }

  /**
   * Inject temporary cleanup stylesheet and measure post-cleanup dimensions.
   * @param {object} options
   * @param {string[]} [options.cleanupSelectors]
   * @param {boolean} [options.hideScrollbars]
   */
  async function prepareCapture({ cleanupSelectors = [], hideScrollbars = true } = {}) {
    restoreCleanupStyle();

    savedScrollY = window.scrollY;
    savedScrollBehavior = document.documentElement.style.scrollBehavior;
    document.documentElement.style.scrollBehavior = 'instant';

    const rules = [];
    if (hideScrollbars) {
      rules.push(
        'html { scrollbar-width: none !important; }',
        'html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }'
      );
    }

    const safeSelectors = (Array.isArray(cleanupSelectors) ? cleanupSelectors : []).filter(
      (s) => typeof s === 'string' && s.trim() && !/[{};<>`]/.test(s)
    );
    if (safeSelectors.length > 0) {
      rules.push(
        `${safeSelectors.join(',\n')} { display: none !important; visibility: hidden !important; }`
      );
    }

    if (rules.length > 0) {
      const styleEl = document.createElement('style');
      styleEl.setAttribute(CLEANUP_STYLE_ATTR, 'true');
      styleEl.textContent = rules.join('\n');
      (document.head || document.documentElement).appendChild(styleEl);
    }

    await waitForPaint(50);
    return readPageMetrics();
  }

  /**
   * Scroll to Y and optionally hide position:fixed / position:sticky elements after slice 0.
   * @param {object} params
   * @param {number} params.y
   * @param {boolean} [params.hideFixed]
   */
  async function scrollAndHideFixed({ y, hideFixed = false }) {
    document.documentElement.style.scrollBehavior = 'instant';
    window.scrollTo({ top: y, left: 0, behavior: 'instant' });

    if (hideFixed) {
      const candidates = Array.from(document.querySelectorAll('body *'));
      const toHide = [];

      for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        await new Promise((resolve) =>
          requestAnimationFrame(() => {
            for (const el of batch) {
              const pos = window.getComputedStyle(el).position;
              if (pos === 'fixed' || pos === 'sticky') {
                toHide.push(el);
              }
            }
            resolve();
          })
        );
      }

      for (let i = 0; i < toHide.length; i += BATCH_SIZE) {
        const batch = toHide.slice(i, i + BATCH_SIZE);
        await new Promise((resolve) =>
          requestAnimationFrame(() => {
            for (const el of batch) {
              if (!hiddenFixedEntries.some((entry) => entry.el === el)) {
                hiddenFixedEntries.push({
                  el,
                  prevVisibility: el.style.getPropertyValue('visibility'),
                  prevPriority: el.style.getPropertyPriority('visibility')
                });
              }
              el.style.setProperty('visibility', 'hidden', 'important');
            }
            resolve();
          })
        );
      }
    }

    await waitForPaint(70);
    return {
      actualScrollY: Math.round(window.scrollY),
      viewportHeight: window.innerHeight,
      scrollHeight: readPageMetrics().scrollHeight
    };
  }

  function restoreCleanupStyle() {
    document.querySelectorAll(`style[${CLEANUP_STYLE_ATTR}="true"]`).forEach((el) => el.remove());
  }

  /**
   * Restore all temporarily hidden elements, stylesheets, and scroll position.
   * @param {object} [options]
   * @param {boolean} [options.restoreScroll]
   */
  async function restorePage({ restoreScroll = true } = {}) {
    restoreCleanupStyle();

    if (hiddenFixedEntries.length > 0) {
      const entries = hiddenFixedEntries;
      hiddenFixedEntries = [];
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        await new Promise((resolve) =>
          requestAnimationFrame(() => {
            for (const entry of batch) {
              if (entry.prevVisibility) {
                entry.el.style.setProperty('visibility', entry.prevVisibility, entry.prevPriority);
              } else {
                entry.el.style.removeProperty('visibility');
              }
            }
            resolve();
          })
        );
      }
    }

    if (restoreScroll) {
      window.scrollTo({ top: savedScrollY, left: 0, behavior: 'instant' });
    }
    if (savedScrollBehavior !== null) {
      document.documentElement.style.scrollBehavior = savedScrollBehavior;
      savedScrollBehavior = null;
    } else {
      document.documentElement.style.removeProperty('scroll-behavior');
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
