// One cycle per UTC day: backup cron times must not train twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isDue } from '../src/ci/due.js';
import { runCycle } from '../src/run.js';
import { testConfig, vdir } from './helpers.js';

test('due when a variant has no run-state or did not run today; not due once all ran today; force overrides', async () => {
  const cfg = testConfig();
  const now = new Date('2026-11-20T10:17:00Z');
  assert.equal(isDue(cfg, { now }).due, true); // never ran
  await runCycle({ cfg, deps: { now: () => new Date('2026-11-20T04:17:00Z') } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(vdir(cfg), cfg.paths.runState), 'utf8')).lastRunDay, '2026-11-20');
  const later = isDue(cfg, { now });
  assert.equal(later.due, false);
  assert.match(later.reason, /already ran today/);
  assert.equal(isDue(cfg, { now: new Date('2026-11-21T04:17:00Z') }).due, true); // next day
  assert.equal(isDue(cfg, { now, force: true }).due, true);
});

test('a corrupt run-state counts as due (never silently skip training)', () => {
  const cfg = testConfig();
  fs.mkdirSync(vdir(cfg), { recursive: true });
  fs.writeFileSync(path.join(vdir(cfg), cfg.paths.runState), '{not json');
  assert.equal(isDue(cfg).due, true);
});

test('state written before lastRunDay existed: last-run.json timestamp counts', () => {
  const cfg = testConfig();
  fs.mkdirSync(vdir(cfg), { recursive: true });
  fs.writeFileSync(path.join(vdir(cfg), cfg.paths.runState), JSON.stringify({ runCount: 3, baselineRunsDone: 2 }));
  fs.writeFileSync(path.join(vdir(cfg), cfg.paths.lastRun), JSON.stringify({ timestamp: '2026-11-20T07:56:00.000Z' }));
  assert.equal(isDue(cfg, { now: new Date('2026-11-20T10:17:00Z') }).due, false);
  assert.equal(isDue(cfg, { now: new Date('2026-11-21T04:17:00Z') }).due, true);
});
