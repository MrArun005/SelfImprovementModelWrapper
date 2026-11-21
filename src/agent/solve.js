import { fill } from '../util.js';
import { retrieveLessons, retrieveSkills } from './retrieve.js';

export function formatLessons(lessons) {
  if (!lessons.length) return '';
  return '## Lessons from past mistakes\n' + lessons.map((l) => `- ${l.text}`).join('\n') + '\n\n';
}

/**
 * Day 2 showed that a shown solution hurt MORE the more similar its problem was (the small model copied it), so a
 * skill is shown with the statement of the problem it solved and a warning to compare before reusing anything.
 */
export function formatSkills(skills, maxChars) {
  if (!skills.length) return '';
  return '## A DIFFERENT problem you solved before\nIt may look similar, but the requirements are not the same. Compare the two statements and only reuse ideas that fit the new problem.\n' +
    skills.map((s) => (s.statement ? `Earlier problem: ${s.statement}\n` : '') + '```javascript\n' + s.code.slice(0, maxChars) + '\n```').join('\n') + '\n\n';
}

/** The statement text of a problem (its comment lines), for showing next to a skill. */
export function statementOf(task, maxChars) {
  const text = task.vars?.prompt ?? task.prompt ?? '';
  return text.split('\n').filter((l) => l.trim().startsWith('//')).map((l) => l.trim().replace(/^\/\/\s?/, '')).join(' ').slice(0, maxChars);
}

export function buildMessages({ systemPrompt, userTemplate, problem, lessons, skills, cfg }) {
  const user = fill(userTemplate, {
    ...(problem.vars ?? { prompt: problem.prompt.trimEnd() }),
    lessons: formatLessons(lessons),
    skills: formatSkills(skills, cfg.agent.maxSkillChars),
  });
  return [{ role: 'system', content: systemPrompt.trim() }, { role: 'user', content: user }];
}

/** Pull the code out of a model reply. Falls back to treating the reply as the function body. */
export function extractCode(text, problem) {
  const fences = [...String(text).matchAll(/```[\w-]*[ \t]*\n([\s\S]*?)(?:```|$)/g)].map((m) => m[1]);
  const ep = problem.entryPoint;
  const defines = (c) => new RegExp(`function\\s+${ep}\\s*\\(|(?:const|let|var)\\s+${ep}\\s*=`).test(c);
  let code = fences.find(defines) ?? fences[0] ?? String(text);
  if (!defines(code)) code = `${problem.prompt}${code}\n}`;
  return code.trim() + '\n';
}

/**
 * One solve attempt. `memory` = { systemPrompt, lessons, skills } visible to this attempt.
 * @returns {Promise<{code, reply, messages, usedLessons, usedSkills, usage}>}
 */
export async function solve({ llm, problem, memory, templates, cfg, temperature, seed, reserve, extract = extractCode, feedback = null }) {
  // pinned lessons (a provisional lesson being verified on its own problem) always come first
  const pinned = memory.pinnedLessons ?? [];
  const usedLessons = [...pinned, ...retrieveLessons(problem, memory.lessons, cfg).filter((l) => !pinned.includes(l))].slice(0, Math.max(cfg.agent.lessonsTopK, pinned.length));
  const usedSkills = retrieveSkills(problem, memory.skills, cfg);
  const messages = buildMessages({ systemPrompt: memory.systemPrompt, userTemplate: templates.solveUser, problem, lessons: usedLessons, skills: usedSkills, cfg });
  // self-repair: show the previous failing attempt and the feedback it got
  if (feedback) messages[1].content += fill(templates.repair, { code: feedback.code.trimEnd(), output: feedback.output.slice(0, cfg.agent.repairOutputChars), feedbackLabel: feedback.label });
  const reply = await llm.chat(messages, { temperature, seed, reserve, meta: { kind: 'solve', problemId: problem.id } });
  return { code: extract(reply, problem), reply, messages, usedLessons, usedSkills, usage: { ...(llm.lastUsage ?? { tokensIn: 0, tokensOut: 0 }) } };
}
