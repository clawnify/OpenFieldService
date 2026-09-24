import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheOfflineResponse,
  clearSavedFieldData,
  hasSavedFieldData,
  isOfflineDataRequest,
  SAVED_DATA_CHANGE_EVENT,
} from '../src/client/offline.ts';

test('offline cache is limited to schedule reads and individual job packets', () => {
  assert.equal(isOfflineDataRequest('GET', '/api/schedule?start=2026-09-21&end=2026-09-27'), true);
  assert.equal(isOfflineDataRequest('GET', '/api/jobs/85bf2f27-6394-4df4-9054-1f15d0065ad1'), true);
  assert.equal(isOfflineDataRequest('GET', '/api/jobs?page=1'), false);
  assert.equal(isOfflineDataRequest('GET', '/api/jobs/85bf2f27/checklist'), false);
  assert.equal(isOfflineDataRequest('POST', '/api/jobs/85bf2f27/notes'), false);
  assert.equal(isOfflineDataRequest('DELETE', '/api/jobs/85bf2f27'), false);
});

test('saved field data can be detected and cleared while online', async () => {
  const originalWindow = globalThis.window;
  const originalCaches = globalThis.caches;
  const entries = new Map();
  const cache = {
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    match: async (request) => entries.get(request.url),
    put: async (request, response) => { entries.set(request.url, response); },
  };
  const cacheStorage = {
    keys: async () => entries.size > 0 ? ['openfieldservice-data-v1'] : [],
    open: async () => cache,
    delete: async () => { entries.clear(); return true; },
  };
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: 'https://field.example' };
  browserWindow.caches = cacheStorage;
  globalThis.window = browserWindow;
  globalThis.caches = cacheStorage;

  let changes = 0;
  browserWindow.addEventListener(SAVED_DATA_CHANGE_EVENT, () => { changes += 1; });
  try {
    assert.equal(await hasSavedFieldData(), false);
    await cacheOfflineResponse('/api/schedule?start=2026-09-21&end=2026-09-27', new Response('{}'));
    assert.equal(await hasSavedFieldData(), true);
    await clearSavedFieldData();
    assert.equal(await hasSavedFieldData(), false);
    assert.equal(changes, 2);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else globalThis.window = originalWindow;
    if (originalCaches === undefined) Reflect.deleteProperty(globalThis, 'caches');
    else globalThis.caches = originalCaches;
  }
});
