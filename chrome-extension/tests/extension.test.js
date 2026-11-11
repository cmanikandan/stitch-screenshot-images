import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  computeScrollOffsets,
  computeViewportStitchPlan,
  computeMultiPageLayout,
  scoreNextPageCandidates,
  sanitizeCssSelectors,
  filterCacheableSelectors
} from '../shared/stitch-math.js';

import {
  GEMINI_INTERACTIONS_URL,
  GEMINI_API_REVISION,
  GEMINI_MODEL,
  extractInteractionJson,
  callGeminiStructured,
  detectClutterSelectors,
  detectNextPageUrl,
  getCachedSelectorsForDomain,
  setCachedSelectorsForDomain,
  clearDomainSelectorCache
} from '../shared/gemini-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');

function createMemoryStorage() {
  const store = {};
  return {
    async get(keys) {
      if (typeof keys === 'string') {
        return { [keys]: store[keys] };
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) out[k] = store[k];
        return out;
      }
      if (keys && typeof keys === 'object') {
        const out = {};
        for (const [k, defVal] of Object.entries(keys)) {
          out[k] = k in store ? store[k] : defVal;
        }
        return out;
      }
      return { ...store };
    },
    async set(items) {
      Object.assign(store, items);
    },
    async remove(key) {
      if (Array.isArray(key)) {
        for (const k of key) delete store[k];
      } else {
        delete store[key];
      }
    }
  };
}

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(buf.subarray(0, 8).equals(sig), true, `${filePath} must have valid PNG signature`);
  assert.equal(buf.subarray(12, 16).toString('ascii'), 'IHDR', `${filePath} must start with IHDR`);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

describe('stitch-math', () => {
  it('computes scroll offsets for single and multi-viewport pages', () => {
    const single = computeScrollOffsets({ scrollHeight: 700, viewportHeight: 900 });
    assert.deepEqual(single.offsets, [0]);

    const exact = computeScrollOffsets({ scrollHeight: 2000, viewportHeight: 1000 });
    assert.deepEqual(exact.offsets, [0, 1000]);

    const remainder = computeScrollOffsets({ scrollHeight: 2450, viewportHeight: 1000 });
    assert.deepEqual(remainder.offsets, [0, 1000, 1450]);
  });

  it('clamps giant scrollHeight to maxCssHeight', () => {
    const huge = computeScrollOffsets({
      scrollHeight: 120000,
      viewportHeight: 1000,
      maxCssHeight: 3500
    });
    assert.equal(huge.effectiveHeight, 3500);
    assert.deepEqual(huge.offsets, [0, 1000, 2000, 2500]);
  });

  it('computes viewport stitch plan with 2x DPR and bottom-slice overlap crop', () => {
    const plan = computeViewportStitchPlan({
      slices: [
        { actualScrollY: 0, imageWidth: 2400, imageHeight: 1600 },
        { actualScrollY: 800, imageWidth: 2400, imageHeight: 1600 },
        { actualScrollY: 1200, imageWidth: 2400, imageHeight: 1600 }
      ],
      scrollHeight: 2000,
      viewportHeight: 800,
      dpr: 2
    });

    assert.equal(plan.width, 2400);
    assert.equal(plan.height, 4000);
    assert.equal(plan.scale, 1);
    assert.equal(plan.placements.length, 3);

    // Slice 0: full 1600px at dy=0
    assert.equal(plan.placements[0].sy, 0);
    assert.equal(plan.placements[0].dy, 0);
    assert.equal(plan.placements[0].sh, 1600);

    // Slice 1: full 1600px at dy=1600
    assert.equal(plan.placements[1].sy, 0);
    assert.equal(plan.placements[1].dy, 1600);
    assert.equal(plan.placements[1].sh, 1600);

    // Slice 2: scrolled to 1200 CSS px (covered 1600 CSS px -> 400 CSS px = 800px overlap)
    assert.equal(plan.placements[2].sy, 800);
    assert.equal(plan.placements[2].sh, 800);
    assert.equal(plan.placements[2].dy, 3200);
  });

  it('produces zero 1px seam gaps when downscaling tall viewports and on fractional DPRs', () => {
    // Downscaled tall capture with prime dimensions that previously risked rounding gaps
    const slices = [];
    const viewportHeight = 773;
    const dpr = 1.75;
    const imgW = Math.round(1366 * dpr);
    const imgH = Math.round(viewportHeight * dpr);
    const scrollHeight = 14800;

    let scrollY = 0;
    while (scrollY < scrollHeight - viewportHeight) {
      slices.push({ actualScrollY: scrollY, imageWidth: imgW, imageHeight: imgH });
      scrollY += viewportHeight - 0.4; // simulate fractional subpixel scrollY on 1.75x DPI
    }
    slices.push({
      actualScrollY: scrollHeight - viewportHeight,
      imageWidth: imgW,
      imageHeight: imgH
    });

    const plan = computeViewportStitchPlan({
      slices,
      scrollHeight,
      viewportHeight,
      dpr,
      maxCanvasWidth: 16384,
      maxCanvasHeight: 12000,
      maxCanvasArea: 16384 * 12000
    });

    assert.ok(plan.scale < 1, 'Plan should downscale to fit maxCanvasHeight=12000');
    assert.ok(plan.height <= 12000);
    assert.equal(plan.placements[0].dy, 0);

    for (let i = 0; i < plan.placements.length - 1; i++) {
      const cur = plan.placements[i];
      const next = plan.placements[i + 1];
      assert.equal(
        cur.dy + cur.dh,
        next.dy,
        `Zero seam gap required between slice ${i} and ${i + 1}`
      );
      assert.equal(cur.dx + cur.dw, plan.width);
    }

    const last = plan.placements[plan.placements.length - 1];
    assert.equal(last.dy + last.dh, plan.height, 'Canvas height must match final slice bottom');

    // Fractional 1.25x DPR without downscaling
    const fracPlan = computeViewportStitchPlan({
      slices: [
        { actualScrollY: 0, imageWidth: 1600, imageHeight: 901 },
        { actualScrollY: 720.8, imageWidth: 1600, imageHeight: 901 },
        { actualScrollY: 1150.4, imageWidth: 1600, imageHeight: 901 }
      ],
      scrollHeight: 1871.2,
      viewportHeight: 720.8,
      dpr: 1.25
    });
    for (let i = 0; i < fracPlan.placements.length - 1; i++) {
      assert.equal(
        fracPlan.placements[i].dy + fracPlan.placements[i].dh,
        fracPlan.placements[i + 1].dy
      );
    }
    const fracLast = fracPlan.placements[fracPlan.placements.length - 1];
    assert.equal(fracLast.dy + fracLast.dh, fracPlan.height);
  });

  it('downscales multi-page vertical layout safely with zero seam gaps', () => {
    const layout = computeMultiPageLayout(
      [
        { width: 1000, height: 10000 },
        { width: 800, height: 10000 }
      ],
      { maxCanvasHeight: 16000, maxCanvasWidth: 16000, maxCanvasArea: 256000000 }
    );

    assert.equal(layout.scale, 0.8);
    assert.equal(layout.width, 800);
    assert.equal(layout.height, 16000);
    assert.equal(layout.placements[0].y, 0);
    assert.equal(layout.placements[1].y, 8000);
    // Narrower 2nd page is centered horizontally
    assert.equal(layout.placements[1].x, 80);

    // Non-divisible 3-page downscale check
    const oddLayout = computeMultiPageLayout(
      [
        { width: 1200, height: 6000 },
        { width: 1200, height: 6000 },
        { width: 1200, height: 6000 }
      ],
      { gapPx: 0, maxCanvasHeight: 16384, maxCanvasWidth: 16384, maxCanvasArea: 268435456 }
    );
    assert.equal(oddLayout.placements[0].y + oddLayout.placements[0].height, oddLayout.placements[1].y);
    assert.equal(oddLayout.placements[1].y + oddLayout.placements[1].height, oddLayout.placements[2].y);
    assert.equal(oddLayout.placements[2].y + oddLayout.placements[2].height, oddLayout.height);
  });

  it('scores next-page pagination links accurately and rejects /more and What\'s Next false positives', () => {
    const currentUrl = 'https://example.com/articles/deep-dive?page=2';
    const best = scoreNextPageCandidates(
      [
        { href: 'https://example.com/articles/deep-dive?page=1', text: 'Previous', rel: 'prev' },
        { href: 'https://twitter.com/share?url=x', text: 'Next' },
        { href: 'https://example.com/articles/deep-dive?page=3', text: 'Next Page', rel: 'next' },
        { href: 'https://example.com/login', text: 'Sign in' }
      ],
      currentUrl
    );

    assert.ok(best);
    assert.equal(best.url, 'https://example.com/articles/deep-dive?page=3');

    const none = scoreNextPageCandidates(
      [
        { href: 'https://example.com/articles/deep-dive?page=1', text: 'Previous', rel: 'prev' },
        { href: 'https://example.com/articles/deep-dive?page=2#comments', text: 'Comments' }
      ],
      currentUrl
    );
    assert.equal(none, null);

    // Reject header "/more" links and unrelated "What's Next in..." blog cards on single-page articles
    const singleArticleFalsePositives = scoreNextPageCandidates(
      [
        { href: 'https://example.com/more', text: 'More' },
        { href: 'https://example.com/blog/whats-next-in-ai-2027', text: "What's Next in AI for 2027" },
        { href: 'https://example.com/blog/up-next-cloud-trends', text: 'Up Next: Cloud Trends' },
        { href: 'https://example.com/about', text: 'About', className: 'next-gen-link' }
      ],
      'https://example.com/blog/clean-screenshots-guide'
    );
    assert.equal(singleArticleFalsePositives, null);

    // Accept genuine page-2 and part-2 pagination links
    const genuinePage2 = scoreNextPageCandidates(
      [
        { href: 'https://example.com/more', text: 'More' },
        {
          href: 'https://example.com/blog/clean-screenshots-guide/page/2',
          text: '2',
          inPagination: true
        }
      ],
      'https://example.com/blog/clean-screenshots-guide'
    );
    assert.ok(genuinePage2);
    assert.equal(genuinePage2.url, 'https://example.com/blog/clean-screenshots-guide/page/2');
  });

  it('sanitizes CSS selectors to block semantic/media/heading/table/form tags while allowing ad selectors', () => {
    const cleaned = sanitizeCssSelectors([
      'html',
      'body',
      '*',
      'main',
      'header',
      'footer',
      'nav',
      'aside',
      'section',
      'img',
      'picture',
      'figure',
      'video',
      'canvas',
      'svg',
      'h1',
      'h2',
      'ul',
      'li',
      'table',
      'thead',
      'tr',
      'td',
      'form',
      'button',
      'input',
      '[role="main"]',
      '#cookie-banner',
      '.promo-bar',
      '.bad { display: block }',
      '@import url("https://evil.test/x.css")',
      '#cookie-banner',
      'div[data-ad="top"]',
      '[id^="div-gpt-ad"]',
      'ins.adsbygoogle',
      '[data-ad-slot]',
      'amp-ad'
    ]);
    assert.deepEqual(cleaned, [
      '#cookie-banner',
      '.promo-bar',
      'div[data-ad="top"]',
      '[id^="div-gpt-ad"]',
      'ins.adsbygoogle',
      '[data-ad-slot]',
      'amp-ad'
    ]);

    // Strips dynamic numeric ad-instance IDs for domain caching
    const cacheable = filterCacheableSelectors([
      '#cookie-banner',
      '#div-gpt-ad-1712345678-0',
      '#google_ads_iframe_99_0',
      '[id^="div-gpt-ad"]',
      '.ad-slot-banner'
    ]);
    assert.deepEqual(cacheable, ['#cookie-banner', '[id^="div-gpt-ad"]', '.ad-slot-banner']);
  });
});

describe('gemini-client', () => {
  it('parses Interactions API array steps, string step.content, and outputs formats', () => {
    const fromSteps = extractInteractionJson({
      steps: [
        { type: 'thought', summary: [{ type: 'text', text: 'thinking' }] },
        {
          type: 'model_output',
          content: [{ type: 'text', text: '```json\n{"selectors":["#banner"]}\n```' }]
        }
      ]
    });
    assert.deepEqual(fromSteps, { selectors: ['#banner'] });

    const fromStringStepContent = extractInteractionJson({
      steps: [
        {
          type: 'model_output',
          content: '{"selectors":["ins.adsbygoogle","[data-ad-slot]"]}'
        }
      ]
    });
    assert.deepEqual(fromStringStepContent, {
      selectors: ['ins.adsbygoogle', '[data-ad-slot]']
    });

    const fromOutputs = extractInteractionJson({
      outputs: [{ type: 'text', text: '{"nextPageUrl":"https://example.com/p2","confidence":"high"}' }]
    });
    assert.equal(fromOutputs.nextPageUrl, 'https://example.com/p2');
  });

  it('calls Interactions API with required headers, model, and schema for clutter detection', async () => {
    let capturedRequest = null;
    const mockFetch = async (url, init) => {
      capturedRequest = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true,
        async json() {
          return {
            steps: [
              {
                type: 'model_output',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      selectors: ['#cookie-consent', 'body', 'header', '.newsletter-modal']
                    })
                  }
                ]
              }
            ]
          };
        }
      };
    };

    const selectors = await detectClutterSelectors(
      'test-api-key',
      {
        hostname: 'example.com',
        viewportWidth: 1280,
        viewportHeight: 800,
        overlays: [{ selector: '#cookie-consent', tag: 'div', position: 'fixed' }]
      },
      { fetchImpl: mockFetch }
    );

    assert.equal(capturedRequest.url, GEMINI_INTERACTIONS_URL);
    assert.equal(capturedRequest.init.headers['x-goog-api-key'], 'test-api-key');
    assert.equal(capturedRequest.init.headers['Api-Revision'], GEMINI_API_REVISION);
    assert.ok(capturedRequest.init.signal, 'Fetch request should include AbortSignal');
    assert.equal(capturedRequest.body.model, GEMINI_MODEL);
    assert.equal(capturedRequest.body.response_format.mime_type, 'application/json');
    assert.deepEqual(selectors, ['#cookie-consent', '.newsletter-modal']);
  });

  it('detects next page URL, resolves relative paths, and rejects hallucinated URLs not in candidates', async () => {
    const mockValidFetch = async () => ({
      ok: true,
      async json() {
        return {
          steps: [
            {
              type: 'model_output',
              content: JSON.stringify({
                nextPageUrl: '/post/part-2',
                confidence: 'high'
              })
            }
          ]
        };
      }
    });

    const result = await detectNextPageUrl(
      'test-api-key',
      {
        currentUrl: 'https://news.example.org/post/part-1',
        pageNumber: 1,
        nextCandidates: [{ href: 'https://news.example.org/post/part-2', text: 'Next' }]
      },
      { fetchImpl: mockValidFetch }
    );

    assert.equal(result.nextPageUrl, 'https://news.example.org/post/part-2');
    assert.equal(result.confidence, 'high');

    // Hallucinated URL not present in nextCandidates must be rejected
    const mockHallucinatedFetch = async () => ({
      ok: true,
      async json() {
        return {
          steps: [
            {
              type: 'model_output',
              content: JSON.stringify({
                nextPageUrl: 'https://news.example.org/post/invented-page-99',
                confidence: 'high'
              })
            }
          ]
        };
      }
    });

    const rejected = await detectNextPageUrl(
      'test-api-key',
      {
        currentUrl: 'https://news.example.org/post/part-1',
        pageNumber: 1,
        nextCandidates: [{ href: 'https://news.example.org/about', text: 'About' }]
      },
      { fetchImpl: mockHallucinatedFetch }
    );
    assert.equal(rejected.nextPageUrl, null);
    assert.equal(rejected.confidence, 'low');
  });

  it('aborts hung Gemini requests cleanly when exceeding timeoutMs', async () => {
    const hangingFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });

    await assert.rejects(
      async () => {
        await callGeminiStructured({
          apiKey: 'test-api-key',
          input: 'test',
          schema: { type: 'object' },
          fetchImpl: hangingFetch,
          timeoutMs: 25
        });
      },
      /timed out after 25ms/i
    );
  });

  it('caches and clears per-domain selectors with TTL and strips dynamic instance IDs', async () => {
    const storage = createMemoryStorage();
    await setCachedSelectorsForDomain(
      storage,
      'example.com',
      ['#banner', 'body', '#div-gpt-ad-170000123-0'],
      1000
    );

    const hit = await getCachedSelectorsForDomain(storage, 'example.com', 5000);
    assert.deepEqual(hit, ['#banner']);

    const expired = await getCachedSelectorsForDomain(storage, 'example.com', 1000 + 8 * 86400 * 1000);
    assert.equal(expired, null);

    await clearDomainSelectorCache(storage);
    assert.equal(await getCachedSelectorsForDomain(storage, 'example.com', 2000), null);
  });
});

describe('Manifest V3, icons, HTML CSP, accessibility, and JS compliance', () => {
  it('validates manifest.json is pure MV3 with matching icon dimensions', () => {
    const manifestPath = path.join(EXT_ROOT, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background?.service_worker, 'background/service-worker.js');
    assert.equal(manifest.action?.default_popup, 'popup/popup.html');
    assert.equal('browser_action' in manifest, false);
    assert.equal('page_action' in manifest, false);
    assert.equal('scripts' in (manifest.background || {}), false);

    for (const perm of ['activeTab', 'tabs', 'scripting', 'storage', 'offscreen', 'downloads']) {
      assert.equal(manifest.permissions.includes(perm), true, `Missing permission ${perm}`);
    }

    for (const [sizeStr, relPath] of Object.entries(manifest.icons)) {
      const expected = Number.parseInt(sizeStr, 10);
      const fullPath = path.join(EXT_ROOT, relPath);
      assert.equal(fs.existsSync(fullPath), true, `Icon file missing: ${relPath}`);
      const dims = readPngDimensions(fullPath);
      assert.equal(dims.width, expected, `${relPath} width mismatch`);
      assert.equal(dims.height, expected, `${relPath} height mismatch`);
    }
  });

  it('validates HTML files contain zero inline scripts, inline handlers, or inline styles and preserve accessibility hooks', () => {
    const htmlFiles = [
      path.join(EXT_ROOT, 'popup/popup.html'),
      path.join(EXT_ROOT, 'offscreen/offscreen.html')
    ];

    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      assert.ok(scriptMatches.length > 0, `${file} should load external script`);
      for (const match of scriptMatches) {
        assert.match(match[1], /\bsrc\s*=/i, `${file} has inline <script> without src`);
        assert.equal(match[2].trim(), '', `${file} has non-empty inline script body`);
        const srcMatch = match[1].match(/\bsrc\s*=\s*"([^"]+)"/i);
        assert.ok(srcMatch);
        const scriptPath = path.resolve(path.dirname(file), srcMatch[1]);
        assert.equal(fs.existsSync(scriptPath), true, `Referenced script missing: ${scriptPath}`);
      }

      assert.equal(/\bon[a-z]+\s*=/i.test(html), false, `${file} must not contain inline on* handlers`);
      assert.equal(/\sstyle\s*=/i.test(html), false, `${file} must not contain inline style= attributes`);
    }

    const popupHtml = fs.readFileSync(path.join(EXT_ROOT, 'popup/popup.html'), 'utf8');
    assert.match(popupHtml, /<progress[^>]*aria-label="Capture progress"/);
    assert.match(popupHtml, /id="btn-cancel-capture"/);

    const popupCss = fs.readFileSync(path.join(EXT_ROOT, 'popup/popup.css'), 'utf8');
    assert.match(popupCss, /input\[aria-invalid="true"\]/);
  });

  it('validates JS files pass syntax checks and follow MV3 async/offscreen rules', () => {
    const jsFiles = [
      'background/service-worker.js',
      'content/page-inspector.js',
      'offscreen/offscreen.js',
      'popup/popup.js',
      'shared/gemini-client.js',
      'shared/stitch-math.js'
    ];

    for (const rel of jsFiles) {
      const full = path.join(EXT_ROOT, rel);
      execFileSync(process.execPath, ['--check', full]);

      const src = fs.readFileSync(full, 'utf8');
      assert.equal(/\.then\s*\(/.test(src), false, `${rel} must use async/await instead of .then()`);
      assert.equal(/\beval\s*\(/.test(src), false, `${rel} must not call eval()`);
      assert.equal(/new\s+Function\s*\(/.test(src), false, `${rel} must not call new Function()`);
      assert.equal(
        /scroll-behavior\s*:\s*instant/i.test(src),
        false,
        `${rel} must not use invalid CSS scroll-behavior: instant`
      );

      if (src.includes('onMessage.addListener')) {
        assert.equal(/return\s+true\s*;/.test(src), true, `${rel} onMessage listener must return true`);
      }
    }

    const offscreenSrc = fs.readFileSync(path.join(EXT_ROOT, 'offscreen/offscreen.js'), 'utf8');
    assert.equal(/chrome\.(downloads|tabs|storage|action)/.test(offscreenSrc), false);
    assert.match(offscreenSrc, /CREATE_BLOB_URL/);
    assert.match(offscreenSrc, /REVOKE_BLOB_URL/);
    assert.match(offscreenSrc, /BEGIN_STITCH/);
    assert.match(offscreenSrc, /COMMIT_STITCH/);

    // Ensure every selector in HEURISTIC_CLUTTER_SELECTORS survives sanitizeCssSelectors
    const swSrc = fs.readFileSync(path.join(EXT_ROOT, 'background/service-worker.js'), 'utf8');
    const blockMatch = swSrc.match(/const\s+HEURISTIC_CLUTTER_SELECTORS\s*=\s*\[([\s\S]*?)\];/);
    assert.ok(blockMatch, 'HEURISTIC_CLUTTER_SELECTORS array must exist in service-worker.js');
    const extractedSelectors = [...blockMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(
      extractedSelectors.length >= 50,
      `Expected >= 50 heuristic clutter selectors, found ${extractedSelectors.length}`
    );
    const sanitizedHeuristics = sanitizeCssSelectors(extractedSelectors);
    assert.deepEqual(sanitizedHeuristics, extractedSelectors);
  });

  it('creates and revokes offscreen Blob URLs cleanly via message listener', async () => {
    let registeredListener = null;
    globalThis.chrome = {
      runtime: {
        onMessage: {
          addListener(fn) {
            registeredListener = fn;
          }
        }
      }
    };

    await import('../offscreen/offscreen.js');
    assert.equal(typeof registeredListener, 'function');

    const onePixelPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const createRes = await new Promise((resolve) => {
      const keepOpen = registeredListener(
        { target: 'offscreen', type: 'CREATE_BLOB_URL', payload: { dataUrl: onePixelPng } },
        {},
        resolve
      );
      assert.equal(keepOpen, true);
    });

    assert.equal(createRes.ok, true);
    assert.match(createRes.data.blobUrl, /^blob:/);

    const revokeRes = await new Promise((resolve) => {
      registeredListener(
        {
          target: 'offscreen',
          type: 'REVOKE_BLOB_URL',
          payload: { blobUrl: createRes.data.blobUrl }
        },
        {},
        resolve
      );
    });
    assert.equal(revokeRes.ok, true);
    assert.equal(revokeRes.data.revoked, true);

    delete globalThis.chrome;
  });

  it('collapses inline ads, CLS reserve wrappers, and Slice-0 bottom bars while protecting embeds/prose and restoring styles byte-for-byte', async () => {
    class MockStyle {
      constructor(owner) {
        this._owner = owner;
        this._map = new Map();
      }
      setProperty(k, v, priority = '') {
        this._map.set(k, priority ? `${v} !${priority}` : v);
        this._syncAttr();
      }
      getPropertyValue(k) {
        return (this._map.get(k) || '').replace(/\s*!important$/i, '');
      }
      _syncAttr() {
        const serialized = [...this._map.entries()].map(([k, v]) => `${k}: ${v};`).join(' ');
        this._owner._attrs.set('style', serialized);
      }
      get display() {
        return this.getPropertyValue('display') || this._owner._computed.display || 'block';
      }
      get visibility() {
        return this.getPropertyValue('visibility') || this._owner._computed.visibility || 'visible';
      }
      get opacity() {
        return this.getPropertyValue('opacity') || this._owner._computed.opacity || '1';
      }
      get position() {
        return this._owner._computed.position || 'static';
      }
      get zIndex() {
        return this._owner._computed.zIndex || 'auto';
      }
      get top() {
        return this._owner._computed.top || 'auto';
      }
    }

    class MockElement {
      constructor(tag, opts = {}) {
        this.nodeType = 1;
        this.isConnected = true;
        this.tagName = tag.toUpperCase();
        this.id = opts.id || '';
        this.className = opts.className || '';
        this._attrs = new Map(Object.entries(opts.attrs || {}));
        if (opts.origStyle !== undefined) {
          this._attrs.set('style', opts.origStyle);
        }
        this._computed = opts.computed || {};
        this._rect = opts.rect || { top: 0, left: 0, bottom: 100, right: 800, width: 800, height: 100 };
        this._text = opts.text || '';
        this.children = [];
        this.parentElement = null;
        this.style = new MockStyle(this);
      }
      get classList() {
        const list = this.className.split(/\s+/).filter(Boolean);
        return {
          [Symbol.iterator]: () => list[Symbol.iterator](),
          contains: (c) => list.includes(c)
        };
      }
      appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
      }
      remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      }
      hasAttribute(k) {
        return this._attrs.has(k);
      }
      getAttribute(k) {
        return this._attrs.has(k) ? this._attrs.get(k) : null;
      }
      setAttribute(k, v) {
        this._attrs.set(k, String(v));
        if (k === 'style') {
          this.style._map.clear();
          for (const decl of String(v).split(';')) {
            const idx = decl.indexOf(':');
            if (idx > 0) {
              const prop = decl.slice(0, idx).trim();
              const val = decl.slice(idx + 1).trim();
              if (prop) this.style._map.set(prop, val);
            }
          }
        }
      }
      removeAttribute(k) {
        this._attrs.delete(k);
        if (k === 'style') this.style._map.clear();
      }
      getAttributeNames() {
        return [...this._attrs.keys()];
      }
      getBoundingClientRect() {
        return this._rect;
      }
      get textContent() {
        if (this.children.length === 0) return this._text;
        return [this._text, ...this.children.map((c) => c.textContent)].join(' ').trim();
      }
      set textContent(v) {
        this._text = String(v);
      }
      get innerText() {
        if (this.style.display === 'none') return '';
        if (this.children.length === 0) return this._text;
        return [
          this._text,
          ...this.children.filter((c) => c.style.display !== 'none').map((c) => c.innerText)
        ]
          .join(' ')
          .trim();
      }
      getElementsByTagName(tag) {
        const t = tag.toUpperCase();
        const out = [];
        const walk = (node) => {
          for (const ch of node.children) {
            if (ch.tagName === t) out.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return out;
      }
      _matchesSingle(sel) {
        const s = sel.trim();
        if (s === 'body *') return true;
        if (s === `style[data-stitch-cleanup="true"]`) {
          return this.tagName === 'STYLE' && this.getAttribute('data-stitch-cleanup') === 'true';
        }
        if (s === 'img') return this.tagName === 'IMG';
        if (s === 'a[href]') return this.tagName === 'A' && this.hasAttribute('href');
        if (s === 'ins.adsbygoogle') {
          return this.tagName === 'INS' && this.classList.contains('adsbygoogle');
        }
        if (s.startsWith('.')) {
          return this.classList.contains(s.slice(1));
        }
        if (s.startsWith('#')) {
          return this.id === s.slice(1);
        }
        if (['main', 'article', '[role="main"]', '[role="article"]', 'h1', 'iframe[src]', 'embed[src]', 'blockquote.twitter-tweet', 'blockquote.instagram-media', 'video', 'canvas', 'svg', 'iframe'].includes(s)) {
          if (s === 'iframe[src]') return this.tagName === 'IFRAME' && this.hasAttribute('src');
          if (s.startsWith('[')) return false;
          if (s.includes('.')) {
            const [tg, cl] = s.split('.');
            return this.tagName === tg.toUpperCase() && this.classList.contains(cl);
          }
          return this.tagName === s.toUpperCase();
        }
        return false;
      }
      querySelectorAll(selectorList) {
        const parts = selectorList.split(',').map((p) => p.trim()).filter(Boolean);
        const out = [];
        const walk = (node) => {
          for (const ch of node.children) {
            if (parts.some((p) => ch._matchesSingle(p))) out.push(ch);
            walk(ch);
          }
        };
        walk(this);
        return out;
      }
      querySelector(selectorList) {
        return this.querySelectorAll(selectorList)[0] || null;
      }
    }

    const head = new MockElement('head');
    const body = new MockElement('body');
    body.scrollHeight = 2400;
    body.scrollWidth = 1200;

    // 1. Protected article with prose + legitimate YouTube embed + accidentally shared `.shared-box` class
    const article = body.appendChild(
      new MockElement('article', {
        className: 'story shared-box',
        origStyle: 'max-width: 720px;',
        rect: { top: 40, left: 0, bottom: 1800, right: 800, width: 800, height: 1760 }
      })
    );
    article.appendChild(new MockElement('h1', { text: 'Deep Dive Into Seamless Stitching' }));
    for (let i = 0; i < 4; i++) {
      article.appendChild(
        new MockElement('p', {
          text: 'Primary article paragraph content that must always remain visible in output.'
        })
      );
    }
    const ytWrapper = article.appendChild(
      new MockElement('div', {
        className: 'embed-wrapper',
        rect: { top: 300, left: 0, bottom: 660, right: 640, width: 640, height: 360 }
      })
    );
    ytWrapper.appendChild(
      new MockElement('iframe', {
        attrs: { src: 'https://www.youtube.com/embed/dQw4w9WgXcQ' },
        rect: { top: 300, left: 0, bottom: 660, right: 640, width: 640, height: 360 }
      })
    );

    // 2. Outer CLS min-height reserve wrapper + "Advertisement" label + inner AdSense slot (in-between article)
    const clsReserveOuter = article.appendChild(
      new MockElement('div', {
        className: 'cls-slot-shell',
        origStyle: 'min-height: 280px;',
        rect: { top: 700, left: 0, bottom: 980, right: 728, width: 728, height: 280 }
      })
    );
    clsReserveOuter.appendChild(
      new MockElement('span', {
        text: 'Advertisement',
        rect: { top: 700, left: 0, bottom: 720, right: 120, width: 120, height: 20 }
      })
    );
    const adUnit = clsReserveOuter.appendChild(
      new MockElement('ins', {
        className: 'adsbygoogle shared-box',
        rect: { top: 720, left: 0, bottom: 970, right: 728, width: 728, height: 250 }
      })
    );

    // 3. Standalone empty "Sponsored" placeholder box without ad class tokens
    const sponsoredPlaceholder = article.appendChild(
      new MockElement('div', {
        className: 'slot-frame',
        text: 'Sponsored',
        rect: { top: 1050, left: 0, bottom: 1300, right: 728, width: 728, height: 250 }
      })
    );

    // 4. Bottom-anchored fixed promo bar on Slice 0
    const bottomStickyBar = body.appendChild(
      new MockElement('div', {
        id: 'bottom-sticky-promo',
        computed: { position: 'fixed' },
        rect: { top: 720, left: 0, bottom: 800, right: 1200, width: 1200, height: 80 }
      })
    );

    const docRoot = new MockElement('html');
    docRoot.scrollHeight = 2400;
    docRoot.scrollWidth = 1200;
    docRoot.appendChild(head);
    docRoot.appendChild(body);

    let inspectorListener = null;
    const windowObj = {
      innerWidth: 1200,
      innerHeight: 800,
      devicePixelRatio: 2,
      scrollY: 145.5,
      location: { href: 'https://example.com/story', hostname: 'example.com' },
      scrollTo({ top }) {
        this.scrollY = top;
      },
      getComputedStyle(el) {
        return el.style;
      }
    };

    const sandbox = {
      window: windowObj,
      document: {
        head,
        body,
        documentElement: docRoot,
        createElement: (tag) => new MockElement(tag),
        querySelectorAll: (sel) => docRoot.querySelectorAll(sel),
        querySelector: (sel) => docRoot.querySelector(sel)
      },
      HTMLElement: MockElement,
      CSS: { escape: (s) => s },
      performance: { now: () => Date.now() },
      requestAnimationFrame: (cb) => setTimeout(cb, 0),
      setTimeout,
      clearTimeout,
      chrome: {
        runtime: {
          onMessage: {
            addListener(fn) {
              inspectorListener = fn;
            }
          }
        }
      }
    };
    sandbox.globalThis = sandbox;

    const inspectorCode = fs.readFileSync(path.join(EXT_ROOT, 'content/page-inspector.js'), 'utf8');
    vm.runInNewContext(inspectorCode, sandbox);
    assert.equal(typeof inspectorListener, 'function');

    const sendMsg = (type, payload = {}) =>
      new Promise((resolve) => {
        inspectorListener({ type, payload }, {}, resolve);
      });

    // Pass `.shared-box` which overlaps both protected `article` AND `adUnit`!
    const prepRes = await sendMsg('PREPARE_CAPTURE', {
      cleanupSelectors: ['.shared-box', 'ins.adsbygoogle'],
      hideScrollbars: true,
      autoCleanClutter: true
    });
    assert.equal(prepRes.ok, true);

    // Protected article and YouTube embed remain untouched
    assert.equal(article.getAttribute('style'), 'max-width: 720px;');
    assert.equal(ytWrapper.hasAttribute('style'), false);

    // Overly broad `.shared-box` must NOT be emitted into <style data-stitch-cleanup="true">
    const injectedStyle = head.querySelector('style[data-stitch-cleanup="true"]');
    assert.ok(injectedStyle);
    assert.equal(injectedStyle.textContent.includes('.shared-box'), false);
    assert.equal(injectedStyle.textContent.includes('ins.adsbygoogle'), true);

    // Inline ad, outer CLS min-height wrapper, and standalone "Sponsored" box are all collapsed!
    assert.equal(adUnit.style.display, 'none');
    assert.equal(clsReserveOuter.style.display, 'none');
    assert.equal(sponsoredPlaceholder.style.display, 'none');

    // Slice-0 bottom fixed bar is hidden before Slice 0 on scrollable page
    assert.equal(bottomStickyBar.style.visibility, 'hidden');

    // RESTORE_PAGE restores every original style attribute and scroll offset byte-for-byte
    const restoreRes = await sendMsg('RESTORE_PAGE', { restoreScroll: true });
    assert.equal(restoreRes.ok, true);
    assert.equal(head.querySelector('style[data-stitch-cleanup="true"]'), null);
    assert.equal(article.getAttribute('style'), 'max-width: 720px;');
    assert.equal(clsReserveOuter.getAttribute('style'), 'min-height: 280px;');
    assert.equal(adUnit.hasAttribute('style'), false);
    assert.equal(sponsoredPlaceholder.hasAttribute('style'), false);
    assert.equal(bottomStickyBar.hasAttribute('style'), false);
    assert.equal(windowObj.scrollY, 145.5);
  });
});
