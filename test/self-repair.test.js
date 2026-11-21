// Self-repair lever: on train the model sees its failing code + the real test output; on holdout it may
// only use the worked examples from the problem statement, never the hidden grading tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractExamples, publicTestSource } from '../src/agent/public-tests.js';
import { runTests } from '../src/judge/run-tests.js';
import { runCycle } from '../src/run.js';
import { loadConfig } from '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { testConfig, writeSplit, scriptedLLM, tmpDir } from './helpers.js';

const judge = loadConfig({ env: {} }).judge;
const PROMPT = '// Return true if the balance ever drops below zero.\n// >>> below_zero([1, 2, 3])\n// false\n// >>> below_zero([1, 2, -4, 5])\n// true\nfunction below_zero(operations){\n';

test('worked examples are extracted from the problem statement', () => {
  assert.deepEqual(extractExamples(PROMPT, 'below_zero'), [
    { call: 'below_zero([1, 2, 3])', expected: 'false' },
    { call: 'below_zero([1, 2, -4, 5])', expected: 'true' },
  ]);
  assert.deepEqual(extractExamples('// no examples\nfunction f(x){\n', 'f'), []);
  assert.equal(publicTestSource('// >>> f(1\n// 2\nfunction f(x){\n', 'f', 2022), null); // unparsable example -> no public tests
});

test('public tests pass a correct solution and report every failing example for a wrong one', async () => {
  const src = publicTestSource(PROMPT, 'below_zero', 2022);
  const good = 'function below_zero(ops){ let b = 0; for (const o of ops) { b += o; if (b < 0) return true; } return false; }';
  assert.equal((await runTests(good, src, judge)).type, 'pass');
  const bad = await runTests('function below_zero(ops){ return false; }', src, judge);
  assert.equal(bad.type, 'fail');
  assert.match(bad.output, /below_zero\(\[1, 2, -4, 5\]\) should be true but was false/);
});

const SR = [{ name: 'self-repair', label: 'Self-repair', track: 'multipl-e', levers: { selfRepair: true }, budgetShare: 1, color: '#000' }];
const HIDDEN_MARKER = 'HIDDEN-TEST-MARKER-8231';
const problems = [
  { id: 'tr', entryPoint: 'tr', prompt: '// add one\nfunction tr(x){\n', tests: `const assert = require('node:assert'); /* ${HIDDEN_MARKER} */ assert.deepEqual(tr(1), 2);`, mock: { correct: 'function tr(x){ return x + 1; }', buggy: 'function tr(x){ return x; }' } },
  { id: 'ho', entryPoint: 'ho', prompt: '// double\n// >>> ho(2)\n// 4\nfunction ho(x){\n', tests: `const assert = require('node:assert'); assert.deepEqual(ho(3), 6, '${HIDDEN_MARKER}');`, mock: { correct: 'function ho(x){ return x * 2; }', buggy: 'function ho(x){ return x * 3; }' } },
];

/** Config whose fixture dataset is exactly `problems`. */
function cfgWith(extra) {
  const file = path.join(tmpDir(), 'problems.json');
  fs.writeFileSync(file, JSON.stringify(problems));
  return testConfig({ ...extra, dataset: { useFixture: true, fixturePath: file } });
}

function llmThatRepairs() {
  // wrong first, right once it is shown its previous failing attempt
  return scriptedLLM((meta, messages) => {
    const p = problems.find((x) => x.id === meta.problemId);
    const repaired = messages[1].content.includes('Your previous attempt failed');
    return '```javascript\n' + (repaired ? p.mock.correct : p.mock.buggy) + '\n```';
  });
}

test('train: the second attempt sees the first attempt and its real test output', async () => {
  const cfg = cfgWith({ variants: SR, defaultVariant: 'self-repair', gate: { baselineRuns: 0 } });
  writeSplit(cfg, ['tr'], ['ho']);
  const llm = llmThatRepairs();
  const s = await runCycle({ cfg, deps: { llm } });
  const train = llm.calls.filter((c) => c.meta.problemId === 'tr');
  assert.equal(train.length, 2);
  assert.doesNotMatch(train[0].messages[1].content, /previous attempt failed/);
  assert.match(train[1].messages[1].content, /Your previous attempt failed[\s\S]*return x;[\s\S]*Test output/);
  assert.equal(s.train.passed, 1);
});

test('holdout: repair feedback comes only from the statement\'s examples, never from the hidden tests', async () => {
  const cfg = cfgWith({ variants: SR, defaultVariant: 'self-repair', gate: { baselineRuns: 1 } });
  writeSplit(cfg, ['tr'], ['ho']);
  const llm = llmThatRepairs();
  const s = await runCycle({ cfg, deps: { llm } });
  const evalCalls = llm.calls.filter((c) => c.meta.problemId === 'ho');
  assert.ok(evalCalls.length >= 2, 'a repair happened on holdout');
  for (const c of evalCalls) assert.ok(!c.messages.map((m) => m.content).join('\n').includes(HIDDEN_MARKER), 'hidden test text leaked into a holdout prompt');
  assert.match(evalCalls[1].messages[1].content, /Results on the examples from the problem statement[\s\S]*ho\(2\) should be 4 but was 6/);
  assert.equal(s.champion.passRate, 1); // repaired using the public example, then passed the hidden test
});

test('without the lever there is no repair, on train or holdout', async () => {
  const cfg = cfgWith({ gate: { baselineRuns: 1 } });
  writeSplit(cfg, ['tr'], ['ho']);
  const llm = llmThatRepairs();
  await runCycle({ cfg, deps: { llm } });
  assert.ok(llm.calls.every((c) => !c.messages[1].content.includes('previous attempt failed')));
});

// ---- sample-and-filter ----
import { planEval, trainSeed } from '../src/run.js';
import { variantConfig } from '../src/variants.js';

const SF = [{ name: 'sample-filter', label: 'Sample + filter', track: 'multipl-e', levers: { sampleFilter: true }, budgetShare: 1, color: '#000' }];

test('sample-and-filter keeps the first candidate that passes the statement\'s examples (holdout), hidden tests unseen', async () => {
  const cfg = cfgWith({ variants: SF, defaultVariant: 'sample-filter', gate: { baselineRuns: 1 }, agent: { samples: 3 } });
  writeSplit(cfg, ['tr'], ['ho']);
  const seenSeeds = [];
  const llm = scriptedLLM((meta, messages) => {
    const p = problems.find((x) => x.id === meta.problemId);
    return '```javascript\n' + p.mock.buggy + '\n```';
  });
  // wrap to answer correctly on the 2nd distinct seed for 'ho'
  const wrapped = { ...llm, async chat(m, o = {}) {
    if (o.meta?.problemId === 'ho') { seenSeeds.push(o.seed); const k = seenSeeds.filter((s) => s === o.seed).length; const idx = [...new Set(seenSeeds)].indexOf(o.seed);
      llm.calls.push({ messages: m, ...o }); const p = problems[1]; return '```javascript\n' + (idx % 3 === 1 ? p.mock.correct : p.mock.buggy) + '\n```'; }
    return llm.chat(m, o);
  } };
  const s = await runCycle({ cfg, deps: { llm: wrapped } });
  const ho = llm.calls.filter((c) => c.meta?.problemId === 'ho');
  assert.ok(new Set(ho.map((c) => c.seed)).size >= 2, 'samples use different seeds');
  for (const c of ho) assert.ok(!c.messages.map((m) => m.content).join('\n').includes(HIDDEN_MARKER));
  assert.equal(s.champion.passRate, 1, 'the passing sample was kept and passed the hidden test');
});

test('train retries use different sampling seeds (no copies of the previous attempt)', () => {
  const cfg = loadConfig({ env: {} });
  assert.notEqual(trainSeed(cfg, 1, 'p', 1), trainSeed(cfg, 1, 'p', 2));
  assert.notEqual(trainSeed(cfg, 1, 'p', 1), trainSeed(cfg, 2, 'p', 1));
  assert.equal(trainSeed(cfg, 3, 'q', 2), trainSeed(cfg, 3, 'q', 2));
});

test('eval planning charges extra only where public examples exist', () => {
  const cfg = variantConfig(loadConfig({ env: {} }), 'sample-filter');
  const holdout = Array.from({ length: 10 }, (_, i) => `p${i}`);
  const withExamples = new Set(['p0', 'p1']);
  const cost = (id) => (withExamples.has(id) ? cfg.agent.samples : 1);
  const full = 8 * 1 + 2 * cfg.agent.samples; // total worst-case cost of one pass over all 10
  assert.equal(planEval(holdout, full * cfg.eval.repeats, 1, cfg, cost).ids.length, 10);
  assert.ok(planEval(holdout, (full - 1) * cfg.eval.repeats, 1, cfg, cost).ids.length < 10);
});

test('extra samples are drawn hotter than the first (diverse candidates for the filter)', async () => {
  const { attemptWithChecks } = await import('../src/agent/attempt.js');
  const cfg = loadConfig({ env: {} });
  const temps = [];
  const llm = { lastUsage: { tokensIn: 1, tokensOut: 1 }, async chat(m, o) { temps.push(o.temperature); return '```javascript\nfunction ho(x){ return x * 3; }\n```'; } };
  const problem = problems[1];
  const publicTests = (await import('../src/agent/public-tests.js')).publicTestSource(problem.prompt, problem.entryPoint, 2022);
  await attemptWithChecks({ llm, problem, memory: { systemPrompt: 'S', lessons: [], skills: [] }, templates: { solveUser: '{{prompt}}', repair: '' },
    cfg, temperature: 0.2, seed: 1, reserve: 0, publicTests, samples: 3, repairs: 0 });
  assert.equal(temps.length, 3);
  assert.equal(temps[0], 0.2);
  assert.ok(temps.slice(1).every((t) => t === cfg.agent.sampleTemperature));
});
