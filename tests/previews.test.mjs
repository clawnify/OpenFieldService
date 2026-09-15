import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('saved preview pipeline rejects stale compositions and invalid captures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ofs-preview-check-'));
  try {
    mkdirSync(join(directory, 'scripts'));
    for (const path of ['scripts/build-previews.mjs', 'scripts/feature-concepts.mjs', 'screenshots', 'previews', 'icon.svg', 'readme-banner.png', 'readme-banner-dark.png']) {
      cpSync(new URL('../' + path, import.meta.url), join(directory, path), { recursive: true });
    }
    const run = (...args) => spawnSync(process.execPath, ['scripts/build-previews.mjs', ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(run('check').status, 0);
    assert.equal(run('build').status, 0);
    const concept = readFileSync(join(directory, '.preview-build/dispatch.html'), 'utf8');
    assert.ok(!concept.includes('data:image/png'), 'feature illustrations must not embed screenshots');
    assert.match(concept, /Illustrative UI/);
    assert.match(concept, /Conceptual technician assignment/);
    const cover = readFileSync(join(directory, 'readme-banner.png'));
    const wrongSize = run('import', 'cover-light', 'screenshots/dashboard-mobile.png');
    assert.notEqual(wrongSize.status, 0);
    assert.match(wrongSize.stderr, /Expected 1600×1000/);
    assert.deepEqual(readFileSync(join(directory, 'readme-banner.png')), cover, 'invalid input must not overwrite the cover');

    const manifestPath = join(directory, 'screenshots/manifest.json');
    const original = readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(original);
    manifest.features[0].title = 'Changed headline';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match(run('check').stderr, /Stale output: dispatch/);
    manifest.features[0].sources[0] = 'missing-reference';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match(run('build').stderr, /Unknown reference screenshot/);
    writeFileSync(manifestPath, original);

    const gallery = join(directory, 'previews/website-gallery.json');
    writeFileSync(gallery, '[]\n');
    assert.match(run('check').stderr, /Stale website gallery/);
    assert.equal(run('export').status, 0);
    assert.equal(run('check').status, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
