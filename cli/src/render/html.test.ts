import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtml } from './html.js';

test('Expand/Collapse All render inside the bucket view, not the header toolbar', () => {
  const html = renderHtml([], {
    viewer: 'maintainer-a',
    now: new Date('2026-09-20T12:00:00Z'),
    authorOpenCounts: new Map(),
  });

  const find = (marker: string): number => {
    const index = html.indexOf(marker);
    assert.notEqual(index, -1, `expected to find marker ${marker}`);
    return index;
  };

  const bucketViewStart = find('id="view-buckets"');
  const tableViewStart = find('id="view-table"');
  const expandIndex = find('id="expand-all"');
  const collapseIndex = find('id="collapse-all"');

  assert.ok(
    expandIndex > bucketViewStart && expandIndex < tableViewStart,
    'Expand All must render inside the bucket view, not the table view',
  );
  assert.ok(
    collapseIndex > bucketViewStart && collapseIndex < tableViewStart,
    'Collapse All must render inside the bucket view, not the table view',
  );
});
