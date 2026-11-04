// GENERATED from shared/logic.js, game.js, insights.js, ledger.js, todos.js, dreams.js, diet.js and history.js by build.py. Edit the sources, not this copy.
// Pure habit logic. Single source of truth: build.py copies this to gas/Logic.gs and web/logic.js.
// Runs in Apps Script (V8), browsers and tests. No Date.now / time zones: callers pass 'YYYY-MM-DD' and 'HH:MM'.
//
// Task: {id, name, dim, freq, param, slot, remind, active, link, since, cls ('必做'|'加分'), tierUp, tierDown, options[]}
// Log:  {date, taskId, tier, minutes, note}

var COUNT_FREQS = ['weekly_n', 'monthly_n', 'quarterly_n'];
var MIN_FREQS = ['weekly_min', 'monthly_min'];
var OVERALL_THRESHOLD = 0.8;
var GRACE_DAYS = 2;   // a day left unfinished is only "missed" once it is more than this many days old: late entries are fine
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
// exempts: [{date, taskId}] days on which a 免責券 waived that task; they are looked up as 'x|date|id'.
// extras: {low: [dates marked 低能量日], core: [task ids that still count on a low-energy day]}; looked up as 'low|date' and 'core|id'.
function indexLogs(logs, exempts, extras) {
  var idx = {};
  for (var x = 0; x < (exempts || []).length; x++) idx['x|' + exempts[x].date + '|' + exempts[x].taskId] = true;
  var ex = extras || {}, j;
  for (j = 0; j < (ex.low || []).length; j++) idx['low|' + ex.low[j]] = true;
  for (j = 0; j < (ex.core || []).length; j++) idx['core|' + ex.core[j]] = true;
  for (j = 0; j < (ex.vac || []).length; j++) idx['vac|' + ex.vac[j]] = true;
  for (j = 0; j < (ex.vcore || []).length; j++) idx['vcore|' + ex.vcore[j]] = true;
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
// Waived by a 免責券: the task is not required that day (no miss, no point, the streak just passes over it).
function isExempt(task, date, idx) { return idx['x|' + date + '|' + task.id] === true; }

// 低能量日 (the 疲勞 state of the day): only the 核心 tasks are still required, the other fixed 必做 tasks are let go
// for that day. With no 核心 task chosen nothing is let go, so the feature does nothing until it is set up.
function isLowDay(date, idx) { return idx['low|' + date] === true; }
function hasCore_(idx) {
  for (var k in idx) if (k.indexOf('core|') === 0) return true;
  return false;
}
// 休假日 (mode 休假, stored as the pseudo item '_mode'): the same idea with its own list, the tasks flagged 休假日仍要做 (settings.vacTasks).
function isVacDay(date, idx) { return idx['vac|' + date] === true; }
function hasVcore_(idx) {
  for (var k in idx) if (k.indexOf('vcore|') === 0) return true;
  return false;
}
function isRelieved(task, date, idx) {
  if (!isFixedMust_(task)) return false;
  return (isLowDay(date, idx) && idx['core|' + task.id] !== true && hasCore_(idx)) ||
    (isVacDay(date, idx) && idx['vcore|' + task.id] !== true && hasVcore_(idx));
}
// Not required that day: waived by a 免責券, or let go on a low-energy day.
function isWaived(task, date, idx) { return isExempt(task, date, idx) || isRelieved(task, date, idx); }

// Dates the day's state was set to 疲勞 (train rows with the pseudo item '_state'), and the ids listed in settings.coreTasks.
function lowDaysFrom(train) {
  return (train || []).filter(function (r) { return r.item === '_state' && r.version === '疲勞'; }).map(function (r) { return r.date; });
}
function coreIdsFrom(settings) {
  return String((settings && settings.coreTasks) || '').split(/[,、\s]+/).filter(function (x) { return x; });
}
function vacDaysFrom(train) {
  return (train || []).filter(function (r) { return r.item === '_mode' && r.version === '休假'; }).map(function (r) { return r.date; });
}
function vacIdsFrom(settings) {
  return String((settings && settings.vacTasks) || '').split(/[,、\s]+/).filter(function (x) { return x; });
}
function extrasFrom(train, settings) { return { low: lowDaysFrom(train), core: coreIdsFrom(settings), vac: vacDaysFrom(train), vcore: vacIdsFrom(settings) }; }
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
  if (isBonus(task) || !task.remind || isWaived(task, date, idx) || !isDue(task, date, idx)) return false;
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
    if (!isFixedMust_(t) || !isScheduled(t, date) || isWaived(t, date, idx)) continue;
    due++;
    if (isDone(t, date, idx)) done++;
  }
  return { leave: false, due: due, done: done, rate: due ? done / due : null };
}

function bonusStats(tasks, date, idx) {
  var due = 0, done = 0;
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    if (!isBonus(t) || isCounterTask(t) || isAccumFreq(t.freq) || !isScheduled(t, date)) continue;
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
  for (i = 0; i < LOOKBACK_DAYS; i++, d = addDays(d, -1)) {
    if (leave[d] || !isScheduled(task, d) || isWaived(task, d, idx)) continue;
    if (isDone(task, d, idx)) n++;
    else if (daysBetween(d, date) > GRACE_DAYS) break;
  }
  return n;
}

function overallStreak(tasks, date, idx, leave) {
  var n = 0, d = date;
  for (var i = 0; i < LOOKBACK_DAYS; i++, d = addDays(d, -1)) {
    var s = dayStats(tasks, d, idx, leave);
    if (s.rate === null) continue;
    if (s.rate >= OVERALL_THRESHOLD) n++;
    else if (daysBetween(d, date) > GRACE_DAYS) break;
  }
  return n;
}

// 補登卡: the 必做 tasks still open on the last GRACE_DAYS days (newest first is not needed: oldest first), [{date, left}].
function backfillPending(tasks, today, idx, leave) {
  var out = [];
  for (var i = GRACE_DAYS; i >= 1; i--) {
    var d = addDays(today, -i), s = dayStats(tasks, d, idx, leave);
    if (!s.leave && s.due > s.done) out.push({ date: d, left: s.due - s.done });
  }
  return out;
}

// Per-dimension completion of 必做 fixed tasks over [start, min(end, today)].
function dimensionRates(tasks, start, end, today, idx, leave) {
  var out = {}, last = end < today ? end : today;
  for (var d = start; d <= last; d = addDays(d, 1)) {
    if (leave[d]) continue;
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i];
      if (!isFixedMust_(t) || !isScheduled(t, d) || isWaived(t, d, idx)) continue;
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
// Option labels can carry a default amount ('深蹲*30'); a log note stores what was really done ('深蹲*25').
function parseOption(label) {
  var m = /^(.*?)\s*[*×]\s*(\d+)$/.exec(String(label).trim());
  return m ? { base: m[1].trim(), count: parseInt(m[2], 10) } : { base: String(label).trim(), count: 0 };
}

function noteItem(base, count) { return count > 0 ? base + '*' + count : base; }

function parseNote(note) {
  return String(note || '').split('、').filter(function (x) { return x; }).map(parseOption);
}

// Extras for a period: 進階 days, 加分 check-ins, per-option days (options) and summed amounts (reps), grouped by option name.
function periodExtras(tasks, logs, start, end) {
  var byId = {}, i;
  for (i = 0; i < tasks.length; i++) byId[tasks[i].id] = tasks[i];
  var out = { advanced: 0, bonus: 0, options: {}, reps: {} };
  for (i = 0; i < logs.length; i++) {
    var l = logs[i], t = byId[l.taskId];
    if (l.date < start || l.date > end || !t || isCounterTask(t)) continue;  // 飲食狀態 has its own summary (dietPeriod)
    if (l.tier === '進階') out.advanced++;
    if (isBonus(t) && !isAccumFreq(t.freq)) out.bonus++;
    parseNote(l.note).forEach(function (p) {
      out.options[p.base] = (out.options[p.base] || 0) + 1;
      if (p.count > 0) out.reps[p.base] = (out.reps[p.base] || 0) + p.count;
    });
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

// ---- Training menu (the 「訓練」 tab): what you CAN do today. Never a to-do: nothing here affects 必做 rates or streaks. ----
// One merged plan (10/26): home strength A/B (kettlebell + band), Zone 2, one kettlebell interval, your fixed yoga classes
// and the Saturday gym session, plus at most one 5-minute mobility / pelvic-floor item a day. The old Samsung run plan is retired.
// Week 1 starts on `start` (a Monday). Weekday numbers: 1 = Monday ... 7 = Sunday.
//
// Every item has a tier so the week can be sized to the time you really have:
//   'min' = the core of the week (what to keep when busy), 'std' = the full plan, 'opt' = only if you feel like it.
//   fixed items (your classes, the gym) are counted on their own.

var TRAIN_WEEKS = 12;
var TRAIN_STATES = ['精神好', '普通', '疲勞'];

// Zone 2 minutes by week: Tuesday, and the long Sunday one. A 25-minute Thursday walk/jog brings the week to about 120.
var Z2_TUE = [40, 40, 40, 40, 40, 45, 45, 45, 45, 45, 45, 40];
var Z2_SUN = [50, 50, 55, 55, 60, 60, 60, 65, 65, 65, 70, 55];
var Z2_THU = 25;

var STRENGTH_LOWER = ['腿推或深蹲　4 × 6–10', '羅馬尼亞硬舉　3 × 8–12', '保加利亞分腿蹲　3 × 每側 8–12（先在無痛範圍）', '臀推　3 × 10–15', '腿彎舉　3 × 12–15', '小腿提踵　3 × 15–20（小腿不適就減量）', '靠牆靜蹲　2 × 45–90 秒'];
var STRENGTH_UPPER = ['臥推或伏地挺身　3 × 8–12', '坐姿划船　3 × 10–15', '高位下拉　3 × 10–15', '肩推　3 × 8–12', '臀橋　3 × 15–20（頂端停 1–2 秒）', 'Pallof press　3 × 每側 12', 'Dead bug　3 × 每側 10', '臀橋等長　2 × 30–45 秒'];
var PELVIC_MOVES = ['慢收縮：輕到中等力收縮 5 秒、完全放鬆 5 秒，共 8 次（正常呼吸，不憋氣）', '快速收縮：收 1 秒、放 1 秒，共 10 次', '腹式呼吸與放鬆 1–2 分鐘', '若有疼痛、排尿不適或會陰緊繃，先不要加量，請專業人員評估'];
var HIP_MOVES = ['髖屈肌伸展（弓箭步）　每側 30–45 秒', '4 字（鴿式）伸展　每側 30–45 秒', '90/90 髖轉換　8 次', '全程不痛、不彈震，呼吸放鬆'];

function intervalSets_(week) { return week <= 4 ? 6 : week <= 8 ? 7 : 8; }

function trainItem_(id, kind, title, icon, minutes, detail, easy, up, extra) {
  var o = { id: id, kind: kind, title: title, icon: icon, minutes: minutes, detail: detail, easy: easy, up: up || '', fixed: false, tier: 'opt', time: '白天' };
  for (var k in (extra || {})) o[k] = extra[k];
  return o;
}

function homeStrengthItem_(day) {
  return trainItem_(day === 'A' ? 'home-a' : 'home-b', 'strength-home', '力量 ' + day + ' 日（居家）', '🦾', 35,
    ['壺鈴＋彈力帶，動作與次數在下面的清單，記下每組幾下、幾公斤', '核心動作已經包含在內，不用另外做核心'],
    '每個動作做 2 組，或只做前 3 個動作', '每個動作多做 1 組，下放放慢到 4 秒', { day: day, tier: 'min', time: '白天或晚上' });
}

function zone2Item_(id, title, minutes, tier) {
  return trainItem_(id, 'run', title, '🏃', minutes, ['輕鬆配速（RPE 3–4／10），能完整說完一句話', '下雨：健身房跑步機、或公寓樓梯快走'],
    '縮短到 25–30 分，或改快走', '', { planned: minutes, isRun: true, tier: tier });
}

function intervalItem_(week) {
  var n = intervalSets_(week);
  return trainItem_('kb-interval', 'interval', '壺鈴間歇 ' + n + ' 組', '⚡', 20,
    ['熱身 5 分鐘（開合跳、髖部活動）', '壺鈴擺盪 30 秒全力、休息 90 秒，共 ' + n + ' 組', '收操 3–5 分鐘', '胸悶、頭暈或胸痛就立刻停下'],
    '改成 20 分鐘輕鬆有氧，或休息（前晚沒睡好、腿很痠時）', '', { tier: 'opt', time: '白天' });
}

function gymItem_(week) {
  var lower = week % 2 === 1;
  return trainItem_(lower ? 'strength-lower' : 'strength-upper', 'strength', '重訓（健身房）：' + (lower ? '下肢' : '上肢＋臀髖'), '🏋️', 60,
    (lower ? STRENGTH_LOWER : STRENGTH_UPPER).concat(['RPE 7–8，保留 2–3 次餘力；髖緊就縮小動作幅度']),
    '每個動作減成 2 組，或只做伸展與活動度', '主要動作各多做 1 組，仍保留 2–3 次餘力', { fixed: true, tier: 'std', time: '晚上' });
}

function yogaItem_() {
  return trainItem_('yoga', 'yoga', '瑜珈課', '🧘', 60, ['固定課程'], '', '', { fixed: true, tier: 'std', time: '晚上' });
}

function pelvicItem_() { return trainItem_('pelvic', 'pelvic', '骨盆底控制與呼吸', '🫁', 5, PELVIC_MOVES, '只做腹式呼吸放鬆', ''); }
function hipItem_() { return trainItem_('hip', 'mobility', '髖部放鬆 5 分', '🤸', 5, HIP_MOVES, '', ''); }

// -> {week, started, finished, items:[...]} for one date. start: 'YYYY-MM-DD' of week 1's Monday.
function trainingMenu(date, start) {
  var diff = daysBetween(start, date);
  if (diff < 0) return { week: 0, started: false, finished: false, items: [] };
  var raw = Math.floor(diff / 7) + 1;
  var week = Math.min(raw, TRAIN_WEEKS), wd = weekdayOf(date), items = [];
  if (wd === 1) items = [homeStrengthItem_('A'), pelvicItem_()];
  else if (wd === 2) items = [zone2Item_('run-z2', 'Zone 2 ' + Z2_TUE[week - 1] + ' 分', Z2_TUE[week - 1], 'std'), hipItem_()];
  else if (wd === 3) items = [yogaItem_(), intervalItem_(week)];
  else if (wd === 4) items = [yogaItem_(), zone2Item_('run-short', 'Zone 2 短 ' + Z2_THU + ' 分（走路或慢跑）', Z2_THU, 'opt'), hipItem_()];
  else if (wd === 5) items = [homeStrengthItem_('B'), pelvicItem_()];
  else if (wd === 6) items = [gymItem_(week)];
  else items = [zone2Item_('run-long', '長 Zone 2 ' + Z2_SUN[week - 1] + ' 分', Z2_SUN[week - 1], 'min'), pelvicItem_()];
  return { week: week, started: true, finished: raw > TRAIN_WEEKS, items: items };
}

// The week that contains `date`, sized three ways: the core you keep when busy (min), the full plan (std), and the extras (opt).
// Your fixed classes and the gym session are counted apart. -> {min, std, opt, fixed}, all in minutes.
function trainingWeekLoad(date, start) {
  var monday = addDays(date, -(weekdayOf(date) - 1)), out = { min: 0, std: 0, opt: 0, fixed: 0 };
  for (var i = 0; i < 7; i++) {
    var m = trainingMenu(addDays(monday, i), start);
    m.items.forEach(function (it) {
      if (it.fixed) { out.fixed += it.minutes; return; }
      if (it.tier === 'min') { out.min += it.minutes; out.std += it.minutes; }
      else if (it.tier === 'std') out.std += it.minutes;
      else out.opt += it.minutes;
    });
  }
  return out;
}

// 開機提醒: the training items of `date` that are not logged yet, without the pelvic-floor one ([] before the plan starts, after it ends, or once everything is done).
function trainingReminder(date, start, trainLogs) {
  var menu = trainingMenu(date, start);
  if (!menu.started || menu.finished) return [];
  var done = {};
  (trainLogs || []).forEach(function (r) { if (r.date === date) done[r.item] = true; });
  return menu.items.filter(function (it) { return !done[it.id] && it.id !== 'pelvic'; });   // the pelvic-floor item stays off a screen others may see (same rule as Telegram)
}

// What to show for an item given today's state (精神好 / 普通 / 疲勞).
function trainVariant(item, state) {
  if (state === '疲勞' && item.easy) return { label: '輕鬆版', text: item.easy };
  if (state === '精神好' && item.up) return { label: '進階版', text: item.up };
  return null;
}

// Plain facts for the week containing `date`: sessions done and minutes. trainLogs: [{date, item, minutes}].
function trainingSummary(date, trainLogs) {
  var start = addDays(date, -(weekdayOf(date) - 1)), end = addDays(start, 6), sessions = 0, minutes = 0;
  for (var i = 0; i < trainLogs.length; i++) {
    var l = trainLogs[i];
    if (l.item === '_state' || l.date < start || l.date > end) continue;
    sessions++;
    minutes += Number(l.minutes) || 0;
  }
  return { sessions: sessions, minutes: minutes, start: start, end: end };
}

// One line for the morning Telegram message. Pelvic-floor items never go to Telegram.
function buildTrainingLine(date, start) {
  var m = trainingMenu(date, start);
  var titles = m.items.filter(function (t) { return t.kind !== 'pelvic'; }).map(function (t) { return t.title; });
  return titles.length ? '🏃 今天可以練（不強制）：' + titles.join('、') : '';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    addDays: addDays, weekdayOf: weekdayOf, daysBetween: daysBetween, monthKey: monthKey, quarterKey: quarterKey,
    isLastDayOfMonth: isLastDayOfMonth, isQuarterStart: isQuarterStart, periodRange: periodRange, indexLogs: indexLogs,
    indexLeave: indexLeave, isScheduled: isScheduled, isDue: isDue, progress: progress, needsReminder: needsReminder,
    dayStats: dayStats, bonusStats: bonusStats, taskStreak: taskStreak, overallStreak: overallStreak,
    dimensionRates: dimensionRates, dailyRates: dailyRates, periodExtras: periodExtras, decideReminder: decideReminder,
    buildReminderText: buildReminderText, buildReminderKeyboard: buildReminderKeyboard, decidePeriodic: decidePeriodic,
    buildMonthReport: buildMonthReport, buildPlanText: buildPlanText, minutesOn: minutesOn, tierOn: tierOn, parseOption: parseOption, noteItem: noteItem, parseNote: parseNote, iconOf: iconOf, SLOTS: SLOTS,
    trainingMenu: trainingMenu, trainingWeekLoad: trainingWeekLoad, trainVariant: trainVariant, trainingSummary: trainingSummary,
    buildTrainingLine: buildTrainingLine, TRAIN_STATES: TRAIN_STATES
  };
}

// Gamification: skills, levels, star coins, achievements, clean days, limited-time challenges.
// Everything is derived from the same logs the rest of the app uses (nothing extra is stored), so old check-ins count too.
// Concatenated after logic.js by build.py; it uses logic.js functions (dayStats, isScheduled, indexLogs, ...) directly.
//
// data = {tasks, logs, leave, train, slips, slipItems, redemptions, challenges, settings}
//   logs:        {date, taskId, tier, minutes, note, ts}
//   train:       {date, item, minutes, ...}
//   slips:       {date, item}            item = 扣分項 id
//   slipItems:   {id, name, icon, active}
//   redemptions: {date, rewardId, name, cost}
//   challenges:  {date, move, level, result ('成功'|'失敗'|'放棄')}

var SKILLS = ['體能', '健康', '財商', '學習', '關係'];

var SKILL_TITLES = {
  '體能': ['動起來的人', '晨動者', '規律運動者', '穩定跑者', '體能新星', '肌耐力玩家', '耐力戰士', '鐵人預備軍', '精實身形', '體能大師',
    '耐力玩家', '間歇掌控者', '力量鍛造師', '全能運動家', '體能宗師', '不倦的行者', '鋼鐵意志', '耐力傳奇', '巔峰身形', '體能傳說'],
  '健康': ['養生新手', '早睡嘗試者', '補水達人', '規律生活者', '血糖守護者', '睡眠管理師', '身心平衡者', '健康職人', '養生達人', '健康大師',
    '作息建築師', '飲食設計師', '恢復力專家', '身心守護者', '健康宗師', '長壽習慣家', '能量管理者', '自癒力達人', '養生傳奇', '健康傳說'],
  '財商': ['記帳新手', '帳目小幫手', '收支觀察者', '預算管理者', '資產園丁', '現金流掌舵手', '理財策略家', '複利信徒', '財務自由路上人', '財商大師',
    '現金流守門人', '資產配置家', '風險管理者', '長期主義者', '財商宗師', '複利建築師', '被動收入築夢者', '財務自由先行者', '財富智者', '財商傳說'],
  '學習': ['好奇寶寶', '閱讀者', '筆記常客', '知識探險家', '持續進修者', '深度思考者', '學習職人', '跨域整合者', '知識建築師', '學習大師',
    '持續閱讀者', '筆記系統家', '概念連結者', '終身學習者', '學習宗師', '知識整合家', '思想實驗家', '洞察獵人', '智慧傳承者', '學習傳說'],
  '關係': ['打招呼的人', '傾聽者', '暖心聯絡人', '關係經營者', '可靠夥伴', '自我覺察者', '溫暖支柱', '情感智者', '人際橋梁', '關係大師',
    '默契培養者', '陪伴專家', '衝突調解者', '信任建構者', '關係宗師', '溫度傳遞者', '家人的避風港', '友誼園丁', '深度連結者', '關係傳說']
};

// Extra star coins when a skill reaches one of these levels (on top of the +5 every level gives).
var TIER_PROMO = { 4: 10, 7: 20, 10: 40, 15: 80, 20: 150 };
var STREAK_COINS = { 7: 10, 14: 20, 30: 40, 60: 80, 100: 150 };
var WEEKEND_EARLY_HOUR = 12;    // 假日早鳥: weekend morning workout before this hour
var WEEKEND_EARLY_COINS = 4;    // on top of the usual 2 for a qualified day
var TOTAL_TITLES = ['新手', '起步者', '穩定者', '前進者', '實踐者', '行動家', '磨練者', '達人', '名家', '宗師', '圓滿'];
var GAME_LOOKBACK_DAYS = 800;
var CHALLENGE_DRAWS_PER_DAY = 3;
var CHALLENGE_REWARDED_PER_DAY = 2;

// Cumulative skill points needed to be at level L: each level costs 10 + 3 * (L - 1) more than the one before.
function levelCum(L) { return L <= 1 ? 0 : 10 * (L - 1) + 3 * (L - 1) * (L - 2) / 2; }

function levelOf(sp) {
  var L = 1;
  while (levelCum(L + 1) <= sp) L++;
  return L;
}

function skillTitle(skill, level) {
  var t = SKILL_TITLES[skill];
  if (!t) return '';
  return level <= 20 ? t[level - 1] : t[19] + ' Lv.' + level;
}

function tierName(level) {
  if (level >= 20) return '傳說';
  if (level >= 15) return '宗師';
  if (level >= 10) return '大師';
  if (level >= 7) return '高階';
  if (level >= 4) return '進階';
  return '初階';
}

function levelFrame(level) { return level >= 20 ? 'rainbow' : level >= 15 ? 'gold' : level >= 10 ? 'silver' : ''; }

function totalTitle(total) { return TOTAL_TITLES[Math.min(10, Math.floor(total / 10))]; }

// The skill a task trains: its own 技能 field, else a guess from its dimension and name. '' = none (娛樂, 工作).
function skillOf(task) {
  if (task.skill === '無') return '';
  if (SKILLS.indexOf(task.skill) >= 0) return task.skill;
  var d = task.dim, n = task.name || '';
  if (d === '財商') return '財商';
  if (d === '學習') return '學習';
  if (d === '情緒') return '關係';
  if (d === '健康') return /睡|水|保養|血糖|拉筋|就寢|喝|吃|菜|醋/.test(n) ? '健康' : '體能';
  return '';
}

function groupBy_(rows, key) {
  var out = {};
  for (var i = 0; i < rows.length; i++) (out[rows[i][key]] || (out[rows[i][key]] = [])).push(rows[i]);
  return out;
}

function daysInMonth_(ym) {
  return new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();
}

// Achievement catalogue. test(S) looks at the running state S after each day; the first day it is true is the unlock date.
var ACHIEVEMENTS = [
  { id: 's3', cat: '連續', name: '起步', desc: '連續 3 天達標', coins: 0, test: function (S) { return S.streak >= 3; } },
  { id: 's7', cat: '連續', name: '一週不間斷', desc: '連續 7 天達標', coins: 0, test: function (S) { return S.streak >= 7; } },
  { id: 's14', cat: '連續', name: '兩週堅持', desc: '連續 14 天達標', coins: 0, test: function (S) { return S.streak >= 14; } },
  { id: 's21', cat: '連續', name: '習慣養成', desc: '連續 21 天達標', coins: 0, test: function (S) { return S.streak >= 21; } },
  { id: 's30', cat: '連續', name: '滿月', desc: '連續 30 天達標', coins: 0, test: function (S) { return S.streak >= 30; } },
  { id: 's60', cat: '連續', name: '兩個月', desc: '連續 60 天達標', coins: 0, test: function (S) { return S.streak >= 60; } },
  { id: 's100', cat: '連續', name: '百日', desc: '連續 100 天達標', coins: 0, test: function (S) { return S.streak >= 100; } },
  { id: 'p1', cat: '完美日', name: '第一次完美', desc: '第一次必做 100% 完成', coins: 3, test: function (S) { return S.perfectCount >= 1; } },
  { id: 'p3', cat: '完美日', name: '三連完美', desc: '連續 3 個完美日', coins: 5, test: function (S) { return S.perfectStreak >= 3; } },
  { id: 'p10', cat: '完美日', name: '十全十美', desc: '累計 10 個完美日', coins: 5, test: function (S) { return S.perfectCount >= 10; } },
  { id: 'p30', cat: '完美日', name: '完美收藏家', desc: '累計 30 個完美日', coins: 10, test: function (S) { return S.perfectCount >= 30; } },
  { id: 'p100', cat: '完美日', name: '百分百', desc: '累計 100 個完美日', coins: 20, test: function (S) { return S.perfectCount >= 100; } },
  { id: 'w1', cat: '每週', name: '一週五天', desc: '一週內達標 5 天', coins: 3, test: function (S) { return S.weekQual >= 5 || S.weekRun >= 1; } },
  { id: 'w4', cat: '每週', name: '四週穩定', desc: '連續 4 週，每週都達標 5 天', coins: 10, test: function (S) { return S.weekRunNow >= 4; } },
  { id: 'k3', cat: '技能', name: '新手畢業', desc: '任一技能到 Lv3', coins: 5, test: function (S) { return S.maxLevel >= 3; } },
  { id: 'k5', cat: '技能', name: '漸入佳境', desc: '任一技能到 Lv5', coins: 5, test: function (S) { return S.maxLevel >= 5; } },
  { id: 'k10', cat: '技能', name: '大師誕生', desc: '任一技能到 Lv10', coins: 15, test: function (S) { return S.maxLevel >= 10; } },
  { id: 'k15', cat: '技能', name: '宗師之路', desc: '任一技能到 Lv15', coins: 20, test: function (S) { return S.maxLevel >= 15; } },
  { id: 'k20', cat: '技能', name: '傳說誕生', desc: '任一技能到 Lv20', coins: 20, test: function (S) { return S.maxLevel >= 20; } },
  { id: 'a3', cat: '技能', name: '均衡發展', desc: '五個技能都到 Lv3', coins: 10, test: function (S) { return S.minLevel >= 3; } },
  { id: 'a5', cat: '技能', name: '全面進化', desc: '五個技能都到 Lv5', coins: 15, test: function (S) { return S.minLevel >= 5; } },
  { id: 'a10', cat: '技能', name: '五星全能', desc: '五個技能都到 Lv10', coins: 20, test: function (S) { return S.minLevel >= 10; } },
  { id: 'a20', cat: '技能', name: '圓滿', desc: '五個技能都到 Lv20', coins: 20, test: function (S) { return S.minLevel >= 20; } },
  { id: 't1', cat: '體能', name: '第一次訓練', desc: '在訓練頁完成第一次訓練', coins: 3, test: function (S) { return S.trainTotal >= 1; } },
  { id: 'tw4', cat: '體能', name: '一週四練', desc: '一週內完成 4 次訓練', coins: 5, test: function (S) { return S.weekTrain >= 4; } },
  { id: 'r600', cat: '體能', name: '跑滿 10 小時', desc: '累計跑步 600 分鐘', coins: 5, test: function (S) { return S.runTotal >= 600; } },
  { id: 'r1200', cat: '體能', name: '跑滿 20 小時', desc: '累計跑步 1200 分鐘', coins: 10, test: function (S) { return S.runTotal >= 1200; } },
  { id: 'r3000', cat: '體能', name: '跑滿 50 小時', desc: '累計跑步 3000 分鐘', coins: 20, test: function (S) { return S.runTotal >= 3000; } },
  { id: 'rw4', cat: '體能', name: '跑步四週達標', desc: '連續 4 週達到每週跑步目標', coins: 10, test: function (S) { return S.runWeekNow >= 4; } },
  { id: 'rw8', cat: '體能', name: '跑步八週達標', desc: '連續 8 週達到每週跑步目標', coins: 15, test: function (S) { return S.runWeekNow >= 8; } },
  { id: 'k10k', cat: '體能', name: '10 公里完成', desc: '完成三星練跑教練的 10 公里等級測試', coins: 15, test: function (S) { return S.test10k; } },
  { id: 'p12', cat: '體能', name: '走完 12 週計畫', desc: '訓練計畫走到第 12 週', coins: 20, test: function (S) { return S.plan12; } },
  { id: 'lr60', cat: '夢想', name: '長跑一小時', desc: '單次跑步滿 60 分鐘', coins: 3, test: function (S) { return S.runLongest >= 60; } },
  { id: 'lr90', cat: '夢想', name: '長跑九十分', desc: '單次跑步滿 90 分鐘', coins: 5, test: function (S) { return S.runLongest >= 90; } },
  { id: 'lr120', cat: '夢想', name: '長跑兩小時', desc: '單次跑步滿 120 分鐘，半馬等級的耐力', coins: 10, test: function (S) { return S.runLongest >= 120; } },
  { id: 'y10', cat: '夢想', name: '瑜珈入門', desc: '手錶記到瑜伽累計 10 次', coins: 3, test: function (S) { return S.yogaTotal >= 10; } },
  { id: 'y30', cat: '夢想', name: '瑜珈常客', desc: '手錶記到瑜伽累計 30 次', coins: 8, test: function (S) { return S.yogaTotal >= 30; } },
  { id: 'y60', cat: '夢想', name: '瑜珈達人', desc: '手錶記到瑜伽累計 60 次', coins: 15, test: function (S) { return S.yogaTotal >= 60; } },
  { id: 'lf20', cat: '夢想', name: '重訓起步', desc: '重量訓練累計打卡 20 次', coins: 5, test: function (S) { return S.liftTotal >= 20; } },
  { id: 'lf50', cat: '夢想', name: '重訓老手', desc: '重量訓練累計打卡 50 次', coins: 10, test: function (S) { return S.liftTotal >= 50; } },
  { id: 'lf100', cat: '夢想', name: '重訓百次', desc: '重量訓練累計打卡 100 次', coins: 20, test: function (S) { return S.liftTotal >= 100; } },
  { id: 'cv50', cat: '夢想', name: '被動收入過半', desc: '被動收入覆蓋率達 50%（近 13 個月被動收入除以支出）', coins: 10, test: function (S) { return S.cov50; } },
  { id: 'cv100', cat: '夢想', name: '被動收入打平', desc: '被動收入覆蓋率達 100%，被動收入已能支應支出', coins: 25, test: function (S) { return S.cov100; } },
  { id: 'cv150', cat: '夢想', name: '被動收入有餘', desc: '被動收入覆蓋率達 150%', coins: 30, test: function (S) { return S.cov150; } },
  { id: 'c1', cat: '限時挑戰', name: '第一次挑戰成功', desc: '限時挑戰第一次成功', coins: 3, test: function (S) { return S.chTotal >= 1; } },
  { id: 'c10', cat: '限時挑戰', name: '挑戰十次', desc: '限時挑戰累計成功 10 次', coins: 8, test: function (S) { return S.chTotal >= 10; } },
  { id: 'c30', cat: '限時挑戰', name: '挑戰三十次', desc: '限時挑戰累計成功 30 次', coins: 15, test: function (S) { return S.chTotal >= 30; } },
  { id: 'c2', cat: '限時挑戰', name: '一天雙殺', desc: '同一天挑戰成功 2 次', coins: 5, test: function (S) { return S.chDay >= 2; } },
  { id: 'cl7', cat: '清爽', name: '清爽一週', desc: '任一扣分項連續乾淨 7 天', coins: 5, test: function (S) { return S.cleanMax >= 7; } },
  { id: 'cl14', cat: '清爽', name: '清爽兩週', desc: '任一扣分項連續乾淨 14 天', coins: 8, test: function (S) { return S.cleanMax >= 14; } },
  { id: 'cl30', cat: '清爽', name: '清爽一個月', desc: '任一扣分項連續乾淨 30 天', coins: 15, test: function (S) { return S.cleanMax >= 30; } },
  { id: 'cl2', cat: '清爽', name: '雙清爽兩週', desc: '炸物和飲酒同時連續乾淨 14 天', coins: 10, test: function (S) { return S.cleanCombo >= 14; } },
  { id: 'h30', cat: '習慣養成', name: '三十次達人', desc: '同一個任務累計完成 30 次', coins: 5, test: function (S) { return S.doneMax >= 30; } },
  { id: 'h100', cat: '習慣養成', name: '百次達人', desc: '同一個任務累計完成 100 次', coins: 15, test: function (S) { return S.doneMax >= 100; } },
  { id: 'low10', cat: '習慣養成', name: '再累也有做', desc: '用「最低版」守住習慣累計 10 次', coins: 8, test: function (S) { return S.low >= 10; } },
  { id: 'glu30', cat: '習慣養成', name: '血糖守護', desc: '血糖措施累計完成 30 次', coins: 8, test: function (S) { return S.glucose >= 30; } },
  { id: 'r1', cat: '犒賞', name: '犒賞自己', desc: '第一次兌換獎勵', coins: 3, test: function (S) { return S.redCount >= 1; } },
  { id: 'we2', cat: '假日', name: '假日早起', desc: '連續 2 個假日早上 12 點前完成晨間鍛鍊', coins: 5, test: function (S) { return S.weekendRun >= 2; } },
  { id: 'we4', cat: '假日', name: '假日不賴床', desc: '連續 4 個假日早上 12 點前完成晨間鍛鍊', coins: 10, test: function (S) { return S.weekendRun >= 4; } },
  { id: 'we8', cat: '假日', name: '假日戰士', desc: '連續 8 個假日早上 12 點前完成晨間鍛鍊', coins: 20, test: function (S) { return S.weekendRun >= 8; } },
  { id: 'hid1', cat: '隱藏', hidden: true, name: '早鳥', desc: '早上 6 點前完成晨間鍛鍊', coins: 5, test: function (S) { return S.early; } },
  { id: 'hid2', cat: '隱藏', hidden: true, name: '滿分一天', desc: '一天內必做和加分全部完成', coins: 8, test: function (S) { return S.fullDay; } },
  { id: 'hid3', cat: '隱藏', hidden: true, name: '七天全勤', desc: '連續 7 天達標，而且沒用請假日', coins: 8, test: function (S) { return S.noLeave7; } }
];

// 免責券 owned = redeemed rewards of type 免責券 minus the waivers already used.
function ticketsLeft(redemptions, exempts) {
  var bought = 0;
  (redemptions || []).forEach(function (r) { if (r.type === '免責券') bought++; });
  return Math.max(0, bought - (exempts || []).length);
}

function emptyGame_(today) {
  var skills = {};
  SKILLS.forEach(function (s) {
    skills[s] = { sp: 0, level: 1, title: skillTitle(s, 1), tier: tierName(1), frame: '', levelStart: 0, nextAt: levelCum(2), toNext: levelCum(2), gain: 0 };
  });
  return {
    today: today, skills: skills, totalLevel: 5, totalTitle: totalTitle(5), coins: { earned: 0, spent: 0, balance: 0, gain: 0 }, events: [],
    achievements: ACHIEVEMENTS.map(function (a) { return { id: a.id, cat: a.cat, name: a.name, desc: a.desc, coins: a.coins, hidden: !!a.hidden, unlocked: false, date: '' }; }),
    streak: { current: 0, best: 0 }, perfectCount: 0, qualifiedTotal: 0, tickets: 0,
    month: { key: monthKey(today), qualified: 0, leave: 0, days: daysInMonth_(monthKey(today)) }, clean: []
  };
}

function computeGame(data, today) {
  var tasks = data.tasks || [], logs = data.logs || [], train = data.train || [], leaveArr = data.leave || [];
  var slips = data.slips || [], items = data.slipItems || [], reds = data.redemptions || [], chs = data.challenges || [];
  var settings = data.settings || {};
  var idx = indexLogs(logs, data.exempts || [], extrasFrom(train, data.settings)), leave = indexLeave(leaveArr);
  var byId = {};
  tasks.forEach(function (t) { byId[t.id] = t; });
  var logsBy = groupBy_(logs, 'date'), trainBy = groupBy_(train, 'date'), slipsBy = groupBy_(slips, 'date');
  var chBy = groupBy_(chs, 'date'), redBy = groupBy_(reds, 'date');
  var workBy = groupBy_(data.workouts || [], 'date');
  var covHits = parseDreamCovHits(settings.dreamCov);

  var first = '';
  function lower_(d) { if (d && (!first || d < first)) first = d; }
  logs.forEach(function (l) { lower_(l.date); });
  train.forEach(function (r) { lower_(r.date); });
  tasks.forEach(function (t) { lower_(t.since); });
  if (!first) return emptyGame_(today);
  var floor = addDays(today, -GAME_LOOKBACK_DAYS);
  var start = first < floor ? floor : first;

  var runIds = {}, runTarget = 0;
  tasks.forEach(function (t) {
    if (t.freq === 'weekly_min' && /跑/.test(t.name || '')) { runIds[t.id] = true; if (!runTarget) runTarget = targetOf(t); }
  });
  var trainStart = settings.trainStart || '2026-10-19';
  var slipStart = settings.slipStart || '';
  var activeItems = items.filter(function (i) { return i.active !== false; });
  var itemByName = {};
  activeItems.forEach(function (i) { itemByName[i.name] = i.id; });

  var sp = {}, level = {}, cleanStreak = {}, cleanBest = {};
  SKILLS.forEach(function (s) { sp[s] = 0; level[s] = 1; });
  activeItems.forEach(function (i) { cleanStreak[i.id] = 0; cleanBest[i.id] = 0; });

  var events = [], earned = 0, coinsByDate = {}, spGainToday = {};
  function addCoins(d, n, type, text) {
    if (!n) return;
    earned += n;
    coinsByDate[d] = (coinsByDate[d] || 0) + n;
    if (type) events.push({ date: d, type: type, coins: n, text: text });
  }

  var S = {
    streak: 0, perfectCount: 0, perfectStreak: 0, weekQual: 0, weekRun: 0, weekRunNow: 0, maxLevel: 1, minLevel: 1,
    trainTotal: 0, weekTrain: 0, runTotal: 0, runWeekNow: 0, test10k: false, plan12: false, chTotal: 0, chDay: 0,
    cleanMax: 0, cleanCombo: 0, doneMax: 0, low: 0, glucose: 0, redCount: 0, early: false, fullDay: false, noLeave7: false,
    runLongest: 0, yogaTotal: 0, liftTotal: 0, cov50: false, cov100: false, cov150: false, weekendRun: 0
  };
  var best = 0, qualifiedTotal = 0;
  var doneCount = {}, unlocked = {};
  var wk = '', weekQual = 0, weekRunMin = 0, runWeekRun = 0, weekTrain = 0;
  var mk = '', monthQual = 0, monthLeave = 0, spent = 0;

  function finalizeMonth(key, lastDate) {
    if (!key) return;
    var n = daysInMonth_(key);
    if (monthQual + monthLeave === n && monthQual > 0) addCoins(lastDate, 50, 'month', key + ' 整月達標');
  }

  for (var d = start; d <= today; d = addDays(d, 1)) {
    var isToday = d === today;
    var onLeave = !!leave[d];

    // ---- calendar rollovers ----
    var w = addDays(d, -(weekdayOf(d) - 1));
    if (w !== wk) {
      if (wk) {
        S.weekRun = weekQual >= 5 ? S.weekRun + 1 : 0;
        if (runTarget) runWeekRun = weekRunMin >= runTarget ? runWeekRun + 1 : 0;
      }
      wk = w; weekQual = 0; weekRunMin = 0; weekTrain = 0;
    }
    var m = monthKey(d);
    if (m !== mk) {
      finalizeMonth(mk, addDays(d, -1));
      mk = m; monthQual = 0; monthLeave = 0;
    }
    if (onLeave) monthLeave++;

    // ---- day result ----
    var st = dayStats(tasks, d, idx, leave);
    var qualified = !onLeave && st.due > 0 && st.rate >= OVERALL_THRESHOLD;
    var perfect = qualified && st.done === st.due;
    if (qualified) {
      qualifiedTotal++; weekQual++; monthQual++;
      addCoins(d, 2, '', '');
      if (perfect) addCoins(d, 2, '', '');
      S.streak++;
      if (S.streak > best) best = S.streak;
      if (STREAK_COINS[S.streak]) addCoins(d, STREAK_COINS[S.streak], 'streak', '連續 ' + S.streak + ' 天達標');
      if (weekQual === 5) addCoins(d, 5, 'week', '這週已達標 5 天');
      if (monthQual === 10) addCoins(d, 10, 'month', monthKey(d) + ' 達標滿 10 天');
      if (monthQual === 20) addCoins(d, 25, 'month', monthKey(d) + ' 達標滿 20 天');
    } else if (!onLeave && st.due > 0 && daysBetween(d, today) > GRACE_DAYS) {
      S.streak = 0;
    }
    if (perfect) { S.perfectCount++; S.perfectStreak++; }
    else if (!onLeave && st.due > 0 && daysBetween(d, today) > GRACE_DAYS) S.perfectStreak = 0;

    // ---- skill points ----
    var sk = {};
    SKILLS.forEach(function (s) { sk[s] = { due: 0, done: 0, extra: 0 }; });
    tasks.forEach(function (t) {
      if (!isFixedMust_(t) || !isScheduled(t, d) || isWaived(t, d, idx)) return;
      var s = skillOf(t);
      if (!s) return;
      sk[s].due++;
      if (isDone(t, d, idx)) sk[s].done++;
    });
    var dayLogs = logsBy[d] || [], dayTrain = (trainBy[d] || []).filter(function (r) { return r.item !== '_state'; });
    var dayCh = chBy[d] || [];
    var chOk = dayCh.filter(function (c) { return c.result === '成功'; }).length;
    dayLogs.forEach(function (l) {
      var t = byId[l.taskId];
      if (!t || isCounterTask(t)) return;
      doneCount[t.id] = (doneCount[t.id] || 0) + 1;
      if (l.tier === '最低') S.low++;
      if (/血糖/.test(t.name || '')) S.glucose++;
      if (/重量訓練/.test(t.name || '')) S.liftTotal++;
      if (runIds[t.id]) { var mins = Number(l.minutes) || 0; S.runTotal += mins; weekRunMin += mins; }
      if (/晨間/.test(t.name || '') && l.ts && parseInt(String(l.ts).slice(11, 13), 10) < 6) S.early = true;
      var s = skillOf(t);
      if (s && (isAccumFreq(t.freq) || isBonus(t) || l.tier === '進階')) sk[s].extra++;
    });
    dayTrain.forEach(function (r) {
      sk['體能'].extra++;
      S.trainTotal++; weekTrain++;
      if (r.item === 'test10k') S.test10k = true;
      if (daysBetween(trainStart, r.date) >= 77) S.plan12 = true;
    });
    sk['體能'].extra += Math.min(chOk, CHALLENGE_REWARDED_PER_DAY);
    // Workouts the phone synced from the watch (see Health.gs). Same 20-minute floor as the auto-ticks.
    (workBy[d] || []).forEach(function (wo) {
      var mins = Number(wo.minutes) || 0;
      if (mins < 20) return;
      if (wo.type === '瑜伽') S.yogaTotal++;
      if ((wo.type === '跑步' || wo.type === '跑步機') && mins > S.runLongest) S.runLongest = mins;
    });
    DREAM_COV_STEPS.forEach(function (st) { if (covHits[String(st)] && d >= covHits[String(st)]) S['cov' + st] = true; });
    S.chTotal += chOk;
    S.chDay = chOk;
    if (chOk) addCoins(d, 2 * Math.min(chOk, CHALLENGE_REWARDED_PER_DAY), '', '');
    S.weekTrain = weekTrain;
    var doneMax = 0;
    for (var k in doneCount) if (doneCount[k] > doneMax) doneMax = doneCount[k];
    S.doneMax = doneMax;

    SKILLS.forEach(function (s) {
      var base = sk[s].due > 0 && sk[s].done / sk[s].due >= OVERALL_THRESHOLD ? 1 : 0;
      var gain = onLeave ? 0 : base + Math.min(sk[s].extra * 0.5, 1);
      if (!gain) return;
      var before = levelOf(sp[s]);
      sp[s] += gain;
      var after = levelOf(sp[s]);
      if (isToday) spGainToday[s] = gain;
      for (var L = before + 1; L <= after; L++) {
        addCoins(d, 5 + (TIER_PROMO[L] || 0), 'level', s + ' 升到 Lv' + L + '「' + skillTitle(s, L) + '」');
      }
      level[s] = after;
    });
    var lv = SKILLS.map(function (s) { return level[s]; });
    S.maxLevel = Math.max.apply(null, lv);
    S.minLevel = Math.min.apply(null, lv);

    // ---- weeks, running ----
    S.weekQual = weekQual;
    S.weekRunNow = S.weekRun + (weekQual >= 5 ? 1 : 0);
    S.runWeekNow = runTarget ? runWeekRun + (weekRunMin >= runTarget ? 1 : 0) : 0;

    // ---- clean days ----
    if (slipStart && d >= slipStart && activeItems.length) {
      var active = dayLogs.length > 0 || (trainBy[d] || []).length > 0 || dayCh.length > 0 || (slipsBy[d] || []).length > 0;
      var slipIds = {};
      (slipsBy[d] || []).forEach(function (r) { slipIds[r.item] = true; });
      activeItems.forEach(function (i) {
        if (slipIds[i.id]) cleanStreak[i.id] = 0;
        else if (active) { cleanStreak[i.id]++; if (cleanStreak[i.id] > cleanBest[i.id]) cleanBest[i.id] = cleanStreak[i.id]; }
      });
      var mx = 0;
      activeItems.forEach(function (i) { if (cleanStreak[i.id] > mx) mx = cleanStreak[i.id]; });
      S.cleanMax = mx;
      var fry = itemByName['炸物'], booze = itemByName['飲酒'];
      S.cleanCombo = fry && booze ? Math.min(cleanStreak[fry], cleanStreak[booze]) : 0;
    }

    // ---- 假日早鳥: a weekend morning workout logged on that same day before noon (a late backfill is fine, it just earns no bonus) ----
    if (weekdayOf(d) >= 6 && !onLeave) {
      var weekendEarly = dayLogs.some(function (l) {
        var t = byId[l.taskId];
        return t && /晨間/.test(t.name || '') && l.ts && String(l.ts).slice(0, 10) === d && parseInt(String(l.ts).slice(11, 13), 10) < WEEKEND_EARLY_HOUR;
      });
      if (weekendEarly) { S.weekendRun++; addCoins(d, WEEKEND_EARLY_COINS, 'weekend', '假日早鳥：' + WEEKEND_EARLY_HOUR + ' 點前完成晨間鍛鍊'); }
      else if (d !== today) S.weekendRun = 0;
    }

    // ---- redemptions and hidden conditions ----
    var dayReds = redBy[d] || [];
    dayReds.forEach(function (r) { S.redCount++; spent += Number(r.cost) || 0; });
    if (perfect) {
      var bonusDue = 0, bonusDone = 0;
      tasks.forEach(function (t) {
        if (!isBonus(t) || isCounterTask(t) || isAccumFreq(t.freq) || !isScheduled(t, d)) return;
        bonusDue++;
        if (isDone(t, d, idx)) bonusDone++;
      });
      if (bonusDue > 0 && bonusDue === bonusDone) S.fullDay = true;
    }
    if (S.streak >= 7 && qualified) {
      var gap = false;
      for (var q = 0; q < 7; q++) if (leave[addDays(d, -q)]) gap = true;
      if (!gap) S.noLeave7 = true;
    }

    // ---- achievements ----
    ACHIEVEMENTS.forEach(function (a) {
      if (unlocked[a.id] || !a.test(S)) return;
      unlocked[a.id] = d;
      addCoins(d, a.coins, 'ach', '成就「' + a.name + '」');
      if (!a.coins) events.push({ date: d, type: 'ach', coins: 0, text: '成就「' + a.name + '」' });
    });
  }
  if (isLastDayOfMonth(today)) finalizeMonth(mk, today);

  var out = emptyGame_(today);
  var totalLevel = 0;
  SKILLS.forEach(function (s) {
    var L = level[s];
    out.skills[s] = {
      sp: sp[s], level: L, title: skillTitle(s, L), tier: tierName(L), frame: levelFrame(L),
      levelStart: levelCum(L), nextAt: levelCum(L + 1), toNext: levelCum(L + 1) - sp[s], gain: spGainToday[s] || 0
    };
    totalLevel += L;
  });
  out.totalLevel = totalLevel;
  out.totalTitle = totalTitle(totalLevel);
  out.coins = { earned: earned, spent: spent, balance: Math.max(0, earned - spent), gain: coinsByDate[today] || 0 };
  out.events = events;
  out.achievements = ACHIEVEMENTS.map(function (a) {
    return { id: a.id, cat: a.cat, name: a.name, desc: a.desc, coins: a.coins, hidden: !!a.hidden, unlocked: !!unlocked[a.id], date: unlocked[a.id] || '' };
  });
  out.streak = { current: S.streak, best: best };
  out.tickets = ticketsLeft(reds, data.exempts || []);
  out.perfectCount = S.perfectCount;
  out.qualifiedTotal = qualifiedTotal;
  out.month = { key: monthKey(today), qualified: monthQual, leave: monthLeave, days: daysInMonth_(monthKey(today)) };
  out.clean = activeItems.map(function (i) { return { id: i.id, name: i.name, icon: i.icon, streak: cleanStreak[i.id], best: cleanBest[i.id] }; });
  return out;
}

// ---- limited-time challenges ----

// Draws one move from the 運動動作庫. rand in [0, 1). state: today's 精神好 / 普通 / 疲勞.
// place: '在家' draws from every active move; '在外面' only from moves whose 地點 is 辦公室.
// library rows: {move, kind, unit, easy, standard, hard, minutes, active, place, howto, links, images}
function drawChallenge(library, state, rand, place) {
  var outside = place === '在外面';
  var pool = library.filter(function (r) {
    return r.active !== false && Number(r.minutes) > 0 && (Number(r.standard) > 0 || Number(r.easy) > 0 || Number(r.hard) > 0) &&
      (!outside || r.place === '辦公室');
  });
  if (!pool.length) return null;
  var r = pool[Math.min(pool.length - 1, Math.floor(rand * pool.length))];
  var level = state === '疲勞' ? '簡單' : state === '精神好' ? '挑戰' : '標準';
  var amount = Number(level === '簡單' ? r.easy : level === '挑戰' ? r.hard : r.standard) || Number(r.standard) || Number(r.easy) || Number(r.hard);
  return {
    move: r.move, kind: r.kind || '', unit: r.unit || '次', amount: amount, level: level, minutes: Number(r.minutes),
    place: outside ? '在外面' : '在家', howto: r.howto || '', links: r.links || [], images: r.images || []
  };
}

// Draws used on a date: resolved rows plus a challenge still running on this phone.
function challengeDrawsLeft(date, challenges, pending) {
  var used = challenges.filter(function (c) { return c.date === date; }).length + (pending ? 1 : 0);
  return Math.max(0, CHALLENGE_DRAWS_PER_DAY - used);
}

function challengeText(c) {
  return c.minutes + ' 分鐘內完成 ' + c.move + ' ' + c.amount + ' ' + c.unit;
}

// Insights from the health sheet, the daily self check-in, the strength log and the habit logs. Pure functions: no clock, no DOM.
// Concatenated after game.js by build.py; it uses logic.js functions (addDays, indexLogs, dayStats, ...) directly.
//
// health row:      {date (wake-up day), bed 'YYYY-MM-DD HH:MM', wake, sleepMin, deepMin, steps, rhr, weight, bodyFat}
// check-in:        {date, energy, mood, stress, sore (1-5), flags: [names], extra: {name: 1-5}}
// strength move:   {id, name, day 'A'|'B', sets, repsLow, repsHigh, unit '次'|'秒', weighted, progress, active, order}
// strength row:    {date, move (name), reps: [n, ...], weight (kg, 0 = bodyweight), note}
// goal map:        [{taskId, goal '1'|'2'|'3'}]

var GOALS = [
  { id: '1', name: '外貌體態', icon: '💪' },
  { id: '2', name: '健康長壽', icon: '🌿' },
  { id: '3', name: '耐力', icon: '🔥' }
];

// Self check-in: 1-5 scales (worseHigh: a high number is the bad end) and yes/no flags (good: yes is the good answer).
var CHECKIN_METRICS = [
  { key: 'energy', label: '精力', low: '低', high: '高', worseHigh: false },
  { key: 'mood', label: '心情', low: '差', high: '好', worseHigh: false },
  { key: 'stress', label: '壓力', low: '小', high: '大', worseHigh: true },
  { key: 'sore', label: '痠痛', low: '無', high: '很痠', worseHigh: true }
];
var CHECKIN_FLAGS = [
  { name: '蛋白質達標', good: true },
  { name: '睡前3小時沒進食', good: true },
  { name: '酒精', good: false },
  { name: '咖啡因超過2杯', good: false }
];

function timeMin_(s) {
  var m = /(\d{2}):(\d{2})$/.exec(String(s || ''));
  return m ? +m[1] * 60 + +m[2] : null;
}

// Bedtime on a line that runs past midnight: 23:40 -> 1420, 00:30 -> 1470 (hours before noon belong to the night before).
function bedLine_(s) {
  var m = timeMin_(s);
  if (m === null) return null;
  return m < 720 ? m + 1440 : m;
}

function fmtClock_(m) {
  m = ((Math.round(m) % 1440) + 1440) % 1440;
  return pad2_(Math.floor(m / 60)) + ':' + pad2_(m % 60);
}

function mean_(a) {
  if (!a.length) return null;
  var s = 0;
  for (var i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

function stdev_(a) {
  if (a.length < 2) return null;
  var m = mean_(a), v = 0;
  for (var i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
  return Math.sqrt(v / a.length);
}

function rowsBetween_(rows, start, end) {
  return (rows || []).filter(function (r) { return r.date >= start && r.date <= end; });
}

function notNull_(x) { return x !== null && x !== undefined && !isNaN(x); }
function hasSleep_(r) { return Number(r.sleepMin) > 0 && bedLine_(r.bed) !== null; }
function byDateAsc_(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

// Last 7 days against the 14 days before: how long, how late, how regular, and whether bedtime is drifting later.
function sleepSummary(health, today) {
  var all = health || [];
  var w = rowsBetween_(all, addDays(today, -6), today).filter(hasSleep_).sort(byDateAsc_);
  var prior = rowsBetween_(all, addDays(today, -20), addDays(today, -7)).filter(hasSleep_);
  var bed = w.map(function (r) { return bedLine_(r.bed); }).filter(notNull_);
  var wake = w.map(function (r) { return timeMin_(r.wake); }).filter(notNull_);
  var priorBed = prior.map(function (r) { return bedLine_(r.bed); }).filter(notNull_);
  var dur = w.map(function (r) { return Number(r.sleepMin); });
  var deep = w.map(function (r) { return Number(r.deepMin); }).filter(function (x) { return x > 0; });
  var out = {
    n: w.length, sleepMin: mean_(dur), deepMin: mean_(deep), bed: mean_(bed), wake: mean_(wake), bedSd: stdev_(bed),
    priorBed: mean_(priorBed), drift: null, alert: false, last: w.length ? w[w.length - 1] : null
  };
  if (out.bed !== null && out.priorBed !== null) out.drift = out.bed - out.priorBed;
  out.alert = out.drift !== null && out.drift >= 30 && out.n >= 3;
  return out;
}

// [{date, value}] for a numeric field over the last `days` days, skipping days without data.
function healthSeries(health, today, days, field) {
  var start = addDays(today, -(days - 1)), out = [];
  rowsBetween_(health, start, today).sort(byDateAsc_).forEach(function (r) {
    var v = field === 'bedLine' ? bedLine_(r.bed) : Number(r[field]);
    if (notNull_(v) && v > 0) out.push({ date: r.date, value: v });
  });
  return out;
}

function checkinOn(checkins, date) {
  var list = checkins || [];
  for (var i = 0; i < list.length; i++) if (list[i].date === date) return list[i];
  return null;
}

// Average of each 1-5 metric (and each custom one) over the last `days` days, and how many days each flag was ticked.
function checkinSummary(checkins, today, days) {
  var rows = rowsBetween_(checkins, addDays(today, -(days - 1)), today);
  var out = { n: rows.length, avg: {}, extra: {}, flags: {} };
  CHECKIN_METRICS.forEach(function (m) {
    out.avg[m.key] = mean_(rows.map(function (r) { return Number(r[m.key]); }).filter(function (x) { return x > 0; }));
  });
  var extraVals = {};
  rows.forEach(function (r) {
    var e = r.extra || {};
    for (var k in e) if (Number(e[k]) > 0) (extraVals[k] = extraVals[k] || []).push(Number(e[k]));
    (r.flags || []).forEach(function (f) { out.flags[f] = (out.flags[f] || 0) + 1; });
  });
  for (var k in extraVals) out.extra[k] = mean_(extraVals[k]);
  return out;
}

// ---- strength log ----

// What to do next time for one move, from the history of that move.
function strengthAdvice(move, rows) {
  var mine = (rows || []).filter(function (r) { return r.move === move.name; }).sort(byDateAsc_).reverse();
  var last = mine[0] || null;
  var target = move.sets + ' 組 × ' + move.repsLow + (move.repsHigh > move.repsLow ? '–' + move.repsHigh : '') + ' ' + move.unit;
  if (!last) return { last: null, target: target, ready: false, best: 0, text: '第一次：先用輕鬆的重量，把動作做標準' };
  var reps = last.reps || [];
  var hit = reps.length >= move.sets && reps.slice(0, move.sets).every(function (n) { return n >= move.repsHigh; });
  var best = 0;
  mine.forEach(function (r) { if (Number(r.weight) > best) best = Number(r.weight); });
  return {
    last: last, target: target, ready: hit, best: best,
    text: hit ? '上次每組都做到 ' + move.repsHigh + ' ' + move.unit + '，這次加一階：' + (move.progress || '加重或放慢') : '目標是每組做到 ' + move.repsHigh + ' ' + move.unit + '，再練一次'
  };
}

// A and B days take turns: the day after the one logged last.
function nextStrengthDay(moves, rows) {
  var byName = {}, lastDate = '';
  (moves || []).forEach(function (m) { byName[m.name] = m; });
  (rows || []).forEach(function (r) { if (byName[r.move] && r.date > lastDate) lastDate = r.date; });
  if (!lastDate) return 'A';
  var count = { A: 0, B: 0 };
  rows.forEach(function (r) { if (r.date === lastDate && byName[r.move]) count[byName[r.move].day] = (count[byName[r.move].day] || 0) + 1; });
  return count.A >= count.B ? 'B' : 'A';
}

function repsText(reps) { return (reps || []).join('、'); }

// "12,12,10" -> [12, 12, 10]; anything that is not a positive whole number is dropped.
function parseReps(s) {
  return String(s === undefined || s === null ? '' : s).split(/[,、\s]+/).map(function (x) { return parseInt(x, 10); }).filter(function (n) { return n > 0 && n < 1000; });
}

// ---- goals 1 / 2 / 3: how the tasks mapped to each goal did this week against last week ----

function goalRate_(tasks, ids, idx, leave, endDate) {
  var due = 0, done = 0;
  var start = addDays(endDate, -6);
  tasks.forEach(function (t) {
    if (!t.active || ids.indexOf(t.id) < 0) return;
    if (isAccumFreq(t.freq)) {
      if (t.freq.indexOf('weekly') !== 0) return;
      var p = progress(t, endDate, idx);
      due += 1; done += Math.min(1, p.done / p.target);
      return;
    }
    for (var d = start; d <= endDate; d = addDays(d, 1)) {
      if (leave[d] || !isScheduled(t, d) || isWaived(t, d, idx)) continue;
      due++;
      if (isDone(t, d, idx)) done++;
    }
  });
  return due ? done / due : null;
}

function goalProgress(tasks, goalMap, idx, leave, today) {
  return GOALS.map(function (g) {
    var ids = (goalMap || []).filter(function (m) { return m.goal === g.id; }).map(function (m) { return m.taskId; });
    var rate = goalRate_(tasks, ids, idx, leave, today), prev = goalRate_(tasks, ids, idx, leave, addDays(today, -7));
    return { id: g.id, name: g.name, icon: g.icon, tasks: ids.length, rate: rate, prev: prev, delta: rate !== null && prev !== null ? rate - prev : null };
  });
}

// ---- monthly review ----

function monthWindow_(month, today) {
  var y = +month.slice(0, 4), m = +month.slice(5, 7);
  var last = fmtDate_(new Date(Date.UTC(y, m, 0)));
  return { start: month + '-01', end: last < today ? last : today };
}

function reviewOf_(data, month, today) {
  var w = monthWindow_(month, today), out = { month: month, start: w.start, end: w.end };
  if (w.end < w.start) return out;
  var idx = indexLogs(data.logs || [], data.exempts || [], data.extras), leave = indexLeave(data.leave || []);
  var due = 0, done = 0, qualified = 0, days = 0;
  for (var d = w.start; d <= w.end; d = addDays(d, 1)) {
    var st = dayStats(data.tasks || [], d, idx, leave);
    if (st.rate === null) continue;
    days++; due += st.due; done += st.done;
    if (st.rate >= OVERALL_THRESHOLD) qualified++;
  }
  out.days = days; out.rate = due ? done / due : null; out.qualified = qualified;
  var hs = rowsBetween_(data.health || [], w.start, w.end).sort(byDateAsc_);
  var sleepRows = hs.filter(hasSleep_);
  out.sleepMin = mean_(sleepRows.map(function (r) { return Number(r.sleepMin); }));
  out.bed = mean_(sleepRows.map(function (r) { return bedLine_(r.bed); }).filter(notNull_));
  out.steps = mean_(hs.map(function (r) { return Number(r.steps); }).filter(function (x) { return x > 0; }));
  out.rhr = mean_(hs.map(function (r) { return Number(r.rhr); }).filter(function (x) { return x > 0; }));
  var ws = hs.filter(function (r) { return Number(r.weight) > 0; }), fs = hs.filter(function (r) { return Number(r.bodyFat) > 0; });
  out.weightFirst = ws.length ? Number(ws[0].weight) : null; out.weightLast = ws.length ? Number(ws[ws.length - 1].weight) : null;
  out.fatFirst = fs.length ? Number(fs[0].bodyFat) : null; out.fatLast = fs.length ? Number(fs[fs.length - 1].bodyFat) : null;
  var zone = 0, strengthDays = {};
  var byId = {};
  (data.tasks || []).forEach(function (t) { byId[t.id] = t; });
  (data.logs || []).forEach(function (l) {
    if (l.date < w.start || l.date > w.end) return;
    var t = byId[l.taskId];
    if (!t) return;
    if (t.freq === 'weekly_min' && /跑|Zone/.test(t.name)) zone += Number(l.minutes) || 0;
    if (/重量/.test(t.name)) strengthDays[l.date] = true;
  });
  (data.strength || []).forEach(function (r) { if (r.date >= w.start && r.date <= w.end) strengthDays[r.date] = true; });
  out.zone2Min = zone; out.strengthDays = Object.keys(strengthDays).length;
  var cs = checkinSummary(data.checkins || [], w.end, daysBetween(w.start, w.end) + 1);
  out.checkins = cs.n; out.energy = cs.avg.energy; out.mood = cs.avg.mood; out.stress = cs.avg.stress; out.sore = cs.avg.sore;
  return out;
}

function monthReview(data, month, today) {
  var prev = addDays(month + '-01', -1).slice(0, 7);
  return { cur: reviewOf_(data, month, today), prev: reviewOf_(data, prev, today) };
}

// Plain-text summary: easy to paste into a chat for a proper review.
function monthReviewText(rev) {
  var c = rev.cur, p = rev.prev, L = [];
  function pctOf(r) { return r === null || r === undefined ? '—' : Math.round(r * 100) + '%'; }
  function hrs(m) { return notNull_(m) ? (Math.round(m / 6) / 10) + ' 小時' : '—'; }
  L.push(c.month + ' 月回顧（' + c.start + ' ～ ' + c.end + '）');
  L.push('必做完成率 ' + pctOf(c.rate) + (p.rate !== null && p.rate !== undefined ? '（上月 ' + pctOf(p.rate) + '）' : '') + '，達標 ' + c.qualified + ' 天');
  L.push('睡眠 平均 ' + hrs(c.sleepMin) + (notNull_(p.sleepMin) ? '（上月 ' + hrs(p.sleepMin) + '）' : '') + '，平均入睡 ' + (notNull_(c.bed) ? fmtClock_(c.bed) : '—') + (notNull_(p.bed) ? '（上月 ' + fmtClock_(p.bed) + '）' : ''));
  L.push('步數 平均 ' + (notNull_(c.steps) ? Math.round(c.steps) : '—') + (notNull_(p.steps) ? '（上月 ' + Math.round(p.steps) + '）' : '') + '，最低心率平均 ' + (notNull_(c.rhr) ? Math.round(c.rhr) : '—'));
  if (notNull_(c.weightFirst)) L.push('體重 ' + c.weightFirst + ' → ' + c.weightLast + ' kg' + (notNull_(c.fatFirst) ? '，體脂 ' + c.fatFirst + ' → ' + c.fatLast + '%' : ''));
  L.push('重量訓練 ' + c.strengthDays + ' 天（上月 ' + (p.strengthDays || 0) + '），Zone 2 共 ' + c.zone2Min + ' 分鐘（上月 ' + (p.zone2Min || 0) + '）');
  if (c.checkins) L.push('自評（' + c.checkins + ' 天）精力 ' + (notNull_(c.energy) ? c.energy.toFixed(1) : '—') + '、心情 ' + (notNull_(c.mood) ? c.mood.toFixed(1) : '—') + '、壓力 ' + (notNull_(c.stress) ? c.stress.toFixed(1) : '—') + '、痠痛 ' + (notNull_(c.sore) ? c.sore.toFixed(1) : '—'));
  return L.join('\n');
}

// Daily ledger helpers: expenses (記帳), meals (餐費) and the diary (日記). Ported from the old 手機記錄 project (mobile_reminders/src/Logic.gs),
// so the rows written here have exactly the shape the rest of that system (budget alerts, pasting into the workbook) expects.
// Concatenated after insights.js by build.py; it uses logic.js functions (toDate_, ...) directly.

// Sheet YAAG: one sheet per year; the diary column is 2 * month (1-based); the row is day + 1.
function yaagCell(dateStr) {
  var d = toDate_(dateStr);
  return { sheetName: String(d.getUTCFullYear()), row: d.getUTCDate() + 1, col: 2 * (d.getUTCMonth() + 1) };
}

function appendDiary(existing, addition) {
  var add = String(addition).trim();
  if (!add) return existing;
  var old = String(existing).replace(/\s+$/, '');
  return old ? old + '\n' + add : add;
}

// A cell that starts with = + - @ would be read as a formula; a leading apostrophe keeps it text.
function safeSheetText(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fullwidthDigits_(raw) {
  return String(raw).replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/[,，\s]/g, '');
}

function parseAmount(raw) {
  if (raw === null || raw === undefined) throw new Error('金額不正確，請輸入大於 0 的數字');
  var s = fullwidthDigits_(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('金額不正確，請輸入大於 0 的數字');
  var n = Math.round(parseFloat(s));
  if (!(n > 0)) throw new Error('金額不正確，請輸入大於 0 的數字');
  return n;
}

// -> [日期, 年月, 收支類型, 大類, 子類, 項目描述, 現金金額, 刷卡金額, 總金額, 備註]
function expenseRow(input) {
  toDate_(input.date);
  if (input.type !== '支出' && input.type !== '收入') throw new Error('收支類型不正確');
  if (input.method !== '現金' && input.method !== '刷卡') throw new Error('付款方式不正確');
  if (!String(input.category || '').trim()) throw new Error('請選擇大類');
  var amt = parseAmount(input.amount);
  var cash = input.method === '現金';
  return [input.date, input.date.slice(0, 7), input.type,
    safeSheetText(input.category), safeSheetText(input.sub || ''), safeSheetText(input.desc || ''),
    cash ? amt : 0, cash ? '' : amt, amt, safeSheetText(input.note || '')];
}

// ---- 餐費 (mirrors sheet 3_每日餐費 columns A..O: 日期 年月 星期, then 內容/分數/金額 x 4 meals) ----
var MEAL_COLS_ = { '早餐': 4, '午餐': 7, '晚餐': 10, '消夜': 13 };
var MEAL_NAMES = ['早餐', '午餐', '晚餐', '消夜'];

function mealColumns(meal) {
  if (!MEAL_COLS_.hasOwnProperty(meal)) throw new Error('餐別不正確');
  return { content: MEAL_COLS_[meal], amount: MEAL_COLS_[meal] + 2 };
}

// Blank means "no amount"; zero is allowed (a free meal); negatives and text are rejected.
function parseMealAmount(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return 0;
  var s = fullwidthDigits_(raw);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('金額不正確，請輸入 0 或正數');
  return Math.round(parseFloat(s));
}

// existing: the 15-element row of that date (or null). Returns a NEW 15-element row.
// The same meal twice: contents joined by a space, amounts added. The 分數 columns stay blank (sheet formulas own them).
function mergeMeal(existing, input) {
  var d = toDate_(input.date);
  var c = mealColumns(input.meal);
  var content = String(input.content || '').trim();
  var amount = parseMealAmount(input.amount);
  if (!content && amount === 0) throw new Error('請填寫內容或金額');
  var row = existing ? existing.slice() : [];
  for (var i = 0; i < 15; i++) if (row[i] === undefined || row[i] === null) row[i] = '';
  row[0] = input.date;
  row[1] = input.date.slice(0, 7);
  row[2] = '日一二三四五六'.charAt(d.getUTCDay());
  var old = String(row[c.content - 1]);
  row[c.content - 1] = old && content ? old + ' ' + content : (old || content);
  var prev = row[c.amount - 1] === '' ? 0 : Number(row[c.amount - 1]);
  var total = prev + amount;
  row[c.amount - 1] = (total > 0 || row[c.amount - 1] !== '') ? total : '';
  return row;
}

// Meal to preselect for a clock hour (0-23).
function defaultMeal(hour) { return hour < 10 ? '早餐' : hour < 15 ? '午餐' : hour < 21 ? '晚餐' : '消夜'; }

// Custom reminders (待辦提醒) and the budget view, ported from the old 手機記錄 project (mobile_reminders/src/Logic.gs and BudgetLogic.gs).
// The reminders themselves are still sent by that project's 5-minute trigger from the same sheet 提醒清單; the habit app only edits the list.
// Concatenated after ledger.js by build.py; it uses logic.js functions (toDate_, ...) directly.

function isValidDate(dateStr) {
  try { toDate_(dateStr); return true; } catch (e) { return false; }
}

function normalizeTime(raw) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Error('時間格式需為 HH:MM');
  return (m[1].length < 2 ? '0' : '') + m[1] + ':' + m[2];
}

// Validates and normalises user-supplied todo input; the id is assigned by the caller.
// repeat: once (needs a date) / daily / weekly (weekdays 0-6, Sunday = 0) / monthly (monthDay 1-31).
function validateTodo(t) {
  var text = String(t.text || '').trim();
  if (!text) throw new Error('請填寫提醒內容');
  var time;
  try { time = normalizeTime(t.time); } catch (e) { throw new Error('時間格式需為 HH:MM'); }
  var repeat = t.repeat || 'once';
  if (['once', 'daily', 'weekly', 'monthly'].indexOf(repeat) === -1) throw new Error('重複方式不正確');
  var date = '', weekdays = [], monthDay = 0;
  if (repeat === 'once') {
    date = String(t.date || '');
    if (!isValidDate(date)) throw new Error('請選擇有效日期');
  } else if (repeat === 'weekly') {
    weekdays = (t.weekdays || []).map(Number);
    if (!weekdays.length || weekdays.some(function (w) { return !(w >= 0 && w <= 6 && w % 1 === 0); })) throw new Error('請選擇星期');
  } else if (repeat === 'monthly') {
    monthDay = Number(t.monthDay);
    if (!(monthDay >= 1 && monthDay <= 31 && monthDay % 1 === 0)) throw new Error('每月日期需為 1~31 日');
  }
  return {
    id: t.id || '', text: text, time: time, repeat: repeat, date: date, weekdays: weekdays, monthDay: monthDay,
    enabled: t.enabled === undefined ? true : !!t.enabled, done: !!t.done, lastSent: t.lastSent || ''
  };
}

// The next day a todo is due on or after `today` ('' when it never comes again). Sunday = 0 in t.weekdays, like the reminder sheet.
function todoNextDate(t, today) {
  if (t.repeat === 'once') return t.date || '';
  var i, d;
  if (t.repeat === 'daily') return today;
  if (t.repeat === 'weekly') {
    for (i = 0; i < 7; i++) { d = addDays(today, i); if ((t.weekdays || []).indexOf(weekdayOf(d) % 7) >= 0) return d; }
    return '';
  }
  if (t.repeat === 'monthly') {
    for (i = 0; i < 62; i++) {
      d = addDays(today, i);
      var dom = Number(d.slice(8, 10)), last = daysInMonth_(d.slice(0, 7));
      if (dom === Math.min(Number(t.monthDay), last)) return d;
    }
  }
  return '';
}

// Splits the list for the 待辦 page: today / within 7 days / later (soonest first), and past (done, or a one-time item whose day has gone).
function groupTodos(todos, today) {
  var g = { today: [], week: [], later: [], past: [] }, week = addDays(today, 7);
  function key(t) { return (todoNextDate(t, today) || '9999-99-99') + ' ' + (t.time || ''); }
  todos.forEach(function (t) {
    var nx = todoNextDate(t, today);
    if (t.done || !nx || (t.repeat === 'once' && nx < today)) g.past.push(t);
    else if (nx === today) g.today.push(t);
    else if (nx <= week) g.week.push(t);
    else g.later.push(t);
  });
  ['today', 'week', 'later'].forEach(function (k) { g[k].sort(function (a, b) { return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0; }); });
  g.past.sort(function (a, b) { return (b.date || '') < (a.date || '') ? -1 : 1; });
  return g;
}

function describeTodo(t) {
  var wd = ['日', '一', '二', '三', '四', '五', '六'];
  var when = { once: t.date, daily: '每天', weekly: '每週' + (t.weekdays || []).map(function (d) { return wd[d]; }).join('、'), monthly: '每月' + t.monthDay + '日' }[t.repeat];
  return when + ' ' + t.time;
}

// ---- Budget (read-only view of the old budget alerts). Budget = mean monthly spend over the last 12 months x BUDGET_BUFFER, unless overridden. ----

var BUDGET_BUFFER = 1.2;
var BUDGET_MIN_MONTHS = 9;
var BUDGET_MEAL_CAT = '餐費';
var BUDGET_EXCLUDED = ['房租', '保險', '醫療', '債', '旅遊', '禮金', '報稅', '器材', '其他支出', '其他未列支出', '按摩', '文書'];
var BUDGET_MEAL_COLS = ['早餐金額', '午餐金額', '晚餐金額', '消夜金額'];
var MIRROR_MEAL_HEADER = ['日期', '總額'];

function isNum_(v) { return typeof v === 'number' && isFinite(v); }

// First row that contains every header name, or -1.
function findHeaderRow(values, names) {
  for (var i = 0; i < values.length; i++) {
    var row = values[i].map(String);
    if (names.every(function (n) { return row.indexOf(n) >= 0; })) return i;
  }
  return -1;
}

// 總金額 when it is a number, otherwise 現金 + 刷卡 (anything non-numeric counts as 0).
function rowAmount(r) {
  if (isNum_(r.total)) return r.total;
  return (isNum_(r.cash) ? r.cash : 0) + (isNum_(r.card) ? r.card : 0);
}

// The n months before ym ('YYYY-MM'), newest first.
function lastMonths(ym, n) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)), out = [];
  for (var i = 0; i < n; i++) {
    m--;
    if (m === 0) { m = 12; y--; }
    out.push(y + '-' + (m < 10 ? '0' : '') + m);
  }
  return out;
}

// rows: [{ym, cat, amount}] -> {cat: {ym: sum}}
function aggregateSpend(rows) {
  var out = {};
  rows.forEach(function (r) {
    if (!isNum_(r.amount)) return;
    out[r.cat] = out[r.cat] || {};
    out[r.cat][r.ym] = (out[r.cat][r.ym] || 0) + r.amount;
  });
  return out;
}

// settings: [{cat, budget: number|null, monitor: '自動'|'是'|'否'}]. Returns the monitored categories with a budget.
function buildPlan(hist, months, settings) {
  var byCat = {}, cats = {}, out = [];
  (settings || []).forEach(function (s) { byCat[s.cat] = s; cats[s.cat] = true; });
  Object.keys(hist).forEach(function (c) { cats[c] = true; });
  Object.keys(cats).sort().forEach(function (cat) {
    var s = byCat[cat] || {}, monitor = s.monitor || '自動';
    if (monitor === '否') return;
    var h = hist[cat] || {}, sum = 0, active = 0;
    months.forEach(function (m) { var v = h[m] || 0; sum += v; if (v > 0) active++; });
    var auto = Math.round(sum / months.length * BUDGET_BUFFER);
    var eligible = monitor === '是' || (active >= BUDGET_MIN_MONTHS && BUDGET_EXCLUDED.indexOf(cat) < 0);
    if (!eligible) return;
    if (isNum_(s.budget) && s.budget > 0) out.push({ cat: cat, budget: s.budget, source: '覆寫' });
    else if (auto > 0) out.push({ cat: cat, budget: auto, source: '自動' });
  });
  return out;
}

function mergeSpent(mirror, inbox) {
  var out = {};
  [mirror, inbox].forEach(function (src) { Object.keys(src).forEach(function (c) { out[c] = (out[c] || 0) + src[c]; }); });
  return out;
}

function buildUsage(plan, spent) {
  return plan.map(function (p) {
    var s = spent[p.cat] || 0;
    return { cat: p.cat, spent: s, budget: p.budget, pct: Math.round(s / p.budget * 100), source: p.source };
  }).sort(function (a, b) { return b.pct - a.pct; });
}

function dayNumber_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000 : NaN;
}

// info: {sourceModified, mirrored, result} as displayed on the mirror's 更新資訊 sheet.
function mirrorUsable(info, today) {
  if (info.result !== '成功') return { ok: false, reason: '鏡像更新結果：' + (info.result || '空白') };
  var age = dayNumber_(today) - dayNumber_(info.mirrored);
  if (isNaN(age)) return { ok: false, reason: '讀不到鏡像更新時間' };
  if (age > 2) return { ok: false, reason: '鏡像已 ' + age + ' 天沒更新（最後 ' + info.mirrored + '）' };
  return { ok: true, reason: '' };
}

function excelNewerThanMirror(info) {
  if (!info.sourceModified || !info.mirrored) return false;
  return String(info.sourceModified) > String(info.mirrored);
}

// Sheet values -> objects keyed by the header row found via `required`; blank rows dropped.
function tableToObjects(values, required) {
  var h = findHeaderRow(values, required);
  if (h < 0) throw new Error('找不到表頭：' + required.join('、'));
  var head = values[h].map(String), out = [];
  values.slice(h + 1).forEach(function (row) {
    if (row.every(function (c) { return c === '' || c === null; })) return;
    var o = {};
    head.forEach(function (name, i) { if (name) o[name] = row[i]; });
    out.push(o);
  });
  return out;
}

// Phone 餐費收件匣: one 金額 column per meal.
function mealAmount(o) {
  return BUDGET_MEAL_COLS.reduce(function (s, c) { return s + (isNum_(o[c]) ? o[c] : 0); }, 0);
}

// The mirror's 3_每日餐費 has a two-row header whose four meal columns are all just 金額; 總額 is their sum.
function mirrorMealAmount(o) { return isNum_(o['總額']) ? o['總額'] : 0; }

// Pure helpers for the 夢想 page and the passive-income achievements. The data lives in the 「50夢想」 Google sheet
// (tab 夢想清單: 編號, 主軸, 夢想, 狀態, 目標年份, 達成年份, 對應系統, 下一步, 自動進度); nothing here touches Sheets.

var DREAM_STATUSES = ['未開始', '進行中', '已排定', '已達成'];
var DREAM_COV_STEPS = [50, 100, 150];

// rows: the sheet values including the header row. Blank rows and rows without a dream name are dropped.
// progress is a fraction 0..1 or null when the sheet has no automatic figure for that dream.
function parseDreams(rows) {
  var items = [];
  (rows || []).slice(1).forEach(function (r) {
    var name = String(r[2] == null ? '' : r[2]).trim();
    if (!name) return;
    var status = String(r[3] == null ? '' : r[3]).trim();
    if (DREAM_STATUSES.indexOf(status) < 0) status = '未開始';
    var p = r[8] === '' || r[8] == null ? null : Number(r[8]);
    items.push({
      id: String(r[0] == null ? '' : r[0]).trim(), axis: String(r[1] == null ? '' : r[1]).trim() || '其他', name: name, status: status,
      targetYear: String(r[4] == null ? '' : r[4]).trim(), doneYear: String(r[5] == null ? '' : r[5]).trim(),
      source: String(r[6] == null ? '' : r[6]).trim(), next: String(r[7] == null ? '' : r[7]).trim(),
      progress: p == null || !isFinite(p) ? null : Math.max(0, Math.min(1, p))
    });
  });
  var axes = [], byAxis = {};
  items.forEach(function (it) {
    var a = byAxis[it.axis];
    if (!a) { a = byAxis[it.axis] = { name: it.axis, total: 0, done: 0, planned: 0, doing: 0 }; axes.push(a); }
    a.total++;
    if (it.status === '已達成') a.done++;
    else if (it.status === '已排定') a.planned++;
    else if (it.status === '進行中') a.doing++;
  });
  var done = items.filter(function (it) { return it.status === '已達成'; }).length;
  return { items: items, axes: axes, total: items.length, done: done };
}

// rows: the A:B values of the 進度 tab. Returns the 被動收入覆蓋率 as a fraction (1.131 = 113.1%), or null if the label is missing.
function parseDreamCoverage(rows) {
  for (var i = 0; i < (rows || []).length; i++) {
    if (String(rows[i][0] || '').trim() === '被動收入覆蓋率') {
      var n = Number(rows[i][1]);
      return isFinite(n) && rows[i][1] !== '' ? n : null;
    }
  }
  return null;
}

// Stored as "50:2026-11-02,100:2026-11-02": the first day each coverage step was seen reached. Never removed, so an
// achievement stays unlocked if the coverage later dips.
function parseDreamCovHits(text) {
  var hits = {};
  String(text || '').split(',').forEach(function (p) {
    var m = /^(\d+):(\d{4}-\d{2}-\d{2})$/.exec(p.trim());
    if (m) hits[m[1]] = m[2];
  });
  return hits;
}

function dreamCovHits(text, coverage, today) {
  var hits = parseDreamCovHits(text), changed = false;
  if (coverage != null) {
    DREAM_COV_STEPS.forEach(function (s) {
      if (coverage * 100 >= s && !hits[String(s)]) { hits[String(s)] = today; changed = true; }
    });
  }
  var value = DREAM_COV_STEPS.filter(function (s) { return hits[String(s)]; }).map(function (s) { return s + ':' + hits[String(s)]; }).join(',');
  return { value: value, changed: changed };
}

// 飲食狀態: four tap-counter tasks (早餐飲食 .. 消夜飲食) record what each meal contained. The score rules are the ones the old sheet
// 3_每日餐費 used (formulas E/H/K/N), minus 🏋 (exercise is logged on its own). Pure helpers; concatenated after dreams.js by build.py.

var DIET_MEALS = ['早餐', '午餐', '晚餐', '消夜'];
var DIET_NEG = ['🥤', '🍟', '🍷', '🍩'];
var DIET_POS = ['🥗', '🥬', '🍎'];
var DIET_INFO = ['🍖'];   // recorded and counted, but not scored (so months stay comparable with the old 飲食分)
var DIET_PROTEIN = '🍖足量蛋白';
var DIET_PLAIN = '普通（沒有特別狀況）';
var DIET_MARK = '#計數';   // first option line: this task uses the tap-counter window instead of the number inputs
var DIET_OPTIONS = [DIET_MARK, '🥤含糖飲料', '🍟炸物', '🍷酒', '🍩甜點', '🥗健康餐', '🥬足量蔬菜', '🍎水果', DIET_PROTEIN, DIET_PLAIN];

// Existing meal tasks were created before 🍖 existed: show it anyway (just before 普通) so no sheet migration is needed.
function counterLabels(t) {
  var labels = t.options.slice(1);
  if (!labels.some(function (o) { return String(o).indexOf(DIET_INFO[0]) === 0; })) {
    var at = labels.indexOf(DIET_PLAIN);
    labels.splice(at < 0 ? labels.length : at, 0, DIET_PROTEIN);
  }
  return labels;
}

function isCounterTask(t) { return !!(t && t.options && t.options.length && t.options[0] === DIET_MARK); }

// '午餐飲食' -> '午餐'; any other task -> null.
function dietMealOf(t) {
  var name = t && t.name ? String(t.name) : '';
  for (var i = 0; i < DIET_MEALS.length; i++) if (name === DIET_MEALS[i] + '飲食') return DIET_MEALS[i];
  return null;
}

// Note like '🥤含糖飲料*2、🍟炸物' -> {'🥤': 2, '🍟': 1, ...}; an item without *N counts once.
function dietCounts(note) {
  var out = {};
  DIET_NEG.concat(DIET_POS, DIET_INFO).forEach(function (e) { out[e] = 0; });
  parseNote(note).forEach(function (p) {
    DIET_NEG.concat(DIET_POS, DIET_INFO).forEach(function (e) {
      if (p.base.indexOf(e) === 0) out[e] += p.count > 0 ? p.count : 1;
    });
  });
  return out;
}

function dietClamp_(lo, hi, x) { return Math.max(lo, Math.min(hi, x)); }

// 早/午/晚: 3 - bad + good, 0..5. 消夜: 1 - bad + good, -2..2 (an unlogged 消夜 is "didn't eat", worth +1: see dietDay).
function dietMealScore(meal, note) {
  var c = dietCounts(note), delta = 0;
  DIET_NEG.forEach(function (e) { delta -= c[e]; });
  DIET_POS.forEach(function (e) { delta += c[e]; });
  return meal === '消夜' ? dietClamp_(-2, 2, 1 + delta) : dietClamp_(0, 5, 3 + delta);
}

// Logged meals of one day, or null when none of the four was logged.
function dietDay(tasks, logs, date) {
  var mealOf = {}, i;
  for (i = 0; i < tasks.length; i++) { var m = dietMealOf(tasks[i]); if (m) mealOf[tasks[i].id] = m; }
  var notes = {};
  for (i = 0; i < logs.length; i++) {
    var l = logs[i];
    if (l.date === date && mealOf[l.taskId] && String(l.note || '').trim()) notes[mealOf[l.taskId]] = l.note;
  }
  var logged = DIET_MEALS.filter(function (x) { return notes[x] !== undefined; });
  if (!logged.length) return null;
  var total = 0, counts = dietCounts('');
  DIET_MEALS.forEach(function (x) {
    if (notes[x] !== undefined) {
      total += dietMealScore(x, notes[x]);
      var c = dietCounts(notes[x]);
      Object.keys(c).forEach(function (e) { counts[e] += c[e]; });
    } else if (x === '消夜') total += 1;
  });
  return { date: date, logged: logged, total: total, counts: counts };
}

// Month/quarter numbers. avgDaily: mean day total; score100: the same on a 0..100 scale (16 is the best possible day), which is the figure the old OneNote 飲食分 held.
function dietPeriod(tasks, logs, start, end) {
  var out = { days: 0, avgDaily: null, score100: null, totals: dietCounts(''), dayCounts: dietCounts('') }, sum = 0;
  for (var d = start; d <= end; d = addDays(d, 1)) {
    var day = dietDay(tasks, logs, d);
    if (!day) continue;
    out.days++; sum += day.total;
    Object.keys(day.counts).forEach(function (e) {
      out.totals[e] += day.counts[e];
      if (day.counts[e] > 0) out.dayCounts[e]++;
    });
  }
  if (out.days) {
    out.avgDaily = Math.round(sum / out.days * 100) / 100;
    out.score100 = Math.round(sum / out.days / 16 * 1000) / 10;
  }
  return out;
}

// 歷史對照: months before HISTORY_FROM are the hand-written numbers of the 「歷史月統計」 tab; from HISTORY_FROM on, the same kind of
// numbers are worked out from the app's own records (training tab, task check-ins, 小失誤, 飲食狀態). Pure helpers; concatenated by build.py.

var HISTORY_FROM = '2026-11';

// Training-menu item id -> the history row it counts toward; warm-up style items (core, pelvic, hip, walk) count for nothing.
function trainKindOf(item) {
  item = String(item || '');
  if (item.indexOf('run') === 0 || item === 'test10k') return '有氧';
  if (item.indexOf('strength') === 0 || item.indexOf('home-') === 0 || item === 'kb-interval') return '重訓';
  if (item === 'yoga') return '瑜珈';
  return null;
}

function addDates_(set, date) { set[date] = true; }
function size_(set) { return Object.keys(set).length; }

// data: {tasks, logs, train, slips, slipItems}. Days in `ym` per row, or null when the app has nothing for that month.
function monthAutoStats(data, ym) {
  var tasks = data.tasks || [], logs = data.logs || [], train = data.train || [], slips = data.slips || [], slipItems = data.slipItems || [];
  var inMonth = function (r) { return monthKey(r.date) === ym; };
  var any = logs.some(inMonth) || train.some(inMonth) || slips.some(inMonth);
  if (!any) return null;
  var days = { '有氧': {}, '重訓': {}, '瑜珈': {}, '飲酒': {}, '閱讀（天）': {} }, byId = {};
  tasks.forEach(function (t) { byId[t.id] = t; });
  train.filter(inMonth).forEach(function (r) { var k = trainKindOf(r.item); if (k) addDates_(days[k], r.date); });
  logs.filter(inMonth).forEach(function (l) {
    var t = byId[l.taskId];
    if (!t) return;
    var name = t.name || '';
    if (t.freq === 'weekly_min' && /跑|Zone 2/.test(name)) addDates_(days['有氧'], l.date);
    if (/重量訓練/.test(name)) addDates_(days['重訓'], l.date);
    if (name === '閱讀') addDates_(days['閱讀（天）'], l.date);
  });
  var boozeIds = {};
  slipItems.forEach(function (i) { if (i.name === '飲酒') boozeIds[i.id] = true; });
  slips.filter(inMonth).forEach(function (s) { if (boozeIds[s.item]) addDates_(days['飲酒'], s.date); });
  var out = {};
  Object.keys(days).forEach(function (k) { out[k] = size_(days[k]); });
  var dp = dietPeriod(tasks, logs, ym + '-01', ym + '-' + (daysInMonth_(ym) < 10 ? '0' : '') + daysInMonth_(ym));
  if (dp.days) { out['炸物'] = dp.totals['🍟']; out['飲食分'] = dp.score100; }
  return out;
}

// oldRows: [{month, item, count}] from the tab. Adds one row per item for every month from HISTORY_FROM up to today's month that has app data.
function historyWithAuto(oldRows, data, today) {
  var rows = (oldRows || []).slice(), last = monthKey(today);
  for (var ym = HISTORY_FROM; ym <= last; ym = monthKey(addDays(ym + '-28', 4))) {
    var m = monthAutoStats(data, ym);
    if (!m) continue;
    Object.keys(m).forEach(function (item) { rows.push({ month: ym, item: item, count: m[item], auto: true }); });
  }
  return rows;
}
