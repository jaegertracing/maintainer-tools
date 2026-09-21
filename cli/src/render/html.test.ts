import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtml } from './html.js';

test('Expand/Collapse All render inside the bucket view, not the header toolbar', () => {
  const html = renderHtml([], {
    viewer: 'maintainer-a',
    now: new Date('2026-09-20T12:00:00Z'),
    authorOpenCounts: new Map(),
  });

  const headerEnd = html.indexOf('</header>');
  const bucketViewStart = html.indexOf('id="view-buckets"');
  const tableViewStart = html.indexOf('id="view-table"');
  const expandIndex = html.indexOf('id="expand-all"');
  const collapseIndex = html.indexOf('id="collapse-all"');

  for (const [name, index] of [
    ['</header>', headerEnd],
    ['id="view-buckets"', bucketViewStart],
    ['id="view-table"', tableViewStart],
    ['id="expand-all"', expandIndex],
    ['id="collapse-all"', collapseIndex],
  ] as const) {
    assert.notEqual(index, -1, `expected to find marker ${name}`);
  }

  assert.ok(bucketViewStart > headerEnd, 'bucket view must open after the header closes');
  assert.ok(
    expandIndex > bucketViewStart && expandIndex < tableViewStart,
    'Expand All must render inside the bucket view, not the table view',
  );
  assert.ok(
    collapseIndex > bucketViewStart && collapseIndex < tableViewStart,
    'Collapse All must render inside the bucket view, not the table view',
  );
});
