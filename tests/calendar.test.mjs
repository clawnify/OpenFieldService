import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, daysInRange, weekRange } from '../src/client/calendar.ts';

test('calendar dates and week navigation preserve local days across timezones and DST', () => {
  const original = process.env.TZ;
  try {
    for (const timezone of ['Europe/Amsterdam', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = timezone;
      assert.equal(calendarDate(new Date(2026, 8, 15, 0, 30)), '2026-09-15');
      assert.deepEqual(weekRange(new Date(2026, 8, 20, 23, 30)), ['2026-09-14', '2026-09-20'], 'Sunday stays in the current week');
      assert.deepEqual(daysInRange('2026-09-14', '2026-09-20'), ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20']);
      assert.deepEqual(daysInRange('2026-03-28', '2026-03-30'), ['2026-03-28', '2026-03-29', '2026-03-30']);
      assert.deepEqual(daysInRange('2026-10-24', '2026-10-26'), ['2026-10-24', '2026-10-25', '2026-10-26']);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
