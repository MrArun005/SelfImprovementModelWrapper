// Expert iteration (variant `finetune`): dataset selection never leaks holdout problems, the variant switches
// to the fine-tuned model name, and the workflow keeps the training job read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT } from '../src/config.js';
import { variantConfig, variantBudget } from '../src/variants.js';
import { selectSolutions, completionFor } from '../src/finetune/prepare.js';
import { finetuneRow } from '../src/finetune/record.js';

const cfg = loadConfig({ env: {} });
const row = (problemId, code, ts, variant = 'lessons', result = 'pass') => ({ problemId, code, ts, variant, result });
const opts = (o = {}) => ({ train: new Set(['a', 'b', 'c']), holdout: new Set(['h']), maxPerProblem: 2, maxExamples: 100, seed: 1, ...o });

test('selectSolutions: passing train solutions only; holdout rows are excluded and counted', () => {
  const rows = [row('a', 'x', '1'), row('h', 'y', '2'), row('b', 'z', '3', 'full', 'fail'), row('zz', 'q', '4')];
  const { picked, excludedHoldout, notTrain } = selectSolutions(rows, opts());
  assert.deepEqual(picked.map((p) => p.problemId), ['a']);
  assert.equal(excludedHoldout, 1);
  assert.equal(notTrain, 1);
});

test('selectSolutions: distinct solutions per problem up to the cap, earliest first; whitespace-only duplicates dropped', () => {
  const rows = [row('a', 'f( )', '3'), row('a', 'f()', '1'), row('a', 'g()', '2'), row('a', 'h()', '4'), row('a', 'f(  )', '5')];
  const { picked } = selectSolutions(rows, opts());
  assert.deepEqual(picked.map((p) => p.code), ['f()', 'g()']);
});

test('selectSolutions: maxExamples caps the set deterministically', () => {
  const rows = ['a', 'b', 'c'].map((id, i) => row(id, `c${i}`, String(i)));
  const one = selectSolutions(rows, opts({ maxExamples: 2 })).picked;
  assert.equal(one.length, 2);
  assert.deepEqual(one, selectSolutions(rows, opts({ maxExamples: 2 })).picked);
});

test('completion is one fenced code block, the format the agent is asked for', () => {
  const c = completionFor('function f(){}\n\n', cfg.finetune.completionFence);
  assert.match(c, /^```javascript\nfunction f\(\)\{\}\n```$/);
});

test('finetune variant: same track and budget unit as the others, served under the fine-tuned model name', () => {
  const vc = variantConfig(cfg, 'finetune');
  assert.equal(vc.variant.levers.finetune, true);
  assert.equal(vc.llm.model, cfg.finetune.ollamaModel);
  assert.equal(variantConfig(cfg, 'baseline').llm.model, cfg.llm.model);
  assert.equal(variantBudget(cfg, 'finetune').requestsPerRun, variantBudget(cfg, 'baseline').requestsPerRun);
  assert.equal(variantConfig(cfg, 'finetune-base').llm.model, cfg.finetune.baseOllamaModel);
  assert.notEqual(cfg.finetune.baseOllamaModel, cfg.finetune.ollamaModel);
});

test('fine-tuned and reference models go through the same convert + quantize steps', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/improve.yml'), 'utf8');
  assert.match(yml, /build "\$RUNNER_TEMP\/ft\/\$MERGED_DIR"/);
  assert.match(yml, /build "\$HOME\/\.sic-hf\/\$BASE_REVISION"/);
  assert.match(yml, /"\$L\/bin\/\$TOOL" "\$2\.full" "\$2" "\$QUANT"/);
  assert.doesNotMatch(yml, /^\s*ADAPTER |create --quantize/m);
});

test('record row keeps the manifest and the training metrics', () => {
  const r = finetuneRow({ examples: 3 }, { steps: 1 }, 't');
  assert.deepEqual(r, { ts: 't', examples: 3, train: { steps: 1 } });
});

test('workflow: the fine-tuning job is read-only, never runs a model server, and other variants do not depend on it succeeding', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/improve.yml'), 'utf8');
  const job = yml.split(/\n  finetune:\n/)[1].split(/\n  improve:\n/)[0];
  assert.match(job, /contents: read/);
  assert.match(job, /persist-credentials: false/);
  assert.doesNotMatch(job, /contents: write|ollama serve|src\/run\.js/);
  assert.match(yml, /needs: \[plan, finetune\]\n {4}if: \$\{\{ !cancelled\(\)/);
});

test('trainer reads every setting from the generated settings file (no literals)', () => {
  const py = fs.readFileSync(path.join(ROOT, 'tools/finetune/train.py'), 'utf8');
  for (const k of Object.keys(cfg.finetune.train)) if (k !== 'threads') assert.match(py, new RegExp(`s\\["${k}"\\]|s\\.get\\("${k}"\\)`), k);
  assert.doesNotMatch(py, /Qwen|huggingface\.co|https?:\/\//);
});

test('base model files are pinned by SHA-256 and fetched through the mirror script', () => {
  for (const [f, sha] of Object.entries(cfg.finetune.baseFiles)) assert.match(sha, /^[0-9a-f]{64}$/, f);
  assert.ok(cfg.finetune.baseMirrors.length >= 2, 'a fallback mirror');
  const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/improve.yml'), 'utf8');
  assert.match(yml, /run: bash tools\/finetune\/fetch-base\.sh/);
  assert.match(fs.readFileSync(path.join(ROOT, 'tools/finetune/fetch-base.sh'), 'utf8'), /sha256sum -c/);
});
