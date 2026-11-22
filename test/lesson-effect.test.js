// Observational lesson effect: excludes the lesson's own problem and compares within the runs it was used in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonEffects } from '../src/analysis.js';

const a = (runId, problemId, result, lessonIds = [], ts = '2') => ({ phase: 'train', runId, problemId, result, lessonIds, ts });

test('lessonEffects: with vs without in the same runs, born problem excluded, min uses enforced', () => {
  const vs = {
    traces: [{ lessonCreated: 'L1', problemId: 'born', ts: '1' }],
    attempts: [
      a('r1', 'born', 'pass', ['L1']), // pinned retry on its own problem: excluded
      a('r1', 'p1', 'pass', ['L1']), a('r1', 'p2', 'pass', ['L1']), a('r1', 'p3', 'fail', ['L1']),
      a('r1', 'q1', 'fail'), a('r1', 'q2', 'fail'), a('r1', 'q3', 'pass'),
      a('r2', 'q4', 'pass'), // a run where L1 was never retrieved: not comparable
      a('r1', 'p0', 'pass', ['L1'], '0'), // before the lesson existed: excluded
    ],
  };
  const [e] = lessonEffects(vs, 3);
  assert.equal(e.id, 'L1');
  assert.equal(e.uses, 3);
  assert.equal(e.comparable, 3);
  assert.ok(Math.abs(e.effect - (2 / 3 - 1 / 3)) < 1e-9);
  assert.deepEqual(lessonEffects(vs, 4), []);
});
