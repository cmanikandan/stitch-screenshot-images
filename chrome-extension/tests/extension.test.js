import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeScrollOffsets,
  computeViewportStitchPlan,
  computeMultiPageLayout,
  scoreNextPageCandidates,
  sanitizeCssSelectors
} from '../shared/stitch-math.js';

import {
  GEMINI_INTERACTIONS_URL,
  GEMINI_API_REVISION,
  GEMINI_MODEL,
  extractInteractionJson,
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

  it('downscales multi-page vertical layout safely when exceeding maxCanvasHeight', () => {
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
  });

  it('scores next-page pagination links accurately and rejects previous/external links', () => {
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
  });

  it('sanitizes CSS selectors to block broad tags and injection syntax', () => {
    const cleaned = sanitizeCssSelectors([
      'html',
      'body',
      '*',
      'main',
      '#cookie-banner',
      '.promo-bar',
      '.bad { display: block }',
      '#cookie-banner',
      'div[data-ad="top"]'
    ]);
    assert.deepEqual(cleaned, ['#cookie-banner', '.promo-bar', 'div[data-ad="top"]']);
  });
});

describe('gemini-client', () => {
  it('parses Interactions API steps and outputs formats', () => {
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
                      selectors: ['#cookie-consent', 'body', '.newsletter-modal']
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
    assert.equal(capturedRequest.body.model, GEMINI_MODEL);
    assert.equal(capturedRequest.body.response_format.mime_type, 'application/json');
    assert.deepEqual(selectors, ['#cookie-consent', '.newsletter-modal']);
  });

  it('detects next page URL and resolves relative paths via Gemini Interactions API', async () => {
    const mockFetch = async () => ({
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
                    nextPageUrl: '/post/part-2',
                    confidence: 'high'
                  })
                }
              ]
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
      { fetchImpl: mockFetch }
    );

    assert.equal(result.nextPageUrl, 'https://news.example.org/post/part-2');
    assert.equal(result.confidence, 'high');
  });

  it('caches and clears per-domain selectors with TTL', async () => {
    const storage = createMemoryStorage();
    await setCachedSelectorsForDomain(storage, 'example.com', ['#banner', 'body'], 1000);

    const hit = await getCachedSelectorsForDomain(storage, 'example.com', 5000);
    assert.deepEqual(hit, ['#banner']);

    const expired = await getCachedSelectorsForDomain(storage, 'example.com', 1000 + 8 * 86400 * 1000);
    assert.equal(expired, null);

    await clearDomainSelectorCache(storage);
    assert.equal(await getCachedSelectorsForDomain(storage, 'example.com', 2000), null);
  });
});

describe('Manifest V3, icons, HTML CSP, and JS compliance', () => {
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

  it('validates HTML files contain zero inline scripts, inline handlers, or inline styles', () => {
    const htmlFiles = [
      path.join(EXT_ROOT, 'popup/popup.html'),
      path.join(EXT_ROOT, 'offscreen/offscreen.html')
    ];

    for (const file of htmlFiles) {
      const html = fs.readFileSync(file, 'utf8');
      // Check every <script> tag has src= and empty body
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

      if (src.includes('onMessage.addListener')) {
        assert.equal(/return\s+true\s*;/.test(src), true, `${rel} onMessage listener must return true`);
      }
    }

    const offscreenSrc = fs.readFileSync(path.join(EXT_ROOT, 'offscreen/offscreen.js'), 'utf8');
    assert.equal(/chrome\.(downloads|tabs|storage|action)/.test(offscreenSrc), false);
  });
});
