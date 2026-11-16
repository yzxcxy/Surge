import assert from 'node:assert/strict';
import test from 'node:test';
import { reminderNotificationId, reminderOccurrences } from '../web/todo-reminders.mjs';

test('one-time reminders skip past times and daily repeats start on the chosen date', () => {
  const anchor = new Date(2026, 10, 17, 9, 30).getTime();
  assert.deepEqual(reminderOccurrences(anchor, 'none', false, anchor - 60_000), [anchor]);
  assert.deepEqual(reminderOccurrences(anchor, 'none', false, anchor + 60_000), []);
  const daily = reminderOccurrences(anchor, 'daily', false, anchor - 86_400_000);
  assert.equal(daily[0], anchor);
  assert.equal(daily[1], new Date(2026, 10, 18, 9, 30).getTime());
});

test('monthly repeats skip dates missing the selected day', () => {
  const anchor = new Date(2026, 0, 31, 8).getTime();
  const dates = reminderOccurrences(anchor, 'monthly', false, anchor - 60_000);
  assert.equal(dates[0], anchor);
  assert.equal(dates[1], new Date(2026, 2, 31, 8).getTime());
});

test('lunar yearly reminders follow the Chinese calendar', () => {
  const newYear2026 = new Date(2026, 1, 17, 9).getTime();
  const dates = reminderOccurrences(newYear2026, 'yearly', true, newYear2026 + 60_000);
  assert.equal(dates[0], new Date(2027, 1, 7, 9).getTime());
  assert.equal(dates[1], new Date(2028, 0, 26, 9).getTime());
});

test('notification identifiers are stable positive Android integers', () => {
  const first = reminderNotificationId('a-note', 123);
  assert.equal(first, reminderNotificationId('a-note', 123));
  assert.notEqual(first, reminderNotificationId('a-note', 124));
  assert.ok(first > 0 && first <= 2147483647);
});
