#!/usr/bin/env node
/**
 * 会议 relay 决策 smoke test（不连 Gateway、不跑 Agent）
 *
 *   npm run test:meeting-relay
 *
 * 验证 findNextMention：最终总结阶段不应因派活里的 @ 再 relay 议事 Agent。
 */
const { findNextMention } = require('../meeting-group');
const {
  hasClosingModeratorMessage,
  extractMeetingFinalSummaryText,
  buildMeetingRequirementSections,
  buildModeratorBriefingMessage,
  buildModeratorSpeakNowMessage,
  buildParticipantGroupPrompt,
} = require('../meeting-protocol');
const {
  parseMeetingRequirementSections,
  buildMeetingPresetMarkdown,
  presetFromMarkdown,
  unsavedMeetingParameters,
} = require('../meeting-preset-doc');

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

function relay(messages, roundCount = 1, options) {
  const processed = new Set();
  return findNextMention(messages, roster, processed, MOD, roundCount, options);
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

runCase('往期主题：同一轮驳回重选应再 relay 该 agent', () => {
  const messages = [
    mod('@nai_pang 请发言'),
    participant('nai_pang', '首选银轨小学'),
    mod('@nai_pang 往期主题重复，请重选'),
  ];
  const pending = relay(messages, 2, { noRepeatPastTopics: true });
  assertEqual(pending, 'nai_pang');
  if (!pending?.repick) throw new Error('expected repick');
});

runCase('往期主题：未写往期主题重复时，同一轮第二次 @ 仍不 relay', () => {
  const messages = [
    mod('@nai_pang 请发言'),
    participant('nai_pang', '首选银轨小学'),
    mod('@nai_pang 请再补充'),
  ];
  assertEqual(relay(messages, 2, { noRepeatPastTopics: true }), null);
});

runCase('往期主题：已经叫回过一次后不再 relay', () => {
  const messages = [
    mod('@nai_pang 请发言'),
    { ...participant('nai_pang', '首选银轨小学'), excludeFromRound: true },
    participant('nai_pang', '改选莱文'),
    mod('@nai_pang 往期主题重复，请重选'),
  ];
  assertEqual(relay(messages, 2, { noRepeatPastTopics: true }), null);
});

runCase('往期主题：开场规则与 @ 不在同一行，仍 relay 第一位', () => {
  const pending = relay([
    mod('往期主题重复则要求重选\n@nai_pang 请发言'),
  ], 2, { noRepeatPastTopics: true });
  assertEqual(pending, 'nai_pang');
  if (pending?.repick) throw new Error('opening dispatch is not a repick');
});

runCase('最终总结原文取收尾，不取第一轮共识', () => {
  const text = extractMeetingFinalSummaryText({
    moderatorAgentId: MOD,
    transcript: [
      mod('**共识**\n首选银轨小学'),
      mod('**最终总结**\n定为莱文\nmeeting adjourned'),
    ],
  });
  if (!text.includes('莱文')) throw new Error(`missing final pick: ${text}`);
  if (text.includes('银轨')) throw new Error(`picked round summary: ${text}`);
});

runCase('会议要求：当轮总结与最终总结各写一遍', () => {
  const body = buildMeetingRequirementSections();
  const ban = (body.match(/逐人复述谁说了什么/g) || []).length;
  if (ban !== 2) throw new Error(`禁止行出现 ${ban} 次，应为 2`);
  const roundHeading = (body.match(/\*\*当轮总结 = 只写结论/g) || []).length;
  const finalHeading = (body.match(/\*\*最终总结 = 只写结论/g) || []).length;
  if (roundHeading !== 1 || finalHeading !== 1) {
    throw new Error(`总结块重复：当轮 ${roundHeading}，最终 ${finalHeading}`);
  }
  if (body.includes('先读报告')) throw new Error('未填阅读报告时不应要求先读');
});

runCase('阅读报告写进主持与议事要求', () => {
  const path = '/srv/reports/weekly.md';
  const body = buildMeetingRequirementSections(path);
  for (const title of ['主持启动任务书', '主持过程中的要求', '议事发言要求']) {
    const chunk = (body.split(`## ${title}\n`)[1] || '').split('\n## ')[0];
    if (!chunk.includes('先读报告（硬约束）')) throw new Error(`${title} 缺少强制阅读`);
    if (!chunk.includes(path)) throw new Error(`${title} 缺少路径`);
    if (!chunk.includes('未读完全文不得发言')) throw new Error(`${title} 缺少未读完不得发言`);
  }
  if (!body.includes('## 阅读报告')) throw new Error('缺少阅读报告章节');
  const parsed = parseMeetingRequirementSections(`---\ntopic: "t"\n---\n${body}`);
  if (!parsed.ok) throw new Error(parsed.error || '解析失败');
  const count = (parsed.sections['主持启动任务书'].match(/先读报告（硬约束）/g) || []).length;
  if (count !== 1) throw new Error(`强制阅读被写了 ${count} 次`);
});

runCase('开会时不把文件里没有的阅读报告临时补上', () => {
  const body = buildMeetingRequirementSections();
  const parsed = parseMeetingRequirementSections(`---\ntopic: "t"\n---\n${body}`);
  if (!parsed.ok) throw new Error(parsed.error || '解析失败');
  const path = '/srv/reports/old.md';
  const message = buildModeratorBriefingMessage({
    topic: 't',
    draft: '底稿',
    goal: '',
    readingReport: path,
    moderator: { agentId: 'qi_zi', label: '启孜' },
    participants: [{ agentId: 'mo_bao', label: '墨宝' }],
    requirements: parsed.sections,
  });
  if (message.includes('先读报告') || message.includes(path)) {
    throw new Error('未写入文件的阅读报告被临时拼进了任务书');
  }
  const savedBody = buildMeetingRequirementSections(path);
  const saved = parseMeetingRequirementSections(`---\ntopic: "t"\n---\n${savedBody}`);
  if (!saved.ok) throw new Error(saved.error || '解析失败');
  const fromFile = buildModeratorBriefingMessage({
    topic: 't',
    draft: '底稿',
    readingReport: '',
    moderator: { agentId: 'qi_zi', label: '启孜' },
    participants: [{ agentId: 'mo_bao', label: '墨宝' }],
    requirements: saved.sections,
  });
  if (!fromFile.includes('未读完全文不得发言') || !fromFile.includes(path)) {
    throw new Error('已保存的强制阅读没有随任务书原文发出');
  }
  const participant = buildParticipantGroupPrompt({
    topic: 't',
    draft: '底稿',
    agentId: 'mo_bao',
    agentLabel: '墨宝',
    instruction: '请发言',
    transcript: '',
    groupSessionKey: 'agent:mo_bao:a2a:qizi-x',
    readingReport: '',
    requirements: saved.sections,
  });
  if (!participant.includes('未读完全文不得发言') || !participant.includes(path)) {
    throw new Error('已保存的强制阅读没有随议事要求原文发出');
  }
});

runCase('会议参数完整写入 OpenClaw 文件并可读回', () => {
  const draft = '## 素材标题\n## 篇幅与收尾\n这是底稿里的标题，不是会议要求';
  const markdown = buildMeetingPresetMarkdown({
    topic: '口播',
    goal: '改口径',
    draft,
    readingReport: '/srv/reports/weekly.md',
    moderatorAgentId: 'qi_zi',
    moderatorLabel: '启孜',
    participantAgentIds: ['mo_bao'],
    participantLabels: ['墨宝'],
    postMeetingExecAgentId: 'nai_pang',
    postMeetingExecLabel: '奶胖',
    roundCount: 2,
    noRepeatPastTopics: true,
    savedAtMs: Date.parse('2026-10-27T00:00:00.000Z'),
  });
  for (const line of [
    '议题：口播',
    '期望结论方向：改口径',
    '阅读报告：/srv/reports/weekly.md',
    '主持：启孜（qi_zi）',
    '墨宝（mo_bao），派发时写 @mo_bao，不要写 @墨宝',
    '会后接收：奶胖（nai_pang）',
    '讨论轮次：2',
    '不可与近 7 天旧题重复：是',
    '未读完全文不得发言',
    draft,
  ]) {
    if (!markdown.includes(line)) throw new Error(`文件缺少：${line}`);
  }
  const preset = presetFromMarkdown(markdown, 'mtest');
  if (!preset) throw new Error('文件无法读回');
  if (preset.draft !== draft) throw new Error('讨论底稿没有原样读回');
  if (preset.participantLabels[0] !== '墨宝') throw new Error('议事名字没有读回');
  if (preset.postMeetingExecLabel !== '奶胖') throw new Error('会后接收人名字没有读回');
  if (preset.readingReport !== '/srv/reports/weekly.md') throw new Error('阅读报告没有读回');
  const parsed = parseMeetingRequirementSections(markdown);
  if (!parsed.ok) throw new Error(parsed.error || '底稿里的标题冲掉了会议要求');
  if (parsed.sections['篇幅与收尾'].includes('这是底稿里的标题')) {
    throw new Error('底稿标题覆盖了正式的篇幅与收尾');
  }
  const empty = buildMeetingPresetMarkdown({
    topic: '空参数',
    moderatorAgentId: 'qi_zi',
    participantAgentIds: ['mo_bao'],
    roundCount: 2,
  });
  if (!empty.includes('阅读报告：无') || !empty.includes('期望结论方向：无') || !empty.includes('会后接收：无')) {
    throw new Error('空参数被省略了');
  }
});

runCase('开始会议临时附上本次底稿和已保存底稿', () => {
  const message = buildModeratorBriefingMessage({
    topic: 't',
    draft: '今天的新素材',
    savedDraft: '上次保存的底稿',
    moderator: { agentId: 'qi_zi', label: '启孜' },
    participants: [{ agentId: 'mo_bao', label: '墨宝' }],
    requirements: parseMeetingRequirementSections(`---\ntopic: "t"\n---\n${buildMeetingRequirementSections()}`).sections,
  });
  if (!message.includes('## 本次讨论底稿') || !message.includes('今天的新素材')) {
    throw new Error('本次底稿没有附上');
  }
  if (!message.includes('## 已保存的讨论底稿') || !message.includes('上次保存的底稿')) {
    throw new Error('已保存的底稿没有附上');
  }
  const same = buildModeratorBriefingMessage({
    topic: 't',
    draft: '同一份',
    savedDraft: '同一份',
    moderator: { agentId: 'qi_zi', label: '启孜' },
    participants: [{ agentId: 'mo_bao', label: '墨宝' }],
    requirements: parseMeetingRequirementSections(`---\ntopic: "t"\n---\n${buildMeetingRequirementSections()}`).sections,
  });
  if (same.includes('## 已保存的讨论底稿')) throw new Error('相同底稿被附了两遍');
});

runCase('任务书要求主持立刻开口，不要先查系统', () => {
  const message = buildModeratorBriefingMessage({
    topic: 't',
    draft: '底稿',
    moderator: { agentId: 'qi_zi', label: '启孜' },
    participants: [{ agentId: 'mo_bao', label: '墨宝' }],
    requirements: parseMeetingRequirementSections(`---\ntopic: "t"\n---\n${buildMeetingRequirementSections()}`).sections,
  });
  if (!message.includes('不要调用 exec')) throw new Error('任务书没有禁止工具');
  if (!message.includes('不要先调用工具')) throw new Error('任务书结尾没有要求立刻开口');
  if (message.includes('先读报告')) throw new Error('没填阅读报告时不应出现先读报告');
  const nudge = buildModeratorSpeakNowMessage([{ agentId: 'mo_bao', label: '墨宝' }]);
  if (!nudge.includes('@mo_bao') || !nudge.includes('不要再调用任何工具')) {
    throw new Error('口头提醒没有指向第一位议事');
  }
});

runCase('只有和已保存文件不一致时才算临时会议', () => {
  const preset = {
    goal: '改口径',
    readingReport: '',
    moderatorAgentId: 'qi_zi',
    postMeetingExecAgentId: '',
    roundCount: 2,
    noRepeatPastTopics: false,
    participantAgentIds: ['mo_bao'],
  };
  const form = {
    goal: '改口径',
    readingReport: '',
    moderatorAgentId: 'qi_zi',
    postMeetingExecAgentId: '',
    roundCount: 2,
    noRepeatPastTopics: false,
    participantAgentIds: ['mo_bao'],
    draft: '这次的新底稿',
  };
  if (unsavedMeetingParameters(form, preset).length !== 0) {
    throw new Error('底稿不同不应要求重存');
  }
  const drifted = unsavedMeetingParameters({ ...form, goal: '另一方向' }, preset);
  if (!drifted.includes('期望结论方向')) throw new Error(`未发现改过的参数：${drifted.join(',')}`);
});

if (process.exitCode) {
  console.error('\nmeeting-relay-smoke FAILED');
  process.exit(1);
}
console.log('\nmeeting-relay-smoke OK');
