// Exploration: only unsolved TRAIN problems, stable sharding, holdout rejected everywhere, passing solutions kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { shardOf, exploreShard } from '../src/explore.js';
import { mergeExploration } from '../src/ci/collect-explore.js';
import { tmpDir } from './helpers.js';

const cfg = loadConfig({ env: {} });

test('shardOf is stable and covers every shard', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `p${i}`);
  const counts = [0, 0, 0];
  for (const id of ids) { assert.equal(shardOf(id, 3), shardOf(id, 3)); counts[shardOf(id, 3)]++; }
  assert.ok(counts.every((c) => c > 30), JSON.stringify(counts));
});

test('mergeExploration: de-duplicates by problem + normalised code and rejects holdout rows', () => {
  const row = (problemId, code) => ({ problemId, code, result: 'pass', track: 'multipl-e' });
  const { rows, added, rejected } = mergeExploration([row('a', 'f( )')], [row('a', 'f(  )'), row('a', 'g()'), row('h', 'x'), { ...row('b', 'y'), result: 'fail' }], new Set(['h']));
  assert.equal(added, 1);
  assert.equal(rejected, 1);
  assert.deepEqual(rows.map((r) => r.code), ['f( )', 'g()']);
});

test('exploreShard: samples only its unsolved train problems, keeps passing distinct solutions, never the holdout', async () => {
  const stateDir = tmpDir();
  const c = { ...cfg, root: cfg.root, finetune: { ...cfg.finetune, sourceStateDir: stateDir, extraTraceFiles: [] },
    explore: { ...cfg.explore, models: { m: { model: 'mock', samples: 3, maxProblems: 50, maxMinutes: 5 } }, shards: [{ shard: 0, model: 'm' }] } };
  const tasks = new Map(['t1', 't2', 'h1'].map((id) => [id, { id, entryPoint: 'f', prompt: 'function f() {\n', vars: { prompt: 'function f() {' } }]));
  const track = { train: ['t1', 't2'], holdout: ['h1'], tasks, templates: { solveUser: '{{prompt}}' },
    extractCode: (r) => r, judge: async (code) => ({ type: code.includes('good') ? 'pass' : 'fail' }) };
  const asked = [];
  let n = 0;
  const llm = { chat: async (_m, o) => { asked.push(o.meta.problemId); n++; return n % 2 ? 'function f(){ return "good"; }' : 'function f(){ return "bad"; }'; } };
  const out = path.join(tmpDir(), 'x.jsonl');
  const s = await exploreShard(c, { shard: 0, modelKey: 'm', out, deps: { track, llm, runId: 'r' } });
  assert.deepEqual([...new Set(asked)].sort(), ['t1', 't2']);
  assert.equal(s.samples, 6);
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.result === 'pass' && r.variant === 'explore-m' && r.problemId !== 'h1'));
  assert.equal(rows.length, 2, 'one distinct passing solution per problem');
});
