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
    buildMonthReport: buildMonthReport, buildPlanText: buildPlanText, minutesOn: minutesOn, tierOn: tierOn, iconOf: iconOf, SLOTS: SLOTS,
    trainingMenu: trainingMenu, trainVariant: trainVariant, trainingSummary: trainingSummary,
    buildTrainingLine: buildTrainingLine, TRAIN_STATES: TRAIN_STATES
  };
}
