import test from 'node:test';
import assert from 'node:assert/strict';
import { isOfflineDataRequest } from '../src/client/offline.ts';

test('offline cache is limited to schedule reads and individual job packets', () => {
  assert.equal(isOfflineDataRequest('GET', '/api/schedule?start=2026-09-21&end=2026-09-27'), true);
  assert.equal(isOfflineDataRequest('GET', '/api/jobs/85bf2f27-6394-4df4-9054-1f15d0065ad1'), true);
  assert.equal(isOfflineDataRequest('GET', '/api/jobs?page=1'), false);
  assert.equal(isOfflineDataRequest('GET', '/api/jobs/85bf2f27/checklist'), false);
  assert.equal(isOfflineDataRequest('POST', '/api/jobs/85bf2f27/notes'), false);
  assert.equal(isOfflineDataRequest('DELETE', '/api/jobs/85bf2f27'), false);
});
