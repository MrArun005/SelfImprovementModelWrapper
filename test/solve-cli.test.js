// The product entry point: complete a function stub with the champion's memory and levers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { solveStub, stubToTask } from '../src/solve-cli.js';
import { loadConfig, ROOT } from '../src/config.js';
import { scriptedLLM } from './helpers.js';

const STUB = fs.readFileSync(new URL('../examples/below_zero.js', import.meta.url), 'utf8');
const GOOD = 'function below_zero(operations){ let b = 0; for (const o of operations) { b += o; if (b < 0) return true; } return false; }';
const BAD = 'function below_zero(operations){ return false; }';

test('stub parsing: signature, entry point, empty-body form, errors', () => {
  assert.equal(stubToTask(STUB).entryPoint, 'below_zero');
  assert.equal(stubToTask('// add\nfunction add(a, b) {}\n').prompt, '// add\nfunction add(a, b) {\n');
  assert.throws(() => stubToTask('// nothing here'), /signature/);
});

test('sample + filter keeps the candidate that passes the stub\'s examples', async () => {
  const cfg = loadConfig({ env: {} });
  let n = 0;
  const llm = scriptedLLM(() => '```javascript\n' + (n++ === 0 ? BAD : GOOD) + '\n```');
  const r = await solveStub({ cfg, stub: STUB, variant: 'sample-filter', llm });
  assert.equal(r.examplesPass, true);
  assert.equal(r.examples, 2);
  assert.match(r.code, /b < 0/);
  assert.equal(r.samples, 2);
});

test('without examples the answer is returned unchecked', async () => {
  const cfg = loadConfig({ env: {} });
  const r = await solveStub({ cfg, stub: '// add two numbers\nfunction add(a, b){\n', variant: 'full', llm: scriptedLLM(() => '```javascript\nfunction add(a,b){return a+b}\n```') });
  assert.equal(r.examplesPass, null);
  assert.equal(r.requests, 1);
});

test('`npm run solve -- --mock` works end to end from the CLI', () => {
  const out = execFileSync(process.execPath, ['src/solve-cli.js', 'examples/below_zero.js', '--mock'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out.toString(), /function below_zero/);
});
