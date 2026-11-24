// Self-tests lever: model-written examples rank the candidates; statement examples come first; never decide pass/fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { variantConfig } from '../src/variants.js';
import { selfTestSource, selfTestsPassed, extractExamples } from '../src/agent/public-tests.js';
import { attemptWithChecks, attemptCost } from '../src/agent/attempt.js';
import { runTests } from '../src/judge/run-tests.js';

const cfg = loadConfig({ env: {} });

test('selfTestSource counts passing examples and never throws', async () => {
  const ex = extractExamples('// >>> f(1)\n// 2\n// >>> f(2)\n// 4\n// >>> f(3)\n// 7', 'f');
  const src = selfTestSource(ex, cfg.curriculum.ecmaVersion);
  const r = await runTests('function f(x) { return 2 * x; }\n', src, cfg.judge);
  assert.equal(r.type, 'pass');
  assert.equal(selfTestsPassed(r.output), 2);
  assert.equal(selfTestSource([], cfg.curriculum.ecmaVersion), null);
});

test('attemptWithChecks with selfTests: draws every sample and keeps the one passing the most self-written examples', async () => {
  const replies = [
    '```javascript\nfunction f(x) { return x; }\n```',          // wrong
    '```javascript\nfunction f(x) { return 2 * x; }\n```',      // right
    '```javascript\nfunction f(x) { return x + 1; }\n```',      // wrong
    '// >>> f(1)\n// 2\n// >>> f(5)\n// 10\n// >>> f(0)\n// 0',  // the self-written examples
  ];
  let i = 0;
  const llm = { lastUsage: { tokensIn: 1, tokensOut: 1 }, chat: async () => replies[i++] };
  const problem = { id: 'p', entryPoint: 'f', prompt: '// doubles x\nfunction f(x) {\n', vars: { prompt: '// doubles x\nfunction f(x) {' } };
  const templates = { solveUser: '{{prompt}}', selfTests: '{{prompt}} {{count}} {{entryPoint}}', repair: '' };
  const vc = variantConfig(cfg, 'sample-filter-tests');
  const a = await attemptWithChecks({ llm, problem, memory: { systemPrompt: 's', lessons: [], skills: [] }, templates, cfg: vc, temperature: 0, seed: 1, reserve: 0,
    extract: (r) => r.match(/```javascript\n([\s\S]*?)```/)[1], publicTests: null, samples: 3, selfTests: true });
  assert.equal(a.samplesDrawn, 3);
  assert.equal(a.requests, 4);
  assert.equal(a.selfTestCount, 3);
  assert.match(a.res.code, /2 \* x/);
  assert.equal(attemptCost(vc, false, 'eval'), vc.agent.samples + 1);
});
