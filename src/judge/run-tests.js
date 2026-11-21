// Runs untrusted, LLM-written code against unit tests in a child `node` process.
// - fresh temp dir per attempt, deleted afterwards
// - empty environment (no tokens), cwd = temp dir
// - Node permission model (fs reads limited to the temp dir, no fs writes, no child processes/workers)
// - hard timeout that kills the whole process group, capped captured output
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const RESULT = Object.freeze({ PASS: 'pass', FAIL: 'fail', ERROR: 'error', TIMEOUT: 'timeout' });

/** Tests in their own block so their `const assert` never clashes with the solution's. */
export function wrapTests(tests) {
  return `;{\n${tests}\n}\n`;
}

/** Kept for callers that want the old single-file form (e.g. debugging); the judge uses the harness below. */
export function buildProgram(code, tests) {
  return `${code}\n\n${wrapTests(tests)}`;
}

/**
 * Harness that runs solution then tests in one realm, but defends the verdict against the solution:
 * - node:assert (and assert.strict) are frozen before the solution runs, so it cannot replace their checks;
 * - process.exit / reallyExit / abort throw, so the solution cannot end the process "successfully" early;
 * - a random marker is printed only after the last test statement ran; PASS needs exit 0 AND the marker.
 * Residual risk (documented): code that reads this harness file from disk could learn the marker.
 */
export function harnessSource(marker) {
  return `'use strict';
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');
for (const o of [assert, assert.strict]) Object.freeze(o);
const write = process.stdout.write.bind(process.stdout);
const blocked = (what) => () => { throw new Error(what + ' is not allowed in a solution'); };
process.exit = blocked('process.exit()');
process.reallyExit = blocked('process.reallyExit()');
process.abort = blocked('process.abort()');
globalThis.require = require;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'solution.js'), 'utf8'), { filename: 'solution.js' });
vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'tests.js'), 'utf8'), { filename: 'tests.js' });
write('\\n' + ${JSON.stringify(marker)} + '\\n');
`;
}

function permissionFlags(dir) {
  // Node >= 22.13 / 23.5: --permission. Older 20.x/22.x: --experimental-permission.
  const [maj, min] = process.versions.node.split('.').map(Number);
  // allow-number: Node releases that renamed the flag (22.13 / 23.5) are facts, not tunables
  const flag = maj > 23 || (maj === 23 && min >= 5) || (maj === 22 && min >= 13) ? '--permission' : '--experimental-permission'; // allow-number: Node versions
  return [flag, `--allow-fs-read=${dir}`];
}

/**
 * pass / timeout / fail (a test assertion failed: judge.failPatterns) / error (anything else).
 * `completed` (when given) must also be true for a pass: the tests verifiably ran to the end.
 */
export function classify({ code, signal, timedOut, output, completed = true }, failPatterns) {
  if (timedOut) return RESULT.TIMEOUT;
  if (code === 0 && !signal && completed) return RESULT.PASS;
  if (failPatterns.some((p) => new RegExp(p, 'm').test(output))) return RESULT.FAIL;
  return RESULT.ERROR;
}

/**
 * @returns {Promise<{type: string, output: string, durationMs: number}>}
 */
export async function runTests(code, tests, judgeCfg) {
  const dir = fs.mkdtempSync(path.join(judgeCfg.tmpRoot || os.tmpdir(), 'sic-judge-'));
  const marker = `SIC-DONE-${crypto.randomBytes(judgeCfg.markerBytes).toString('hex')}`;
  fs.writeFileSync(path.join(dir, 'solution.js'), code);
  fs.writeFileSync(path.join(dir, 'tests.js'), wrapTests(tests));
  const entry = path.join(dir, 'harness.cjs');
  fs.writeFileSync(entry, harnessSource(marker));
  try {
    return await runNode({ dir, entry, judgeCfg, completion: { marker } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run `node <entry>` sandboxed: cwd = dir, empty env, permission model with reads allowed only in `dir`
 * (+ `extraReadDirs`), process-group kill on timeout, capped output. The caller owns `dir`.
 */
/**
 * `completion` decides whether the tests verifiably finished: { marker } (a line the harness prints at the end, which
 * is then stripped from the output) or { check(output) -> boolean } (e.g. a TAP summary with every test passing).
 */
export function runNode({ dir, entry, judgeCfg, extraReadDirs = [], timeoutMs = judgeCfg.timeoutMs, completion = null }) {
  const { maxOutputBytes, maxMemoryMb, useNodePermissionModel, failPatterns } = judgeCfg;
  const perm = useNodePermissionModel ? [...permissionFlags(dir), ...extraReadDirs.map((d) => `--allow-fs-read=${d}`)] : [];
  const args = [`--max-old-space-size=${maxMemoryMb}`, ...perm, entry];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: dir, env: {}, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let bytes = 0;
    const take = (which) => (chunk) => {
      if (bytes >= maxOutputBytes) return;
      const s = chunk.toString('utf8').slice(0, maxOutputBytes - bytes);
      bytes += Buffer.byteLength(s);
      if (which === 'out') out += s; else err += s;
    };
    child.stdout.on('data', take('out'));
    child.stderr.on('data', take('err'));
    let timedOut = false;
    const killTree = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);
    child.on('error', (e) => { err += `spawn error: ${e.message}`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      killTree(); // reap any stragglers in the group
      const combined = [out, err].filter(Boolean).join('\n');
      let completed = true;
      let shown = combined;
      if (completion?.marker) {
        completed = combined.split('\n').some((l) => l.trim() === completion.marker);
        shown = combined.split('\n').filter((l) => l.trim() !== completion.marker).join('\n');
        if (code === 0 && !signal && !timedOut && !completed) shown += '\nError: the program exited before the tests finished';
      } else if (completion?.check) {
        completed = completion.check(combined);
        if (code === 0 && !signal && !timedOut && !completed) shown += '\nError: the test run did not report every test as passed';
      }
      const type = classify({ code, signal, timedOut, output: shown, completed }, failPatterns);
      const drop = (judgeCfg.dropOutputLinePatterns ?? []).map((p) => new RegExp(p));
      const cleaned = shown.split('\n').filter((l) => !drop.some((re) => re.test(l))).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      const output = (timedOut ? `Timed out after ${timeoutMs} ms\n` : '') + cleaned;
      resolve({ type, output: output.replace(new RegExp(escapeRe(dir), 'g'), '<tmp>'), durationMs: Date.now() - started });
    });
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
