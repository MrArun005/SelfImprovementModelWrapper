// Guards the workflow's security and safety wiring (text checks; actionlint covers syntax):
// untrusted code only runs where the token is read-only, smoke runs never commit, and the optional
// Pages deploy can't turn a successful training run into a failed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const yml = fs.readFileSync(path.join(ROOT, '.github/workflows/improve.yml'), 'utf8');

/** Top-level jobs as { name: text } (jobs are 2-space indented keys under `jobs:`). */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const out = {};
  const re = /^ {2}([\w-]+):\n/gm;
  const marks = [...body.matchAll(re)];
  marks.forEach((m, i) => { out[m[1]] = body.slice(m.index, marks[i + 1]?.index ?? body.length); });
  return out;
}
const J = jobs(yml);

test('jobs exist', () => {
  assert.deepEqual(Object.keys(J), ['plan', 'finetune', 'explore', 'improve', 'aggregate', 'commit', 'pages']);
});

test('only the commit job can write to the repo; jobs that run model-written code are read-only', () => {
  assert.match(yml, /^permissions: \{\}$/m);
  for (const [name, text] of Object.entries(J)) {
    if (name === 'commit') assert.match(text, /contents: write/);
    else assert.doesNotMatch(text, /contents: write/, name);
  }
  assert.match(J.improve, /contents: read/);
  assert.match(J.improve, /persist-credentials: false/);
  assert.match(J.aggregate, /persist-credentials: false/);
  assert.doesNotMatch(J.commit, /node |npm /, 'the commit job never runs project code');
});

test('smoke runs never reach aggregate, commit or pages', () => {
  assert.match(J.aggregate, /if: \$\{\{ !cancelled\(\) && !inputs\.smoke && needs\.plan\.outputs\.due == 'true' \}\}/);
  assert.match(J.commit, /needs: aggregate/);
  assert.match(J.commit, /needs\.aggregate\.result == 'success'/);
  assert.match(J.pages, /needs: \[aggregate, commit\]/);
  assert.match(J.pages, /needs\.aggregate\.result == 'success'/);
});

test('the optional Pages deploy cannot fail a successful run, and says why it did not deploy', () => {
  assert.match(J.pages, /id: deploy\n\s+continue-on-error: true/);
  assert.match(J.pages, /if: steps\.deploy\.outcome == 'failure'[\s\S]*::warning::/);
});

test('model setup retries, fails fast with a clear error, and proves the model answers', () => {
  const setup = fs.readFileSync(path.join(ROOT, 'tools/ci/ollama-setup.sh'), 'utf8');
  assert.match(J.improve, /run: bash tools\/ci\/ollama-setup\.sh/);
  assert.match(setup, /retry download \|\| fail/);
  assert.match(setup, /retry "\$HOME\/\.sic-ollama\/bin\/ollama" pull "\$MODEL" \|\| fail/);
  assert.match(setup, /\[ "\$ready" = 1 \] \|\| fail/);
  assert.match(setup, /api\/generate[\s\S]*fail "model \$MODEL did not answer a warm-up request"/);
});

test('backup cron times exist and a once-per-day guard gates training and publishing', () => {
  assert.ok((yml.match(/^ {4}- cron: '/gm) ?? []).length >= 2, 'at least one backup schedule');
  assert.match(J.plan, /node src\/ci\/due\.js >> "\$GITHUB_OUTPUT"/);
  assert.match(J.improve, /if: \$\{\{ !cancelled\(\) && needs\.plan\.outputs\.due == 'true' \}\}/);
  assert.match(J.finetune, /needs\.plan\.outputs\.due == 'true'/);
  assert.match(J.aggregate, /needs\.plan\.outputs\.due == 'true'/);
});
