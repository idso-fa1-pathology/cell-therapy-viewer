import OpenSeadragon from 'openseadragon';
import { PointOverlay } from './point-overlay.js';
import { ViewSync } from './view-sync.js';
import './style.css';

const element = id => document.getElementById(id);
const format = value => value.toLocaleString('en-US');
const viewers = {};
const caseId = decodeURIComponent(window.location.pathname.replace(/^\/|\/$/g, ''));
const manifestUrl = `/api/cases/${encodeURIComponent(caseId)}/manifest`;
let pointOverlay, viewSync, worker, pollTimer, disposed = false;

async function fetchManifest() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(manifestUrl);
    const result = await response.json();
    if (response.ok) return result;
    if (response.status !== 503 || attempt === 19) throw new Error(result.error || `Server returned ${response.status}.`);
    await new Promise(resolve => setTimeout(resolve, 500));
    if (disposed) throw new Error('Viewer closed.');
  }
}

function failSlide(key, message) {
  const status = element(`${key}-loading`);
  status.hidden = false;
  status.classList.add('error');
  status.textContent = message;
}

function updateNavigation(key, metadata) {
  const viewer = viewers[key];
  const item = viewer.world.getItemAt(0);
  if (!item) return;
  const scale = item.viewportToImageZoom(viewer.viewport.getZoom(true));
  element(`${key}-zoom`).textContent = `${(scale * 100).toFixed(1)}%`;
  const target = 90 / scale;
  const power = 10 ** Math.floor(Math.log10(target));
  const pixels = [1, 2, 5, 10].map(n => n * power).filter(n => n <= target).pop();
  element(`${key}-scale-line`).style.width = `${pixels * scale}px`;
  element(`${key}-scale-label`).textContent = `${format(pixels)} px`;
  element(`${key}-info`).textContent = `${format(metadata.width)} × ${format(metadata.height)} px`;
}

function openSlide(key, metadata) {
  return new Promise((resolve, reject) => {
    const viewer = OpenSeadragon({
      element: element(`${key}-viewer`),
      tileSources: metadata.dzi,
      showNavigationControl: false, showNavigator: false,
      animationTime: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : .22,
      blendTime: .12, immediateRender: false,
      imageLoaderLimit: 4, maxImageCacheCount: 140,
      minZoomImageRatio: .85, maxZoomPixelRatio: 4,
      visibilityRatio: .3, constrainDuringPan: true,
      homeFillsViewer: false, zoomPerScroll: 1.3,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true, scrollToZoom: true },
      gestureSettingsTouch: { pinchToZoom: true },
      drawer: ['webgl', 'canvas'],
    });
    viewers[key] = viewer;
    const tileStatus = element(`${key}-tile-status`);
    let tileFailed = false;
    viewer.addHandler('open-failed', event => {
      failSlide(key, `Could not open the slide. ${event.message || 'Check the local server.'}`);
      reject(new Error(`Could not open ${key.toUpperCase()}.`));
    });
    viewer.addHandler('tile-load-failed', () => {
      tileFailed = true;
      tileStatus.textContent = 'A tile failed to load. Reload to retry.';
    });
    viewer.addHandler('update-viewport', () => {
      updateNavigation(key, metadata);
      if (!tileFailed) tileStatus.textContent = viewer.world.getItemAt(0)?.getFullyLoaded() ? '' : 'Loading detail…';
    });
    viewer.addHandler('open', () => {
      element(`${key}-loading`).hidden = true;
      document.querySelectorAll(`[data-slide="${key}"]`).forEach(button => { button.disabled = false; });
      element('reset-all').disabled = false;
      updateNavigation(key, metadata);
      resolve(viewer);
    });
  });
}

async function attachMask(metadata) {
  const mask = new Image();
  mask.className = 'mask-overlay';
  mask.setAttribute('aria-hidden', 'true');
  mask.alt = '';
  mask.src = metadata.mask.url;
  await mask.decode();
  if (disposed) return;
  // OSD maps this single raster to the exact full-slide rectangle, including
  // the independent x/y rounding of the source's 717 × 942 pyramid level.
  viewers.he.addOverlay({
    element: mask,
    location: new OpenSeadragon.Rect(0, 0, 1, metadata.height / metadata.width),
    checkResize: false,
  });
  const toggle = element('he-toggle');
  const opacity = element('he-opacity');
  const update = () => {
    mask.style.opacity = toggle.checked ? Number(opacity.value) / 100 : 0;
    opacity.disabled = !toggle.checked;
    element('he-opacity-value').textContent = `${opacity.value}%`;
  };
  toggle.disabled = opacity.disabled = false;
  toggle.addEventListener('change', update);
  opacity.addEventListener('input', update);
  update();
}

function annotationError(message) {
  const status = element('annotation-status');
  status.classList.add('annotation-error');
  status.textContent = `Annotations unavailable: ${message}`;
}

function setupAnnotationStyle(classes) {
  const size = element('annotation-size');
  const sizeValue = element('annotation-size-value');
  const reset = element('reset-annotation-style');
  const defaults = classes.map(item => `#${item.color.map(value => value.toString(16).padStart(2, '0')).join('')}`);
  const inputs = classes.map((item, index) => {
    const row = document.createElement('label');
    row.className = 'legend-item';
    row.title = `${format(item.count)} points · change color`;
    const input = document.createElement('input');
    input.type = 'color';
    input.className = 'annotation-color';
    input.value = defaults[index];
    input.setAttribute('aria-label', `${item.name} annotation color`);
    const name = document.createElement('span');
    name.textContent = item.name;
    row.append(input, name);
    element('annotation-colors').append(row);
    return input;
  });
  const updateReset = () => {
    reset.disabled = size.value === '100' && inputs.every((input, index) => input.value === defaults[index]);
  };
  const updateColors = () => {
    pointOverlay.setClassColors(inputs.map(input =>
      [1, 3, 5].map(offset => parseInt(input.value.slice(offset, offset + 2), 16))));
    updateReset();
  };
  const updateSize = () => {
    const multiplier = Number(size.value) / 100;
    pointOverlay.setSizeMultiplier(multiplier);
    sizeValue.textContent = `${multiplier}×`;
    size.setAttribute('aria-valuetext', `${multiplier} times default size`);
    updateReset();
  };
  for (const input of inputs) input.addEventListener('input', updateColors);
  size.addEventListener('input', updateSize);
  reset.addEventListener('click', () => {
    inputs.forEach((input, index) => { input.value = defaults[index]; });
    size.value = '100';
    updateColors();
    updateSize();
  });
  updateSize();
}

function loadAnnotations(metadata, dimensions) {
  const status = element('annotation-status');
  worker = new Worker(new URL('./points.worker.js', import.meta.url), { type: 'module' });
  const stopWorker = () => { worker?.terminate(); worker = null; };
  worker.onerror = () => { annotationError('Could not prepare the point layer. Reload to retry.'); stopWorker(); };
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      status.textContent = `Loading annotations · ${data.value}%`;
    } else if (data.type === 'indexing') {
      status.textContent = `Indexing ${format(metadata.count)} points…`;
    } else if (data.type === 'error') {
      annotationError(data.message);
      stopWorker();
    } else if (data.type === 'ready') {
      stopWorker();
      try {
        pointOverlay = new PointOverlay(viewers.ihc, data, dimensions, stats => {
          const message = stats.hidden
            ? `${format(metadata.count)} points · hidden`
            : `${format(metadata.count)} points · ${stats.sampled ? 'overview sampling' : `${format(stats.count)} in view`}`;
          if (status.textContent !== message) status.textContent = message;
          status.title = `${metadata.outside} source points outside image bounds; ${metadata.invalid} invalid coordinates. ${stats.renderer || ''}`;
        });
        const toggle = element('ihc-toggle');
        const opacity = element('ihc-opacity');
        const update = () => {
          pointOverlay.setOpacity(Number(opacity.value) / 100);
          pointOverlay.setVisibility(toggle.checked);
          opacity.disabled = !toggle.checked;
          element('ihc-opacity-value').textContent = `${opacity.value}%`;
          element('annotation-legend').hidden = false;
        };
        toggle.disabled = opacity.disabled = false;
        toggle.addEventListener('change', update);
        opacity.addEventListener('input', update);
        setupAnnotationStyle(metadata.classes);
        update();
      } catch (error) { annotationError(error.message); }
    }
  };
  worker.postMessage({ url: metadata.url, bytes: metadata.bytes, classes: metadata.classes });
}

async function pollAnnotations(ihcReady, dimensions) {
  try {
    const { annotations } = await fetchManifest();
    if (disposed) return;
    if (annotations.state === 'ready') {
      await ihcReady;
      if (!disposed) loadAnnotations(annotations, dimensions);
    } else if (annotations.state === 'error') {
      annotationError(annotations.error);
    } else {
      element('annotation-status').textContent = `${annotations.phase} · ${annotations.progress}%`;
      pollTimer = setTimeout(() => pollAnnotations(ihcReady, dimensions), 500);
    }
  } catch (error) { annotationError(error.message); }
}

document.querySelectorAll('[data-action]').forEach(button => {
  button.addEventListener('click', () => {
    const viewport = viewers[button.dataset.slide]?.viewport;
    if (!viewport) return;
    if (button.dataset.action === 'fit') viewport.goHome();
    else {
      viewport.zoomBy(button.dataset.action === 'in' ? 1.5 : 1 / 1.5);
      viewport.applyConstraints();
    }
  });
});
element('reset-all').addEventListener('click', () => {
  if (viewSync?.enabled) viewers[viewSync.active].viewport.goHome();
  else for (const viewer of Object.values(viewers)) if (viewer.isOpen()) viewer.viewport.goHome();
});
element('sync-toggle').addEventListener('change', event => {
  viewSync?.setEnabled(event.target.checked);
  element('navigation-mode').textContent = event.target.checked ? 'Synced views' : 'Independent views';
});

async function start() {
  try {
    const { slides, case: currentCase } = await fetchManifest();
    element('case-name').textContent = currentCase.id;
    document.title = `${currentCase.id} · Pathology Viewer`;
    for (const key of ['he', 'ihc']) element(`${key}-filename`).textContent = slides[key].filename;
    const heReady = openSlide('he', slides.he);
    const ihcReady = openSlide('ihc', slides.ihc);
    Promise.all([heReady, ihcReady]).then(() => {
      if (disposed) return;
      viewSync = new ViewSync(viewers);
      element('sync-toggle').checked = true;
      element('sync-toggle').disabled = false;
    }).catch(() => {}); // Each panel already reports its own slide error.
    heReady.then(() => attachMask(slides.he)).catch(error => {
      element('he-tile-status').textContent = `Mask unavailable: ${error.message}`;
    });
    // Slides open independently; preparation does not block either viewport.
    ihcReady.catch(() => {});
    pollAnnotations(ihcReady, slides.ihc);
  } catch (error) {
    for (const key of ['he', 'ihc']) failSlide(key, `Could not load case ${caseId}. ${error.message}`);
    annotationError('Check the case files and server, then reload.');
  }
}

window.addEventListener('pagehide', () => {
  disposed = true;
  clearTimeout(pollTimer);
  worker?.terminate();
  pointOverlay?.destroy();
  viewSync?.destroy();
  Object.values(viewers).forEach(viewer => viewer.destroy());
}, { once: true });
start();
