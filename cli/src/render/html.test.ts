import assert from 'node:assert/strict';
import test from 'node:test';

import { renderHtml } from './html.js';

test('Expand/Collapse All render inside the bucket view, not the header toolbar', () => {
  const html = renderHtml([], {
    viewer: 'maintainer-a',
    now: new Date('2026-09-20T12:00:00Z'),
    authorOpenCounts: new Map(),
  });

  const markers = [
    '</header>',
    'id="view-buckets"',
    'id="view-table"',
    'id="expand-all"',
    'id="collapse-all"',
  ];
  const at = new Map(markers.map((marker) => [marker, html.indexOf(marker)]));
  for (const marker of markers) {
    assert.notEqual(at.get(marker), -1, `expected to find marker ${marker}`);
  }

  const headerEnd = at.get('</header>')!;
  const bucketViewStart = at.get('id="view-buckets"')!;
  const tableViewStart = at.get('id="view-table"')!;
  const expandIndex = at.get('id="expand-all"')!;
  const collapseIndex = at.get('id="collapse-all"')!;

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
