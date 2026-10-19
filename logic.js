// GENERATED from shared/logic.js by build.py. Edit the source, not this copy.
// Pure habit logic. Single source of truth: build.py copies this to gas/Logic.gs and web/logic.js.
// Runs in Apps Script (V8), browsers and tests. No Date.now / time zones: callers pass 'YYYY-MM-DD' and 'HH:MM'.
//
// Task: {id, name, dim, freq, param, slot, remind, active, link, since, cls ('必做'|'加分'), tierUp, tierDown, options[]}
// Log:  {date, taskId, tier, minutes, note}

var COUNT_FREQS = ['weekly_n', 'monthly_n', 'quarterly_n'];
var MIN_FREQS = ['weekly_min', 'monthly_min'];
var OVERALL_THRESHOLD = 0.8;
var LOOKBACK_DAYS = 400;
var LOOKBACK_PERIODS = 60;

var SLOTS = [
  { key: 'morning', at: '07:30', until: '12:00' },
  { key: 'noon', at: '12:00', until: '21:00' },
  { key: 'evening', at: '21:00', until: '22:30' },
  { key: 'followup', at: '22:30', until: '24:00' }
];

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function toDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  if (!m) throw new Error('日期不正確：' + s);
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('日期不正確：' + s);
  return d;
}

function fmtDate_(d) {
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function addDays(s, n) {
  var d = toDate_(s);
  d.setUTCDate(d.getUTCDate() + n);
  return fmtDate_(d);
}

// 1 = Monday ... 7 = Sunday
function weekdayOf(s) {
  var w = toDate_(s).getUTCDay();
  return w === 0 ? 7 : w;
}

function daysBetween(a, b) {
  return Math.round((toDate_(b) - toDate_(a)) / 86400000);
}

function monthKey(s) { return String(s).slice(0, 7); }

function quarterKey(s) {
  var d = toDate_(s);
  return d.getUTCFullYear() + '-Q' + (Math.floor(d.getUTCMonth() / 3) + 1);
}

function isLastDayOfMonth(s) {
  return toDate_(addDays(s, 1)).getUTCDate() === 1;
}

function isQuarterStart(s) {
  var d = toDate_(s);
  return d.getUTCDate() === 1 && d.getUTCMonth() % 3 === 0;
}

function isCountFreq(freq) { return COUNT_FREQS.indexOf(freq) >= 0; }
function isMinFreq(freq) { return MIN_FREQS.indexOf(freq) >= 0; }
// Accumulating tasks (N times or N minutes per period) live in their own list, not the daily checklist.
function isAccumFreq(freq) { return isCountFreq(freq) || isMinFreq(freq); }
function isBonus(task) { return task.cls === '加分'; }

var DIM_ICONS = { '健康': '💪', '財商': '💰', '學習': '📖', '情緒': '💭', '工作': '💼', '娛樂': '🎮' };
var ICON_RULES = [
  [/跑/, '🏃'], [/飯後|散步/, '🚶'], [/飯前/, '🤸'], [/步/, '👟'], [/水/, '💧'], [/睡|就寢/, '😴'], [/保養/, '🧴'],
  [/拉筋|伸展/, '🙆'], [/瑜珈/, '🧘'], [/死蟲|臀/, '🏋️'], [/push|ab roll|伏地|重訓|蹲/i, '💪'],
  [/記帳|帳/, '💰'], [/日記|寫/, '✍️'], [/讀|書/, '📖']
];

// Emoji shown for a task: the one it was given, else a guess from its name, else its dimension's.
function iconOf(task) {
  if (task.icon) return task.icon;
  for (var i = 0; i < ICON_RULES.length; i++) if (ICON_RULES[i][0].test(task.name || '')) return ICON_RULES[i][1];
  return DIM_ICONS[task.dim] || '✅';
}

// The period [start, end] an accumulating task is measured over, around date s.
function periodRange(freq, s) {
  var d = toDate_(s), y = d.getUTCFullYear(), m = d.getUTCMonth();
  var base = { weekly_min: 'weekly_n', monthly_min: 'monthly_n' }[freq] || freq;
  if (base === 'weekly_n') {
    var start = addDays(s, -(weekdayOf(s) - 1));
    return { start: start, end: addDays(start, 6) };
  }
  if (base === 'monthly_n') {
    return { start: fmtDate_(new Date(Date.UTC(y, m, 1))), end: fmtDate_(new Date(Date.UTC(y, m + 1, 0))) };
  }
  if (base === 'quarterly_n') {
    var q = Math.floor(m / 3) * 3;
    return { start: fmtDate_(new Date(Date.UTC(y, q, 1))), end: fmtDate_(new Date(Date.UTC(y, q + 3, 0))) };
  }
  throw new Error('不是累計型頻率：' + freq);
}

// logs -> lookup. 'date|id' = checked, 'm|date|id' = minutes, 't|…' = tier, 'n|…' = note. leave -> lookup set.
function indexLogs(logs) {
  var idx = {};
  for (var i = 0; i < logs.length; i++) {
    var l = logs[i], k = l.date + '|' + l.taskId;
    idx[k] = true;
    idx['m|' + k] = Number(l.minutes) || 0;
    idx['t|' + k] = l.tier || '標準';
    idx['n|' + k] = l.note || '';
  }
  return idx;
}

function indexLeave(days) {
  var set = {};
  for (var i = 0; i < days.length; i++) set[days[i]] = true;
  return set;
}

function isDone(task, date, idx) { return idx[date + '|' + task.id] === true; }
function minutesOn(task, date, idx) { return idx['m|' + date + '|' + task.id] || 0; }
function tierOn(task, date, idx) { return isDone(task, date, idx) ? idx['t|' + date + '|' + task.id] : ''; }
function noteOn(task, date, idx) { return idx['n|' + date + '|' + task.id] || ''; }

function weekdaysOf_(task) {
  return String(task.param).split(',').map(function (x) { return parseInt(x, 10); });
}

function targetOf(task) {
  var n = parseInt(task.param, 10);
  return n > 0 ? n : 1;
}

// Is a fixed task on the calendar for this day? Accumulating tasks are flexible, so always "scheduled".
function isScheduled(task, date) {
  if (!task.active) return false;
  if (task.since && date < task.since) return false;
  if (task.freq === 'daily') return true;
  if (task.freq === 'weekdays') return weekdaysOf_(task).indexOf(weekdayOf(date)) >= 0;
  return isAccumFreq(task.freq);
}

// Days checked (count tasks) or minutes logged (minute tasks) inside [start, end].
function periodTotal(task, idx, start, end) {
  var n = 0;
  for (var d = start; d <= end; d = addDays(d, 1)) {
    if (!isDone(task, d, idx)) continue;
    n += isMinFreq(task.freq) ? minutesOn(task, d, idx) : 1;
  }
  return n;
}

function progress(task, date, idx) {
  var r = periodRange(task.freq, date);
  return { done: periodTotal(task, idx, r.start, r.end), target: targetOf(task), start: r.start, end: r.end };
}

// Daily-checklist membership: fixed tasks scheduled today.
function isDue(task, date, idx) {
  if (!isScheduled(task, date)) return false;
  if (!isAccumFreq(task.freq)) return true;
  if (isDone(task, date, idx)) return true;
  var p = progress(task, date, idx);
  return p.done < p.target;
}

// Nag only for 必做 tasks: fixed ones always; accumulating ones once the remaining days are too few.
function needsReminder(task, date, idx) {
  if (isBonus(task) || !task.remind || !isDue(task, date, idx)) return false;
  if (!isAccumFreq(task.freq)) return !isDone(task, date, idx);
  var p = progress(task, date, idx);
  var left = p.target - p.done, daysLeft = daysBetween(date, p.end) + 1;
  if (left <= 0) return false;
  if (isMinFreq(task.freq)) return daysLeft <= 2 && !isDone(task, date, idx);
  return left >= daysLeft && !isDone(task, date, idx);
}

function isFixedMust_(t) { return !isAccumFreq(t.freq) && !isBonus(t); }

// Completion rate of 必做 fixed tasks for one day. Leave days and days with nothing scheduled have rate null.
function dayStats(tasks, date, idx, leave) {
  if (leave[date]) return { leave: true, due: 0, done: 0, rate: null };
  var due = 0, done = 0;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!isFixedMust_(t) || !isScheduled(t, date)) continue;
    due++;
    if (isDone(t, date, idx)) done++;
  }
  return { leave: false, due: due, done: done, rate: due ? done / due : null };
}

function bonusStats(tasks, date, idx) {
  var due = 0, done = 0;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!isBonus(t) || isAccumFreq(t.freq) || !isScheduled(t, date)) continue;
    due++;
    if (isDone(t, date, idx)) done++;
  }
  return { due: due, done: done };
}

function taskStreak(task, date, idx, leave) {
  var n = 0, i;
  if (isAccumFreq(task.freq)) {
    var cur = date;
    for (i = 0; i < LOOKBACK_PERIODS; i++) {
      var r = periodRange(task.freq, cur);
      var met = periodTotal(task, idx, r.start, r.end) >= targetOf(task);
      if (met) n++;
      else if (i > 0) break;
      cur = addDays(r.start, -1);
    }
    return n;
  }
  var d = date;
  if (isScheduled(task, d) && !leave[d] && !isDone(task, d, idx)) d = addDays(d, -1);
  for (i = 0; i < LOOKBACK_DAYS; i++, d = addDays(d, -1)) {
    if (leave[d] || !isScheduled(task, d)) continue;
    if (isDone(task, d, idx)) n++;
    else break;
  }
  return n;
}

function overallStreak(tasks, date, idx, leave) {
  var n = 0, d = date;
  var today = dayStats(tasks, d, idx, leave);
  if (today.rate !== null && today.rate < OVERALL_THRESHOLD) d = addDays(d, -1);
  for (var i = 0; i < LOOKBACK_DAYS; i++, d = addDays(d, -1)) {
    var s = dayStats(tasks, d, idx, leave);
    if (s.rate === null) continue;
    if (s.rate >= OVERALL_THRESHOLD) n++;
    else break;
  }
  return n;
}

// Per-dimension completion of 必做 fixed tasks over [start, min(end, today)].
function dimensionRates(tasks, start, end, today, idx, leave) {
  var out = {}, last = end < today ? end : today;
  for (var d = start; d <= last; d = addDays(d, 1)) {
    if (leave[d]) continue;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!isFixedMust_(t) || !isScheduled(t, d)) continue;
      var o = out[t.dim] || (out[t.dim] = { due: 0, done: 0, rate: null });
      o.due++;
      if (isDone(t, d, idx)) o.done++;
    }
  }
  for (var k in out) out[k].rate = out[k].due ? out[k].done / out[k].due : null;
  return out;
}

function dailyRates(tasks, start, end, idx, leave) {
  var out = [];
  for (var d = start; d <= end; d = addDays(d, 1)) out.push({ date: d, rate: dayStats(tasks, d, idx, leave).rate });
  return out;
}

// Extras for a period: how many 進階 days, how many 加分 check-ins, and how often each picked option was done.
function periodExtras(tasks, logs, start, end) {
  var byId = {}, i;
  for (i = 0; i < tasks.length; i++) byId[tasks[i].id] = tasks[i];
  var out = { advanced: 0, bonus: 0, options: {} };
  for (i = 0; i < logs.length; i++) {
    var l = logs[i], t = byId[l.taskId];
    if (l.date < start || l.date > end || !t) continue;
    if (l.tier === '進階') out.advanced++;
    if (isBonus(t) && !isAccumFreq(t.freq)) out.bonus++;
    if (l.note) l.note.split('、').forEach(function (o) { if (o) out.options[o] = (out.options[o] || 0) + 1; });
  }
  return out;
}

// ---- Telegram reminders ----

// sent: {morning: true, ...} for today. Returns {send: slotKey|null, tasks: [...], bonus: n}.
function decideReminder(date, hhmm, sent, tasks, idx, leave) {
  if (leave[date]) return { send: null, tasks: [], bonus: 0 };
  var pending = tasks.filter(function (t) { return needsReminder(t, date, idx); });
  var bonusLeft = bonusStats(tasks, date, idx);
  for (var i = 0; i < SLOTS.length; i++) {
    var s = SLOTS[i];
    if (hhmm < s.at || hhmm >= s.until || sent[s.key]) continue;
    var list = pending;
    if (s.key === 'noon') list = pending.filter(function (t) { return t.slot === '早' || t.slot === '午'; });
    if (!list.length) return { send: null, tasks: [], bonus: 0 };
    return { send: s.key, tasks: list, bonus: s.key === 'evening' ? bonusLeft.due - bonusLeft.done : 0 };
  }
  return { send: null, tasks: [], bonus: 0 };
}

var SLOT_TITLES = {
  morning: '☀️ 今日必做',
  noon: '🌤 午間提醒，還沒做',
  evening: '🌙 今晚還沒做',
  followup: '⏰ 補提醒，還沒做'
};

function buildReminderText(slot, tasks, appUrl, bonus) {
  var lines = [SLOT_TITLES[slot] + '（' + tasks.length + '）'];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    lines.push('• ' + (t.icon ? t.icon + ' ' : '') + t.name + (t.slot && t.slot !== '不限' ? '（' + t.slot + '）' : ''));
  }
  if (bonus > 0) lines.push('還有 ' + bonus + ' 項加分');
  if (appUrl) lines.push(appUrl);
  return lines.join('\n');
}

// Inline buttons: a plain task can be ticked from Telegram; tasks that need choices open the app instead.
function buildReminderKeyboard(tasks, date, appUrl) {
  var rows = [];
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i], plain = !isAccumFreq(t.freq) && !(t.options && t.options.length);
    var label = (t.icon ? t.icon + ' ' : '') + t.name;
    if (plain) rows.push([{ text: '✓ ' + label, callback_data: 'c|' + t.id + '|' + date }]);
    else if (appUrl) rows.push([{ text: label + ' →', url: appUrl }]);
  }
  return rows;
}

// One periodic message per tick: quarter start (also covers month plan) > month plan > month report.
function decidePeriodic(date, hhmm, sent) {
  if (isQuarterStart(date) && hhmm >= '08:05' && !sent[date + '|quarterPlan']) return 'quarterPlan';
  if (toDate_(date).getUTCDate() === 1 && !isQuarterStart(date) && hhmm >= '08:00' && !sent[date + '|monthPlan']) return 'monthPlan';
  if (isLastDayOfMonth(date) && hhmm >= '20:00' && !sent[date + '|monthReport']) return 'monthReport';
  return null;
}

function buildMonthReport(tasks, date, idx, leave, logs) {
  var start = monthKey(date) + '-01';
  var rates = dimensionRates(tasks, start, date, date, idx, leave);
  var lines = ['📊 ' + monthKey(date) + ' 月統計（必做）'];
  for (var k in rates) lines.push(k + '：' + Math.round(rates[k].rate * 100) + '%（' + rates[k].done + '/' + rates[k].due + '）');
  tasks.forEach(function (t) {
    if (t.active && (t.freq === 'monthly_n' || t.freq === 'monthly_min')) {
      var p = progress(t, date, idx);
      lines.push(t.name + '：' + p.done + '/' + p.target + (isMinFreq(t.freq) ? ' 分' : ''));
    }
  });
  if (logs) {
    var x = periodExtras(tasks, logs, start, date);
    lines.push('進階 ' + x.advanced + ' 次・加分 ' + x.bonus + ' 次');
  }
  return lines.join('\n');
}

function buildPlanText(kind, date, goals) {
  var title = kind === 'quarterPlan' ? '🗓 新的一季開始，做季規劃：' + quarterKey(date) : '📅 新的一月開始，做月規劃：' + monthKey(date);
  var lines = [title];
  var key = kind === 'quarterPlan' ? quarterKey(date) : monthKey(date);
  (goals || []).forEach(function (g) { if (g.period === key && !g.done) lines.push('• ' + g.name); });
  return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    addDays: addDays, weekdayOf: weekdayOf, daysBetween: daysBetween, monthKey: monthKey, quarterKey: quarterKey,
    isLastDayOfMonth: isLastDayOfMonth, isQuarterStart: isQuarterStart, periodRange: periodRange, indexLogs: indexLogs,
    indexLeave: indexLeave, isScheduled: isScheduled, isDue: isDue, progress: progress, needsReminder: needsReminder,
    dayStats: dayStats, bonusStats: bonusStats, taskStreak: taskStreak, overallStreak: overallStreak,
    dimensionRates: dimensionRates, dailyRates: dailyRates, periodExtras: periodExtras, decideReminder: decideReminder,
    buildReminderText: buildReminderText, buildReminderKeyboard: buildReminderKeyboard, decidePeriodic: decidePeriodic,
    buildMonthReport: buildMonthReport, buildPlanText: buildPlanText, minutesOn: minutesOn, tierOn: tierOn, iconOf: iconOf, SLOTS: SLOTS
  };
}
