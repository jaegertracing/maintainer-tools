// ISO 8601 week number — used as the scope key for `weekly_digest`. Two
// runs in the same week converge on one comment (edit-in-place); the
// first run after the week rolls over posts fresh.
//
// Week 1 is the week containing the year's first Thursday (equivalently,
// the week containing Jan 4). Weeks start on Monday. The "week year" can
// differ from the calendar year for the first/last few days of January
// and December.

export function isoWeek(date: Date): string {
  // Work in UTC throughout to avoid local-DST artifacts at midnight.
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Day number where Monday=0..Sunday=6 (matches ISO).
  const dayNum = (tmp.getUTCDay() + 6) % 7;
  // Shift to the Thursday of this week; that day decides the week year.
  tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
  const weekYear = tmp.getUTCFullYear();
  // Jan 4 is always in week 1; use that as the anchor.
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() - jan4Day + 3);
  const week = 1 + Math.round((tmp.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${weekYear}-W${String(week).padStart(2, '0')}`;
}
