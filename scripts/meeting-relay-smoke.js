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

if (process.exitCode) {
  console.error('\nmeeting-relay-smoke FAILED');
  process.exit(1);
}
console.log('\nmeeting-relay-smoke OK');
