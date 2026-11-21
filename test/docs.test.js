// The docs must not drift from the code: every configured variant is described, the model named in the README
// is the configured one, and every npm script the README tells people to run exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';

const cfg = loadConfig({ env: {} });
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const decisions = fs.readFileSync(path.join(ROOT, 'DECISIONS.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('DECISIONS.md describes every configured variant', () => {
  for (const v of cfg.variants) assert.ok(decisions.includes(`\`${v.name}\``), `variant ${v.name} missing from DECISIONS.md`);
});

test('README names the configured model', () => {
  assert.ok(readme.includes(cfg.llm.model), `README should mention ${cfg.llm.model}`);
});

test('every `npm run X` in the README exists in package.json', () => {
  const used = [...readme.matchAll(/npm run ([\w-]+)/g)].map((m) => m[1]);
  assert.ok(used.length > 0);
  for (const s of new Set(used)) assert.ok(pkg.scripts[s], `README uses "npm run ${s}" but package.json has no such script`);
});
