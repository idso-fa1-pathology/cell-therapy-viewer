import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const layouts = [
  {
    name: 'configured subdirectories', caseId: 'project A/batch α/test link',
    files: {
      he: 'slides/original_HE.tiff', ihc: 'slides/original_IHC.tiff',
      mask: 'results/masks/original_HE.png', annotations: 'results/annotations/original_IHC.geojson',
    },
    environment: {
      HE_SLIDE_SUBDIR: 'slides', IHC_SLIDE_SUBDIR: 'slides',
      HE_MASK_SUBDIR: 'results/masks', IHC_ANNOTATIONS_SUBDIR: 'results/annotations',
    },
  },
  {
    name: 'cohort/slide path templates', caseId: '26-490/26-490-145-liver',
    files: {
      he: 'HE-Stains/26-490-145-liver_HE.tiff',
      ihc: 'IHC-Regs/26-490-145-liver/26-490-145-liver_IHC_Reg.tiff',
      mask: 'HE-Recogs/Segformer-mit_b5/26-490-145-liver_HE.png',
      annotations: 'IHC-Regs/26-490-145-liver/Reg-cell_recog-IHC_to_HE_transformed_shapes.geojson',
    },
    environment: {
      HE_SLIDE_PATH: 'HE-Stains/{slide}_HE.tiff',
      IHC_SLIDE_PATH: 'IHC-Regs/{slide}/{slide}_IHC_Reg.tiff',
      HE_MASK_PATH: 'HE-Recogs/Segformer-mit_b5/{slide}_HE.png',
      IHC_ANNOTATIONS_PATH: 'IHC-Regs/{slide}/Reg-cell_recog-IHC_to_HE_transformed_shapes.geojson',
    },
  },
];

for (const layout of layouts) {
test(`nested case URL loads and refreshes with ${layout.name}`, async ({ page }) => {
  await fs.mkdir('.cache', { recursive: true });
  const temporary = await fs.mkdtemp(path.resolve('.cache/nested-browser-'));
  const caseId = layout.caseId;
  const dataRoot = path.join(temporary, 'data');
  const folder = path.join(dataRoot, caseId);
  let server, closed;
  try {
    for (const filename of Object.values(layout.files)) {
      await fs.mkdir(path.dirname(path.join(folder, filename)), { recursive: true });
    }
    const source = path.resolve('data/2606J01_511_2_Liv_19');
    for (const [filename, key] of [
      ['2606J01_511_2_Liv_19_HE.tiff', 'he'],
      ['2606J01_511_2_Liv_19_IHC.tiff', 'ihc'],
      ['2606J01_511_2_Liv_19_HE.png', 'mask'],
    ]) {
      await fs.link(path.join(source, filename), path.join(folder, layout.files[key]));
    }
    await fs.writeFile(path.join(folder, layout.files.annotations), JSON.stringify({
      type: 'Feature', geometry: { type: 'Point', coordinates: [10000, 15000] },
      properties: { classification: { name: 'Nested annotation', color: [255, 0, 0] } },
    }));
    server = spawn('.venv/bin/python', [
      'server.py', '--host', '127.0.0.1', '--port', '0',
      '--data-dir', dataRoot, '--cache-dir', path.join(temporary, 'cache'),
    ], {
      env: {
        ...process.env, HE_SLIDE_SUBDIR: '.', IHC_SLIDE_SUBDIR: '.',
        HE_MASK_SUBDIR: '.', IHC_ANNOTATIONS_SUBDIR: '.',
        HE_SLIDE_PATH: '', IHC_SLIDE_PATH: '', HE_MASK_PATH: '', IHC_ANNOTATIONS_PATH: '',
        ...layout.environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise(resolve => server.once('close', resolve));
    let output = '', baseURL, failure;
    server.on('error', error => { failure = error; });
    server.stderr.on('data', chunk => { output += chunk; });
    server.stdout.on('data', chunk => {
      output += chunk;
      baseURL = output.match(/Pathology Viewer: (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    });
    await expect.poll(() => {
      if (failure) throw failure;
      if (server.exitCode !== null) throw new Error(output);
      return baseURL;
    }).toBeTruthy();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    const url = `${baseURL}/${caseId.split('/').map(encodeURIComponent).join('/')}`;
    await page.goto(url); // Server adds the trailing slash.
    await expect(page).toHaveURL(url + '/');
    for (let load = 0; load < 2; load++) {
      await expect(page.locator('#case-name')).toHaveText(caseId);
      await expect(page.locator('#he-toggle')).toBeEnabled();
      await expect(page.locator('#ihc-toggle')).toBeEnabled();
      await expect(page.locator('#he-tile-status')).toHaveText('');
      await expect(page.locator('#ihc-tile-status')).toHaveText('');
      await expect(page.getByLabel('Nested annotation annotation color', { exact: true })).toBeEnabled();
      if (load === 0) await page.reload();
    }
    expect(errors).toEqual([]);
  } finally {
    if (server) {
      server.kill('SIGTERM');
      await closed;
    }
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
}
