// Recursive self-improvement rounds: the exam never leaks into search or training, rounds chain and stop as
// configured, the exam is paired (same seeds for every model), and the verdict follows the pre-registered rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { rsiSplit, planRound, selectTraining, passAt1, compareModels, rsiVerdict, roundModel } from '../src/rsi/core.js';
import { searchShard, examShard, foldRound } from '../src/rsi/cli.js';
import { rsiReport, rsiSummaryLine } from '../src/rsi/report.js';
import { tmpDir } from './helpers.js';

const cfg = loadConfig({ env: {} });
const stats = { resamples: 500, confidence: 0.95, seed: 3 };

test('rsiSplit: exam = holdout + fixed extra train problems; search pool is the rest; never overlap; stable', () => {
  const train = Array.from({ length: 60 }, (_, i) => `t${String(i).padStart(2, '0')}`);
  const holdout = ['h1', 'h2', 'h3'];
  const a = rsiSplit(train, holdout, { evalExtraFromTrain: 10, evalSeed: 5 });
  const b = rsiSplit([...train].reverse(), holdout, { evalExtraFromTrain: 10, evalSeed: 5 });
  assert.deepEqual(a, b);
  assert.equal(a.exam.length, 13);
  assert.ok(holdout.every((h) => a.exam.includes(h)));
  assert.equal(a.pool.length, 50);
  assert.ok(a.pool.every((id) => !a.exam.includes(id)));
});

test('planRound: round 1 searches with the stock model and examines base + round 1; later rounds chain the previous run', () => {
  const rsi = cfg.rsi;
  const p1 = planRound(rsi, [], 'stock');
  assert.equal(p1.round, 1);
  assert.equal(p1.search_model, 'stock');
  assert.equal(p1.search_served, 'false');
  assert.equal(p1.build_base, 'true');
  const models1 = new Set(JSON.parse(p1.eval_matrix).map((j) => j.model));
  assert.deepEqual([...models1].sort(), [0, 1]);
  assert.equal(JSON.parse(p1.eval_matrix).length, 2 * rsi.eval.shards);
  const p3 = planRound(rsi, [{ round: 1, runId: '11', vsPrevious: { estimate: 0.02 } }, { round: 2, runId: '22', vsPrevious: { estimate: 0.01 } }], 'stock');
  assert.equal(p3.round, 3);
  assert.equal(p3.search_model, roundModel(rsi, 2));
  assert.equal(p3.prev_run_id, '22');
  assert.equal(p3.search_served, 'true');
  assert.equal(p3.stop, '');
  assert.deepEqual([...new Set(JSON.parse(p3.eval_matrix).map((j) => j.model))], [3]);
});

test('planRound stops after maxRounds, or after stopAfterNonImproving rounds that did not beat the round before', () => {
  const rsi = { ...cfg.rsi, maxRounds: 3, stopAfterNonImproving: 2 };
  const r = (round, est) => ({ round, runId: String(round), vsPrevious: { estimate: est } });
  assert.equal(planRound(rsi, [r(1, 0.1), r(2, 0.1), r(3, 0.1)], 'x').stop, 'max-rounds');
  assert.equal(planRound(rsi, [r(1, 0.1), r(2, -0.01)], 'x').stop, '');
  assert.equal(planRound(rsi, [r(1, 0), r(2, -0.01)], 'x').stop, 'stalled');
});

test('selectTraining: rejects exam rows (counted), dedupes, weights hard wins, newest round first, caps', () => {
  const row = (problemId, code, passFraction, round = 1) => ({ problemId, code, passFraction, round, result: 'pass' });
  const rows = [row('e', 'x', 0.1), row('hard', 'a( )', 0.2), row('hard', 'a(  )', 0.2), row('hard', 'b()', 0.2), row('hard', 'c()', 0.2),
    row('easy', 'old()', 1, 1), row('easy', 'new()', 1, 2), row('outside', 'z', 0.1)];
  const s = selectTraining(rows, { pool: ['hard', 'easy'], exam: ['e'], maxPerProblem: 2, hardPassFraction: 0.5, hardWeight: 2, maxExamples: 100, seed: 1 });
  assert.equal(s.leaked, 1);
  assert.equal(s.problems, 2);
  assert.equal(s.hardProblems, 1);
  assert.deepEqual(s.examples.filter((x) => x.problemId === 'hard').map((x) => x.code), ['a( )', 'a( )', 'b()', 'b()']);
  assert.deepEqual(s.examples.filter((x) => x.problemId === 'easy').map((x) => x.code), ['new()']);
  const capped = selectTraining(rows, { pool: ['hard', 'easy'], exam: ['e'], maxPerProblem: 2, hardPassFraction: 0.5, hardWeight: 2, maxExamples: 3, seed: 1 });
  assert.equal(capped.examples.length, 3);
  assert.ok(capped.examples.every((x) => x.hard), 'hard wins are kept first');
});

test('passAt1 + compareModels: per-problem pass fractions, paired difference with a CI', () => {
  const a = passAt1([{ problemId: 'p1', passed: 2, samples: 10 }, { problemId: 'p2', passed: 5, samples: 10 }, { problemId: 'p3', passed: 0, samples: 10 }]);
  const b = passAt1([{ problemId: 'p1', passed: 6, samples: 10 }, { problemId: 'p2', passed: 9, samples: 10 }, { problemId: 'p3', passed: 4, samples: 10 }]);
  assert.equal(a.get('p2'), 0.5);
  const c = compareModels(a, b, stats);
  assert.equal(c.n, 3);
  assert.ok(Math.abs(c.estimate - 0.4) < 1e-9);
  assert.ok(c.low > 0 && c.significant);
});

test('rsiVerdict: collecting until the primary round; confirmed only if it beats the base AND adds to round 1', () => {
  const spec = { primaryRound: 3 };
  const r = (round, est, low) => ({ round, vsBase: { estimate: est, low, high: est + 0.05 } });
  assert.equal(rsiVerdict(spec, [r(1, 0.02, -0.01)]).status, 'collecting');
  assert.equal(rsiVerdict(spec, [r(1, 0.02, -0.01), r(2, 0.03, 0), r(3, 0.05, 0.01)]).confirmed, true);
  const noCompound = rsiVerdict(spec, [r(1, 0.06, 0.02), r(2, 0.03, 0), r(3, 0.05, 0.01)]);
  assert.equal(noCompound.beatsBase, true);
  assert.equal(noCompound.compounding, false);
  assert.equal(noCompound.confirmed, false);
  assert.equal(rsiVerdict(spec, [r(1, 0.02, -0.01), r(2, 0.03, 0), r(3, 0.05, -0.001)]).confirmed, false);
});

function mockTrack(train, holdout) {
  const tasks = new Map([...train, ...holdout].map((id) => [id, { id, entryPoint: 'f', prompt: 'function f() {\n', vars: { prompt: 'function f() {' } }]));
  return { train, holdout, tasks, templates: { solveUser: '{{prompt}}' }, extractCode: (r) => r, judge: async (code) => ({ type: code.includes('good') ? 'pass' : 'fail' }) };
}

test('searchShard and examShard: search never touches the exam; the exam uses the same seeds for every model', async () => {
  const train = Array.from({ length: 12 }, (_, i) => `t${i}`);
  const track = mockTrack(train, ['h0', 'h1']);
  const c = { ...cfg, rsi: { ...cfg.rsi, evalExtraFromTrain: 2, search: { ...cfg.rsi.search, shards: 1, samples: 3 }, eval: { ...cfg.rsi.eval, shards: 1, samples: 4 } } };
  const asked = [];
  let n = 0;
  const llm = { chat: async (_m, o) => { asked.push(o.meta.problemId); n++; return n % 3 ? 'function f(){ return "good"; }' : 'bad'; } };
  const out = path.join(tmpDir(), 's.jsonl');
  const s = await searchShard(c, { round: 1, shard: 0, model: 'm', out, deps: { track, llm } });
  const split = rsiSplit(train, ['h0', 'h1'], c.rsi);
  assert.equal(s.problems, split.pool.length);
  assert.ok(asked.every((id) => split.pool.includes(id)), 'only search-pool problems are sampled');
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.filter((r) => r.kind === 'stat').length, split.pool.length);
  assert.ok(rows.filter((r) => r.kind === 'solution').every((r) => r.code.includes('good')));

  const seedsBy = {};
  for (const m of ['a', 'b']) {
    seedsBy[m] = [];
    const llm2 = { chat: async (_m, o) => { seedsBy[m].push(`${o.meta.problemId}:${o.seed}:${o.temperature}`); return 'function f(){ return "good"; }'; } };
    const er = await examShard(c, { modelRound: m === 'a' ? 0 : 1, shard: 0, model: m, out: path.join(tmpDir(), `${m}.jsonl`), deps: { track, llm: llm2 } });
    assert.deepEqual(er.map((r) => r.problemId).sort(), split.exam);
  }
  assert.deepEqual(seedsBy.a, seedsBy.b);
});

test('foldRound + report: rounds accumulate, comparisons vs base and previous, verdict line', () => {
  const ex = (m, passes) => passes.map((p, i) => ({ modelRound: m, problemId: `p${i}`, passed: p, samples: 10 }));
  let state = { rounds: [], solutions: [], search: [], exam: [] };
  const search = [{ kind: 'stat', problemId: 'q', passed: 3, samples: 10, passFraction: 0.3, model: 'stock' }, { kind: 'solution', problemId: 'q', code: 'good', passFraction: 0.3, result: 'pass', model: 'stock' }];
  state = foldRound(cfg, state, { round: 1, runId: '1', ts: 't', searchModel: 'stock', searchRows: search, examRows: [...ex(0, [1, 2, 3, 4]), ...ex(1, [2, 3, 4, 5])], manifest: { examples: 5, hardProblems: 1 }, metrics: { lossFirst: 1, lossLast: 0.5, stopped: 'finished' } });
  state = foldRound(cfg, state, { round: 2, runId: '2', ts: 't', searchModel: 'm1', searchRows: search, examRows: ex(2, [3, 4, 5, 6]), manifest: null, metrics: null });
  assert.equal(state.rounds.length, 2);
  assert.equal(state.solutions.length, 2);
  assert.ok(Math.abs(state.rounds[1].vsBase.estimate - 0.2) < 1e-9);
  assert.ok(Math.abs(state.rounds[1].vsPrevious.estimate - 0.1) < 1e-9);
  // re-recording a round replaces it instead of duplicating
  state = foldRound(cfg, state, { round: 2, runId: '2b', ts: 't', searchModel: 'm1', searchRows: search, examRows: ex(2, [3, 4, 5, 6]), manifest: null, metrics: null });
  assert.equal(state.rounds.length, 2);
  assert.equal(state.solutions.length, 2);
  const v = rsiVerdict(cfg.rsi.preregistered, state.rounds);
  const md = rsiReport(cfg, state, v, '');
  assert.match(md, /Status: collecting, 2 of 3 rounds done/);
  assert.match(md, /\| 2 \| 45\.0% \(4\) \|/);
  assert.match(rsiSummaryLine(cfg, state.rounds, v, ''), /round 2 model scores 45\.0%/);
  assert.match(rsiSummaryLine(cfg, [], v, ''), /no round finished yet/);
});

test('rsi workflow: only commit can write; search and exam run with read-only tokens and no persisted credentials', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/rsi.yml'), 'utf8');
  const body = yml.slice(yml.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const marks = [...body.matchAll(/^ {2}([\w-]+):\n/gm)];
  const J = Object.fromEntries(marks.map((m, i) => [m[1], body.slice(m.index, marks[i + 1]?.index ?? body.length)]));
  assert.deepEqual(Object.keys(J), ['plan', 'search', 'train', 'exam', 'record', 'commit', 'next-round']);
  assert.match(yml, /^permissions: \{\}$/m);
  for (const [name, text] of Object.entries(J)) {
    if (name === 'commit') assert.match(text, /contents: write/);
    else assert.doesNotMatch(text, /contents: write/, name);
  }
  for (const j of ['search', 'exam', 'train', 'record']) assert.match(J[j], /persist-credentials: false/, j);
  assert.doesNotMatch(J.commit, /node |npm /, 'the commit job never runs project code');
  assert.match(J['next-round'], /needs\.record\.outputs\.continue == 'true'/);
  assert.match(yml, /group: rsi\n\s+cancel-in-progress: false/);
  // the plan imports the track (npm packages) and must fail loudly, not hand empty outputs to every later job
  assert.match(J.plan, /npm ci --ignore-scripts[\s\S]*set -euo pipefail/);
});
