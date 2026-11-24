// Decides whether a scheduled run should start a cycle. Cron fires several times a day (and GitHub sometimes drops
// one); a cycle starts when some active variant's last cycle began at least cycle.minHoursBetween hours ago, so
// several cycles fit in a day without overlapping or repeating one that just ran.
//   node src/ci/due.js [--force] >> "$GITHUB_OUTPUT"   -> due=true|false and a human-readable reason
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, rootPath } from '../config.js';
import { variantStateDir, activeVariants } from '../variants.js';
import { MS_PER_HOUR } from '../util.js';

/** When a variant's last cycle started: run-state.lastRunAt, else last-run.json's timestamp, else never. */
export function lastRunAt(cfg, name) {
  const dir = rootPath(cfg, variantStateDir(cfg, name));
  const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const t = read(path.join(dir, cfg.paths.runState))?.lastRunAt ?? read(path.join(dir, cfg.paths.lastRun))?.timestamp;
  return t ? new Date(t) : null;
}

export function isDue(cfg, { force = false, now = new Date() } = {}) {
  if (force) return { due: true, reason: 'forced' };
  const gap = cfg.cycle.minHoursBetween;
  const pending = activeVariants(cfg).filter((v) => {
    const t = lastRunAt(cfg, v.name);
    return !t || (now - t) / MS_PER_HOUR >= gap;
  }).map((v) => v.name);
  return pending.length ? { due: true, reason: `no cycle in the last ${gap} h for: ${pending.join(', ')}` } : { due: false, reason: `every variant ran in the last ${gap} h` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const force = process.argv.includes('--force') || process.env.SIC_FORCE === '1' || process.env.SIC_SMOKE === '1';
  const r = isDue(loadConfig(), { force });
  console.log(`due=${r.due}`);
  console.error(`due: ${r.reason}`);
}
