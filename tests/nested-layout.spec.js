import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

test('nested case URL loads and refreshes with assets in configured subdirectories', async ({ page }) => {
  await fs.mkdir('.cache', { recursive: true });
  const temporary = await fs.mkdtemp(path.resolve('.cache/nested-browser-'));
  const caseId = 'project A/batch α/test link';
  const dataRoot = path.join(temporary, 'data');
  const folder = path.join(dataRoot, caseId);
  let server, closed;
  try {
    for (const directory of ['slides', 'results/masks', 'results/annotations']) {
      await fs.mkdir(path.join(folder, directory), { recursive: true });
    }
    const source = path.resolve('data/2606J01_511_2_Liv_19');
    for (const [filename, directory] of [
      ['2606J01_511_2_Liv_19_HE.tiff', 'slides'],
      ['2606J01_511_2_Liv_19_IHC.tiff', 'slides'],
      ['2606J01_511_2_Liv_19_HE.png', 'results/masks'],
    ]) {
      await fs.link(path.join(source, filename), path.join(folder, directory, filename));
    }
    await fs.writeFile(path.join(folder, 'results/annotations/original_IHC.geojson'), JSON.stringify({
      type: 'Feature', geometry: { type: 'Point', coordinates: [10000, 15000] },
      properties: { classification: { name: 'Nested annotation', color: [255, 0, 0] } },
    }));
    server = spawn('.venv/bin/python', [
      'server.py', '--host', '127.0.0.1', '--port', '0',
      '--data-dir', dataRoot, '--cache-dir', path.join(temporary, 'cache'),
    ], {
      env: {
        ...process.env, HE_SLIDE_SUBDIR: 'slides', IHC_SLIDE_SUBDIR: 'slides',
        HE_MASK_SUBDIR: 'results/masks', IHC_ANNOTATIONS_SUBDIR: 'results/annotations',
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
