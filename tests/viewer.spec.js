import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';

async function ready(page) {
  await page.goto('/2606J01_511_2_Liv_19/');
  await expect(page.locator('#case-name')).toHaveText('2606J01_511_2_Liv_19');
  await expect(page.locator('#he-toggle')).toBeEnabled();
  await expect(page.locator('#ihc-toggle')).toBeEnabled();
  await expect(page.locator('#he-tile-status')).toHaveText('');
  await expect(page.locator('#ihc-tile-status')).toHaveText('');
}

// Read the actual rendered mask rectangle and WebGL projection; this catches
// pan drift as well as matching zoom labels without exposing app internals.
async function renderedViews(page) {
  return page.evaluate(() => {
    const view = document.querySelector('#he-viewer').getBoundingClientRect();
    const mask = document.querySelector('.mask-overlay').getBoundingClientRect();
    const canvas = document.querySelector('.point-overlay');
    const gl = canvas.getContext('webgl');
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    const center = gl.getUniform(program, gl.getUniformLocation(program, 'u_anchor'));
    const basis = gl.getUniform(program, gl.getUniformLocation(program, 'u_basis'));
    return {
      he: {
        x: (view.x + view.width / 2 - mask.x) * 22970 / mask.width,
        y: (view.y + view.height / 2 - mask.y) * 30170 / mask.height,
        scale: mask.width / 22970,
      },
      ihc: { x: center[0], y: center[1], scale: basis[0] },
    };
  });
}

async function expectSynced(page) {
  await expect.poll(async () => {
    const { he, ihc } = await renderedViews(page);
    return Math.hypot(he.x - ihc.x, he.y - ihc.y) * ihc.scale;
  }).toBeLessThan(2); // OSD rounds the mask's DOM rectangle to screen pixels.
  await expect.poll(async () => {
    const { he, ihc } = await renderedViews(page);
    return Math.abs(he.scale - ihc.scale) * 22970;
  }).toBeLessThan(2);
  await expect.poll(() => page.evaluate(() =>
    document.querySelector('#he-zoom').textContent === document.querySelector('#ihc-zoom').textContent,
  )).toBe(true);
  // Let the initiating pan/zoom spring finish before comparing later isolated
  // gestures. Disabling sync does not cancel the user's existing animation.
  let previous;
  await expect.poll(async () => {
    const current = JSON.stringify(await renderedViews(page));
    const settled = current === previous;
    previous = current;
    return settled;
  }).toBe(true);
}

async function annotationPixels(page) {
  return page.evaluate(() => {
    // Redraw through an existing control, then inspect the real canvas before
    // WebGL's non-preserved drawing buffer is cleared by the compositor.
    document.querySelector('#ihc-opacity').dispatchEvent(new Event('input', { bubbles: true }));
    const canvas = document.querySelector('.point-overlay');
    const gl = canvas.getContext('webgl');
    let pixels;
    if (gl) {
      pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    } else {
      pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    }
    const result = { red: 0, green: 0, blue: 0, covered: 0 };
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 20) continue;
      result.covered++;
      if (pixels[i] > pixels[i + 1] * 2 && pixels[i] > pixels[i + 2] * 2) result.red++;
      if (pixels[i + 1] > pixels[i] * 2 && pixels[i + 1] > pixels[i + 2] * 2) result.green++;
      if (pixels[i + 2] > pixels[i] * 2 && pixels[i + 2] > pixels[i + 1] * 2) result.blue++;
    }
    return result;
  });
}

for (const renderer of ['WebGL', 'Canvas']) {
  test(`annotation colors and size change the rendered ${renderer} points and reset to source styles`, async ({ page }) => {
    if (renderer === 'Canvas') {
      await page.addInitScript(() => {
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          if (/webgl/.test(type)) return null;
          return getContext.call(this, type, ...args);
        };
      });
    }
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await ready(page);
    await expect(page.locator('#annotation-status')).toHaveAttribute('title', new RegExp(renderer));
    const color = page.getByLabel('hCD45+ annotation color', { exact: true });
    const otherColor = page.locator('.annotation-color').nth(1);
    const size = page.getByRole('slider', { name: 'Annotation point size' });
    const reset = page.getByRole('button', { name: 'Reset style', exact: true });
    const initialZoom = await page.locator('#ihc-zoom').textContent();
    await expect(color).toHaveValue('#ff0000');
    await expect(otherColor).toHaveValue('#00ff00');
    await expect(size).toHaveValue('100');
    await expect(reset).toBeDisabled();
    const original = await annotationPixels(page);
    expect(original.red).toBeGreaterThan(0);
    expect(original.green).toBeGreaterThan(0);
    expect(original.blue).toBe(0);

    await color.fill('#0000ff');
    const recolored = await annotationPixels(page);
    expect(recolored.red).toBe(0);
    expect(recolored.blue).toBeGreaterThan(0);
    expect(recolored.green).toBeGreaterThan(0);
    await expect(otherColor).toHaveValue('#00ff00');
    await size.fill('50');
    await expect(page.locator('#annotation-size-value')).toHaveText('0.5×');
    const small = await annotationPixels(page);
    await size.fill('300');
    await expect(page.locator('#annotation-size-value')).toHaveText('3×');
    const large = await annotationPixels(page);
    expect(large.covered).toBeGreaterThan(small.covered * 2);
    await expect(page.locator('#ihc-zoom')).toHaveText(initialZoom);
    await expect(page.locator('#he-opacity')).toHaveValue('40');
    await expect(page.getByRole('checkbox', { name: 'Sync views', exact: true })).toBeChecked();
    const viewerBeforeToggle = await page.locator('#ihc-viewer').boundingBox();
    await page.locator('#ihc-toggle').uncheck();
    await expect(page.locator('#annotation-legend')).toBeVisible();
    expect(await page.locator('#ihc-viewer').boundingBox()).toEqual(viewerBeforeToggle);
    await page.locator('#ihc-toggle').check();
    await expect(color).toHaveValue('#0000ff');
    await expect(size).toHaveValue('300');
    if (renderer === 'WebGL') {
      await fs.mkdir('.cache/verification', { recursive: true });
      await page.screenshot({ path: '.cache/verification/annotation-styles.png' });
      for (const width of [1440, 1100, 780, 580]) {
        await page.setViewportSize({ width, height: width >= 1100 ? 1000 : 700 });
        const panel = await page.locator('#ihc-viewer').boundingBox();
        const left = await page.locator('#he-viewer').boundingBox();
        const controls = await page.locator('#annotation-legend').boundingBox();
        expect(controls.x).toBeGreaterThanOrEqual(panel.x);
        expect(controls.x + controls.width).toBeLessThanOrEqual(panel.x + panel.width);
        expect(controls.y + controls.height).toBeLessThanOrEqual(panel.y);
        expect(left.y).toEqual(panel.y);
        expect(left.height).toEqual(panel.height);
        expect(panel.height).toBeGreaterThan(250);
        await expect(size).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        expect(overflow).toBe(false);
        if (width === 780) await page.screenshot({ path: '.cache/verification/annotation-styles-compact.png' });
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await reset.click();
    await expect(color).toHaveValue('#ff0000');
    await expect(size).toHaveValue('100');
    await expect(reset).toBeDisabled();
    const restored = await annotationPixels(page);
    expect(restored.red).toBeGreaterThan(0);
    expect(restored.green).toBeGreaterThan(0);
    expect(restored.blue).toBe(0);
    expect(errors).toEqual([]);
  });
}

test('sync defaults on, follows either panel, and re-syncs to the last navigated view', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  const toggle = page.getByRole('checkbox', { name: 'Sync views', exact: true });
  await expect(toggle).toBeChecked();
  await expect(page.locator('#navigation-mode')).toHaveText('Synced views');
  await expectSynced(page);
  const homeZoom = await page.locator('#he-zoom').textContent();
  await page.getByRole('button', { name: 'Zoom in H&E', exact: true }).click();
  await expect(page.locator('#he-zoom')).not.toHaveText(homeZoom);
  await expectSynced(page);

  for (const key of ['ihc', 'he']) {
    const box = await page.locator(`#${key}-viewer`).boundingBox();
    await page.mouse.move(box.x + box.width * .4, box.y + box.height * .4);
    await page.mouse.wheel(0, -300);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .55, box.y + box.height * .48, { steps: 20 });
    await page.mouse.up();
    await expectSynced(page);
  }

  for (const key of ['he', 'ihc']) {
    await toggle.uncheck();
    await expect(page.locator('#navigation-mode')).toHaveText('Independent views');
    const other = key === 'he' ? 'ihc' : 'he';
    const before = (await renderedViews(page))[other];
    const zoom = await page.locator(`#${key}-zoom`).textContent();
    await page.getByRole('button', { name: `Zoom in ${key === 'he' ? 'H&E' : 'IHC'}`, exact: true }).click();
    await expect(page.locator(`#${key}-zoom`)).not.toHaveText(zoom);
    const box = await page.locator(`#${key}-viewer`).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6, { steps: 20 });
    await page.mouse.up();
    const unchanged = (await renderedViews(page))[other];
    expect(unchanged).toEqual(before);
    await toggle.check();
    await expectSynced(page);
  }

  await page.getByRole('button', { name: 'Fit IHC to screen' }).click();
  await expect(page.locator('#he-zoom')).toHaveText(homeZoom);
  await expectSynced(page);
  await page.getByRole('button', { name: 'Zoom in H&E', exact: true }).click();
  await expect(page.locator('#he-zoom')).not.toHaveText(homeZoom);
  await page.getByRole('button', { name: 'Reset views' }).click();
  await expect(page.locator('#he-zoom')).toHaveText(homeZoom);
  await expectSynced(page);
  await page.setViewportSize({ width: 780, height: 700 });
  await expectSynced(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectSynced(page);
  await expect(page.locator('#he-tile-status')).toHaveText('');
  await expect(page.locator('#ihc-tile-status')).toHaveText('');
  await fs.mkdir('.cache/verification', { recursive: true });
  await page.screenshot({ path: '.cache/verification/synced-views.png' });
  await toggle.uncheck();
  await page.reload();
  await expect(toggle).toBeChecked();
  expect(errors).toEqual([]);
});

test('real slides: independent navigation, overlay controls, resizing, and bounded rendering', async ({ page }) => {
  const errors = [], badResponses = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) badResponses.push(response.url()); });
  page.on('request', request => requests.push(request.url()));
  await page.addInitScript(() => {
    window.testMetrics = { draws: [], longTasks: [], frames: [] };
    const draw = WebGLRenderingContext.prototype.drawElements;
    WebGLRenderingContext.prototype.drawElements = function(mode, count, ...rest) {
      if (mode === this.POINTS) window.testMetrics.draws.push(count);
      return draw.call(this, mode, count, ...rest);
    };
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) window.testMetrics.longTasks.push({ start: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  await ready(page);
  await page.getByRole('checkbox', { name: 'Sync views', exact: true }).uncheck();
  await expect(page.locator('.slide-panel')).toHaveCount(2);
  const originalHe = await page.locator('#he-zoom').textContent();
  const originalIhc = await page.locator('#ihc-zoom').textContent();
  const originalMask = await page.locator('.mask-overlay').boundingBox();
  await fs.mkdir('.cache/verification', { recursive: true });
  await page.screenshot({ path: '.cache/verification/overview.png' });

  await page.locator('#he-toggle').uncheck();
  await expect(page.locator('.mask-overlay')).toHaveCSS('opacity', '0');
  await expect(page.locator('#he-opacity')).toBeDisabled();
  await page.locator('#he-toggle').check();
  await page.locator('#he-opacity').fill('70');
  await expect(page.locator('.mask-overlay')).toHaveCSS('opacity', '0.7');
  await page.locator('#he-opacity').fill('40');
  await page.locator('#ihc-toggle').uncheck();
  await expect(page.locator('.point-overlay')).toBeHidden();
  await page.locator('#ihc-toggle').check();
  await expect(page.locator('.point-overlay')).toBeVisible();
  await page.locator('#ihc-opacity').fill('0');
  await expect(page.locator('.point-overlay')).toBeHidden();
  await page.locator('#ihc-opacity').fill('75');
  await expect(page.locator('.point-overlay')).toBeVisible();

  await page.getByRole('button', { name: 'Zoom in H&E', exact: true }).click();
  await expect(page.locator('#he-zoom')).not.toHaveText(originalHe);
  await expect(page.locator('#ihc-zoom')).toHaveText(originalIhc);
  await expect.poll(async () => (await page.locator('.mask-overlay').boundingBox()).width).toBeGreaterThan(originalMask.width * 1.4);
  await page.getByRole('button', { name: 'Fit H&E to screen' }).click();
  await expect(page.locator('#he-zoom')).toHaveText(originalHe);

  const navigationStart = await page.evaluate(() => {
    window.testMetrics.frames = [];
    let previous = performance.now();
    window.testMetrics.capture = true;
    function tick(now) {
      if (!window.testMetrics.capture) return;
      window.testMetrics.frames.push(now - previous);
      previous = now;
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    return performance.now();
  });
  const right = await page.locator('#ihc-viewer').boundingBox();
  await page.mouse.move(right.x + right.width * .38, right.y + right.height * .3);
  await page.mouse.wheel(0, -1200);
  await expect(page.locator('#ihc-zoom')).not.toHaveText(originalIhc);
  await page.mouse.down();
  await page.mouse.move(right.x + right.width * .48, right.y + right.height * .45, { steps: 30 });
  await page.mouse.up();
  await expect(page.locator('#he-zoom')).toHaveText(originalHe);
  await expect(page.locator('#ihc-tile-status')).toHaveText('');
  await page.screenshot({ path: '.cache/verification/detail.png' });
  const metrics = await page.evaluate(start => {
    const m = window.testMetrics;
    m.capture = false;
    const frames = m.frames.slice(2).sort((a,b) => a-b);
    return {
      maxSubmittedPoints: Math.max(...m.draws),
      frameMedianMs: frames[Math.floor(frames.length / 2)],
      frameP95Ms: frames[Math.floor(frames.length * .95)],
      navigationLongTasks: m.longTasks.filter(t => t.start >= start),
      canvasCount: document.querySelectorAll('canvas').length,
      domNodes: document.querySelectorAll('*').length,
    };
  }, navigationStart);
  console.log('Actual slide browser metrics:', JSON.stringify(metrics));
  expect(metrics.maxSubmittedPoints).toBeGreaterThan(0);
  expect(metrics.maxSubmittedPoints).toBeLessThanOrEqual(50_000);
  expect(metrics.domNodes).toBeLessThan(250);

  await page.getByRole('button', { name: 'Reset views' }).click();
  await expect(page.locator('#ihc-zoom')).toHaveText(originalIhc);
  // Repeated wheel gestures keep one tissue landmark under the cursor while
  // traversing the pyramid down to native-resolution cells.
  await page.mouse.move(right.x + right.width * .394, right.y + right.height * .434);
  for (let i = 0; i < 15; i++) {
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(100); // Intentional user gesture cadence.
  }
  await expect.poll(async () => parseFloat(await page.locator('#ihc-zoom').textContent())).toBeGreaterThan(90);
  await expect(page.locator('#ihc-tile-status')).toHaveText('');
  await expect(page.locator('#annotation-status')).toContainText('in view');
  await page.screenshot({ path: '.cache/verification/cellular-detail.png' });
  await page.getByRole('button', { name: 'Reset views' }).click();
  await expect(page.locator('#ihc-zoom')).toHaveText(originalIhc);
  await page.setViewportSize({ width: 780, height: 700 });
  const leftBox = await page.locator('#he-viewer').boundingBox();
  const rightBox = await page.locator('#ihc-viewer').boundingBox();
  expect(Math.abs(leftBox.width - rightBox.width)).toBeLessThan(1);
  expect(leftBox.y).toEqual(rightBox.y);
  await page.screenshot({ path: '.cache/verification/compact.png' });
  expect(requests.some(url => /\.(tiff|geojson)(\?|$)/.test(url))).toBe(false);
  expect(errors).toEqual([]);
  expect(badResponses).toEqual([]);
  await fs.writeFile('.cache/verification/browser-metrics.json', JSON.stringify(metrics, null, 2));
});

test('a million-point layer is prepared in a worker and navigation remains bounded', async ({ page }) => {
  const packed = new Float32Array(1_000_000 * 3);
  for (let i = 0; i < 1_000_000; i++) {
    packed[i * 3] = (i * 7919) % 22970;
    packed[i * 3 + 1] = (i * 4861) % 30170;
    packed[i * 3 + 2] = i % 2;
  }
  await page.route('**/api/cases/*/manifest', async route => {
    const response = await route.fetch();
    const manifest = await response.json();
    manifest.annotations = {
      ...manifest.annotations, state: 'ready', count: 1_000_000,
      bytes: packed.byteLength, outside: 0, invalid: 0,
      classes: [
        { name: 'positive', color: [255, 0, 0], count: 500_000 },
        { name: 'negative', color: [0, 255, 0], count: 500_000 },
      ],
    };
    await route.fulfill({ json: manifest });
  });
  await page.route('**/api/cases/*/*/points/*.bin', route => route.fulfill({
    contentType: 'application/octet-stream', body: Buffer.from(packed.buffer),
  }));
  await page.addInitScript(() => {
    window.largestPointDraw = 0;
    const original = WebGLRenderingContext.prototype.drawElements;
    WebGLRenderingContext.prototype.drawElements = function(mode, count, ...rest) {
      if (mode === this.POINTS) window.largestPointDraw = Math.max(window.largestPointDraw, count);
      return original.call(this, mode, count, ...rest);
    };
  });
  await ready(page);
  await expect(page.locator('#annotation-status')).toContainText('1,000,000 points');
  await page.getByLabel('positive annotation color', { exact: true }).fill('#0000ff');
  await page.getByRole('slider', { name: 'Annotation point size' }).fill('200');
  const styled = await annotationPixels(page);
  expect(styled.blue).toBeGreaterThan(0);
  expect(styled.red).toBe(0);
  await page.getByRole('button', { name: 'Zoom in IHC', exact: true }).click();
  await page.locator('#ihc-toggle').uncheck();
  await expect(page.locator('.point-overlay')).toBeHidden();
  await page.locator('#ihc-toggle').check();
  await expect(page.locator('.point-overlay')).toBeVisible();
  const largest = await page.evaluate(() => window.largestPointDraw);
  expect(largest).toBeGreaterThan(0);
  expect(largest).toBeLessThanOrEqual(50_000);
});

test('WebGL context loss switches to a working Canvas overlay', async ({ page }) => {
  await ready(page);
  await page.getByLabel('hCD45+ annotation color', { exact: true }).fill('#0000ff');
  await page.getByRole('slider', { name: 'Annotation point size' }).fill('200');
  const supported = await page.locator('.point-overlay').evaluate(canvas => {
    const gl = canvas.getContext('webgl');
    const extension = gl?.getExtension('WEBGL_lose_context');
    extension?.loseContext();
    return Boolean(extension);
  });
  test.skip(!supported, 'The graphics driver does not expose context loss simulation.');
  await expect(page.locator('#annotation-status')).toHaveAttribute('title', /Canvas/);
  await expect(page.locator('.point-overlay')).toHaveCount(1);
  await expect(page.locator('.point-overlay')).toBeVisible();
  const recovered = await annotationPixels(page);
  expect(recovered.blue).toBeGreaterThan(0);
  expect(recovered.red).toBe(0);
  await expect(page.getByRole('slider', { name: 'Annotation point size' })).toHaveValue('200');
});

test('Canvas fallback renders when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (/webgl/.test(type)) return null;
      return getContext.call(this, type, ...args);
    };
  });
  await ready(page);
  await expect(page.locator('#annotation-status')).toHaveAttribute('title', /Canvas/);
  await expect(page.locator('.point-overlay')).toBeVisible();
  const coloredPixels = await page.locator('.point-overlay').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]) count++;
    return count;
  });
  expect(coloredPixels).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Zoom in IHC', exact: true }).click();
  await page.locator('#ihc-toggle').uncheck();
  await expect(page.locator('.point-overlay')).toBeHidden();
});

test('high DPI preserves the mask rectangle and annotation backing resolution', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:8000', viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    await ready(page);
    const mask = await page.locator('.mask-overlay').boundingBox();
    expect(Math.abs(mask.width / mask.height - 22970 / 30170)).toBeLessThan(.001);
    const dimensions = await page.locator('.point-overlay').evaluate(canvas => ({
      width: canvas.width, height: canvas.height, cssWidth: canvas.clientWidth, cssHeight: canvas.clientHeight,
    }));
    expect(dimensions.width).toEqual(dimensions.cssWidth * 2);
    expect(dimensions.height).toEqual(dimensions.cssHeight * 2);
  } finally { await context.close(); }
});
