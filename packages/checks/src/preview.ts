// Copyright (c) 2026 The Jaeger Authors.
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { PullRequest } from './types.js';
import { groupDashboardItems, renderDashboard } from './render/dashboard.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixturesPath = join(__dirname, '../test/fixtures/sample_prs.json');
const rawData = readFileSync(fixturesPath, 'utf-8');
const samplePrs = JSON.parse(rawData) as PullRequest[];

const dashboardData = groupDashboardItems(samplePrs);
const rendered = renderDashboard(dashboardData);

const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
if (stepSummaryPath) {
  appendFileSync(stepSummaryPath, rendered, 'utf-8');
} else {
  process.stdout.write(rendered);
}
