const { formatSchedule, presentJobs, jobFailure } = require('../automation-main');
const { platformKeepaliveLost } = require('../keepalive-main');

let passed = 0;
function check(condition, label) {
  if (!condition) throw new Error(label);
  passed += 1;
  console.log('  ok ', label);
}

check(formatSchedule({ kind: 'cron', expr: '45 14 * * *' }) === '每天 14:45', 'a daily cron reads as a clock time');
check(formatSchedule({ kind: 'cron', expr: '0 2,6,10,14,18,22 * * *' }) === '每天 02:00、06:00、10:00、14:00、18:00、22:00', 'a comma list of hours stays in order');
check(formatSchedule({ kind: 'cron', expr: '30 19 * * 5' }) === '每周五 19:30', 'a weekday cron names the day');
check(formatSchedule({ kind: 'cron', expr: '0 20 28-31 * *' }) === '每月 28-31 日 20:00', 'a day-of-month range stays visible');
check(formatSchedule({ kind: 'every', everyMs: 21600000 }) === '每 6 小时', 'an interval becomes hours');
check(formatSchedule({ kind: 'at', at: '2026-11-23T03:00:00.000Z' }, () => '11-22 20:00') === '11-22 20:00', 'a one-shot uses the formatted instant');

const rows = presentJobs([
  { id: 'b', agentId: 'nai_pang', name: '乙', schedule: { kind: 'cron', expr: '0 15 * * *' }, state: { lastRunAtMs: 10, lastRunStatus: 'error', lastError: 'boom' } },
  { id: 'a', agentId: 'main', name: '甲', schedule: { kind: 'every', everyMs: 3600000 }, state: { lastRunAtMs: 10, lastRunStatus: 'ok' } },
  { id: 'c', name: '丙', schedule: { kind: 'cron', expr: '0 3 * * *' }, state: {} },
], [{ id: 'main', name: '启孜' }, { id: 'nai_pang', name: '奶胖' }]);
check(rows.map((row) => row.agentName).join(',') === '奶胖,启孜,未指定', 'rows are ordered by agent name');
check(rows[0].lastOk === false && rows[0].lastError === 'boom', 'a failed run is marked for the red dot');
check(rows[1].lastOk === true && rows[1].scheduleLabel === '每小时', 'a successful run keeps its time');
check(rows[2].lastOk === null, 'a job that has never run is neither success nor failure');
check(jobFailure({ state: { lastRunAtMs: 1, lastRunStatus: 'skipped' } }) === false, 'a skip is not a failure');

const lost = { status: { chrome_on: true, paused: false, browser_alive: true, script: { state: 'ok' }, awaiting_login: true, session: { status: 'logged_out' } } };
const missing = { status: { chrome_on: true, paused: false, browser_alive: true, script: { state: 'missing' } } };
const paused = { status: { ...lost.status, paused: true } };
check(platformKeepaliveLost(lost) === true, 'a logged-out platform lights the Keep-alive button');
check(platformKeepaliveLost(missing) === false, 'a missing script does not light the Keep-alive button');
check(platformKeepaliveLost(paused) === false, 'a paused platform does not light the Keep-alive button');

console.log(`automation schedule smoke ok (${passed})`);
