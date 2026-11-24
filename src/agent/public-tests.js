// "Public tests" = the worked examples written in a problem statement, e.g.
//   // >>> below_zero([1, 2, -4, 5])
//   // true
// They are part of the prompt the model already sees, so using them as feedback during holdout evaluation is
// honest. The hidden grading tests are never used as feedback on holdout problems.
import * as acorn from 'acorn';

function isExpression(src) {
  try {
    const node = acorn.parseExpressionAt(src, 0, { ecmaVersion: 'latest' });
    return node.end === src.trimEnd().length;
  } catch { return false; }
}

/** Parse `// >>> call` + the following `// expected` comment line. Examples that aren't valid JS are skipped. */
export function extractExamples(prompt, entryPoint) {
  const lines = prompt.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*\/\/\s*>>>\s*(.+)$/);
    if (!m) continue;
    const call = m[1].trim();
    // the expected value is the next comment line; anything after it (explanations, "# ..." notes) is prose
    const e = (lines[i + 1] ?? '').match(/^\s*\/\/\s?(.*)$/);
    const expected = e && !/^\s*>>>/.test(e[1]) ? e[1].trim() : '';
    if (call.startsWith(`${entryPoint}(`) && expected && isExpression(call) && isExpression(expected)) out.push({ call, expected });
  }
  return out;
}

/** A node:assert test script that checks every example and reports all failures; null if none or unparsable. */
export function publicTestSource(prompt, entryPoint, ecmaVersion) {
  const ex = extractExamples(prompt, entryPoint);
  if (!ex.length) return null;
  const cases = ex.map((e) => `  [${JSON.stringify(e.call)}, () => (${e.call}), () => (${e.expected})]`).join(',\n');
  const src = `const assert = require('node:assert');
const failures = [];
for (const [label, actual, expected] of [
${cases}
]) {
  let a;
  try { a = actual(); assert.deepEqual(a, expected()); }
  catch (e) { failures.push(label + ' should be ' + JSON.stringify(expected()) + ' but was ' + (e && e.code === 'ERR_ASSERTION' ? JSON.stringify(a) : String(e))); }
}
if (failures.length) throw new assert.AssertionError({ message: 'Examples from the problem statement failed:\\n' + failures.join('\\n') });
`;
  try { acorn.parse(src, { ecmaVersion, sourceType: 'script' }); } catch { return null; }
  return src;
}

/**
 * Model-written examples (same "// >>> call" + "// expected" format) as a script that never throws: it prints how
 * many examples a candidate passes, so candidates can be ranked by it. The examples may themselves be wrong, which is
 * why they only rank candidates and never decide pass/fail.
 */
export const SELF_TESTS_TAG = 'SELF_TESTS_PASSED';
export function selfTestSource(examples, ecmaVersion) {
  if (!examples.length) return null;
  const cases = examples.map((e) => `  [() => (${e.call}), () => (${e.expected})]`).join(',\n');
  const src = `const assert = require('node:assert');
let passed = 0;
for (const [actual, expected] of [
${cases}
]) {
  try { assert.deepEqual(actual(), expected()); passed++; } catch {}
}
console.log('${SELF_TESTS_TAG} ' + passed);
`;
  try { acorn.parse(src, { ecmaVersion, sourceType: 'script' }); } catch { return null; }
  return src;
}

export function selfTestsPassed(output) {
  const m = String(output ?? '').match(new RegExp(`${SELF_TESTS_TAG} (\\d+)`));
  return m ? Number(m[1]) : 0;
}
