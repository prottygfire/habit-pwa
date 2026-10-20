// GENERATED from shared/logic.js and shared/game.js by build.py. Edit the sources, not this copy.
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
// exempts: [{date, taskId}] days on which a 免責券 waived that task; they are looked up as 'x|date|id'.
function indexLogs(logs, exempts) {
  var idx = {};
  for (var x = 0; x < (exempts || []).length; x++) idx['x|' + exempts[x].date + '|' + exempts[x].taskId] = true;
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
  if (isBonus(task) || !task.remind || isExempt(task, date, idx) || !isDue(task, date, idx)) return false;
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
    if (!isFixedMust_(t) || !isScheduled(t, date) || isExempt(t, date, idx)) continue;
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
  if (isScheduled(task, d) && !leave[d] && !isExempt(task, d, idx) && !isDone(task, d, idx)) d = addDays(d, -1);
  for (i = 0; i < LOOKBACK_DAYS; i++, d = addDays(d, -1)) {
    if (leave[d] || !isScheduled(task, d) || isExempt(task, d, idx)) continue;
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
      if (!isFixedMust_(t) || !isScheduled(t, d) || isExempt(t, d, idx)) continue;
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
    if (l.date < start || l.date > end || !t) continue;
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
// Sources: Samsung 練跑教練 level 4 (4 weeks, goal 10 km in 1:09:09), the 12-week fitness plan (docx), and the fixed weekly classes.
// Week 1 starts on `start` (a Monday). Weekday numbers: 1 = Monday ... 7 = Sunday.

var TRAIN_WEEKS = 12;
var TRAIN_STATES = ['精神好', '普通', '疲勞'];

// Samsung plan: [id, title, km, minutes, quality]. Minutes are the planned durations from the app.
var RUN_PLAN = [
  [['run01', '慢跑', 4, 30, false], ['run02', '低強度間歇跑', 2.46, 28, true], ['run03', '慢跑', 4.19, 30, false], ['run04', '慢跑', 6, 45, false]],
  [['run05', '慢跑', 4.29, 30, false], ['run06', '重複訓練', 1.8, 22, true], ['run07', '慢跑', 5, 38, false], ['run08', '加速跑', 6, 43, true]],
  [['run09', '慢跑', 6, 44, false], ['run10', '爬坡間歇跑', 0, 20, true], ['run11', '慢跑', 8, 56, false], ['run12', '變速跑', 0, 40, true]],
  [['run13', '慢跑', 8, 56, false], ['run14', '重複訓練', 2.8, 31, true], ['run15', '加速跑', 8, 57, true]]
];

// 12-week plan progress table (weeks 1-12): Monday Zone 2 minutes, long Zone 2 minutes (the plan's Saturday).
var Z2_MINUTES = [45, 45, 50, 50, 50, 55, 55, 60, 60, 60, 60, 60];
var LONG_MINUTES = [60, 60, 60, 60, 70, 70, 75, 75, 75, 80, 90, 75];

function hiitText_(week) {
  if (week <= 4) return '4 × 3 分鐘，每組後輕鬆 2 分鐘（高強度累積 12 分）';
  if (week <= 8) return '5 × 3 分鐘，每組後輕鬆 2 分鐘（高強度累積 15 分）';
  if (week <= 11) return '4 × 4 分鐘，每組後輕鬆 2–3 分鐘（高強度累積 16 分）';
  return '4 × 3 分鐘，恢復 2 分鐘（減量週）';
}

var STRENGTH_LOWER = ['腿推或深蹲　4 × 6–10', '羅馬尼亞硬舉　3 × 8–12', '保加利亞分腿蹲　3 × 每側 8–12（先在無痛範圍）', '臀推　3 × 10–15', '腿彎舉　3 × 12–15', '小腿提踵　3 × 15–20（小腿不適就減量）', '靠牆靜蹲　2 × 45–90 秒'];
var STRENGTH_UPPER = ['臥推或伏地挺身　3 × 8–12', '坐姿划船　3 × 10–15', '高位下拉　3 × 10–15', '肩推　3 × 8–12', '臀橋　3 × 15–20（頂端停 1–2 秒）', 'Pallof press　3 × 每側 12', 'Dead bug　3 × 每側 10', '臀橋等長　2 × 30–45 秒'];
var CORE_MOVES = ['Plank　3 × 45–60 秒', 'Side plank　3 × 每側 30–45 秒', 'Dead bug　3 × 每側 10', 'Pallof press　3 × 每側 12'];
var PELVIC_MOVES = ['慢收縮：輕到中等力收縮 5 秒、完全放鬆 5 秒，共 8 次（正常呼吸，不憋氣）', '快速收縮：收 1 秒、放 1 秒，共 10 次', '腹式呼吸與放鬆 1–2 分鐘', '若有疼痛、排尿不適或會陰緊繃，先不要加量，請專業人員評估'];
var HIP_MOVES = ['髖屈肌伸展（弓箭步）　每側 30–45 秒', '4 字（鴿式）伸展　每側 30–45 秒', '90/90 髖轉換　8 次', '全程不痛、不彈震，呼吸放鬆'];

function trainItem_(id, kind, title, icon, minutes, detail, easy, up, extra) {
  var o = { id: id, kind: kind, title: title, icon: icon, minutes: minutes, detail: detail, easy: easy, up: up || '', fixed: false, time: '白天' };
  for (var k in (extra || {})) o[k] = extra[k];
  return o;
}

function runItem_(r) {
  var label = r[1] + (r[2] ? ' ' + r[2] + ' 公里' : '') + '・' + r[3] + ' 分';
  var easyText = r[4] ? '身體累就改成 20–30 分鐘輕鬆慢跑或快走，或直接休息' : '身體累就縮短到 20–30 分鐘，或改快走';
  var detail = ['三星練跑教練・' + label, r[4] ? '高強度段以 RPE 8／10 為準，不是全力衝刺' : '輕鬆配速（RPE 3–4／10），要能完整說完一句話'];
  return trainItem_(r[0], 'run', label, '🏃', r[3], detail, easyText, '', { planned: r[3], isRun: true });
}

function strengthItem_(week) {
  var lower = week % 2 === 1;
  return trainItem_(lower ? 'strength-lower' : 'strength-upper', 'strength', '重訓：' + (lower ? '下肢肌力＋肌耐力' : '上肢＋臀髖＋核心'), '🏋️', 60,
    (lower ? STRENGTH_LOWER : STRENGTH_UPPER).concat(['RPE 7–8，保留 2–3 次餘力；髖緊就縮小動作幅度']),
    '每個動作減成 2 組，或只做伸展與活動度', '主要動作各多做 1 組，仍保留 2–3 次餘力', { fixed: true, time: '晚上' });
}

function yogaItem_() {
  return trainItem_('yoga', 'yoga', '瑜珈課', '🧘', 60, ['固定課程'], '', '', { fixed: true, time: '晚上' });
}

function coreItem_() { return trainItem_('core', 'core', '核心 10 分', '🔥', 10, CORE_MOVES, '每項 2 組', '每項多做 1 組'); }
function pelvicItem_() { return trainItem_('pelvic', 'pelvic', '骨盆底控制與呼吸', '🫁', 5, PELVIC_MOVES, '只做腹式呼吸放鬆', ''); }
function hipItem_() { return trainItem_('hip', 'mobility', '髖部放鬆 5 分', '🤸', 5, HIP_MOVES, '', ''); }
function walkItem_() { return trainItem_('walk', 'walk', '輕鬆走路 20–40 分', '🚶', 30, ['恢復日：慢慢走，不追速度'], '', ''); }

function cardioItems_(week, slotIdx) {
  // slotIdx: 0 Monday, 1 Wednesday, 2 Friday, 3 Sunday.
  if (week <= 4) {
    var r = RUN_PLAN[week - 1][slotIdx];
    return r ? [runItem_(r)] : [];
  }
  if (slotIdx === 0) {
    return [trainItem_('run-z2', 'run', 'Zone 2 慢跑 ' + Z2_MINUTES[week - 1] + ' 分', '🏃', Z2_MINUTES[week - 1],
      ['輕鬆配速（RPE 3–4／10），能完整說句子', '沒有飛輪／橢圓機就用慢跑或快走'], '縮短到 30 分鐘，或改快走', '', { planned: Z2_MINUTES[week - 1], isRun: true })];
  }
  if (slotIdx === 1) {
    return [trainItem_('run-hiit', 'run', '間歇跑', '⚡', 40,
      ['熱身 10 分鐘（逐步加速）', hiitText_(week), '高強度段 RPE 8／10，不是全力衝刺；恢復段 RPE 2–3', '收操 5–10 分鐘'], '改成 20–40 分鐘輕鬆有氧，或休息（前晚沒睡好、腿很痠、疲勞高時）', '', { planned: 40, isRun: true })];
  }
  if (slotIdx === 3) {
    var items = [trainItem_('run-long', 'run', '長時間 Zone 2 ' + LONG_MINUTES[week - 1] + ' 分', '🏃', LONG_MINUTES[week - 1],
      ['輕鬆配速（RPE 3–4／10）', '結束時應該還有餘力，不是耗竭', '前一晚做了下肢重訓的話，腿痠就縮短'], '縮短到 40 分鐘，或改快走', '', { planned: LONG_MINUTES[week - 1], isRun: true })];
    if (week === 5) items.push(trainItem_('test10k', 'run', '等級測試：跑 10 公里（目標 1:09:09）', '🏁', 70, ['三星練跑教練第 4 級的測試', '準備好再跑，沒有時間壓力'], '改天再測', '', { planned: 70, isRun: true }));
    return items;
  }
  return [];
}

// -> {week, started, finished, items:[...]} for one date. start: 'YYYY-MM-DD' of week 1's Monday.
function trainingMenu(date, start) {
  var diff = daysBetween(start, date);
  if (diff < 0) return { week: 0, started: false, finished: false, items: [] };
  var raw = Math.floor(diff / 7) + 1;
  var week = Math.min(raw, TRAIN_WEEKS), wd = weekdayOf(date), items = [];
  if (wd === 1) items = cardioItems_(week, 0).concat([coreItem_(), pelvicItem_()]);
  else if (wd === 2) items = [hipItem_(), pelvicItem_()];
  else if (wd === 3) items = cardioItems_(week, 1).concat([yogaItem_()]);
  else if (wd === 4) items = [yogaItem_(), walkItem_(), hipItem_(), pelvicItem_()];
  else if (wd === 5) items = cardioItems_(week, 2).concat([coreItem_(), pelvicItem_()]);
  else if (wd === 6) items = [strengthItem_(week)];
  else items = cardioItems_(week, 3).concat([pelvicItem_()]);
  return { week: week, started: true, finished: raw > TRAIN_WEEKS, items: items };
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
    trainingMenu: trainingMenu, trainVariant: trainVariant, trainingSummary: trainingSummary,
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
    '持久力玩家', '間歇掌控者', '力量鍛造師', '全能運動家', '體能宗師', '不倦的行者', '鋼鐵意志', '耐力傳奇', '巔峰身形', '體能傳說'],
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
  var idx = indexLogs(logs, data.exempts || []), leave = indexLeave(leaveArr);
  var byId = {};
  tasks.forEach(function (t) { byId[t.id] = t; });
  var logsBy = groupBy_(logs, 'date'), trainBy = groupBy_(train, 'date'), slipsBy = groupBy_(slips, 'date');
  var chBy = groupBy_(chs, 'date'), redBy = groupBy_(reds, 'date');

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
    cleanMax: 0, cleanCombo: 0, doneMax: 0, low: 0, glucose: 0, redCount: 0, early: false, fullDay: false, noLeave7: false
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
    } else if (!onLeave && st.due > 0 && !isToday) {
      S.streak = 0;
    }
    if (perfect) { S.perfectCount++; S.perfectStreak++; }
    else if (!onLeave && st.due > 0 && !isToday) S.perfectStreak = 0;

    // ---- skill points ----
    var sk = {};
    SKILLS.forEach(function (s) { sk[s] = { due: 0, done: 0, extra: 0 }; });
    tasks.forEach(function (t) {
      if (!isFixedMust_(t) || !isScheduled(t, d) || isExempt(t, d, idx)) return;
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
      if (!t) return;
      doneCount[t.id] = (doneCount[t.id] || 0) + 1;
      if (l.tier === '最低') S.low++;
      if (/血糖/.test(t.name || '')) S.glucose++;
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

    // ---- redemptions and hidden conditions ----
    var dayReds = redBy[d] || [];
    dayReds.forEach(function (r) { S.redCount++; spent += Number(r.cost) || 0; });
    if (perfect) {
      var bonusDue = 0, bonusDone = 0;
      tasks.forEach(function (t) {
        if (!isBonus(t) || isAccumFreq(t.freq) || !isScheduled(t, d)) return;
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
// library rows: {move, kind, unit, easy, standard, hard, minutes, active}
function drawChallenge(library, state, rand) {
  var pool = library.filter(function (r) { return r.active !== false && Number(r.minutes) > 0 && (Number(r.standard) > 0 || Number(r.easy) > 0 || Number(r.hard) > 0); });
  if (!pool.length) return null;
  var r = pool[Math.min(pool.length - 1, Math.floor(rand * pool.length))];
  var level = state === '疲勞' ? '簡單' : state === '精神好' ? '挑戰' : '標準';
  var amount = Number(level === '簡單' ? r.easy : level === '挑戰' ? r.hard : r.standard) || Number(r.standard) || Number(r.easy) || Number(r.hard);
  return { move: r.move, kind: r.kind || '', unit: r.unit || '次', amount: amount, level: level, minutes: Number(r.minutes) };
}

// Draws used on a date: resolved rows plus a challenge still running on this phone.
function challengeDrawsLeft(date, challenges, pending) {
  var used = challenges.filter(function (c) { return c.date === date; }).length + (pending ? 1 : 0);
  return Math.max(0, CHALLENGE_DRAWS_PER_DAY - used);
}

function challengeText(c) {
  return c.minutes + ' 分鐘內完成 ' + c.move + ' ' + c.amount + ' ' + c.unit;
}
