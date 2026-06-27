#!/usr/bin/env node
/**
 * 会议 relay 决策 smoke test（不连 Gateway、不跑 Agent）
 *
 *   npm run test:meeting-relay
 *
 * 验证 findNextMention：最终总结阶段不应因派活里的 @ 再 relay 议事 Agent。
 */
const { findNextMention } = require('../meeting-group');
const { hasClosingModeratorMessage } = require('../meeting-protocol');

const MOD = 'qi_zi';
const roster = [
  { agentId: 'nai_pang', label: '奈胖' },
  { agentId: 'mo_bao', label: '墨宝' },
];

function mod(text) {
  return { who: 'me', speakerAgentId: MOD, text, speakerLabel: '启孜' };
}

function participant(agentId, text) {
  return { who: 'them', speakerAgentId: agentId, text };
}

function runCase(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  }
}

function assertEqual(actual, expected, detail) {
  const a = actual == null ? null : actual.agentId;
  const e = expected == null ? null : expected;
  if (a !== e) {
    throw new Error(`${detail || 'relay target'}: expected ${e}, got ${a}`);
  }
}

function relay(messages, roundCount = 1) {
  const processed = new Set();
  return findNextMention(messages, roster, processed, MOD, roundCount);
}

// 一轮制、两人各发言一次 → 进入最终总结阶段
const finalPhasePrefix = [
  mod('@nai_pang 请按底稿论述'),
  participant('nai_pang', '奈胖观点'),
  mod('@mo_bao 请补充'),
  participant('mo_bao', '墨宝观点'),
];

runCase('议事阶段：主持 @ 应触发 relay', () => {
  const pending = relay([mod('@nai_pang 请发言')], 1);
  assertEqual(pending, 'nai_pang');
});

runCase('最终阶段：派活 @ 不得 relay（死循环根因）', () => {
  const messages = [
    ...finalPhasePrefix,
    mod([
      '**结论** 采用方案 A',
      '**派活** @mo_bao 会后整理文档',
      'meeting adjourned',
    ].join('\n')),
  ];
  assertEqual(relay(messages, 1), null);
});

runCase('最终阶段：adjourn 不在末行时 @ 仍不得 relay', () => {
  const messages = [
    ...finalPhasePrefix,
    mod([
      'meeting adjourned',
      '',
      '**派活** @mo_bao 请执行',
    ].join('\n')),
  ];
  assertEqual(relay(messages, 1), null);
});

runCase('最终阶段：只有 @ 派活、无 adjourn，仍不得 relay', () => {
  const messages = [
    ...finalPhasePrefix,
    mod('**派活** @nai_pang 跟进出包'),
  ];
  assertEqual(relay(messages, 1), null);
});

runCase('收尾口令：末行 meeting adjourned 应被识别', () => {
  const messages = [
    ...finalPhasePrefix,
    mod('**结论** ok\nmeeting adjourned'),
  ];
  if (!hasClosingModeratorMessage(messages, MOD)) {
    throw new Error('hasClosingModeratorMessage should be true');
  }
  assertEqual(relay(messages, 1), null);
});

runCase('正文解释口令、末行 adjourn：应识别收尾（非 relay）', () => {
  const messages = [
    ...finalPhasePrefix,
    mod([
      '按硬约束：末行 meeting adjourned，收尾勿 @ 任何人',
      '**结论** 采用方案 A',
      '**派活** mo_bao 会后整理',
      'meeting adjourned',
    ].join('\n')),
  ];
  if (!hasClosingModeratorMessage(messages, MOD)) {
    throw new Error('hasClosingModeratorMessage should be true when adjourn is last line only');
  }
  assertEqual(relay(messages, 1), null);
});

runCase('idle 场景：全员轮次已满、末行 adjourn，speechMode 应为 final_summary', () => {
  const { resolveModeratorSpeechMode } = require('../meeting-protocol');
  const messages = [
    ...finalPhasePrefix,
    mod('**派活** mo_bao 落地\nmeeting adjourned'),
  ];
  const mode = resolveModeratorSpeechMode(messages, roster, MOD, 1);
  if (mode.kind !== 'final_summary') {
    throw new Error(`expected final_summary, got ${mode.kind}`);
  }
});

function addFullRound(messages, roundLabel) {
  messages.push(mod(`@nai_pang 第${roundLabel}轮`));
  messages.push(participant('nai_pang', `奈胖 R${roundLabel}`));
  messages.push(mod(`@mo_bao 第${roundLabel}轮`));
  messages.push(participant('mo_bao', `墨宝 R${roundLabel}`));
}

runCase('第3轮：nai_pang 已发言后主持再 @ 同一人不得 relay', () => {
  const messages = [];
  addFullRound(messages, 1);
  addFullRound(messages, 2);
  messages.push(mod('@nai_pang 第3轮'));
  messages.push(participant('nai_pang', '奈胖 R3'));
  messages.push(mod('@nai_pang 请再补充'));
  assertEqual(relay(messages, 3), null);
});

runCase('第3轮：nai_pang 已发言后 @mo_bao 仍应 relay', () => {
  const messages = [];
  addFullRound(messages, 1);
  addFullRound(messages, 2);
  messages.push(mod('@nai_pang 第3轮'));
  messages.push(participant('nai_pang', '奈胖 R3'));
  messages.push(mod('@mo_bao 第3轮'));
  assertEqual(relay(messages, 3), 'mo_bao');
});

runCase('nudge 提示：第3轮 nai_pang 已发言后不得标为尚未发言', () => {
  const { buildModeratorContinuePrompt } = require('../meeting-protocol');
  const messages = [];
  addFullRound(messages, 1);
  addFullRound(messages, 2);
  messages.push(mod('@nai_pang 第3轮'));
  messages.push(participant('nai_pang', '奈胖 R3'));
  messages.push(mod('收到，请继续'));
  const prompt = buildModeratorContinuePrompt({
    transcript: '(略)',
    lastSpeakerLabel: '奈胖',
    roster,
    messages,
    roundCount: 3,
    moderatorAgentId: MOD,
  });
  if (/尚未发言：.*nai_pang/.test(prompt)) {
    throw new Error('nai_pang should not appear in 尚未发言 after speaking in round 3');
  }
  if (!prompt.includes('尚未发言：墨宝 (@mo_bao)')) {
    throw new Error('mo_bao should be the only remaining speaker in round 3');
  }
});

runCase('轮末：全员同步发言后应提示作当轮总结（非全员尚未发言）', () => {
  const { buildModeratorContinuePrompt } = require('../meeting-protocol');
  const messages = [];
  addFullRound(messages, 1);
  messages.push(mod('收到'));
  const prompt = buildModeratorContinuePrompt({
    transcript: '(略)',
    lastSpeakerLabel: '墨宝',
    roster,
    messages,
    roundCount: 3,
    moderatorAgentId: MOD,
  });
  if (prompt.includes('尚未发言：')) {
    throw new Error('after round 1 complete, should not list 尚未发言 for everyone');
  }
  if (!prompt.includes('所有议事 Agent 已各发言一次')) {
    throw new Error('should prompt round summary when round segment is complete');
  }
});

if (process.exitCode) {
  console.error('\nmeeting-relay-smoke FAILED');
  process.exit(1);
}
console.log('\nmeeting-relay-smoke OK');
