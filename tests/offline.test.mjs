import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheOfflineResponse,
  clearSavedFieldData,
  enableOfflineStorage,
  hasSavedFieldData,
  isOfflineStorageEnabled,
  isOfflineDataRequest,
  OFFLINE_STORAGE_CHANGE_EVENT,
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
  const cacheNames = new Set();
  const cache = {
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
    match: async (request) => entries.get(request.url),
    put: async (request, response) => { entries.set(request.url, response); },
  };
  const markerCache = { keys: async () => [], match: async () => undefined, put: async () => undefined };
  const cacheStorage = {
    keys: async () => [...cacheNames],
    open: async (name) => {
      cacheNames.add(name);
      return name === 'openfieldservice-data-v1' ? cache : markerCache;
    },
    delete: async (name) => {
      const existed = cacheNames.delete(name);
      if (name === 'openfieldservice-data-v1') entries.clear();
      return existed;
    },
  };
  const browserWindow = new EventTarget();
  browserWindow.location = { origin: 'https://field.example' };
  browserWindow.caches = cacheStorage;
  globalThis.window = browserWindow;
  globalThis.caches = cacheStorage;

  let changes = 0;
  browserWindow.addEventListener(OFFLINE_STORAGE_CHANGE_EVENT, () => { changes += 1; });
  try {
    assert.equal(await isOfflineStorageEnabled(), true);
    assert.equal(await hasSavedFieldData(), false);
    await cacheOfflineResponse('/api/schedule?start=2026-09-21&end=2026-09-27', new Response('{}'));
    assert.equal(await hasSavedFieldData(), true);
    await clearSavedFieldData();
    assert.equal(await isOfflineStorageEnabled(), false);
    assert.equal(await hasSavedFieldData(), false);
    await cacheOfflineResponse('/api/jobs/85bf2f27-6394-4df4-9054-1f15d0065ad1', new Response('{}'));
    assert.equal(await hasSavedFieldData(), false);
    await enableOfflineStorage();
    assert.equal(await isOfflineStorageEnabled(), true);
    assert.equal(changes, 3);
  } finally {
    if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window');
    else globalThis.window = originalWindow;
    if (originalCaches === undefined) Reflect.deleteProperty(globalThis, 'caches');
    else globalThis.caches = originalCaches;
  }
});
