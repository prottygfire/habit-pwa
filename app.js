// Habit PWA. Data lives in the Google Sheet behind the Apps Script endpoint; this file only draws and syncs.
// Check-ins are applied locally first and queued, so tapping works offline and syncs when the network returns.
(function () {
  'use strict';

  var VERSION = '2026-11-06 v23';
  var SLOT_ORDER = ['早', '午', '晚', '不限'];
  var DIMS = ['健康', '財商', '學習', '情緒', '工作', '娛樂'];
  var FREQ_LABEL = {
    daily: '每天', weekdays: '指定星期', weekly_n: '每週 N 次', monthly_n: '每月 N 次', quarterly_n: '每季 N 次',
    weekly_min: '每週累計 N 分鐘', monthly_min: '每月累計 N 分鐘'
  };
  var UNIT = { weekly_n: '週', monthly_n: '月', quarterly_n: '季', weekly_min: '週', monthly_min: '月' };
  var WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
  var ICON_CHOICES = ['💪', '🏃', '🚶', '🤸', '🏋️', '🧘', '🙆', '👟', '💧', '😴', '🧴', '🥗', '📖', '✍️', '💰', '📒', '🎯', '🎮', '🎨', '🧹', '💊', '☀️', '🌙'];
  var TABS = ['today', 'ledger', 'train', 'effort', 'health', 'more', 'game', 'dreams', 'tasks', 'plan', 'settings'];

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: run without persistence */ } }
  };

  // Animation, vibration and sound switches. Animations ignore the system "reduce motion" setting on purpose.
  var PREFS = Object.assign({ anim: true, vibrate: true, sound: false, launch: true }, LS.get('habit.prefs', {}));
  function savePrefs() { LS.set('habit.prefs', PREFS); }

  function localDate(d) {
    return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
  }

  var state = {
    cfg: LS.get('habit.cfg', null),
    data: LS.get('habit.data', null),
    dreams: LS.get('habit.dreams', null),
    queue: LS.get('habit.queue', []),
    mutations: 0,   // bumped by every local change; a sync answer that started before the latest change is stale
    tab: 'today',
    date: localDate(new Date()),
    trainDate: localDate(new Date()),
    openedOn: localDate(new Date()),
    planMode: 'month',
    editing: null,
    modal: null,
    busy: false,
    rev: 0,
    pop: null,
    preview: null,
    challenge: LS.get('habit.challenge', null),
    place: LS.get('habit.place', '在家')
  };

  var qTab = new URLSearchParams(location.search).get('tab');
  if (TABS.indexOf(qTab) >= 0) state.tab = qTab;

  function today() { return localDate(new Date()); }

  function h(tag, attrs) {
    var el = document.createElement(tag);
    for (var k in (attrs || {})) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
      else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  var toastTimer;
  // action = {label, fn}: the toast becomes tappable for 6 seconds (used for 復原 after a swipe delete).
  function toast(msg, action) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.onclick = null;
    el.classList.toggle('act', !!action);
    if (action) {
      el.appendChild(document.createTextNode('　'));
      el.appendChild(h('b', null, action.label));
      el.onclick = function () { el.classList.remove('on', 'act'); el.onclick = null; action.fn(); };
    }
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on', 'act'); el.onclick = null; }, action ? 6000 : 3200);
  }

  // ---- API ----

  function api(action, payload) {
    var body = JSON.stringify(Object.assign({ secret: state.cfg.secret, action: action }, payload || {}));
    return fetch(state.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' })
      .then(function (r) {
        // Google sometimes answers with an HTML error page instead of JSON: that is a hiccup, not a bad request.
        return r.json().catch(function () { var e = new Error('伺服器暫時沒回應'); e.transient = true; throw e; });
      }, function () { var e = new Error('連不上伺服器'); e.network = true; throw e; })
      .then(function (res) {
        if (!res.ok) {
          var e = new Error(res.error === 'unauthorized' ? '暗號不正確' : res.error);
          e.unauthorized = res.error === 'unauthorized';
          e.transient = TRANSIENT_ERROR.test(String(res.error || ''));
          throw e;
        }
        return res;
      });
  }

  // Server-side hiccups (lock timeout while another job writes the sheet, quota, overload): the request is fine, so keep it queued and try again.
  var TRANSIENT_ERROR = /lock|timeout|timed out|too many|try again|quota|server error|overload|service invoked|backend|暫時|逾時|忙碌/i;
  var retryTimer = null;
  function retryFlushLater() {
    if (retryTimer) return;
    retryTimer = setTimeout(function () { retryTimer = null; flush().then(function () { if (state.tab === 'settings') render(); }); }, 15000);
  }

  var flushing = false;
  function flush() {
    if (flushing || !state.cfg || !state.queue.length) return Promise.resolve();
    flushing = true;
    function next() {
      if (!state.queue.length) return Promise.resolve();
      var op = state.queue[0];
      return api(op.action, op.payload).then(function () {
        state.queue.shift();
        LS.set('habit.queue', state.queue);
        return next();
      });
    }
    return next().catch(function (e) {
      if (e.network || e.transient) { retryFlushLater(); return; }   // nothing is dropped: the check-in stays queued and goes out on the next try
      if (e.unauthorized) { toast('暗號不正確，請到設定重新輸入'); state.tab = 'settings'; return; }
      state.queue.shift();
      LS.set('habit.queue', state.queue);
      toast('有一筆沒送出：' + e.message);
    }).then(function () { flushing = false; });
  }

  // quiet = background poll: draw again only when the server data really differs from what is on screen.
  function refresh(quiet) {
    if (!state.cfg) { render(); return Promise.resolve(); }
    var stale = false, changed = true;
    return flush().then(function () {
      if (state.queue.length) return;
      var seq = state.mutations;
      return api('bootstrap').then(function (res) {
        // You may have ticked something while this request was on its way: the answer was read before that change, so applying it
        // would put the task back to unchecked. Drop it and sync again once the new change has been sent.
        if (state.mutations !== seq || state.queue.length || flushing) { stale = true; return; }
        var keepLedger = state.data && state.data.ledger;
        var before = quiet === true && state.data ? JSON.stringify(Object.assign({}, state.data, { ledger: null })) : '';
        state.data = { ledger: keepLedger, tasks: res.tasks, logs: res.logs, leave: res.leave, goals: res.goals, history: res.history, train: res.train || [], settings: res.settings || {},
          slipItems: res.slipItems || [], slips: res.slips || [], rewards: res.rewards || [], redemptions: res.redemptions || [],
          library: res.library || [], challenges: res.challenges || [], exempts: res.exempts || [],
          workouts: res.workouts || [], health: res.health || [], checkins: res.checkins || [], strengthMoves: res.strengthMoves || [], strength: res.strength || [], goalMap: res.goalMap || [] };
        changed = !before || before !== JSON.stringify(Object.assign({}, state.data, { ledger: null }));
        state.rev++;
        LS.set('habit.data', state.data);
      });
    }).catch(function (e) {
      if (e.unauthorized) { toast('暗號不正確，請到設定重新輸入'); state.tab = 'settings'; }
      else if (!e.network && !e.transient) toast(e.message);
      else changed = false;
    }).then(function () { if (quiet === true && !changed && !stale) return; render(); celebrate(); if (stale) setTimeout(refresh, 600); else if (state.data && state.cfg && state.tab !== 'ledger') loadLedger(); });
  }

  function enqueue(action, payload) {
    state.mutations++;
    state.queue.push({ action: action, payload: payload });
    LS.set('habit.queue', state.queue);
    LS.set('habit.data', state.data);
    state.rev++;
    render();
    celebrate();
    // The screen is already up to date (changes are applied locally first), so only the settings page, which shows the
    // unsent count and any password error, needs another draw; redrawing elsewhere would cut the animations short.
    flush().then(function () { if (state.tab === 'settings') render(); });
  }

  // ---- derived data ----

  function ctx() {
    var d = state.data;
    return { tasks: d.tasks, logs: d.logs, idx: indexLogs(d.logs, d.exempts || [], extras()), leave: indexLeave(d.leave) };
  }

  // ---- borrowed from MyRoutine: cue text, per-habit totals and milestones, new-habit hint ----

  // 情境提示 ("上班路上", "飯後"...): kept as JSON {taskId: text} in the 設定 sheet under taskCues.
  function cuesOf() {
    try { var o = JSON.parse((state.data && state.data.settings && state.data.settings.taskCues) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; }
  }

  // How many different days each task has been checked, cached per data revision.
  var doneCache = { rev: -1, map: {} };
  function doneCountOf(t) {
    if (doneCache.rev !== state.rev || !doneCache.map) {
      var seen = {}, map = {};
      ((state.data && state.data.logs) || []).forEach(function (l) {
        var k = l.date + '|' + l.taskId;
        if (seen[k]) return;
        seen[k] = true;
        map[l.taskId] = (map[l.taskId] || 0) + 1;
      });
      doneCache = { rev: state.rev, map: map };
    }
    return doneCache.map[t.id] || 0;
  }

  var MILESTONES = [[10, '🥉'], [30, '🥈'], [100, '🏆']];
  function milestoneOf(n) {
    var got = '', next = 0;
    MILESTONES.forEach(function (m) { if (n >= m[0]) got = m[1]; else if (!next) next = m[0]; });
    return { got: got, next: next };
  }

  // The first three days of a new habit are the hardest ("跨過 3 天門檻").
  function newHabitDay(t, date) {
    if (!t.since) return 0;
    var d = daysBetween(t.since, date);
    return d >= 0 && d < 3 ? d + 1 : 0;
  }

  // Low-energy days and the 核心 tasks, from the 訓練 state rows and the settings.
  function extras() {
    return extrasFrom(dget('train'), (state.data && state.data.settings) || {});
  }

  function dateTitle(s) {
    var d = toDate_(s);
    return (d.getUTCMonth() + 1) + ' 月 ' + d.getUTCDate() + ' 日（週' + WEEKDAY_NAMES[weekdayOf(s) - 1] + '）';
  }

  function pct(r) { return r === null || r === undefined ? '—' : Math.round(r * 100) + '%'; }
  function dimCls(d) { return 'd' + DIMS.indexOf(d); }
  function nameLine(t) { return h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, iconOf(t)), t.name); }
  function hasOptions(t) { return !!(t.options && t.options.length); }

  // ---- game state (derived from the data, see shared/game.js) ----

  function dget(k) { return (state.data && state.data[k]) || []; }

  function gameData() {
    var d = state.data;
    return { tasks: d.tasks, logs: d.logs, leave: d.leave, train: dget('train'), slips: dget('slips'), slipItems: dget('slipItems'),
      redemptions: dget('redemptions'), challenges: dget('challenges'), exempts: dget('exempts'), settings: d.settings || {}, workouts: dget('workouts') };
  }

  var gameCache = { rev: -1, today: '', g: null };
  function game() {
    if (gameCache.rev !== state.rev || gameCache.today !== today()) gameCache = { rev: state.rev, today: today(), g: computeGame(gameData(), today()) };
    return gameCache.g;
  }

  function fmtPts(n) { return n % 1 ? n.toFixed(1) : String(n); }

  function perfectNow(date) {
    var st = dayStats(state.data.tasks, date, indexLogs(state.data.logs, dget('exempts'), extras()), indexLeave(state.data.leave));
    return !st.leave && st.due > 0 && st.done === st.due;
  }

  function stamp() {
    var n = new Date();
    return localDate(n) + 'T' + pad2_(n.getHours()) + ':' + pad2_(n.getMinutes()) + ':' + pad2_(n.getSeconds());
  }

  // ---- feedback: confetti, banner, vibration, sound ----

  function buzz() { if (PREFS.vibrate && navigator.vibrate) { try { navigator.vibrate(18); } catch (e) { /* not supported */ } } }

  var audioCtx = null;
  function beep() {
    if (!PREFS.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.04;
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.12);
    } catch (e) { /* no audio */ }
  }

  function confetti() {
    if (!PREFS.anim) return;
    var colors = ['#f29058', '#f0b84a', '#6aa3f0', '#d783c4', '#4cc38a'];
    var box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
    for (var i = 0; i < 26; i++) {
      box.appendChild(h('i', { style: 'left:' + Math.round(Math.random() * 100) + '%;background:' + colors[i % colors.length] +
        ';animation-delay:' + Math.round(Math.random() * 180) + 'ms;--dx:' + Math.round(Math.random() * 60 - 30) + 'px' }));
    }
    document.body.appendChild(box);
    setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 1300);
  }

  var bannerQueue = [], bannerBusy = false;
  function pushBanner(icon, text) {
    bannerQueue.push({ icon: icon, text: text });
    if (!bannerBusy) nextBanner();
  }
  function nextBanner() {
    var b = bannerQueue.shift(), el = document.getElementById('banner');
    if (!b) { bannerBusy = false; return; }
    bannerBusy = true;
    el.textContent = '';
    el.appendChild(h('span', { class: 'bi' }, b.icon));
    el.appendChild(document.createTextNode(b.text));
    el.className = '';
    void el.offsetWidth; // restart the CSS animation
    el.className = PREFS.anim ? 'show' : 'show still';
    buzz(); beep();
    setTimeout(function () { el.className = ''; setTimeout(nextBanner, 150); }, PREFS.anim ? 1500 : 2500);
  }

  // Banners for what is new since this phone last looked. The first run only records the current state.
  function celebrate() {
    if (!state.data || !state.data.tasks) return;
    var g = game(), seen = LS.get('habit.seen', null);
    var cur = { ach: g.achievements.filter(function (a) { return a.unlocked; }).map(function (a) { return a.id; }), levels: {} };
    SKILLS.forEach(function (s) { cur.levels[s] = g.skills[s].level; });
    if (!seen) { LS.set('habit.seen', cur); return; }
    var items = [];
    g.achievements.forEach(function (a) {
      if (a.unlocked && seen.ach.indexOf(a.id) < 0) items.push({ icon: '🏅', text: '解鎖成就「' + a.name + '」' + (a.coins ? '　+' + a.coins + ' 星幣' : '') });
    });
    SKILLS.forEach(function (s) {
      if (g.skills[s].level > (seen.levels[s] || 1)) items.push({ icon: '⬆️', text: s + ' 升到 Lv' + g.skills[s].level + '「' + g.skills[s].title + '」' });
    });
    LS.set('habit.seen', cur);
    if (items.length > 3) items = [{ icon: '🎉', text: '新增 ' + items.length + ' 項成就與升級，到「成就」頁看看' }];
    items.forEach(function (i) { pushBanner(i.icon, i.text); });
  }

  // ---- 免責券: waive one 必做 task on one day ----

  function tickets() { return ticketsLeft(dget('redemptions'), dget('exempts')); }

  function canExempt(t, date, c) {
    if (isAccumFreq(t.freq) || isBonus(t) || !isScheduled(t, date) || isDone(t, date, c.idx) || isExempt(t, date, c.idx) || c.leave[date]) return false;
    var n = daysBetween(today(), date);
    return n >= -7 && n <= 14 && tickets() > 0;
  }

  function exemptTask(t, date) {
    if (!confirm('用 1 張免責券，抵免 ' + date + ' 的「' + t.name + '」？這天它不算失敗，也不加技能點。')) return;
    state.data.exempts = dget('exempts').concat([{ date: date, taskId: t.id }]);
    enqueue('exempt', { date: date, taskId: t.id });
  }

  function unexemptTask(t, date) {
    state.data.exempts = dget('exempts').filter(function (e) { return !(e.date === date && e.taskId === t.id); });
    enqueue('unexempt', { date: date, taskId: t.id });
  }

  // ---- check-in actions (local first, then queued) ----

  function setLog(t, date, entry) {
    var d = state.data;
    d.logs = d.logs.filter(function (l) { return !(l.date === date && l.taskId === t.id); });
    if (entry) d.logs.push(Object.assign({ date: date, taskId: t.id, ts: stamp() }, entry));
  }

  function checkTask(t, date, tier, note) {
    var isNow = date === today(), before = isNow ? game() : null, wasPerfect = isNow ? perfectNow(date) : false;
    setLog(t, date, { tier: tier, minutes: 0, note: note });
    state.rev++;
    var pop = { id: t.id, text: '', confetti: false }, sk = skillOf(t);
    if (isNow) {
      var after = game();
      if (sk) { var diff = after.skills[sk].gain - before.skills[sk].gain; if (diff > 0) pop.text = '+' + fmtPts(diff) + ' ' + sk; }
      if (!wasPerfect && perfectNow(date)) pop.confetti = true;
    }
    state.pop = pop;
    enqueue('toggle', { date: date, taskId: t.id, done: true, tier: tier, note: note });
  }

  function uncheckTask(t, date) {
    setLog(t, date, null);
    enqueue('toggle', { date: date, taskId: t.id, done: false });
  }

  function saveMinutes(t, date, minutes) {
    setLog(t, date, minutes > 0 ? { tier: '', minutes: minutes, note: '' } : null);
    enqueue('setMinutes', { date: date, taskId: t.id, minutes: minutes });
  }

  function toggleLeave(date, on) {
    var d = state.data;
    d.leave = d.leave.filter(function (x) { return x !== date; });
    if (on) d.leave.push(date);
    enqueue('setLeave', { date: date, on: on });
  }

  // ---- training (the 訓練 tab: suggestions, never obligations) ----

  function trainStart() { return (state.data.settings && state.data.settings.trainStart) || '2026-10-19'; }
  function trainRows() { return state.data.train || []; }
  function trainOn(id, date) { return trainRows().filter(function (r) { return r.item === id && r.date === date; })[0]; }
  function trainStateOn(date) { var r = trainOn('_state', date); return r ? r.version : ''; }
  function runTask() {
    return state.data.tasks.filter(function (t) { return t.active && t.freq === 'weekly_min' && t.name.indexOf('跑') >= 0; })[0];
  }

  function setTrainLocal(id, date, row) {
    state.data.train = trainRows().filter(function (r) { return !(r.item === id && r.date === date); });
    if (row) state.data.train.push(Object.assign({ date: date, item: id, minutes: 0, rpe: 0, version: '', note: '' }, row));
  }

  // A finished run also feeds the 跑步 weekly-minutes goal, so the two views never disagree.
  function trainDone(item, date, minutes, rpe, note, version) {
    setTrainLocal(item.id, date, { minutes: minutes, rpe: rpe, version: version, note: note });
    enqueue('trainSet', { date: date, item: item.id, done: true, minutes: minutes, rpe: rpe, version: version, note: note });
    var rt = runTask();
    if (item.isRun && rt && minutes > 0) saveMinutes(rt, date, minutes);
    if (item.kind === 'strength') tickByName(/重量訓練/, date, '健身房');
    if (item.kind === 'interval') tickByName(/壺鈴間歇/, date, '');
  }

  function trainUndo(item, date) {
    setTrainLocal(item.id, date, null);
    enqueue('trainSet', { date: date, item: item.id, done: false });
    var rt = runTask();
    if (item.isRun && rt) saveMinutes(rt, date, 0);
  }

  function vacOn(date) { var r = trainOn('_mode', date); return !!r && r.version === '休假'; }
  function setVacMode(date, on) {
    setTrainLocal('_mode', date, on ? { version: '休假' } : null);
    enqueue('trainSet', { date: date, item: '_mode', done: on, version: on ? '休假' : '' });
  }

  function setTrainState(date, st) {
    var on = trainStateOn(date) !== st;
    setTrainLocal('_state', date, on ? { version: st } : null);
    enqueue('trainSet', { date: date, item: '_state', done: on, version: on ? st : '' });
  }

  // ---- modals ----

  function closeModal() { state.modal = null; renderModal(); }

  function modalShell(title, body) {
    return h('div', { class: 'overlay', onclick: function (ev) { if (ev.target === ev.currentTarget) closeModal(); } },
      h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h1', null, title), body));
  }

  function optionsModal(m, c) {
    var t = m.task, date = m.date;
    var done = isDone(t, date, c.idx);
    var picked = parseNote(noteOn(t, date, c.idx)), pickedMap = {};
    picked.forEach(function (p) { pickedMap[p.base] = p.count; });
    var bases = t.options.map(function (o) { return parseOption(o).base; });
    var extras = picked.filter(function (p) { return bases.indexOf(p.base) < 0; }).map(function (p) { return noteItem(p.base, p.count); });
    var form = h('form', { onsubmit: function (ev) {
      ev.preventDefault();
      var chosen = [];
      t.options.forEach(function (o, i) {
        if (!form.elements['opt' + i].checked) return;
        chosen.push(noteItem(parseOption(o).base, parseInt(form.elements['cnt' + i].value, 10) || 0));
      });
      var other = form.elements.other.value.split(/[、,，]/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
      var all = chosen.concat(other);
      if (!all.length) { toast('請至少選一項，或在「其他」填寫'); return; }
      state.modal = null; renderModal();
      checkTask(t, date, '標準', all.join('、'));
    } },
      h('p', { class: 'muted' }, '勾選你今天做了什麼，次數可以自己改（選填；至少一項就算完成）'),
      t.options.map(function (o, i) {
        var p = parseOption(o), on = pickedMap[p.base] !== undefined, cnt = on ? pickedMap[p.base] : p.count;
        return h('div', { class: 'opt' },
          h('label', { class: 'optl' }, h('input', { type: 'checkbox', name: 'opt' + i, checked: on }), h('span', null, p.base)),
          h('input', { class: 'cnt', type: 'number', name: 'cnt' + i, min: '0', max: '9999', inputmode: 'numeric', placeholder: '次數', value: cnt || '', 'aria-label': p.base + ' 次數',
            oninput: function (ev) { if (ev.target.value) form.elements['opt' + i].checked = true; } }));
      }),
      h('label', { class: 'f', for: 'm-other' }, '其他（選填，多項用頓號分隔，可寫「跳繩*100」）'),
      h('input', { type: 'text', id: 'm-other', name: 'other', value: extras.join('、'), maxlength: '60' }),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn primary grow', type: 'submit' }, done ? '更新' : '完成'),
        done ? h('button', { class: 'btn danger', type: 'button', onclick: function () { closeModal(); uncheckTask(t, date); } }, '取消完成') : null,
        h('button', { class: 'btn', type: 'button', onclick: closeModal }, '關閉')));
    return modalShell(t.name, form);
  }

  // 飲食狀態: tap = +1, tap again = +2, "−" takes one back (same feel as the 小失誤 buttons). 「普通」 and the others exclude each other.
  function counterModal(m, c) {
    var t = m.task, date = m.date, done = isDone(t, date, c.idx);
    var labels = counterLabels(t).map(function (o) { return parseOption(o).base; });
    var counts = {};
    parseNote(noteOn(t, date, c.idx)).forEach(function (p) { counts[p.base] = p.count > 0 ? p.count : 1; });
    var row = h('div', { class: 'slips' });
    function bump(label, delta) {
      var n = Math.max(0, (counts[label] || 0) + delta);
      if (label === DIET_PLAIN) { n = Math.min(n, 1); if (n) counts = {}; }
      else if (n) delete counts[DIET_PLAIN];
      if (n) counts[label] = n; else delete counts[label];
      paint();
    }
    function paint() {
      row.textContent = '';
      labels.forEach(function (label) {
        var n = counts[label] || 0, plain = label === DIET_PLAIN;
        row.appendChild(h('div', { class: 'slip' + (n ? ' has' : '') },
          h('button', { class: 'slipmain', type: 'button', 'aria-label': (plain ? '選 ' : '加一 ') + label, onclick: function () { bump(label, plain && n ? -1 : 1); } },
            label, n && !plain ? h('b', null, ' ×' + n) : n ? h('b', null, ' ✓') : null),
          n && !plain ? h('button', { class: 'slipundo', type: 'button', 'aria-label': '少一 ' + label, onclick: function () { bump(label, -1); } }, '−') : null));
      });
    }
    paint();
    function save() {
      var items = labels.filter(function (l) { return counts[l]; }).map(function (l) { return l === DIET_PLAIN ? l : noteItem(l, counts[l]); });
      if (!items.length) { toast('請至少按一項，或選「普通」'); return; }
      state.modal = null; renderModal();
      checkTask(t, date, '標準', items.join('、'));
    }
    return modalShell(t.name, h('div', null,
      h('p', { class: 'muted' }, '這餐有什麼就按一下（按兩下算 2，「−」減少）；沒有特別的就按「普通」。'),
      row,
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn primary grow', type: 'button', onclick: save }, done ? '更新' : '完成'),
        done ? h('button', { class: 'btn danger', type: 'button', onclick: function () { closeModal(); uncheckTask(t, date); } }, '取消完成') : null,
        h('button', { class: 'btn', type: 'button', onclick: closeModal }, '關閉'))));
  }

  function tierModal(m, c) {
    var t = m.task, date = m.date, cur = tierOn(t, date, c.idx);
    function choice(tier, text) {
      return h('button', { class: 'btn tier' + (cur === tier ? ' on' : ''), type: 'button', onclick: function () { closeModal(); checkTask(t, date, tier, ''); } },
        h('b', null, tier), h('span', null, text));
    }
    return modalShell(t.name, h('div', null,
      h('p', { class: 'muted' }, '身體狀況不同，做到哪一檔都算完成，連續不會斷。'),
      t.tierUp ? choice('進階', t.tierUp) : null,
      choice('標準', t.name),
      t.tierDown ? choice('最低', t.tierDown) : null,
      h('div', { class: 'row', style: 'margin-top:14px' },
        cur ? h('button', { class: 'btn danger', type: 'button', onclick: function () { closeModal(); uncheckTask(t, date); } }, '取消完成') : null,
        h('button', { class: 'btn grow', type: 'button', onclick: closeModal }, '關閉'))));
  }

  function minutesModal(m, c) {
    var t = m.task, date = m.date, cur = minutesOn(t, date, c.idx);
    var form = h('form', { onsubmit: function (ev) {
      ev.preventDefault();
      var v = parseInt(form.elements.mins.value, 10);
      if (!(v >= 0 && v <= 1440)) { toast('分鐘數要在 0 到 1440 之間'); return; }
      closeModal(); saveMinutes(t, date, v);
    } },
      h('p', { class: 'muted' }, dateTitle(date) + ' 一共做了幾分鐘？（重新輸入會覆蓋當天的數字）'),
      h('label', { class: 'f', for: 'm-mins' }, '分鐘'),
      h('input', { type: 'number', id: 'm-mins', name: 'mins', min: '0', max: '1440', step: '1', inputmode: 'numeric', value: cur || '', required: true }),
      h('div', { class: 'row', style: 'margin-top:8px' }, [10, 20, 30, 45].map(function (n) {
        return h('button', { class: 'btn small', type: 'button', onclick: function () { form.elements.mins.value = (parseInt(form.elements.mins.value, 10) || 0) + n; } }, '+' + n);
      })),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn primary grow', type: 'submit' }, '儲存'),
        cur ? h('button', { class: 'btn danger', type: 'button', onclick: function () { closeModal(); saveMinutes(t, date, 0); } }, '清除') : null,
        h('button', { class: 'btn', type: 'button', onclick: closeModal }, '關閉')));
    return modalShell(t.name, form);
  }

  function trainModal(m) {
    var item = m.task, date = m.date, cur = trainOn(item.id, date);
    var st = trainStateOn(date);
    var form = h('form', { onsubmit: function (ev) {
      ev.preventDefault();
      var mins = parseInt(form.elements.mins.value, 10) || 0;
      if (mins < 0 || mins > 1440) { toast('分鐘數要在 0 到 1440 之間'); return; }
      var ver = st === '疲勞' && item.easy ? '輕鬆' : st === '精神好' && item.up ? '進階' : '標準';
      closeModal();
      trainDone(item, date, mins, parseInt(form.elements.rpe.value, 10) || 0, form.elements.note.value.trim(), ver);
    } },
      h('p', { class: 'muted' }, dateTitle(date) + '：做了就記一筆，沒做不會被記成失敗。'),
      h('label', { class: 'f', for: 't-mins' }, '實際分鐘' + (item.isRun ? '（會一併計入跑步每週累計）' : '（選填）')),
      h('input', { type: 'number', id: 't-mins', name: 'mins', min: '0', max: '1440', inputmode: 'numeric', value: cur ? cur.minutes || '' : item.planned || item.minutes || '' }),
      h('label', { class: 'f', for: 't-rpe' }, '費力程度 RPE（選填，1 輕鬆 ～ 10 全力）'),
      h('select', { id: 't-rpe', name: 'rpe' }, [h('option', { value: '' }, '不填')].concat([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) { return h('option', { value: String(n), selected: !!cur && cur.rpe === n }, String(n)); }))),
      h('label', { class: 'f', for: 't-note' }, '備註（選填，例如髖緊、睡不好）'),
      h('input', { type: 'text', id: 't-note', name: 'note', maxlength: '60', value: cur ? cur.note : '' }),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn primary grow', type: 'submit' }, cur ? '更新' : '做了'),
        cur ? h('button', { class: 'btn danger', type: 'button', onclick: function () { closeModal(); trainUndo(item, date); } }, '取消') : null,
        h('button', { class: 'btn', type: 'button', onclick: closeModal }, '關閉')));
    return modalShell(item.title, form);
  }

  function renderModal() {
    var host = document.getElementById('modal');
    if (!state.modal || !state.data) { host.textContent = ''; host.dataset.key = ''; return; }
    var m = state.modal, key = m.type + '|' + m.task.id + '|' + m.date;
    if (host.dataset.key === key && host.firstChild) return; // keep what the user is typing across background re-renders
    host.textContent = '';
    host.dataset.key = key;
    var c = ctx();
    host.appendChild(m.type === 'counter' ? counterModal(m, c) : m.type === 'options' ? optionsModal(m, c) : m.type === 'tier' ? tierModal(m, c) : m.type === 'train' ? trainModal(m) : m.type === 'strength' ? strengthModal(m) : m.type === 'redeem' ? redeemModal() : minutesModal(m, c));
    var first = host.querySelector('input,button');
    if (first) first.focus();
  }

  // ---- today ----

  function taskItem(t, c, date) {
    var done = isDone(t, date, c.idx), tier = tierOn(t, date, c.idx), note = noteOn(t, date, c.idx);
    var streak = taskStreak(t, date, c.idx, c.leave);
    var tiered = !!(t.tierUp || t.tierDown), ex = isExempt(t, date, c.idx), rel = isRelieved(t, date, c.idx);
    var sub = [h('span', { class: 'chip dc' }, t.dim)];
    if (ex) sub.push(h('span', { class: 'chip on' }, '🎫 免責'));
    if (rel && !done) sub.push(h('span', { class: 'chip' }, '🌙 今天放過'));
    if (isBonus(t)) sub.push(h('span', { class: 'chip' }, '加分'));
    if (done && tier && tier !== '標準') sub.push(h('span', { class: 'chip on' }, tier));
    if (streak > 0) sub.push(h('span', { class: 'muted' }, '🔥' + streak + '天'));
    var nd = newHabitDay(t, date);
    if (nd) sub.push(h('span', { class: 'chip on' }, '🌱 跨過 3 天門檻 第 ' + nd + '/3 天'));
    var total = doneCountOf(t), ms = milestoneOf(total);
    if (total > 0) sub.push(h('span', { class: 'muted' }, (ms.got ? ms.got + ' ' : '') + '累計 ' + total + ' 次' + (ms.next ? '・再 ' + (ms.next - total) + ' 次到 ' + ms.next : '')));
    var cue = cuesOf()[t.id];
    var tap = function () {
      if (isCounterTask(t)) { state.modal = { type: 'counter', task: t, date: date }; renderModal(); }
      else if (hasOptions(t)) { state.modal = { type: 'options', task: t, date: date }; renderModal(); }
      else if (done) uncheckTask(t, date);
      else checkTask(t, date, '標準', '');
    };
    return h('div', { class: 'card item row ' + dimCls(t.dim) + (done ? ' done' : '') + (isBonus(t) ? ' bonus' : '') + (ex ? ' exempt' : '') + (rel && !done ? ' relieved' : '') },
      h('button', { class: 'check' + (state.pop && state.pop.id === t.id && PREFS.anim ? ' pop' : ''), 'aria-pressed': String(done), 'aria-label': (done ? '取消完成 ' : '完成 ') + t.name, onclick: tap }, '✓'),
      state.pop && state.pop.id === t.id && state.pop.text && PREFS.anim ? h('span', { class: 'float', 'aria-hidden': 'true' }, state.pop.text) : null,
      h('div', { class: 'grow' },
        nameLine(t),
        h('div', null, sub),
        cue ? h('div', { class: 'muted' }, '📍 ' + cue) : null,
        done && note ? h('div', { class: 'muted' }, note) : null,
        !done && hasOptions(t) ? h('div', { class: 'muted' }, '點勾選，選今天做了什麼') : null),
      ex ? h('button', { class: 'btn small', 'aria-label': '取消免責 ' + t.name, onclick: function () { unexemptTask(t, date); } }, '取消免責') : null,
      canExempt(t, date, c) ? h('button', { class: 'btn small', 'aria-label': '用免責券抵免 ' + t.name, onclick: function () { exemptTask(t, date); } }, '🎫') : null,
      tiered ? h('button', { class: 'btn small', 'aria-label': t.name + ' 選擇進階或最低', onclick: function () { state.modal = { type: 'tier', task: t, date: date }; renderModal(); } }, '⋯') : null,
      ledgerKindOf(t) && !done ? h('button', { class: 'btn small primary', onclick: function () { openLedger(ledgerKindOf(t), date); } }, '填寫') : null,
      t.link ? h('a', { href: t.link, target: '_blank', rel: 'noopener', class: 'btn small' }, '開啟') : null);
  }

  function accumItem(t, c, date) {
    var p = progress(t, date, c.idx), min = isMinFreq(t.freq), unit = min ? ' 分' : ' 次';
    var streak = taskStreak(t, date, c.idx, c.leave);
    var doneToday = isDone(t, date, c.idx);
    var action;
    if (min) {
      var m = minutesOn(t, date, c.idx);
      action = h('button', { class: 'btn small primary', onclick: function () { state.modal = { type: 'minutes', task: t, date: date }; renderModal(); } }, m ? '今天 ' + m + ' 分 ✎' : '＋記錄');
    } else {
      action = h('button', { class: 'btn small' + (doneToday ? ' primary' : ''), onclick: function () { if (doneToday) uncheckTask(t, date); else checkTask(t, date, '標準', ''); } }, doneToday ? '今天已記 ✓' : '＋今天');
    }
    return h('div', { class: 'card ' + dimCls(t.dim) },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          nameLine(t),
          h('div', null, h('span', { class: 'chip dc' }, t.dim), h('span', { class: 'muted' }, '本' + UNIT[t.freq] + ' ' + p.done + '/' + p.target + unit + (streak > 0 ? ' 🔥' + streak + UNIT[t.freq] : '')))),
        action),
      h('div', { class: 'bar', style: 'margin-top:8px' }, h('i', { style: 'width:' + Math.round(Math.min(1, p.done / p.target) * 100) + '%' })));
  }

  // One block per time slot, in the sheet's 排序 order (real-life order: 飯前 before 飯後, even when 飯前 is 加分).
  function groupBySlot(items, c, date, nodes) {
    SLOT_ORDER.forEach(function (slot) {
      var list = items.filter(function (t) { return (t.slot || '不限') === slot; });
      if (!list.length) return;
      var left = list.filter(function (t) { return isDone(t, date, c.idx); }).length;
      nodes.push(h('h2', { class: 'slothead' }, (slot === '不限' ? '全天' : slot), h('span', { class: 'slotcount' + (left === list.length ? ' full' : '') }, left + '/' + list.length)));
      list.forEach(function (t) { nodes.push(taskItem(t, c, date)); });
    });
  }

  // Home has two sub-tabs like MyRoutine's 日常作息 / 待辦事項; the 待辦 pane is the same one as 記錄 > 待辦.
  function renderToday() {
    var pane = state.homePane === 'todo' ? 'todo' : 'habits';
    var seg = h('div', { class: 'seg' }, [['habits', '日常作息'], ['todo', '待辦事項']].map(function (p) {
      return h('button', { class: 'btn' + (pane === p[0] ? ' on' : ''), 'aria-pressed': String(pane === p[0]), onclick: function () { state.homePane = p[0]; render(); } }, p[1]);
    }));
    return [seg].concat(pane === 'todo' ? todoPane(ledgerState()) : renderTodayHabits());
  }

  function renderTodayHabits() {
    var c = ctx(), date = state.date, isToday = date === today(), onLeave = !!c.leave[date];
    var daily = c.tasks.filter(function (t) { return !isAccumFreq(t.freq) && isScheduled(t, date); });
    var accum = c.tasks.filter(function (t) { return isAccumFreq(t.freq) && isScheduled(t, date); });
    var st = dayStats(c.tasks, date, c.idx, c.leave), bs = bonusStats(c.tasks, date, c.idx);
    var overall = overallStreak(c.tasks, date, c.idx, c.leave);
    var nodes = [
      h('div', { class: 'sticky' },
        h('div', { class: 'row' },
          h('button', { class: 'btn small', 'aria-label': '前一天', onclick: function () { state.date = addDays(date, -1); render(); } }, '‹'),
          h('h1', { class: 'grow' }, dateTitle(date) + (isToday ? ' · 今天' : '')),
          h('button', { class: 'btn small', 'aria-label': '後一天', disabled: date >= today(), onclick: function () { state.date = addDays(date, 1); render(); } }, '›')),
        isToday ? gainLine() : null,
        h('div', { class: 'bar thin', 'aria-hidden': 'true' }, h('i', { style: 'width:' + (st.rate === null ? 0 : Math.round(st.rate * 100)) + '%' }))),
      h('div', { class: 'card' },
        h('div', { class: 'stat' }, h('span', null, '必做完成率 ', h('b', null, pct(st.rate))), h('span', null, '🔥 連續 ', h('b', null, overall), ' 天')),
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': st.rate === null ? 0 : Math.round(st.rate * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('i', { style: 'width:' + (st.rate === null ? 0 : Math.round(st.rate * 100)) + '%' })),
        h('div', { class: 'muted' }, '必做 ' + st.done + '/' + st.due + (bs.due ? '・加分 ' + bs.done + '/' + bs.due : '') + '（必做完成 ≥ 80% 才算連續一天）')),
      h('button', { class: 'btn small' + (onLeave ? ' primary' : ''), onclick: function () { toggleLeave(date, !onLeave); } }, onLeave ? '已請假（點一下取消）' : '這天請假（不影響連續天數）')
    ];
    if (isToday) {
      var pending = backfillPending(c.tasks, date, c.idx, c.leave);
      if (pending.length) {
        nodes.splice(2, 0, h('div', { class: 'card backfill' },
          h('div', { class: 'muted' }, '🕘 這兩天還有可以補登的（晚一點補也一樣算，連續天數會先保留）'),
          h('div', { class: 'row', style: 'margin-top:8px;flex-wrap:wrap' }, pending.slice().reverse().map(function (p) {
            return h('button', { class: 'btn small', type: 'button', onclick: function () { state.date = p.date; render(); } },
              (p.date === addDays(date, -1) ? '昨天' : '前天') + ' ' + p.left + ' 項');
          }))));
      }
    } else if (daysBetween(date, today()) <= GRACE_DAYS && !onLeave) {
      nodes.push(h('p', { class: 'muted' }, '這天可以補登：補的點數和當天打勾完全一樣。'));
    }
    if (onLeave) nodes.push(h('p', { class: 'muted' }, '請假日不提醒，也不計入完成率。'));
    if (!onLeave) nodes.push(dayStateBar(date));
    groupBySlot(daily, c, date, nodes);
    if (accum.length) {
      nodes.push(h('h2', { id: 'accum' }, '累計目標'));
      accum.forEach(function (t) { nodes.push(accumItem(t, c, date)); });
    }
    if (!daily.length && !accum.length) nodes.push(h('p', { class: 'muted' }, '這天沒有任務。到「任務」頁新增。'));
    nodes.push(checkinCard(date));
    return nodes;
  }

  function gainLine() {
    var g = game(), pts = 0;
    SKILLS.forEach(function (s) { pts += g.skills[s].gain; });
    return h('div', { class: 'gainline' }, h('span', null, '今天 +' + fmtPts(pts) + ' 技能點'), h('span', null, '⭐ ' + g.coins.balance));
  }

  // ---- 限時挑戰 ----

  var chTimer = null;
  function chRemaining() { var c = state.challenge; return c ? Math.max(0, Math.ceil((c.endAt - Date.now()) / 1000)) : 0; }
  function fmtTime(sec) { return pad2_(Math.floor(sec / 60)) + ':' + pad2_(sec % 60); }
  function startTicker() {
    if (chTimer) return;
    chTimer = setInterval(function () {
      if (!state.challenge) { clearInterval(chTimer); chTimer = null; return; }
      var el = document.getElementById('ch-timer');
      if (!el) return;
      var left = chRemaining();
      el.textContent = left > 0 ? fmtTime(left) : '時間到';
      if (left <= 0) el.classList.add('over');
    }, 1000);
  }

  function setPlace(p) {
    state.place = p;
    LS.set('habit.place', p);
    state.preview = null;
    render();
  }

  function linkLabel(u) {
    return /instagram\.com/.test(u) ? 'Instagram 影片／貼文' : /facebook\.com/.test(u) ? 'Facebook 影片' : /youtu\.?be/.test(u) ? 'YouTube 影片' : '參考連結';
  }

  // How to do it, plus the links and pictures from the 運動動作庫 row, so a drawn move can be followed along.
  function challengeHelp(c) {
    var nodes = [];
    if (c.howto) nodes.push(h('div', { class: 'howto' }, c.howto));
    (c.images || []).forEach(function (u) { nodes.push(h('img', { class: 'howimg', src: u, alt: c.move + ' 示範圖', loading: 'lazy' })); });
    if ((c.links || []).length) {
      nodes.push(h('div', { class: 'row', style: 'flex-wrap:wrap;margin-top:8px' }, c.links.map(function (u, i) {
        return h('a', { class: 'btn small', href: u, target: '_blank', rel: 'noopener' }, '▶ ' + linkLabel(u) + (c.links.length > 1 ? ' ' + (i + 1) : ''));
      })));
    }
    return nodes;
  }

  function drawNow() {
    var c = drawChallenge(dget('library'), trainStateOn(today()), Math.random(), state.place);
    if (!c && state.place === '在外面') { toast('「在外面」目前沒有可抽的動作：到試算表「運動動作庫」，把「地點」填成「辦公室」的動作才抽得到'); return; }
    if (!c) { toast('動作庫是空的，請到試算表「運動動作庫」新增動作'); return; }
    state.preview = c;
    render();
  }

  function startChallenge() {
    var c = state.preview;
    if (!c) return;
    state.challenge = Object.assign({}, c, { date: today(), startedAt: Date.now(), endAt: Date.now() + c.minutes * 60000 });
    state.preview = null;
    LS.set('habit.challenge', state.challenge);
    startTicker();
    render();
  }

  // A success after the time limit counts as a miss. Nothing is ever subtracted.
  function resolveChallenge(result) {
    var c = state.challenge;
    if (!c) return;
    if (result === '成功' && Date.now() > c.endAt + 1500) result = '失敗';
    var row = { date: c.date, move: c.move, amount: c.amount, level: c.level, minutes: c.minutes, result: result, secs: Math.round((Date.now() - c.startedAt) / 1000), place: c.place || state.place };
    state.challenge = null;
    LS.set('habit.challenge', null);
    state.data.challenges = dget('challenges').concat([row]);
    if (result === '成功') { state.pop = { id: '', text: '', confetti: true }; toast('挑戰成功！'); }
    else toast(result === '失敗' ? '時間到，下次再來，沒有任何扣分' : '已放棄，沒有任何扣分');
    enqueue('challenge', { challenge: row });
  }

  function renderChallenge(date) {
    if (date !== today()) return [];
    var left = challengeDrawsLeft(date, dget('challenges'), !!state.challenge);
    var box = h('div', { class: 'card challenge' }, h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⏱'), '限時挑戰'));
    var c = state.challenge;
    if (c && c.date === today()) {
      var over = chRemaining() <= 0;
      startTicker();
      box.appendChild(h('div', { class: 'muted' }, (c.place ? c.place + '・' : '') + challengeText(c) + '（' + c.level + '量）'));
      challengeHelp(c).forEach(function (n) { box.appendChild(n); });
      box.appendChild(h('div', { id: 'ch-timer', class: 'timer' + (over ? ' over' : '') }, over ? '時間到' : fmtTime(chRemaining())));
      box.appendChild(h('div', { class: 'row', style: 'margin-top:8px' },
        over ? null : h('button', { class: 'btn primary grow', onclick: function () { resolveChallenge('成功'); } }, '完成了'),
        h('button', { class: 'btn' + (over ? ' primary grow' : ''), onclick: function () { resolveChallenge(over ? '失敗' : '放棄'); } }, over ? '結束' : '放棄')));
    } else if (state.preview) {
      box.appendChild(h('div', { class: 'timer small' }, challengeText(state.preview)));
      box.appendChild(h('div', { class: 'muted' }, state.preview.place + '・' + state.preview.level + '量（依今天的狀態）・按「開始」才計時，也才用掉一次機會'));
      challengeHelp(state.preview).forEach(function (n) { box.appendChild(n); });
      box.appendChild(h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn primary grow', onclick: startChallenge }, '開始'),
        h('button', { class: 'btn', onclick: function () { state.preview = null; render(); } }, '先不要')));
    } else {
      box.appendChild(h('div', { class: 'muted' }, '隨機從你的動作庫抽一個，時間內完成有加分，沒完成不扣分。今天還有 ' + left + ' 次。'));
      box.appendChild(h('div', { class: 'seg', role: 'group', 'aria-label': '現在在哪裡' }, ['在家', '在外面'].map(function (p) {
        return h('button', { class: 'btn' + (state.place === p ? ' on' : ''), 'aria-pressed': String(state.place === p), onclick: function () { setPlace(p); } }, p === '在家' ? '🏠 在家' : '🚶 在外面');
      })));
      if (state.place === '在外面') box.appendChild(h('div', { class: 'muted' }, '在外面只會抽「辦公室可以做」的動作（坐著或站著就能做、不用器材）。'));
      box.appendChild(h('button', { class: 'btn primary', style: 'margin-top:8px', disabled: left <= 0, onclick: drawNow }, left > 0 ? '抽一個限時挑戰' : '今天的次數用完了'));
    }
    var todayRows = dget('challenges').filter(function (r) { return r.date === date; });
    if (todayRows.length) {
      box.appendChild(h('div', { class: 'muted', style: 'margin-top:8px' }, '今天：' + todayRows.map(function (r) { return r.move + ' ' + (r.result === '成功' ? '✅' : '▫️'); }).join('　')));
    }
    return [box];
  }

  // ---- 訓練 tab ----

  function trainCard(item, date, st) {
    var cur = trainOn(item.id, date), variant = trainVariant(item, st), future = date > today();
    return h('div', { class: 'card item train' + (cur ? ' done' : '') },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, item.icon), item.title),
          h('div', null,
            h('span', { class: 'chip' + (item.fixed ? ' on' : '') }, item.fixed ? '已排定' : '可以做'),
            h('span', { class: 'chip' }, item.time),
            item.minutes ? h('span', { class: 'muted' }, '約 ' + item.minutes + ' 分') : null,
            cur ? h('span', { class: 'chip on' }, '✓ 做了' + (cur.minutes ? ' ' + cur.minutes + ' 分' : '') + (cur.version && cur.version !== '標準' ? '（' + cur.version + '）' : '')) : null)),
        future ? null : h('button', { class: 'btn small' + (cur ? '' : ' primary'), onclick: function () { state.modal = { type: 'train', task: item, date: date }; renderModal(); } }, cur ? '編輯' : '做了')),
      variant ? h('div', { class: 'variant' }, h('b', null, variant.label + '：'), variant.text) : null,
      item.detail && item.detail.length ? h('details', null, h('summary', null, '內容'), h('ul', null, item.detail.map(function (d) { return h('li', null, d); }))) : null);
  }

  function renderTrain() {
    var date = state.trainDate, isToday = date === today(), future = date > today(), start = trainStart();
    var menu = trainingMenu(date, start), st = trainStateOn(date);
    var sum = trainingSummary(date, trainRows());
    var nodes = [
      h('div', { class: 'sticky' },
        h('div', { class: 'row' },
          h('button', { class: 'btn small', 'aria-label': '前一天', onclick: function () { state.trainDate = addDays(date, -1); render(); } }, '‹'),
          h('h1', { class: 'grow' }, dateTitle(date) + (isToday ? ' · 今天' : future ? ' · 預覽' : '')),
          h('button', { class: 'btn small', 'aria-label': '後一天', disabled: daysBetween(today(), date) >= 14, onclick: function () { state.trainDate = addDays(date, 1); render(); } }, '›')))
    ];
    if (future) nodes.push(h('p', { class: 'muted' }, '這是預覽，到了那天才能記錄。'));
    if (!menu.started) {
      nodes.push(h('p', { class: 'muted' }, '訓練計畫從 ' + start + ' 開始，這天還沒開始。'));
    } else {
      nodes.push(h('p', { class: 'muted' }, '第 ' + menu.week + ' 週・' + (future ? '這天' : '今天') + '有哪些可以做，做了就記，沒做也沒關係。'));
      if (menu.finished) nodes.push(h('p', { class: 'muted' }, '12 週計畫已走完，先沿用第 12 週的內容；想換新計畫再告訴我。'));
      nodes.push(weekLoadCard(date, start));
      nodes.push(h('div', { class: 'seg' }, TRAIN_STATES.map(function (s) {
        return h('button', { class: 'btn' + (st === s ? ' on' : ''), 'aria-pressed': String(st === s), disabled: future, onclick: function () { setTrainState(date, s); } }, s);
      })));
      nodes.push(h('p', { class: 'muted' }, st === '疲勞' ? '疲勞：卡片會改給輕鬆版，需要的話直接休息。' : st === '精神好' ? '精神好：有進階版的項目會多給一個選擇。' : '選今天的狀態，建議會跟著調整（可不選）。'));
      renderChallenge(date).forEach(function (n) { nodes.push(n); });
      nodes.push(h('div', { class: 'card' }, h('div', null, '本週已做 ', h('b', null, sum.sessions), ' 項、累計 ', h('b', null, sum.minutes), ' 分鐘'), h('div', { class: 'muted' }, '只是記錄，這裡沒有目標，也不影響必做完成率。')));
      var fixed = menu.items.filter(function (i) { return i.fixed; }), core = menu.items.filter(function (i) { return !i.fixed && i.tier !== 'opt'; });
      var free = menu.items.filter(function (i) { return !i.fixed && i.tier === 'opt'; });
      function addAll(list) { list.forEach(function (i) { trainNodes(i, date, st).forEach(function (n) { nodes.push(n); }); }); }
      if (core.length) { nodes.push(h('h2', null, '今天排定')); addAll(core); }
      if (fixed.length) { nodes.push(h('h2', null, '固定的課')); addAll(fixed); }
      if (free.length) { nodes.push(h('h2', null, '可以做')); addAll(free); }
      if (!future && !core.some(function (i) { return i.kind === 'strength-home'; })) { var extra = extraStrengthCard(date); if (extra) nodes.push(extra); }
      var wkStart = addDays(date, -(weekdayOf(date) - 1)), rows = [];
      for (var k = 0; k < 7; k++) {
        var d = addDays(wkStart, k), m = trainingMenu(d, start);
        rows.push(h('li', null, h('b', null, '週' + WEEKDAY_NAMES[k] + ' '), m.items.filter(function (i) { return i.kind !== 'pelvic'; }).map(function (i) { return i.title; }).join('、') || '休息'));
      }
      nodes.push(h('details', { class: 'card' }, h('summary', null, '本週一覽'), h('ul', null, rows)));
    }
    var picker = h('input', { type: 'date', id: 'ts-start', value: start });
    nodes.push(h('details', { class: 'card' }, h('summary', null, '計畫設定'),
      h('label', { class: 'f', for: 'ts-start' }, '第 1 週的星期一'), picker,
      h('button', { class: 'btn small', style: 'margin-top:8px', onclick: function () {
        api('setSetting', { key: 'trainStart', value: picker.value }).then(refresh).catch(function (e) { toast(e.network ? '需要網路' : e.message); });
      } }, '儲存')));
    return nodes;
  }

  // ---- 健康趨勢、每日自評、力量紀錄、目標對應、月回顧 (10/26) ----

  function svgEl(tag, attrs) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  // points: [{date, value}] in date order. invert: a bigger number is drawn lower (bedtime, heart rate: higher is worse).
  function sparkline(points, o) {
    o = o || {};
    if (points.length < 2) return h('div', { class: 'muted' }, '資料還不夠畫圖（至少要 2 天）');
    var W = 300, H = o.height || 64, P = 6;
    var vals = points.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (hi === lo) { hi += 1; lo -= 1; }
    var d0 = points[0].date, d1 = points[points.length - 1].date, span = Math.max(1, daysBetween(d0, d1));
    var path = points.map(function (p, i) {
      var x = P + (W - 2 * P) * daysBetween(d0, p.date) / span;
      var t = (p.value - lo) / (hi - lo);
      var y = P + (H - 2 * P) * (o.invert ? t : 1 - t);
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'spark', role: 'img', 'aria-label': o.label || '趨勢圖', preserveAspectRatio: 'none' });
    svg.appendChild(svgEl('path', { d: path, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
    var fmt = o.fmt || String;
    // The line is drawn between this chart's own lowest and highest value (it does not start at 0). With invert, a LOW number is drawn high.
    var topV = o.invert ? lo : hi, botV = o.invert ? hi : lo;
    [P, H - P].forEach(function (y) { svg.insertBefore(svgEl('line', { x1: '0', x2: String(W), y1: String(y), y2: String(y), stroke: 'currentColor', 'stroke-width': '1', 'stroke-dasharray': '3 4', opacity: '.25', 'vector-effect': 'non-scaling-stroke' }), svg.firstChild); });
    return h('div', null,
      h('div', { class: 'sparkwrap' }, svg, h('span', { class: 'yax t' }, fmt(topV)), h('span', { class: 'yax b' }, fmt(botV))),
      h('div', { class: 'row muted', style: 'justify-content:space-between' }, h('span', null, d0.slice(5) + '　' + fmt(points[0].value)), h('span', null, d1.slice(5) + '　' + fmt(points[points.length - 1].value))),
      h('div', { class: 'muted axnote' }, '縱軸：這段期間的最低到最高（' + fmt(lo) + ' ～ ' + fmt(hi) + '），不是從 0 開始；' + (o.invert ? '線越高代表數字越小（越早、越低）。' : '線越高代表數字越大。') + '橫軸是日期，左舊右新。'));
  }

  function hoursText(min) { return min === null || min === undefined || isNaN(min) ? '—' : (min / 60).toFixed(1); }
  function num1(x) { return x === null || x === undefined || isNaN(x) ? '—' : (Math.round(x * 10) / 10).toString(); }

  // For the tiered tasks 就寢 and 步數: how the last `days` days split into 進階 / 標準 / 最低 / 沒達到.
  function tierLines(days) {
    var c = ctx(), t0 = today(), out = [];
    c.tasks.forEach(function (t) {
      if (!t.active || isAccumFreq(t.freq) || !(t.tierUp || t.tierDown) || !/就寢|步數/.test(t.name)) return;
      var n = { '進階': 0, '標準': 0, '最低': 0, miss: 0 };
      for (var i = 0; i < days; i++) {
        var d = addDays(t0, -i);
        if (!isScheduled(t, d) || c.leave[d]) continue;
        if (isDone(t, d, c.idx)) { var tr = tierOn(t, d, c.idx); n[tr] = (n[tr] || 0) + 1; }
        else if (d !== t0) n.miss++;
      }
      out.push(h('div', { style: 'margin:6px 0' }, h('b', null, t.name), '　進階 ' + n['進階'] + '・標準 ' + n['標準'] + '・最低 ' + n['最低'] + '・沒達到 ' + n.miss));
    });
    return out;
  }

  function trendCard(icon, title, summary, pts, o) {
    var card = h('div', { class: 'card' }, h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, icon), title));
    if (summary) card.appendChild(h('div', { class: 'muted' }, summary));
    if (pts && pts.length) card.appendChild(sparkline(pts, o));
    return card;
  }

  function renderHealth() {
    var t0 = today(), hs = dget('health'), nodes = [h('h1', null, '健康趨勢')];
    if (!hs.length) nodes.push(h('p', { class: 'muted' }, '還沒有健康資料。手機的「健康同步」App 會把睡眠、步數、心率、體重傳到試算表「健康」分頁。'));

    var sl = sleepSummary(hs, t0);
    var sleepCard = h('div', { class: 'card' }, h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '😴'), '睡眠（近 7 天）'));
    if (!sl.n) sleepCard.appendChild(h('div', { class: 'muted' }, '近 7 天沒有睡眠資料。'));
    else {
      sleepCard.appendChild(h('div', { class: 'stat' },
        h('span', null, '平均 ', h('b', null, hoursText(sl.sleepMin)), ' 小時'),
        h('span', null, '入睡 ', h('b', null, fmtClock_(sl.bed))),
        h('span', null, '起床 ', h('b', null, fmtClock_(sl.wake)))));
      sleepCard.appendChild(h('div', { class: 'muted' }, (sl.bedSd !== null ? '入睡時間前後差約 ' + Math.round(sl.bedSd) + ' 分鐘' : '') + (sl.deepMin ? '・深眠平均 ' + Math.round(sl.deepMin) + ' 分' : '')));
      if (sl.alert) sleepCard.appendChild(h('div', { class: 'alert' }, '⚠️ 近 7 天平均入睡，比前兩週晚了 ' + Math.round(sl.drift) + ' 分鐘。睡眠影響恢復、荷爾蒙和皮膚，今晚試著提早 15 分鐘上床。'));
      else if (sl.drift !== null && sl.drift <= -20) sleepCard.appendChild(h('div', { class: 'good' }, '👍 近 7 天平均入睡，比前兩週早了 ' + Math.round(-sl.drift) + ' 分鐘。'));
    }
    var bedPts = healthSeries(hs, t0, 28, 'bedLine'), durPts = healthSeries(hs, t0, 28, 'sleepMin');
    if (bedPts.length) { sleepCard.appendChild(h('div', { class: 'muted', style: 'margin-top:8px' }, '入睡時間（近 28 天，越高越早）')); sleepCard.appendChild(sparkline(bedPts, { invert: true, fmt: fmtClock_, label: '入睡時間趨勢' })); }
    if (durPts.length) { sleepCard.appendChild(h('div', { class: 'muted', style: 'margin-top:8px' }, '睡眠時數（近 28 天）')); sleepCard.appendChild(sparkline(durPts, { fmt: function (v) { return hoursText(v) + ' 小時'; }, label: '睡眠時數趨勢' })); }
    nodes.push(sleepCard);

    var tl = tierLines(28);
    if (tl.length) nodes.push(h('div', { class: 'card' }, h('div', { class: 'name' }, '三檔任務（近 28 天）'), tl, h('div', { class: 'muted' }, '三檔都算完成；看「進階」和「標準」有沒有變多。')));

    var rhrPts = healthSeries(hs, t0, 28, 'rhr'), stepPts = healthSeries(hs, t0, 28, 'steps');
    var rhrAvg = mean_(rhrPts.slice(-7).map(function (p) { return p.value; })), stepAvg = mean_(stepPts.slice(-7).map(function (p) { return p.value; }));
    nodes.push(trendCard('❤️', '靜止心率', rhrAvg !== null ? '近 7 天平均 ' + Math.round(rhrAvg) + ' bpm（越低通常代表心肺越好、恢復越好）' : '還沒有心率資料', rhrPts, { invert: true, fmt: function (v) { return v + ' bpm'; }, label: '靜止心率趨勢' }));
    nodes.push(trendCard('👟', '步數', stepAvg !== null ? '近 7 天平均 ' + Math.round(stepAvg) + ' 步' : '還沒有步數資料', stepPts, { fmt: function (v) { return Math.round(v) + ' 步'; }, label: '步數趨勢' }));

    var wPts = healthSeries(hs, t0, 90, 'weight'), fPts = healthSeries(hs, t0, 90, 'bodyFat');
    if (wPts.length || fPts.length) {
      var wCard = h('div', { class: 'card' }, h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚖️'), '體重與體脂（近 90 天）'));
      if (wPts.length) {
        var wl = wPts[wPts.length - 1], wf = wPts[0];
        wCard.appendChild(h('div', { class: 'stat' }, h('span', null, '體重 ', h('b', null, num1(wl.value)), ' kg'), wPts.length > 1 ? h('span', { class: 'muted' }, (wl.value - wf.value >= 0 ? '+' : '') + num1(wl.value - wf.value) + ' kg（自 ' + wf.date.slice(5) + '）') : null));
        wCard.appendChild(sparkline(wPts, { fmt: function (v) { return num1(v) + ' kg'; }, label: '體重趨勢' }));
      }
      if (fPts.length) {
        var fl = fPts[fPts.length - 1], ff = fPts[0];
        wCard.appendChild(h('div', { class: 'stat', style: 'margin-top:8px' }, h('span', null, '體脂 ', h('b', null, num1(fl.value)), ' %'), fPts.length > 1 ? h('span', { class: 'muted' }, (fl.value - ff.value >= 0 ? '+' : '') + num1(fl.value - ff.value) + ' %（自 ' + ff.date.slice(5) + '）') : null));
        wCard.appendChild(sparkline(fPts, { fmt: function (v) { return num1(v) + ' %'; }, label: '體脂趨勢' }));
      }
      nodes.push(wCard);
    } else {
      nodes.push(h('div', { class: 'card' }, h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '⚖️'), '體重與體脂'), h('div', { class: 'muted' }, '還沒有資料。FitDays 要開啟「寫入 Health Connect」，站上體脂計量一次，再到「健康同步」App 按「補抓近 30 天」。')));
    }

    var cs = checkinSummary(dget('checkins'), t0, 7), cp = checkinSummary(dget('checkins'), addDays(t0, -7), 7);
    var cCard = h('div', { class: 'card' }, h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '📝'), '自評（近 7 天，共 ' + cs.n + ' 天有記）'));
    if (!cs.n) cCard.appendChild(h('div', { class: 'muted' }, '到「今日」頁最下面的「今日自評」記一下，10 秒就好。'));
    else {
      CHECKIN_METRICS.forEach(function (m) {
        var v = cs.avg[m.key], pv = cp.avg[m.key];
        var trend = v !== null && pv !== null ? (v - pv > 0.3 ? (m.worseHigh ? '　⚠️ 比前 7 天高' : '　▲') : v - pv < -0.3 ? (m.worseHigh ? '　▲ 比前 7 天低' : '　▼') : '') : '';
        cCard.appendChild(bar(m.label, v !== null ? v.toFixed(1) + ' / 5' + trend : '—', v === null ? 0 : v / 5));
      });
      Object.keys(cs.extra).forEach(function (k) { cCard.appendChild(bar(k, cs.extra[k].toFixed(1) + ' / 5', cs.extra[k] / 5)); });
      var fl2 = CHECKIN_FLAGS.filter(function (f) { return cs.flags[f.name]; }).map(function (f) { return f.name + ' ' + cs.flags[f.name] + ' 天'; });
      if (fl2.length) cCard.appendChild(h('div', { class: 'muted' }, fl2.join('・')));
    }
    nodes.push(cCard);
    return nodes;
  }

  // ---- 每日自評 ----

  function setCheckin(date, key, value, extraName) {
    var cur = Object.assign({ date: date, energy: 0, mood: 0, stress: 0, sore: 0, flags: [], extra: {} }, checkinOn(dget('checkins'), date) || {});
    cur.flags = (cur.flags || []).slice();
    cur.extra = Object.assign({}, cur.extra || {});
    if (extraName) { if (value) cur.extra[extraName] = value; else delete cur.extra[extraName]; }
    else if (key === 'flag') { var i = cur.flags.indexOf(value); if (i >= 0) cur.flags.splice(i, 1); else cur.flags.push(value); }
    else cur[key] = value;
    state.data.checkins = dget('checkins').filter(function (r) { return r.date !== date; }).concat([cur]);
    enqueue('checkin', { checkin: cur });
  }

  function checkinCard(date) {
    var cur = checkinOn(dget('checkins'), date) || { energy: 0, mood: 0, stress: 0, sore: 0, flags: [], extra: {} };
    var filled = !!(cur.energy || cur.mood || cur.stress || cur.sore || (cur.flags || []).length || Object.keys(cur.extra || {}).length);
    var extraNames = String((state.data.settings || {}).checkinExtra || '').split(',').filter(function (x) { return x; });
    function scaleRow(label, low, high, value, onPick) {
      return h('div', { class: 'scale' },
        h('span', { class: 'sl' }, label),
        h('div', { class: 'sbtns' }, [1, 2, 3, 4, 5].map(function (n) {
          return h('button', { class: 'sb' + (value === n ? ' on' : ''), type: 'button', 'aria-pressed': String(value === n), 'aria-label': label + ' ' + n, onclick: function () { onPick(value === n ? 0 : n); } }, String(n));
        })),
        h('span', { class: 'muted se' }, low + '→' + high));
    }
    var open = state.checkinOpen && state.checkinOpen.date === date ? state.checkinOpen.open : !filled;
    var box = h('details', { class: 'card', open: open },
      h('summary', null, '今日自評' + (filled ? '（已記）' : '（約 10 秒）')),
      CHECKIN_METRICS.map(function (m) { return scaleRow(m.label, m.low, m.high, cur[m.key] || 0, function (v) { setCheckin(date, m.key, v); }); }),
      extraNames.map(function (nm) { return scaleRow(nm, '低', '高', (cur.extra || {})[nm] || 0, function (v) { setCheckin(date, '', v, nm); }); }),
      h('div', { class: 'muted' }, '只是記錄，不影響完成率。累積幾週後在「健康」頁看和睡眠、運動的關係。'));
    box.addEventListener('toggle', function () { state.checkinOpen = { date: date, open: box.open }; });
    return box;
  }

  // 今天的狀態: 精神好／普通／疲勞 (shared with the 訓練 tab). 疲勞 = 低能量日.
  function dayStateBar(date) {
    var st = trainStateOn(date), future = date > today(), settings = state.data.settings || {};
    var coreN = coreIdsFrom(settings).length, vacN = vacIdsFrom(settings).length, vac = vacOn(date);
    return h('div', { class: 'card' },
      h('div', { class: 'muted' }, '今天的狀態（疲勞＝低潮）'),
      h('div', { class: 'seg' }, TRAIN_STATES.map(function (s) {
        return h('button', { class: 'btn' + (st === s ? ' on' : ''), 'aria-pressed': String(st === s), disabled: future, onclick: function () { setTrainState(date, s); } }, s === '疲勞' ? '疲勞・低潮' : s);
      })),
      h('div', { class: 'muted' }, st === '疲勞'
        ? (coreN ? '低潮（低能量日）：只有標「核心」的任務還要做，其他今天放過，不影響連續天數。' : '低潮（低能量日）：還沒有設定核心任務。到「任務」頁編輯任務，勾選「低能量日仍要做」。')
        : '選「疲勞」＝低潮，只做核心任務；訓練頁也會給輕鬆版。'),
      h('div', { class: 'muted', style: 'margin-top:10px' }, '今天的模式'),
      h('div', { class: 'seg' }, [['平日', false], ['休假', true]].map(function (m) {
        return h('button', { class: 'btn' + (vac === m[1] ? ' on' : ''), 'aria-pressed': String(vac === m[1]), disabled: future, onclick: function () { if (vac !== m[1]) setVacMode(date, m[1]); } }, m[0]);
      })),
      vac ? h('div', { class: 'muted' }, vacN ? '休假日：只有標「休假日仍要做」的任務還要做，其他今天放過，不影響連續天數。' : '休假日：還沒有設定要做的任務。到「任務」頁編輯任務，勾選「休假日仍要做」。') : null);
  }

  // ---- 力量紀錄 (in the 訓練 tab) ----

  function strengthDayOn(date) {
    var moves = dget('strengthMoves'), byName = {}, rows = dget('strength');
    moves.forEach(function (m) { byName[m.name] = m; });
    var mine = rows.filter(function (r) { return r.date === date && byName[r.move]; });
    if (mine.length) return byName[mine[0].move].day;
    return nextStrengthDay(moves, rows.filter(function (r) { return r.date < date; }));
  }

  function strengthRow(m, date, past) {
    var cur = dget('strength').filter(function (r) { return r.date === date && r.move === m.name; })[0];
    var adv = strengthAdvice(m, past), next = cur ? strengthAdvice(m, past.concat([cur])) : adv;
    return h('div', { class: 'card item train' + (cur ? ' done' : '') },
      h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, m.name),
          h('div', { class: 'muted' }, '目標 ' + adv.target + (adv.last ? '・上次 ' + repsText(adv.last.reps) + (adv.last.weight ? ' @' + adv.last.weight + ' kg' : '') : '')),
          cur ? h('div', null, h('span', { class: 'chip on' }, '✓ ' + repsText(cur.reps) + (cur.weight ? ' @' + cur.weight + ' kg' : ''))) : null),
        h('button', { class: 'btn small' + (cur ? '' : ' primary'), onclick: function () { state.modal = { type: 'strength', task: { id: m.id }, move: m, date: date }; renderModal(); } }, cur ? '編輯' : '記錄')),
      h('div', { class: 'variant' + (next.ready ? ' go' : '') }, (cur ? '下次：' : '') + next.text));
  }

  function strengthModal(m) {
    var mv = m.move, date = m.date;
    var cur = dget('strength').filter(function (r) { return r.date === date && r.move === mv.name; })[0];
    var past = dget('strength').filter(function (r) { return r.date < date; });
    var adv = strengthAdvice(mv, past);
    var w0 = cur ? cur.weight : adv.last ? adv.last.weight : '';
    var form = h('form', { onsubmit: function (ev) {
      ev.preventDefault();
      var reps = [];
      for (var i = 0; i < mv.sets; i++) { var n = parseInt(form.elements['r' + i].value, 10); if (n > 0) reps.push(n); }
      if (!reps.length) { toast('至少填一組的次數'); return; }
      var entry = { date: date, move: mv.name, reps: reps, weight: mv.weighted ? (parseFloat(form.elements.weight.value) || 0) : 0, note: form.elements.note.value.trim() };
      saveStrengthLocal(entry);
      closeModal();
    } },
      h('p', { class: 'muted' }, dateTitle(date) + '・目標 ' + adv.target),
      h('div', { class: 'sets' }, (function () {
        var list = [];
        for (var i = 0; i < mv.sets; i++) list.push(h('label', { class: 'setb' }, '第 ' + (i + 1) + ' 組',
          h('input', { type: 'number', name: 'r' + i, min: '0', max: '999', inputmode: 'numeric', placeholder: String(mv.repsHigh), value: cur && cur.reps[i] ? cur.reps[i] : '' })));
        return list;
      }())),
      mv.weighted ? h('label', { class: 'f', for: 's-weight' }, '重量（公斤，同一個動作每組用同樣重量）') : null,
      mv.weighted ? h('input', { type: 'number', id: 's-weight', name: 'weight', min: '0', max: '500', step: '0.5', inputmode: 'decimal', value: w0 || '' }) : h('input', { type: 'hidden', name: 'weight', value: '' }),
      h('label', { class: 'f', for: 's-note' }, '備註（選填，例如手腕痠、換了彈力帶）'),
      h('input', { type: 'text', id: 's-note', name: 'note', maxlength: '100', value: cur ? cur.note : '' }),
      h('div', { class: 'variant' + (adv.ready ? ' go' : ''), style: 'margin-top:10px' }, adv.text),
      h('div', { class: 'row', style: 'margin-top:14px' },
        h('button', { class: 'btn primary grow', type: 'submit' }, cur ? '更新' : '儲存'),
        cur ? h('button', { class: 'btn danger', type: 'button', onclick: function () { closeModal(); saveStrengthLocal({ date: date, move: mv.name, reps: [], weight: 0, note: '' }); } }, '清除') : null,
        h('button', { class: 'btn', type: 'button', onclick: closeModal }, '關閉')));
    return modalShell(mv.name, form);
  }

  function saveStrengthLocal(entry) {
    state.data.strength = dget('strength').filter(function (r) { return !(r.date === entry.date && r.move === entry.move); });
    if (entry.reps.length) state.data.strength.push(entry);
    enqueue('strength', { entry: entry });
    // A logged session is also the day's 重量訓練 check-in.
    if (entry.reps.length) tickByName(/重量訓練/, entry.date, strengthDayOn(entry.date) + ' 日');
  }

  // ---- 三大目標與月回顧 (in the 月/季 tab) ----

  function goalCard() {
    var c = ctx(), prog = goalProgress(c.tasks, dget('goalMap'), c.idx, c.leave, today());
    var rows = prog.map(function (g) {
      if (!g.tasks) return h('div', { class: 'muted', style: 'margin:8px 0' }, g.icon + ' ' + g.name + '：還沒有對應的任務');
      var arrow = g.delta === null ? '' : g.delta > 0.03 ? '　▲' + Math.round(g.delta * 100) : g.delta < -0.03 ? '　▼' + Math.round(-g.delta * 100) : '　＝';
      return bar(g.icon + ' ' + g.name + '（' + g.tasks + ' 項任務）', pct(g.rate) + arrow, g.rate || 0);
    });
    return [h('h2', null, '三大目標・近 7 天'),
      h('div', { class: 'card' }, rows, h('div', { class: 'muted' }, '完成度＝對應任務近 7 天的完成比例，▲▼ 是和前 7 天比。哪些任務算哪個目標，到試算表「目標對應」調整。'))];
  }

  function reviewCard() {
    var t0 = today(), d = state.data;
    var rev = monthReview({ tasks: d.tasks, logs: d.logs, leave: d.leave, exempts: dget('exempts'), extras: extras(), health: dget('health'), checkins: dget('checkins'), strength: dget('strength') }, monthKey(t0), t0);
    var c = rev.cur, p = rev.prev;
    function row(label, a, b) { return h('tr', null, h('td', null, label), h('td', null, a), h('td', null, b)); }
    function clock(m) { return m === null || m === undefined || isNaN(m) ? '—' : fmtClock_(m); }
    function whole(x) { return x === null || x === undefined || isNaN(x) ? '—' : String(Math.round(x)); }
    function weight(r) { return r.weightFirst === null || r.weightFirst === undefined ? '—' : r.weightFirst + ' → ' + r.weightLast; }
    function fat(r) { return r.fatFirst === null || r.fatFirst === undefined ? '—' : r.fatFirst + ' → ' + r.fatLast; }
    return [h('h2', null, '月回顧（本月到今天 vs 上個月）'),
      h('div', { class: 'card scroll' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, c.month.slice(5) + ' 月'), h('th', null, p.month.slice(5) + ' 月'))),
        h('tbody', null,
          row('必做完成率', pct(c.rate), pct(p.rate)),
          row('達標天數', String(c.qualified || 0), String(p.qualified || 0)),
          row('平均睡眠（小時）', hoursText(c.sleepMin), hoursText(p.sleepMin)),
          row('平均入睡', clock(c.bed), clock(p.bed)),
          row('平均步數', whole(c.steps), whole(p.steps)),
          row('靜止心率', whole(c.rhr), whole(p.rhr)),
          row('體重 kg', weight(c), weight(p)),
          row('體脂 %', fat(c), fat(p)),
          row('重量訓練（天）', String(c.strengthDays || 0), String(p.strengthDays || 0)),
          row('Zone 2（分鐘）', String(c.zone2Min || 0), String(p.zone2Min || 0)),
          row('自評精力', num1(c.energy), num1(p.energy)),
          row('自評壓力', num1(c.stress), num1(p.stress)))),
        h('div', { class: 'row', style: 'margin-top:10px' },
          h('button', { class: 'btn small', onclick: function () {
            var text = monthReviewText(rev);
            if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { toast('已複製，貼給 Claude 就能做完整回顧'); }, function () { toast('無法複製'); });
            else toast('這個瀏覽器不能複製');
          } }, '複製成文字'),
          h('span', { class: 'muted grow' }, '貼給 Claude，會幫你做完整的月回顧與下月重點。')))];
  }

  // ---- 更多 (the pages that used to be separate tabs) ----

  var SUB_PAGES = ['ledger', 'game', 'dreams', 'tasks', 'plan', 'settings'];
  function navTabOf(tab) { return SUB_PAGES.indexOf(tab) >= 0 ? 'more' : tab; }

  function goTab(tab) {
    state.tab = tab; state.editing = null; state.modal = null;
    if (tab === 'ledger') loadLedger();
    if (tab === 'dreams') loadDreams();
    render(); window.scrollTo(0, 0);
  }

  function renderMore() {
    var items = [
      ['ledger', '📒', '記錄', '記帳、餐費、日記、待辦、預算'],
      ['game', '🏅', '成就', '等級、星幣、成就、免責券'],
      ['dreams', '🌠', '夢想', '50 夢想清單與自動進度（資料在「50夢想」試算表）'],
      ['tasks', '🗂', '任務', '新增、修改、排序、設定核心任務'],
      ['plan', '📅', '月/季', '三大目標、月回顧、月/季規劃'],
      ['settings', '⚙️', '設定', '連線、動畫、自評額外題目']
    ];
    var nodes = [h('h1', null, '更多')];
    items.forEach(function (it) {
      nodes.push(h('button', { class: 'card more', onclick: function () { goTab(it[0]); } },
        h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, it[1]), it[2]), h('div', { class: 'muted' }, it[3])));
    });
    return nodes;
  }

  // Sub pages get a way back to 更多.
  function withBack(tab, nodes) {
    if (SUB_PAGES.indexOf(tab) < 0 || !state.cfg) return nodes;
    return [h('button', { class: 'btn small', onclick: function () { goTab('more'); } }, '‹ 更多')].concat(nodes);
  }

  // ---- 記錄: 記帳, 餐費, 日記 ----

  var LEDGER_CHIPS = [['🥤', '含糖'], ['🍟', '炸物'], ['🍷', '酒'], ['🍩', '甜點'], ['🥗', '健康餐'], ['🥬', '足量蔬菜'], ['🍎', '水果'], ['🏋', '運動']];

  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random(); }

  function ledgerKindOf(t) {
    if (!t.active) return '';
    if (/記餐費|餐費/.test(t.name)) return 'meal';
    if (/記帳/.test(t.name)) return 'expense';
    if (/日記/.test(t.name)) return 'diary';
    return '';
  }

  function ledgerState() {
    if (!state.ledger) {
      state.ledger = {
        pane: 'expense', date: today(), busy: false, preview: null, cid: {},
        draft: { type: '支出', category: '', sub: '', desc: '', amount: '', method: LS.get('habit.ledger.method', '刷卡'), note: '',
          meal: defaultMeal(new Date().getHours()), content: '', mamount: '', diary: '' }
      };
    }
    return state.ledger;
  }

  function openLedger(pane, date) {
    var L0 = ledgerState();
    L0.pane = pane; L0.date = date || today(); L0.preview = null;
    goTab('ledger');
  }

  function loadLedger() {
    if (!state.cfg || state.ledgerLoading) return;
    state.ledgerLoading = true;
    api('ledgerData').then(function (res) {
      state.data.ledger = res.ledger;
      LS.set('habit.data', state.data);
    }).catch(function (e) {
      if (!e.network) state.data.ledger = { enabled: false, error: e.message };
    }).then(function () { state.ledgerLoading = false; if (state.tab === 'ledger') render(); });
  }

  // Tick the habit task that matches (記帳, 記餐費, 日記) once its entry is saved.
  function tickByName(re, date, note) {
    var t = state.data.tasks.filter(function (x) { return x.active && re.test(x.name); })[0];
    if (t && !isDone(t, date, ctx().idx)) checkTask(t, date, '標準', note || '');
  }

  function ledgerSend(kind, action, payload, onOk) {
    var L0 = ledgerState();
    L0.busy = true; render();
    api(action, Object.assign({ clientId: L0.cid[kind] || (L0.cid[kind] = uuid()) }, payload)).then(function (res) {
      L0.cid[kind] = null;
      onOk(res.result);
    }).catch(function (e) { toast(e.network ? '需要網路才能記錄，內容還在，連上網再按一次' : e.message); })
      .then(function () { L0.busy = false; render(); });
  }

  function dayChips(L0) {
    var t0 = today(), picks = [['前天', addDays(t0, -2)], ['昨天', addDays(t0, -1)], ['今天', t0]];
    return h('div', { class: 'row', style: 'flex-wrap:wrap' },
      picks.map(function (p) { return h('button', { class: 'btn small' + (L0.date === p[1] ? ' primary' : ''), type: 'button', onclick: function () { L0.date = p[1]; L0.preview = null; render(); } }, p[0]); }),
      h('input', { type: 'date', class: 'dateinp', value: L0.date, max: t0, 'aria-label': '日期', onchange: function (ev) { if (ev.target.value) { L0.date = ev.target.value; L0.preview = null; render(); } } }));
  }

  function rememberExpense(e) {
    var list = LS.get('habit.ledger.recent', []).filter(function (r) { return !(r.desc === e.desc && r.category === e.category); });
    list.unshift({ type: e.type, category: e.category, sub: e.sub, desc: e.desc, amount: e.amount, method: e.method });
    LS.set('habit.ledger.recent', list.slice(0, 12));
    LS.set('habit.ledger.method', e.method);
  }

  function expenseForm(L0, lg) {
    var d = L0.draft, cats = lg.categories[d.type === '收入' ? 'income' : 'expense'];
    if (cats.big.indexOf(d.category) < 0) d.category = cats.big[0];
    var subs = (cats.subs && cats.subs[d.category]) || [];
    function bind(key) { return function (ev) { d[key] = ev.target.value; }; }
    function seg(key, values) {
      return h('div', { class: 'seg' }, values.map(function (v) {
        return h('button', { class: 'btn' + (d[key] === v ? ' on' : ''), type: 'button', 'aria-pressed': String(d[key] === v), onclick: function () { d[key] = v; if (key === 'type') d.category = ''; render(); } }, v);
      }));
    }
    var recent = LS.get('habit.ledger.recent', []).filter(function (r) { return r.type === d.type; }).slice(0, 6);
    var form = h('form', { class: 'card', onsubmit: function (ev) {
      ev.preventDefault();
      var entry = { date: L0.date, type: d.type, category: d.category, sub: d.sub.trim(), desc: d.desc.trim(), amount: d.amount, method: d.method, note: d.note.trim() };
      try { expenseRow(entry); } catch (e) { toast(e.message); return; }
      ledgerSend('expense', 'ledgerExpense', { entry: entry }, function (r) {
        lg.expenses = (lg.expenses || []).concat([{ row: r.row, date: entry.date, type: entry.type, category: entry.category, sub: entry.sub, desc: entry.desc, amount: parseAmount(entry.amount), method: entry.method, note: entry.note }]);
        rememberExpense(entry);
        d.desc = ''; d.amount = ''; d.note = ''; d.sub = '';
        tickByName(/記帳/, entry.date, '');
        toast('已記下：' + (entry.desc || entry.category) + ' ' + parseAmount(entry.amount));
      });
    } },
      recent.length ? h('div', null, h('div', { class: 'muted' }, '常用（點一下帶入）'),
        h('div', { class: 'flags' }, recent.map(function (r) {
          return h('button', { class: 'fl', type: 'button', onclick: function () { Object.assign(d, { type: r.type, category: r.category, sub: r.sub || '', desc: r.desc, amount: r.amount, method: r.method }); render(); } }, (r.desc || r.category) + ' ' + r.amount);
        }))) : null,
      seg('type', ['支出', '收入']),
      h('label', { class: 'f', for: 'x-cat' }, '大類'),
      h('select', { id: 'x-cat', name: 'category', onchange: function (ev) { d.category = ev.target.value; d.sub = ''; render(); } }, cats.big.map(function (o) { return h('option', { value: o, selected: o === d.category }, o); })),
      h('label', { class: 'f', for: 'x-sub' }, '子類（可自己輸入）'),
      h('input', { type: 'text', id: 'x-sub', list: 'x-subs', autocomplete: 'off', value: d.sub, oninput: bind('sub') }),
      h('datalist', { id: 'x-subs' }, subs.map(function (s) { return h('option', { value: s }); })),
      h('label', { class: 'f', for: 'x-desc' }, '項目描述'),
      h('input', { type: 'text', id: 'x-desc', autocomplete: 'off', value: d.desc, oninput: bind('desc') }),
      h('label', { class: 'f', for: 'x-amt' }, '金額'),
      h('input', { type: 'text', id: 'x-amt', inputmode: 'decimal', autocomplete: 'off', value: d.amount, oninput: bind('amount') }),
      seg('method', ['刷卡', '現金']),
      h('label', { class: 'f', for: 'x-note' }, '備註'),
      h('input', { type: 'text', id: 'x-note', autocomplete: 'off', value: d.note, oninput: bind('note') }),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn primary grow', type: 'submit', disabled: L0.busy }, L0.busy ? '寫入中…' : '記下這筆'),
        h('button', { class: 'btn', type: 'button', disabled: L0.busy, onclick: function () {
          ledgerSend('nospend', 'ledgerNoSpend', { date: L0.date }, function () { tickByName(/記帳/, L0.date, '今天沒花錢'); toast('好的，記為「沒花錢」'); });
        } }, '沒花錢')));
    return form;
  }

  function mealForm(L0, lg) {
    var d = L0.draft;
    var form = h('form', { class: 'card', onsubmit: function (ev) {
      ev.preventDefault();
      var entry = { date: L0.date, meal: d.meal, content: d.content, amount: d.mamount };
      try { mergeMeal(null, entry); } catch (e) { toast(e.message); return; }
      ledgerSend('meal', 'ledgerMeal', { entry: entry }, function () {
        var rows = lg.meals || [], row = rows.filter(function (r) { return r.date === entry.date; })[0];
        if (!row) { row = { date: entry.date, meals: {} }; MEAL_NAMES.forEach(function (m) { row.meals[m] = { content: '', amount: 0 }; }); rows = rows.concat([row]); }
        var cur = row.meals[entry.meal];
        cur.content = cur.content && entry.content.trim() ? cur.content + ' ' + entry.content.trim() : (cur.content || entry.content.trim());
        cur.amount += parseMealAmount(entry.amount);
        lg.meals = rows;
        d.content = ''; d.mamount = '';
        tickByName(/餐費/, entry.date, '');
        toast('已記下這餐');
      });
    } },
      h('div', { class: 'seg' }, MEAL_NAMES.map(function (m) {
        return h('button', { class: 'btn' + (d.meal === m ? ' on' : ''), type: 'button', 'aria-pressed': String(d.meal === m), onclick: function () { d.meal = m; render(); } }, m);
      })),
      h('label', { class: 'f', for: 'm-content' }, '內容（下面的符號會加進內容，分數公式靠它計算）'),
      h('input', { type: 'text', id: 'm-content', autocomplete: 'off', value: d.content, oninput: function (ev) { d.content = ev.target.value; } }),
      h('div', { class: 'flags' }, LEDGER_CHIPS.map(function (c) {
        return h('button', { class: 'fl', type: 'button', onclick: function () { d.content = d.content ? d.content.replace(/\s+$/, '') + ' ' + c[0] : c[0]; render(); } }, c[0] + c[1]);
      })),
      h('label', { class: 'f', for: 'm-amt' }, '金額（不分現金／刷卡，可留空）'),
      h('input', { type: 'text', id: 'm-amt', inputmode: 'decimal', autocomplete: 'off', value: d.mamount, oninput: function (ev) { d.mamount = ev.target.value; } }),
      h('button', { class: 'btn primary', type: 'submit', style: 'margin-top:12px;width:100%', disabled: L0.busy }, L0.busy ? '寫入中…' : '記下這餐'));
    return form;
  }

  function diaryForm(L0, lg) {
    var d = L0.draft;
    if (!lg.diary) return h('div', { class: 'card muted' }, '日記資料庫還沒設定：到 Apps Script 執行 setupLedger()。');
    var preview = L0.preview && L0.preview.date === L0.date ? h('div', { class: 'howto', style: 'white-space:pre-wrap' }, L0.preview.text || '（這天還沒有內容）') : null;
    return h('form', { class: 'card', onsubmit: function (ev) {
      ev.preventDefault();
      if (!d.diary.trim()) { toast('請先寫點內容'); return; }
      ledgerSend('diary', 'ledgerDiary', { date: L0.date, text: d.diary }, function (r) {
        d.diary = ''; L0.preview = null;
        tickByName(/日記/, L0.date, '');
        toast('已接在 ' + r.cell + ' 後面');
      });
    } },
      h('label', { class: 'f', for: 'd-text' }, '今天發生了什麼？（會接在 Year at a Glance 當天格子後面）'),
      h('textarea', { id: 'd-text', rows: '8', oninput: function (ev) { d.diary = ev.target.value; } }, d.diary),
      preview,
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn primary grow', type: 'submit', disabled: L0.busy }, L0.busy ? '寫入中…' : '寫進日記'),
        h('button', { class: 'btn', type: 'button', onclick: function () {
          api('ledgerDiaryRead', { date: L0.date }).then(function (res) { L0.preview = { date: L0.date, text: res.result.text }; render(); })
            .catch(function (e) { toast(e.network ? '需要網路' : e.message); });
        } }, '看當天已寫的')));
  }

  function ledgerDayList(L0, lg) {
    var date = L0.date, ex = (lg.expenses || []).filter(function (e) { return e.date === date; });
    var meal = (lg.meals || []).filter(function (r) { return r.date === date; })[0];
    var nodes = [h('h2', null, dateTitle(date) + ' 已記')];
    var spent = 0;
    ex.forEach(function (e) { if (e.type === '支出') spent += e.amount; });
    if (!ex.length && !meal) nodes.push(h('p', { class: 'muted' }, '這天還沒有記錄。已經貼回 Excel 並清空的，不會再出現在這裡。'));
    if (ex.length) {
      nodes.push(h('div', { class: 'card' },
        ex.map(function (e) {
          return h('div', { class: 'row', style: 'margin:6px 0' }, h('div', { class: 'grow' }, (e.type === '收入' ? '＋ ' : '') + (e.desc || e.category), h('div', { class: 'muted' }, e.category + (e.sub ? '・' + e.sub : '') + '・' + e.method)), h('b', null, String(e.amount)));
        }),
        h('div', { class: 'muted' }, '支出合計 ' + spent)));
    }
    if (meal) {
      nodes.push(h('div', { class: 'card' }, MEAL_NAMES.filter(function (m) { return meal.meals[m].content || meal.meals[m].amount; }).map(function (m) {
        var x = meal.meals[m];
        return h('div', { class: 'row', style: 'margin:6px 0' }, h('b', null, m), h('div', { class: 'grow' }, x.content || '—'), x.amount ? h('span', null, String(x.amount)) : null);
      })));
    }
    return nodes;
  }

  function renderLedger() {
    var L0 = ledgerState(), lg = state.data.ledger, nodes = [h('h1', null, '記錄')];
    if (!lg) {
      nodes.push(h('p', { class: 'muted' }, '載入中…'));
      if (!state.ledgerTried) { state.ledgerTried = true; loadLedger(); }
      return nodes;
    }
    if (!lg.enabled) {
      nodes.push(h('div', { class: 'card' }, h('div', { class: 'name' }, '還沒設定記帳資料庫'),
        h('div', { class: 'muted' }, (lg.error ? lg.error + '。' : '') + '到 Apps Script 編輯器執行 setupLedger（只要一次），再回來按「立即同步」。'),
        h('button', { class: 'btn small', style: 'margin-top:8px', onclick: function () { state.ledgerTried = false; state.data.ledger = null; goTab('ledger'); } }, '重新檢查')));
      return nodes;
    }
    nodes.push(h('div', { class: 'seg' }, [['expense', '記帳'], ['meal', '餐費'], ['diary', '日記'], ['todo', '待辦'], ['budget', '預算']].map(function (p) {
      return h('button', { class: 'btn' + (L0.pane === p[0] ? ' on' : ''), 'aria-pressed': String(L0.pane === p[0]), onclick: function () { L0.pane = p[0]; render(); } }, p[1]);
    })));
    if (L0.pane === 'todo' || L0.pane === 'budget') {
      (L0.pane === 'todo' ? todoPane(L0) : budgetPane()).forEach(function (n) { nodes.push(n); });
      return nodes;
    }
    nodes.push(dayChips(L0));
    nodes.push(L0.pane === 'expense' ? expenseForm(L0, lg) : L0.pane === 'meal' ? mealForm(L0, lg) : diaryForm(L0, lg));
    if (L0.pane !== 'diary') ledgerDayList(L0, lg).forEach(function (n) { nodes.push(n); });
    return nodes;
  }

  // ---- 待辦提醒 (the reminders are still sent by the old project's trigger from the same sheet) ----

  function loadTodos() {
    if (!state.cfg || state.todosLoading) return;
    state.todosLoading = true; state.todosError = '';
    api('todoList').then(function (res) { state.todos = res.todos; })
      .catch(function (e) { state.todosError = e.network ? '需要網路才能看待辦' : e.message; })
      .then(function () { state.todosLoading = false; if (todoVisible()) render(); });
  }

  function todoVisible() { return state.tab === 'ledger' || (state.tab === 'today' && state.homePane === 'todo'); }

  function todoDo(action, payload, okMsg, local) {
    api(action, payload).then(function () { if (local) local(); toast(okMsg); if (todoVisible()) render(); })
      .catch(function (e) { toast(e.network ? '需要網路' : e.message); });
  }

  function todoDraft(L0) {
    if (!L0.todoDraft) L0.todoDraft = { text: '', time: '09:00', repeat: 'once', date: today(), weekdays: [], monthDay: '' };
    return L0.todoDraft;
  }

  // Delete without asking, but with a 6-second 復原 (the row is written back with the same id).
  function removeTodo(t) {
    state.todos = (state.todos || []).filter(function (x) { return x.id !== t.id; });
    render();
    api('todoDelete', { id: t.id }).then(function () {
      toast('已刪除「' + t.text.slice(0, 12) + '」', { label: '復原', fn: function () {
        api('todoSave', { todo: { id: t.id, text: t.text, time: t.time, repeat: t.repeat, date: t.date, weekdays: t.weekdays, monthDay: t.monthDay, enabled: t.enabled, done: t.done, lastSent: t.lastSent } })
          .then(function () { state.todos = null; loadTodos(); toast('已復原'); })
          .catch(function (e) { toast(e.network ? '需要網路才能復原' : e.message); });
      } });
    }).catch(function (e) { state.todos = null; loadTodos(); toast(e.network ? '需要網路才能刪除' : e.message); });
  }

  // Swipe a card sideways (either direction, 90px) to run onSwipe; a short drag springs back. Buttons inside keep working.
  function swipeable(el, onSwipe) {
    var sx = 0, sy = 0, dx = 0, on = false, moved = false;
    el.style.touchAction = 'pan-y';
    el.addEventListener('pointerdown', function (ev) {
      if (ev.target.closest && ev.target.closest('button,input,select,a,label')) return;
      on = true; moved = false; sx = ev.clientX; sy = ev.clientY; dx = 0; el.style.transition = 'none';
    });
    el.addEventListener('pointermove', function (ev) {
      if (!on) return;
      dx = ev.clientX - sx;
      if (!moved && Math.abs(dx) < 12) return;
      if (!moved && Math.abs(ev.clientY - sy) > Math.abs(dx)) { on = false; return; }
      moved = true;
      el.style.transform = 'translateX(' + dx + 'px)';
      el.style.opacity = String(Math.max(0.3, 1 - Math.abs(dx) / 220));
    });
    function end() {
      if (!on) return;
      on = false;
      el.style.transition = 'transform .18s, opacity .18s';
      if (moved && Math.abs(dx) >= 90) {
        el.style.transform = 'translateX(' + (dx > 0 ? 120 : -120) + '%)';
        el.style.opacity = '0';
        setTimeout(onSwipe, 170);
      } else { el.style.transform = ''; el.style.opacity = ''; }
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
    return el;
  }

  function todoCard(t) {
    var off = !t.enabled || t.done;
    return swipeable(h('div', { class: 'card swipe' + (off ? ' inactive' : '') },
      h('div', { class: 'name' }, t.text),
      h('div', { class: 'muted' }, describeTodo(t) + (t.done ? '（已完成）' : t.enabled ? '' : '・不提醒') + '　‹ 左右滑可刪除 ›'),
      h('div', { class: 'row', style: 'margin-top:8px' },
        t.done ? null : h('button', { class: 'btn small', onclick: function () { todoDo('todoPatch', { id: t.id, patch: { done: true } }, '已完成', function () { t.done = true; }); } }, '完成'),
        h('button', { class: 'btn small', onclick: function () { todoDo('todoPatch', { id: t.id, patch: { enabled: !t.enabled } }, t.enabled ? '不再提醒' : '會用 Telegram 提醒', function () { t.enabled = !t.enabled; }); } }, t.enabled ? '關提醒' : '開提醒'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn small danger', onclick: function () { removeTodo(t); } }, '刪除'))), function () { removeTodo(t); });
  }

  function todoPane(L0) {
    var nodes = [];
    if (!state.todos) {
      if (!state.todosLoading && !state.todosError) loadTodos();
      nodes.push(h('p', { class: 'muted' }, state.todosError || '載入中…'));
      if (state.todosError) nodes.push(h('button', { class: 'btn small', onclick: function () { state.todosError = ''; render(); } }, '重試'));
      return nodes;
    }
    if (!state.todos.length) nodes.push(h('p', { class: 'muted' }, '還沒有待辦。'));
    var g = groupTodos(state.todos, today());
    [['今天', g.today], ['本週（7 天內）', g.week], ['之後', g.later]].forEach(function (sec) {
      if (!sec[1].length) return;
      nodes.push(h('h2', null, sec[0] + '　' + sec[1].length));
      sec[1].forEach(function (t) { nodes.push(todoCard(t)); });
    });
    if (state.todos.length && !g.today.length && !g.week.length && !g.later.length) nodes.push(h('p', { class: 'muted' }, '今天起沒有待辦。'));
    if (g.past.length) {
      var past = h('details', { class: 'pastbox', open: !!state.todoPastOpen },
        h('summary', null, '過去／已完成　' + g.past.length),
        g.past.map(function (t) { return todoCard(t); }));
      past.addEventListener('toggle', function () { state.todoPastOpen = past.open; });
      nodes.push(past);
    }
    var d = todoDraft(L0), WD = ['日', '一', '二', '三', '四', '五', '六'];
    nodes.push(h('h2', null, '新增'));
    var form = h('form', { class: 'card', onsubmit: function (ev) {
      ev.preventDefault();

      var todo = { text: d.text, time: d.time, repeat: d.repeat, date: d.date, weekdays: d.weekdays, monthDay: d.monthDay, enabled: d.remind !== false };
      try { validateTodo(todo); } catch (e) { toast(e.message); return; }
      api('todoSave', { todo: todo }).then(function () { d.text = ''; toast('已新增提醒'); state.todos = null; loadTodos(); })
        .catch(function (e) { toast(e.network ? '需要網路' : e.message); });
    } },
      h('label', { class: 'f', for: 't-text' }, '內容（會顯示在 Telegram 通知上，請勿填金額或私密資訊）'),
      h('input', { type: 'text', id: 't-text', autocomplete: 'off', value: d.text, oninput: function (ev) { d.text = ev.target.value; } }),
      h('label', { class: 'f', for: 't-time' }, '時間'),
      h('input', { type: 'time', id: 't-time', value: d.time, oninput: function (ev) { d.time = ev.target.value; } }),
      h('label', { class: 'f', for: 't-rep' }, '重複'),
      h('select', { id: 't-rep', onchange: function (ev) { d.repeat = ev.target.value; render(); } },
        [['once', '一次'], ['daily', '每天'], ['weekly', '每週'], ['monthly', '每月']].map(function (o) { return h('option', { value: o[0], selected: d.repeat === o[0] }, o[1]); })),
      d.repeat === 'once' ? h('div', null, h('label', { class: 'f', for: 't-date' }, '日期'), h('input', { type: 'date', id: 't-date', value: d.date, oninput: function (ev) { d.date = ev.target.value; } })) : null,
      d.repeat === 'weekly' ? h('div', null, h('label', { class: 'f' }, '星期'), h('div', { class: 'flags' }, WD.map(function (w, i) {
        var on = d.weekdays.indexOf(i) >= 0;
        return h('button', { class: 'fl' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onclick: function () { if (on) d.weekdays = d.weekdays.filter(function (x) { return x !== i; }); else d.weekdays = d.weekdays.concat([i]); render(); } }, w);
      }))) : null,
      d.repeat === 'monthly' ? h('div', null, h('label', { class: 'f', for: 't-md' }, '每月幾號（31 號在小月會改到月底）'), h('input', { type: 'number', id: 't-md', min: '1', max: '31', inputmode: 'numeric', value: d.monthDay, oninput: function (ev) { d.monthDay = ev.target.value; } })) : null,
      h('label', { class: 'row f' }, h('input', { type: 'checkbox', checked: d.remind !== false, onchange: function (ev) { d.remind = ev.target.checked; } }), ' 到時間用 Telegram 提醒（取消勾選＝只是記在清單裡）'),
      h('button', { class: 'btn primary', type: 'submit', style: 'margin-top:12px;width:100%' }, '新增'));
    nodes.push(form);
    return nodes;
  }

  // ---- 預算 (this month's spending against the monthly budget; the 80% / 100% alerts still come from the old project) ----

  function loadBudget(force) {
    if (!state.cfg || state.budgetLoading) return;
    state.budgetLoading = true; state.budgetError = '';
    api('budgetSummary', { force: !!force }).then(function (res) { state.budget = res.budget; })
      .catch(function (e) { state.budgetError = e.network ? '需要網路才能看預算' : e.message; })
      .then(function () { state.budgetLoading = false; if (state.tab === 'ledger') render(); });
  }

  function money(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function budgetPane() {
    var nodes = [];
    if (!state.budget) {
      if (!state.budgetLoading && !state.budgetError) loadBudget(false);
      nodes.push(h('p', { class: 'muted' }, state.budgetError || '讀取中…（第一次要幾秒）'));
      if (state.budgetError) nodes.push(h('button', { class: 'btn small', onclick: function () { state.budgetError = ''; render(); } }, '重試'));
      return nodes;
    }
    var b = state.budget;
    nodes.push(h('h2', null, b.ym + ' 預算'));
    (b.warnings || []).forEach(function (w) { nodes.push(h('div', { class: 'alert' }, w)); });
    if (!b.usage.length && !(b.warnings || []).length) nodes.push(h('p', { class: 'muted' }, '目前沒有可監控的類別。'));
    b.usage.forEach(function (u) {
      nodes.push(h('div', { class: 'card' },
        h('div', { class: 'row' }, h('b', { class: 'grow' }, u.cat), h('span', null, money(u.spent) + ' / ' + money(u.budget) + '　' + u.pct + '%')),
        h('div', { class: 'bar', style: 'margin-top:6px' }, h('i', { class: u.pct >= 100 ? 'over' : u.pct >= 80 ? 'warn' : '', style: 'width:' + Math.min(u.pct, 100) + '%' })),
        h('div', { class: 'muted' }, '預算' + u.source)));
    });
    nodes.push(h('div', { class: 'muted' }, (b.source && b.source.mirrored ? '鏡像更新 ' + b.source.mirrored + '，另含收件匣 ' + b.source.inboxCount + ' 筆' : '') + (b.at ? '・' + b.at + ' 讀取' : '')));
    nodes.push(h('button', { class: 'btn small', style: 'margin-top:8px', onclick: function () { state.budget = null; loadBudget(true); render(); } }, '重新整理'));
    return nodes;
  }

  // ---- 訓練頁: the merged plan ----

  function weekLoadCard(date, start) {
    var w = trainingWeekLoad(date, start);
    function hm(min) { return min >= 60 ? Math.floor(min / 60) + ' 小時' + (min % 60 ? ' ' + (min % 60) + ' 分' : '') : min + ' 分'; }
    return h('div', { class: 'card' },
      h('div', { class: 'name' }, '這週的負擔'),
      h('div', { class: 'muted' }, '最低版 ' + hm(w.min) + '（週一、週五的力量，加週日長 Zone 2）・標準版 ' + hm(w.std) + '・全做 ' + hm(w.std + w.opt) + (w.fixed ? '，另外固定的課和健身房 ' + hm(w.fixed) : '')),
      h('div', { class: 'muted' }, '忙的週只做最低版就夠。選「疲勞」，卡片會給輕鬆版。'));
  }

  function homeStrengthNodes(item, date, st) {
    var moves = dget('strengthMoves').filter(function (m) { return m.active && m.day === item.day; });
    var logged = dget('strength').filter(function (r) { return r.date === date; });
    var done = moves.some(function (m) { return logged.some(function (r) { return r.move === m.name; }); });
    var variant = trainVariant(item, st), future = date > today();
    var nodes = [h('div', { class: 'card item train' + (done ? ' done' : '') },
      h('div', { class: 'name' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, item.icon), item.title),
      h('div', null, h('span', { class: 'chip on' }, '本週重點'), h('span', { class: 'chip' }, item.time), h('span', { class: 'muted' }, '約 ' + item.minutes + ' 分'),
        done ? h('span', { class: 'chip on' }, '✓ 已記錄') : null),
      variant ? h('div', { class: 'variant' }, h('b', null, variant.label + '：'), variant.text) : null,
      h('ul', null, item.detail.map(function (x) { return h('li', null, x); })))];
    if (!moves.length) {
      nodes.push(h('div', { class: 'card muted' }, '還沒有動作清單。到 Apps Script 執行 migrateV10，或在試算表「力量動作」填寫。'));
      return nodes;
    }
    if (future) return nodes;
    var past = dget('strength').filter(function (r) { return r.date < date; });
    moves.forEach(function (m) { nodes.push(strengthRow(m, date, past)); });
    return nodes;
  }

  // Any day can take one more strength session: a collapsed card with the A / B switch.
  function extraStrengthCard(date) {
    state.strengthDay = state.strengthDay || {};
    var moves = dget('strengthMoves').filter(function (m) { return m.active; });
    if (!moves.length) return null;
    var day = state.strengthDay[date] || strengthDayOn(date), past = dget('strength').filter(function (r) { return r.date < date; });
    var box = h('details', { class: 'card', open: !!state.extraStrengthOpen },
      h('summary', null, '多練一次力量（選填）'),
      h('div', { class: 'seg' }, ['A', 'B'].map(function (d) {
        return h('button', { class: 'btn' + (day === d ? ' on' : ''), type: 'button', 'aria-pressed': String(day === d), onclick: function () { state.strengthDay[date] = d; state.extraStrengthOpen = true; render(); } }, d + ' 日');
      })),
      moves.filter(function (m) { return m.day === day; }).map(function (m) { return strengthRow(m, date, past); }));
    box.addEventListener('toggle', function () { state.extraStrengthOpen = box.open; });
    return box;
  }

  function trainNodes(item, date, st) {
    return item.kind === 'strength-home' ? homeStrengthNodes(item, date, st) : [trainCard(item, date, st)];
  }

  // ---- 成就 tab ----

  function redeemModal() {
    var g = game(), rewards = dget('rewards').filter(function (r) { return r.active && r.cost > 0; });
    var list = rewards.length ? rewards.map(function (r) {
      var can = g.coins.balance >= r.cost;
      return h('div', { class: 'row', style: 'margin:8px 0' },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, (r.type === '免責券' ? '🎫 ' : '') + r.name), h('div', { class: 'muted' }, '⭐ ' + r.cost + (r.note ? '・' + r.note : ''))),
        h('button', { class: 'btn small' + (can ? ' primary' : ''), disabled: !can, onclick: function () {
          if (!confirm('用 ' + r.cost + ' 星幣兌換「' + r.name + '」？')) return;
          api('redeem', { rewardId: r.id }).then(function (res) { toast(res.result.type === '免責券' ? '已兌換免責券，到「今日」頁用掉' : '已兌換「' + res.result.name + '」，犒賞自己吧'); closeModal(); return refresh(); })
            .catch(function (e) { toast(e.network ? '兌換需要網路' : e.message); });
        } }, can ? '兌換' : '星幣不夠'));
    }) : [h('p', { class: 'muted' }, '還沒有可兌換的獎勵。到試算表「獎勵」分頁填寫名稱和星幣數，並把「啟用」改成 TRUE。')];
    return modalShell('兌換獎勵（⭐ ' + g.coins.balance + '）', h('div', null,
      h('p', { class: 'muted' }, '獎勵是額外的犒賞，不是許可證：玩樂（電影、遊戲、出去玩）隨時可以做，不需要兌換。'), list, h('div', { class: 'row', style: 'margin-top:12px' }, h('button', { class: 'btn grow', onclick: closeModal }, '關閉'))));
  }

  function monthCalendar(g) {
    var c = ctx(), t0 = today(), first = monthKey(t0) + '-01', lead = weekdayOf(first) - 1, n = g.month.days, cells = [];
    for (var i = 0; i < lead; i++) cells.push(h('i', { class: 'empty' }));
    for (var d = 1; d <= n; d++) {
      var date = monthKey(t0) + '-' + pad2_(d), st = dayStats(c.tasks, date, c.idx, c.leave), cls = 'day';
      var q = !st.leave && st.due > 0 && st.rate >= OVERALL_THRESHOLD;
      if (date > t0) cls += ' future'; else if (st.leave) cls += ' leave'; else if (q) cls += ' stamp'; else if (st.due > 0 && date < t0) cls += ' miss';
      if (date === t0) cls += ' now';
      cells.push(h('i', { class: cls, title: date }, q ? '✓' : String(d)));
    }
    var heads = WEEKDAY_NAMES.map(function (w) { return h('b', null, w); });
    var qd = g.month.qualified;
    function ms(target, coins, label) { return h('div', { class: 'muted' }, (qd >= target ? '✅ ' : '▫️ ') + label + '：' + (qd >= target ? '已達成' : '還差 ' + (target - qd) + ' 天') + '（+' + coins + ' 星幣）'); }
    return h('div', { class: 'card' },
      h('div', { class: 'cal' }, heads, cells),
      h('div', { class: 'bar', style: 'margin:10px 0' }, h('i', { style: 'width:' + Math.min(100, Math.round(qd / g.month.days * 100)) + '%' })),
      h('div', null, '本月達標 ', h('b', null, qd), ' 天（請假 ' + g.month.leave + ' 天）'),
      ms(10, 10, '10 天'), ms(20, 20 + 5, '20 天'), h('div', { class: 'muted' }, '整月每天都達標（請假日除外）：+50 星幣'));
  }

  // One small calendar per fixed habit for this month: which days were done, which were missed, plus the milestone it has reached.
  function habitMonthCards() {
    var c = ctx(), t0 = today(), ym = monthKey(t0), first = ym + '-01', lead = weekdayOf(first) - 1, n = daysInMonth_(ym);
    var tasks = c.tasks.filter(function (t) { return t.active && !isAccumFreq(t.freq); });
    if (!tasks.length) return [h('p', { class: 'muted' }, '還沒有固定習慣。')];
    return tasks.map(function (t) {
      var cells = [], done = 0, due = 0, i, d;
      for (i = 0; i < lead; i++) cells.push(h('i', { class: 'empty' }));
      for (d = 1; d <= n; d++) {
        var date = ym + '-' + pad2_(d), ok = isDone(t, date, c.idx), sch = isScheduled(t, date) && !c.leave[date], cls = '';
        if (ok) { cls = 'stamp'; done++; due++; }
        else if (date > t0) cls = 'future';
        else if (c.leave[date]) cls = 'leave';
        else if (sch) { cls = 'miss'; due++; }
        else cls = 'rest';
        if (date === t0) cls += ' now';
        cells.push(h('i', { class: cls, title: date }, ok ? '✓' : String(d)));
      }
      var total = doneCountOf(t), ms = milestoneOf(total);
      state.habitOpen = state.habitOpen || {};
      var card = h('details', { class: 'card habit ' + dimCls(t.dim), open: !!state.habitOpen[t.id] },
        h('summary', { class: 'row' }, h('div', { class: 'grow' }, nameLine(t)), h('span', { class: 'muted' }, (ms.got ? ms.got + ' ' : '') + (due ? Math.round(done / due * 100) + '%・' + done + '/' + due : '—'))),
        h('div', { class: 'cal mini' }, cells),
        h('div', { class: 'muted' }, '累計 ' + total + ' 次' + (ms.next ? '・再 ' + (ms.next - total) + ' 次到 ' + ms.next : '・已到 100 次')));
      card.addEventListener('toggle', function () { state.habitOpen[t.id] = card.open; });
      return card;
    });
  }

  function skillCard(s, g) {
    var k = g.skills[s], span = k.nextAt - k.levelStart, done = k.sp - k.levelStart;
    return h('div', { class: 'card skill frame-' + (k.frame || 'none') },
      h('div', { class: 'row' },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, s + '　Lv' + k.level), h('div', { class: 'muted' }, k.tier + '・' + k.title)),
        k.gain > 0 ? h('span', { class: 'chip on' }, '今天 +' + fmtPts(k.gain)) : null),
      h('div', { class: 'bar', style: 'margin-top:8px' }, h('i', { style: 'width:' + Math.round(Math.min(1, done / span) * 100) + '%' })),
      h('div', { class: 'muted' }, '再 ' + fmtPts(Math.round(k.toNext * 10) / 10) + ' 點升 Lv' + (k.level + 1) + '（累積 ' + fmtPts(k.sp) + ' 點）'));
  }

  function badgeWall(g) {
    var cats = [], by = {};
    g.achievements.forEach(function (a) { if (!by[a.cat]) { by[a.cat] = []; cats.push(a.cat); } by[a.cat].push(a); });
    var got = g.achievements.filter(function (a) { return a.unlocked; }).length;
    var nodes = [h('h2', null, '成就（' + got + '/' + g.achievements.length + '）')];
    cats.forEach(function (cat) {
      nodes.push(h('div', { class: 'muted', style: 'margin:8px 0 4px' }, cat));
      nodes.push(h('div', { class: 'badges' }, by[cat].map(function (a) {
        var hide = a.hidden && !a.unlocked;
        return h('div', { class: 'badge' + (a.unlocked ? ' on' : '') },
          h('div', { class: 'bname' }, a.unlocked ? '🏅 ' + a.name : hide ? '？？？' : '🔒 ' + a.name),
          h('div', { class: 'muted' }, hide ? '隱藏成就' : a.desc),
          a.unlocked ? h('div', { class: 'muted' }, a.date.slice(5) + (a.coins ? '・+' + a.coins + '⭐' : '')) : null);
      })));
    });
    return nodes;
  }

  function renderGame() {
    var g = game(), t0 = today();
    var nodes = [
      h('h1', null, '成就'),
      h('div', { class: 'card coinbox' },
        h('div', { class: 'row' },
          h('div', { class: 'grow' }, h('div', { class: 'big' }, '⭐ ', h('b', null, g.coins.balance)), h('div', { class: 'muted' }, '累計賺到 ' + g.coins.earned + '，已兌換 ' + g.coins.spent)),
          h('button', { class: 'btn primary', onclick: function () { state.modal = { type: 'redeem', task: { id: 'redeem' }, date: t0 }; renderModal(); } }, '兌換獎勵')),
        h('div', { class: 'muted', style: 'margin-top:8px' }, '🎫 免責券 ' + g.tickets + ' 張・總等級 ' + g.totalLevel + '／100「' + g.totalTitle + '」・目前連續 ' + g.streak.current + ' 天（最長 ' + g.streak.best + '）・完美日 ' + g.perfectCount + ' 次'))
    ];
    nodes.push(h('h2', null, '技能'));
    SKILLS.forEach(function (s) { nodes.push(skillCard(s, g)); });
    nodes.push(h('h2', null, '本月打卡'));
    nodes.push(monthCalendar(g));
    var habitSec = h('details', { class: 'habitsec', open: !!state.habitSecOpen },
      h('summary', null, '各習慣本月（點開看每個習慣的小日曆）'),
      habitMonthCards());
    habitSec.addEventListener('toggle', function () { state.habitSecOpen = habitSec.open; });
    nodes.push(habitSec);
    if (g.clean.length) {
      nodes.push(h('h2', null, '乾淨天數'));
      nodes.push(h('div', { class: 'card' }, g.clean.map(function (c) {
        var next = c.streak < 7 ? 7 : c.streak < 14 ? 14 : c.streak < 30 ? 30 : 0;
        return h('div', { style: 'margin:6px 0' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, c.icon || '•'), c.name + '　連續 ', h('b', null, c.streak), ' 天（最長 ' + c.best + '）',
          next ? h('span', { class: 'muted' }, '・再 ' + (next - c.streak) + ' 天到 ' + next + ' 天') : null);
      }), h('div', { class: 'muted' }, '當天沒記這項、而且當天有打卡，才算乾淨的一天。')));
    }
    badgeWall(g).forEach(function (n) { nodes.push(n); });
    var reds = dget('redemptions').slice().reverse();
    nodes.push(h('h2', null, '兌換紀錄'));
    if (!reds.length) nodes.push(h('p', { class: 'muted' }, '還沒有兌換過。'));
    reds.slice(0, 10).forEach(function (r) {
      nodes.push(h('div', { class: 'card row' }, h('div', { class: 'grow' }, h('div', { class: 'name' }, (r.type === '免責券' ? '🎫 ' : '') + r.name), h('div', { class: 'muted' }, r.date + '・⭐ ' + r.cost)),
        r.date === t0 ? h('button', { class: 'btn small danger', onclick: function () {
          if (!confirm('撤銷這筆兌換？')) return;
          api('undoRedeem', { ts: r.ts }).then(refresh).catch(function (e) { toast(e.network ? '需要網路' : e.message); });
        } }, '撤銷') : null));
    });
    return nodes;
  }

  // ---- 夢想: read-only view of the 「50夢想」 sheet; statuses are edited in the sheet ----

  function loadDreams() {
    if (!state.cfg || state.dreamsLoading) return;
    state.dreamsLoading = true; state.dreamsError = '';
    api('dreams').then(function (res) {
      state.dreams = res.dreams;
      LS.set('habit.dreams', res.dreams);
    }).catch(function (e) {
      if (!e.network) state.dreamsError = e.message;
    }).then(function () { state.dreamsLoading = false; if (state.tab === 'dreams') render(); });
  }

  function dreamRow(it) {
    var done = it.status === '已達成';
    var chip = done ? h('span', { class: 'chip on' }, '✓ 已達成' + (it.doneYear ? ' ' + it.doneYear : ''))
      : it.status === '已排定' ? h('span', { class: 'chip' }, '預計 ' + (it.targetYear || '已排定'))
      : it.status === '進行中' ? h('span', { class: 'chip on' }, '進行中') : null;
    var pct = it.progress == null ? null : Math.round(it.progress * 100);
    return h('div', { class: 'dream' + (done ? ' done' : ''), style: 'margin:8px 0' },
      h('div', null, h('span', { class: 'muted' }, it.id + '　'), it.name, chip ? h('span', null, ' ', chip) : null),
      pct != null && !done ? h('div', { class: 'row', style: 'align-items:center;gap:8px' }, h('div', { class: 'bar thin grow' }, h('i', { style: 'width:' + pct + '%' })), h('span', { class: 'muted' }, pct + '%')) : null,
      it.next ? h('div', { class: 'muted' }, '下一步：' + it.next) : null);
  }

  function renderDreams() {
    var D = state.dreams;
    var nodes = [h('h1', null, '夢想')];
    if (!D) {
      nodes.push(h('p', { class: 'muted' }, state.dreamsError ? '讀不到夢想清單：' + state.dreamsError : '載入中…（第一次需要網路）'));
      return nodes;
    }
    var pctAll = D.total ? Math.round(D.done / D.total * 100) : 0;
    nodes.push(h('div', { class: 'card' },
      h('div', { class: 'big' }, h('b', null, D.done), ' / ' + D.total + ' 已達成'),
      h('div', { class: 'bar', style: 'margin:8px 0' }, h('i', { style: 'width:' + pctAll + '%' })),
      D.coverage != null ? h('div', { class: 'muted' }, '被動收入覆蓋率 ' + Math.round(D.coverage * 100) + '%（近 13 個月被動收入 ÷ 支出，100% 表示能支應支出）') : null));
    D.axes.forEach(function (a) {
      nodes.push(h('h2', null, a.name + '　' + a.done + '/' + a.total));
      nodes.push(h('div', { class: 'card' }, D.items.filter(function (it) { return it.axis === a.name; }).map(dreamRow)));
    });
    nodes.push(h('div', { class: 'row' }, h('p', { class: 'muted grow' }, '狀態、年份、下一步要到「50夢想」試算表改，這裡只讀。更新於 ' + (D.updated || '')),
      h('button', { class: 'btn small', disabled: !!state.dreamsLoading, onclick: loadDreams }, state.dreamsLoading ? '更新中…' : '重新整理')));
    return nodes;
  }

  // ---- tasks ----

  function blankTask() {
    return { id: '', name: '', icon: '', skill: '', dim: '健康', freq: 'daily', param: '', slot: '不限', remind: true, active: true, link: '', cls: '必做', tierUp: '', tierDown: '', options: [] };
  }

  function saveTaskForm(form, original) {
    var f = form.elements;
    var freq = f.freq.value, param = '';
    if (freq === 'weekdays') param = Array.prototype.filter.call(form.querySelectorAll('input[name=wd]'), function (x) { return x.checked; }).map(function (x) { return x.value; }).join(',');
    if (isAccumFreq(freq)) param = f.n.value;
    var task = {
      id: original.id, name: f.name.value, icon: f.icon.value.trim(), skill: f.skill.value, dim: f.dim.value, cls: f.cls.value, freq: freq, param: param, slot: f.slot.value,
      remind: f.remind.checked, active: f.active.checked, link: f.link.value,
      tierUp: isAccumFreq(freq) ? '' : f.tierUp.value, tierDown: isAccumFreq(freq) ? '' : f.tierDown.value,
      options: isAccumFreq(freq) ? '' : f.options.value
    };
    var coreNow = coreIdsFrom(state.data.settings), wantCore = !!(original.id && f.core && f.core.checked), isCore = coreNow.indexOf(original.id) >= 0;
    var cues = cuesOf(), oldCue = cues[original.id] || '', newCue = original.id && f.cue ? f.cue.value.trim().slice(0, 20) : '';
    state.busy = true; render();
    api('saveTask', { task: task }).then(function () {
      if (original.id && wantCore !== isCore) {
        var next = wantCore ? coreNow.concat([original.id]) : coreNow.filter(function (x) { return x !== original.id; });
        return api('setSetting', { key: 'coreTasks', value: next.join(',') });
      }
    }).then(function () {
      var vacNow = vacIdsFrom(state.data.settings), wantVac = !!(original.id && f.vcore && f.vcore.checked), isVac = vacNow.indexOf(original.id) >= 0;
      if (original.id && wantVac !== isVac) {
        var nextVac = wantVac ? vacNow.concat([original.id]) : vacNow.filter(function (x) { return x !== original.id; });
        return api('setSetting', { key: 'vacTasks', value: nextVac.join(',') });
      }
    }).then(function () {
      if (original.id && newCue !== oldCue) {
        if (newCue) cues[original.id] = newCue; else delete cues[original.id];
        return api('setSetting', { key: 'taskCues', value: JSON.stringify(cues) });
      }
    }).then(function () { state.editing = null; toast('已儲存'); }).catch(function (e) { toast(e.network ? '需要網路才能修改任務' : e.message); })
      .then(function () { state.busy = false; return refresh(); });
  }

  function renderTaskForm(t) {
    var wds = String(t.param).split(',');
    var form = h('form', { class: 'card', onsubmit: function (ev) { ev.preventDefault(); saveTaskForm(form, t); } },
      h('label', { class: 'f', for: 'f-name' }, '名稱'),
      h('input', { type: 'text', id: 'f-name', name: 'name', value: t.name, required: true, maxlength: '80' }),
      h('label', { class: 'f', for: 'f-icon' }, '圖示（一個表情符號，留空會依名稱自動挑）'),
      h('div', { class: 'row' },
        h('input', { type: 'text', id: 'f-icon', name: 'icon', value: t.icon || '', maxlength: '8', style: 'width:90px;font-size:1.4rem;text-align:center' }),
        h('div', { class: 'icons grow' }, ICON_CHOICES.map(function (ic) {
          return h('button', { class: 'ibtn', type: 'button', 'aria-label': '選用圖示 ' + ic, onclick: function () { form.elements.icon.value = ic; } }, ic);
        }))),
      h('label', { class: 'f', for: 'f-cls' }, '類別（必做計入完成率與連續；加分只記錄）'),
      h('select', { id: 'f-cls', name: 'cls' }, ['必做', '加分'].map(function (k) { return h('option', { value: k, selected: k === t.cls }, k); })),
      h('label', { class: 'f', for: 'f-skill' }, '技能（做這個任務會讓哪個技能成長）'),
      h('select', { id: 'f-skill', name: 'skill' }, [['', '自動（依名稱與維度判斷）']].concat(SKILLS.map(function (k) { return [k, k]; })).concat([['無', '無（不加技能點）']]).map(function (o) {
        return h('option', { value: o[0], selected: o[0] === (t.skill || '') }, o[1]);
      })),
      h('label', { class: 'f', for: 'f-dim' }, '維度'),
      h('select', { id: 'f-dim', name: 'dim' }, DIMS.map(function (d) { return h('option', { value: d, selected: d === t.dim }, d); })),
      h('label', { class: 'f', for: 'f-freq' }, '頻率'),
      h('select', { id: 'f-freq', name: 'freq', onchange: function (ev) { sync(ev.target.value); } },
        Object.keys(FREQ_LABEL).map(function (k) { return h('option', { value: k, selected: k === t.freq }, FREQ_LABEL[k]); })),
      h('div', { id: 'f-days', class: 'days' }, WEEKDAY_NAMES.map(function (n, i) {
        return h('label', null, h('input', { type: 'checkbox', name: 'wd', value: String(i + 1), checked: wds.indexOf(String(i + 1)) >= 0 }), h('span', null, n));
      })),
      h('div', { id: 'f-n' }, h('label', { class: 'f', for: 'f-nn', id: 'f-nl' }, '次數'), h('input', { type: 'number', id: 'f-nn', name: 'n', min: '1', value: isAccumFreq(t.freq) ? t.param : '3' })),
      h('label', { class: 'f', for: 'f-slot' }, '時段（影響午間提醒）'),
      h('select', { id: 'f-slot', name: 'slot' }, SLOT_ORDER.map(function (s) { return h('option', { value: s, selected: s === t.slot }, s); })),
      h('div', { id: 'f-fixed' },
        h('label', { class: 'f', for: 'f-opts' }, '選項（選填，一行一個；有選項時，點勾選會跳出清單讓你勾做了什麼）'),
        h('textarea', { id: 'f-opts', name: 'options', rows: '4' }, (t.options || []).join('\n')),
        h('label', { class: 'f', for: 'f-up' }, '進階版內容（選填，身體好時）'),
        h('input', { type: 'text', id: 'f-up', name: 'tierUp', value: t.tierUp, maxlength: '60' }),
        h('label', { class: 'f', for: 'f-down' }, '最低版內容（選填，不舒服時；做到這樣也不斷）'),
        h('input', { type: 'text', id: 'f-down', name: 'tierDown', value: t.tierDown, maxlength: '60' }),
        h('p', { class: 'muted' }, '選項和進階／最低二選一。')),
      t.id ? h('label', { class: 'f', for: 'f-cue' }, '情境提示（選填，例如「上班路上」「飯後」；會顯示在今日這項下面）') : null,
      t.id ? h('input', { type: 'text', id: 'f-cue', name: 'cue', maxlength: '20', value: cuesOf()[t.id] || '' }) : null,
      h('label', { class: 'f', for: 'f-link' }, '連結（選填，https://）'),
      h('input', { type: 'url', id: 'f-link', name: 'link', value: t.link }),
      t.id ? h('label', { class: 'row f' }, h('input', { type: 'checkbox', name: 'core', checked: coreIdsFrom(state.data.settings).indexOf(t.id) >= 0 }), ' 低能量日（低潮）仍要做（核心任務）') : null,
      t.id ? h('label', { class: 'row f' }, h('input', { type: 'checkbox', name: 'vcore', checked: vacIdsFrom(state.data.settings).indexOf(t.id) >= 0 }), ' 休假日仍要做') : null,
      h('label', { class: 'row f' }, h('input', { type: 'checkbox', name: 'remind', checked: t.remind }), ' 用 Telegram 提醒（只提醒必做）'),
      h('label', { class: 'row f' }, h('input', { type: 'checkbox', name: 'active', checked: t.active }), ' 啟用（取消勾選＝暫停）'),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn primary grow', type: 'submit', disabled: state.busy }, '儲存'),
        h('button', { class: 'btn', type: 'button', onclick: function () { state.editing = null; render(); } }, '取消')));
    function sync(freq) {
      form.querySelector('#f-days').style.display = freq === 'weekdays' ? '' : 'none';
      form.querySelector('#f-n').style.display = isAccumFreq(freq) ? '' : 'none';
      form.querySelector('#f-nl').textContent = isMinFreq(freq) ? '每' + UNIT[freq] + '目標（分鐘）' : '次數';
      form.querySelector('#f-fixed').style.display = isAccumFreq(freq) ? 'none' : '';
    }
    sync(t.freq);
    return form;
  }

  function freqText(t) {
    if (t.freq === 'weekdays') return '每週' + String(t.param).split(',').map(function (n) { return WEEKDAY_NAMES[n - 1]; }).join('、');
    if (isMinFreq(t.freq)) return '每' + UNIT[t.freq] + ' ' + t.param + ' 分鐘';
    if (isCountFreq(t.freq)) return '每' + UNIT[t.freq] + ' ' + t.param + ' 次';
    return '每天';
  }

  // Reorder on screen at once, then send it through the same queue as check-ins (so it survives a slow or missing connection).
  // The old way waited for the server (moveTask, then a full bootstrap) before anything changed, which on a phone looked like "nothing happens".
  // The list is shown by time slot like the today page (早, 午, 晚, 全天), so ▲▼ move a task past the next task of the SAME slot.
  // Underneath that is the one global 排序 order, so the server is asked to move it one place at a time, as many times as needed.
  function moveTaskLocal(t, dir) {
    var list = state.data.tasks, i = list.indexOf(t), step = dir < 0 ? -1 : 1, j = i + step;
    if (i < 0) return;
    while (j >= 0 && j < list.length && (list[j].slot || '不限') !== (t.slot || '不限')) j += step;
    if (j < 0 || j >= list.length) return;
    list.splice(i, 1);
    list.splice(j, 0, t);
    list.forEach(function (x, k) { x.order = k + 1; });
    for (var n = Math.abs(j - i); n > 0; n--) enqueue('moveTask', { id: t.id, dir: step });
  }

  function renderTasks() {
    if (state.editing) return [h('h1', null, state.editing.id ? '編輯任務' : '新增任務'), renderTaskForm(state.editing)];
    var nodes = [h('div', { class: 'row' }, h('h1', { class: 'grow' }, '任務'), h('button', { class: 'btn primary', onclick: function () { state.editing = blankTask(); render(); } }, '＋ 新增'))];
    SLOT_ORDER.forEach(function (slot) {
      var inSlot = state.data.tasks.filter(function (x) { return (x.slot || '不限') === slot; });
      if (!inSlot.length) return;
      nodes.push(h('h2', null, slot === '不限' ? '全天' : slot));
      inSlot.forEach(function (t, i, all) { nodes.push(taskCard(t, i, all)); });
    });
    if (!state.data.tasks.length) nodes.push(h('p', { class: 'muted' }, '還沒有任務。'));
    nodes.push(h('h2', null, '模板（一鍵加入一組）'));
    nodes.push(h('p', { class: 'muted' }, '加進來的都是「加分」，不會動到必做完成率和連續天數；之後在上面「編輯」可以改成必做。同名的任務不會重複加。'));
    TEMPLATES.forEach(function (tp) { nodes.push(templateCard(tp)); });
    return nodes;
  }

  function taskCard(t, i, all) {
    {
      var extras = (hasOptions(t) ? '・' + (t.options.length - (isCounterTask(t) ? 1 : 0)) + ' 個選項' : '') + (t.tierUp || t.tierDown ? '・有進階/最低' : '');
      function move(dir) { moveTaskLocal(t, dir); }
      return (h('div', { class: 'card item ' + dimCls(t.dim) + (t.active ? '' : ' inactive') },
        h('div', null, nameLine(t),
          h('div', null, h('span', { class: 'chip dc' }, t.dim), h('span', { class: 'chip' + (isBonus(t) ? '' : ' on') }, t.cls || '必做'), skillOf(t) ? h('span', { class: 'chip' }, '技能 ' + skillOf(t)) : null,
            h('span', { class: 'muted' }, freqText(t) + (t.slot !== '不限' ? '・' + t.slot : '') + (t.remind ? '・提醒' : '') + extras + (t.active ? '' : '・已暫停')))),
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn small', 'aria-label': t.name + ' 往前移', disabled: i === 0, onclick: function () { move(-1); } }, '▲'),
          h('button', { class: 'btn small', 'aria-label': t.name + ' 往後移', disabled: i === all.length - 1, onclick: function () { move(1); } }, '▼'),
          h('span', { class: 'grow' }),
          h('button', { class: 'btn small', onclick: function () { state.editing = JSON.parse(JSON.stringify(t)); render(); } }, '編輯'),
          h('button', { class: 'btn small danger', onclick: function () {
            if (!confirm('刪除「' + t.name + '」？打卡紀錄會保留。')) return;
            api('deleteTask', { id: t.id }).then(refresh).catch(function (e) { toast(e.network ? '需要網路才能刪除' : e.message); });
          } }, '刪除'))));
    }
  }

  // Starter groups, all 加分 so adding one cannot change the streak math. Edit them here to match your own routines.
  var TEMPLATES = [
    { name: '🌅 早晨例行', items: [['起床後 3 分鐘伸展', '健康', '早', '🧘'], ['喝一杯水', '健康', '早', '💧'], ['吃早餐', '健康', '早', '🍳']] },
    { name: '🌙 睡前例行', items: [['睡前不滑手機', '情緒', '晚', '📵'], ['寫短短幾句日記', '情緒', '晚', '📝'], ['拉上窗簾準備睡覺', '健康', '晚', '🌙']] },
    { name: '🍂 狀態欠佳最低版', items: [['喝杯水', '健康', '不限', '💧'], ['洗熱水澡', '健康', '晚', '🛁'], ['輕鬆散步 10 分鐘', '健康', '不限', '🚶']] }
  ];

  function templateCard(tp) {
    var have = {};
    state.data.tasks.forEach(function (t) { have[t.name] = true; });
    var todo = tp.items.filter(function (it) { return !have[it[0]]; });
    return h('div', { class: 'card' },
      h('div', { class: 'name' }, tp.name),
      h('div', { class: 'muted' }, tp.items.map(function (it) { return it[3] + ' ' + it[0] + (have[it[0]] ? '（已有）' : ''); }).join('、')),
      h('button', { class: 'btn small primary', style: 'margin-top:8px', disabled: !todo.length || state.busy, onclick: function () {
        state.busy = true; render();
        todo.reduce(function (p, it) {
          return p.then(function () { return api('saveTask', { task: Object.assign(blankTask(), { name: it[0], dim: it[1], slot: it[2], icon: it[3], cls: '加分' }) }); });
        }, Promise.resolve()).then(function () { toast('已加入 ' + todo.length + ' 項'); })
          .catch(function (e) { toast(e.network ? '需要網路才能新增任務' : e.message); })
          .then(function () { state.busy = false; return refresh(); });
      } }, todo.length ? '加入 ' + todo.length + ' 項' : '都已加入'));
  }

  // ---- month / quarter ----

  function bar(label, right, rate, dim) {
    return h('div', { class: dim ? dimCls(dim) : '', style: 'margin:8px 0' },
      h('div', { class: 'row' }, h('span', { class: 'grow' }, label), h('span', { class: 'muted' }, right)),
      h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round(Math.min(1, rate || 0) * 100) + '%' })));
  }

  function renderGoals(key) {
    var mine = state.data.goals.filter(function (g) { return g.period === key; });
    var nodes = [h('h2', null, '一次性事項（' + key + '）')];
    mine.forEach(function (g) {
      nodes.push(h('div', { class: 'card item row ' + dimCls(g.dim) + (g.done ? ' done' : '') },
        h('button', { class: 'check', 'aria-pressed': String(g.done), 'aria-label': g.name, onclick: function () {
          g.done = !g.done;
          api('toggleGoal', { id: g.id, done: g.done }).then(refresh).catch(function (e) { g.done = !g.done; toast(e.network ? '需要網路' : e.message); render(); });
          render();
        } }, '✓'),
        h('div', { class: 'grow' }, h('div', { class: 'name' }, g.name), h('span', { class: 'chip dc' }, g.dim)),
        h('button', { class: 'btn small danger', onclick: function () {
          if (confirm('刪除「' + g.name + '」？')) api('deleteGoal', { id: g.id }).then(refresh).catch(function (e) { toast(e.network ? '需要網路' : e.message); });
        } }, '刪')));
    });
    var form = h('form', { class: 'row', onsubmit: function (ev) {
      ev.preventDefault();
      var f = form.elements;
      api('saveGoal', { goal: { period: key, name: f.name.value, dim: f.dim.value } }).then(refresh).catch(function (e) { toast(e.network ? '需要網路' : e.message); });
    } },
      h('input', { type: 'text', name: 'name', placeholder: '新增事項', required: true, maxlength: '80', 'aria-label': '事項名稱', class: 'grow' }),
      h('select', { name: 'dim', 'aria-label': '維度', style: 'width:auto' }, DIMS.map(function (d) { return h('option', { value: d }, d); })),
      h('button', { class: 'btn primary', type: 'submit' }, '加'));
    nodes.push(form);
    return nodes;
  }

  function renderHistory() {
    var rows = historyWithAuto(state.data.history || [], state.data, today());
    if (!rows.length) return [];
    var months = [], items = [], cell = {}, auto = {};
    rows.forEach(function (r) {
      if (months.indexOf(r.month) < 0) months.push(r.month);
      if (items.indexOf(r.item) < 0) items.push(r.item);
      cell[r.month + '|' + r.item] = r.count;
      if (r.auto) auto[r.month + '|' + r.item] = true;
    });
    months.sort();
    var ORDER = ['有氧', '重訓', '瑜珈', '飲酒', '閱讀', '閱讀（天）', '❤️', '練車', '炸物', '飲食分'];
    items.sort(function (a, b) { var x = ORDER.indexOf(a), y = ORDER.indexOf(b); return (x < 0 ? 99 : x) - (y < 0 ? 99 : y); });
    return [h('h2', null, '歷史對照（' + HISTORY_FROM.slice(5) + ' 月起由 App 自動計算）'),
      h('div', { class: 'card scroll' }, h('table', null,
        h('thead', null, h('tr', null, [h('th', null, '')].concat(months.map(function (m) { return h('th', null, m.slice(5) + '月'); })))),
        h('tbody', null, items.map(function (it) {
          return h('tr', null, [h('td', null, it)].concat(months.map(function (m) { var v = cell[m + '|' + it]; return h('td', { class: auto[m + '|' + it] ? 'auto' : '' }, v === undefined ? '' : v); })));
        }))))];
  }

  function periodKind(freq) { return freq.indexOf('weekly') === 0 ? 'week' : freq.indexOf('monthly') === 0 ? 'month' : 'quarter'; }

  function renderPlan() {
    var c = ctx(), t0 = today(), mode = state.planMode;
    var range = periodRange(mode === 'month' ? 'monthly_n' : 'quarterly_n', t0);
    var key = mode === 'month' ? monthKey(t0) : quarterKey(t0);
    var nodes = [
      h('h1', null, '月/季規劃'),
      h('div', { class: 'seg' },
        h('button', { class: 'btn' + (mode === 'month' ? ' on' : ''), onclick: function () { state.planMode = 'month'; render(); } }, '本月'),
        h('button', { class: 'btn' + (mode === 'quarter' ? ' on' : ''), onclick: function () { state.planMode = 'quarter'; render(); } }, '本季')),
      h('p', { class: 'muted' }, range.start + ' ～ ' + range.end)
    ];
    goalCard().forEach(function (n) { nodes.push(n); });
    if (mode === 'month') reviewCard().forEach(function (n) { nodes.push(n); });
    var rates = dimensionRates(c.tasks, range.start, range.end, t0, c.idx, c.leave);
    nodes.push(h('h2', null, '四維度完成率（必做的固定任務）'));
    var any = false;
    DIMS.forEach(function (d) {
      if (!rates[d]) return;
      any = true;
      nodes.push(bar(d, pct(rates[d].rate) + '（' + rates[d].done + '/' + rates[d].due + '）', rates[d].rate, d));
    });
    if (!any) nodes.push(h('p', { class: 'muted' }, '還沒有資料，從今天開始打卡。'));
    var accum = c.tasks.filter(function (t) {
      if (!t.active || !isAccumFreq(t.freq)) return false;
      var k = periodKind(t.freq);
      return mode === 'month' ? k !== 'quarter' : k !== 'week';
    });
    if (accum.length) {
      nodes.push(h('h2', null, '累計目標'));
      accum.forEach(function (t) {
        var p = progress(t, t0, c.idx);
        nodes.push(bar(iconOf(t) + ' ' + t.name + '（每' + UNIT[t.freq] + '）', p.done + '/' + p.target + (isMinFreq(t.freq) ? ' 分' : ' 次'), p.done / p.target, t.dim));
      });
    }
    var x = periodExtras(c.tasks, c.logs, range.start, range.end);
    nodes.push(h('h2', null, '進階、加分與動作統計'));
    var names = Object.keys(x.options).sort(function (a, b) { return x.options[b] - x.options[a]; });
    nodes.push(h('div', { class: 'card' },
      h('div', null, '進階 ', h('b', null, x.advanced), ' 次・加分 ', h('b', null, x.bonus), ' 次'),
      names.length ? h('div', { style: 'margin-top:8px' }, names.map(function (n) { return h('span', { class: 'chip on' }, n + ' ' + x.options[n] + ' 天' + (x.reps[n] ? '・共 ' + x.reps[n] : '')); })) : h('div', { class: 'muted' }, '飯後運動等有選項的任務，勾選的動作會在這裡累計。')));
    var dp = dietPeriod(c.tasks, c.logs, range.start, range.end < t0 ? range.end : t0);
    if (c.tasks.some(function (t) { return dietMealOf(t); })) {
      nodes.push(h('h2', null, '飲食狀態'));
      nodes.push(h('div', { class: 'card' }, dp.days
        ? [h('div', null, '有記錄 ', h('b', null, dp.days), ' 天・飲食分 ', h('b', null, dp.score100), '（日均 ', dp.avgDaily, ' / 16）'),
           h('div', { style: 'margin-top:8px' }, DIET_NEG.concat(DIET_POS, DIET_INFO).map(function (e) { return h('span', { class: 'chip' + (dp.totals[e] ? ' on' : '') }, e + ' ' + dp.totals[e] + ' 次・' + dp.dayCounts[e] + ' 天'); }))]
        : h('div', { class: 'muted' }, '在今日頁點「早餐飲食」等任務記錄每餐狀況，這裡會匯整飲食分與各項次數。')));
    }
    var trend = dailyRates(c.tasks, range.start, range.end < t0 ? range.end : t0, c.idx, c.leave);
    nodes.push(h('h2', null, '每日必做完成率趨勢'));
    nodes.push(h('div', { class: 'card' }, h('div', { class: 'trend', role: 'img', 'aria-label': '每日完成率趨勢' }, trend.map(function (r) {
      return h('i', { class: r.rate === null ? 'none' : '', style: 'height:' + (r.rate === null ? 3 : Math.max(4, Math.round(r.rate * 100))) + '%', title: r.date + ' ' + pct(r.rate) });
    }))));
    renderGoals(key).forEach(function (n) { nodes.push(n); });
    if (mode === 'quarter') renderGoals(monthKey(t0)).forEach(function (n) { nodes.push(n); });
    renderHistory().forEach(function (n) { nodes.push(n); });
    return nodes;
  }

  // ---- settings ----

  function renderSettings() {
    var cfg = state.cfg || { url: '', secret: '' };
    var form = h('form', { class: 'card', onsubmit: function (ev) {
      ev.preventDefault();
      state.cfg = { url: form.elements.url.value.trim(), secret: form.elements.secret.value };
      LS.set('habit.cfg', state.cfg);
      state.tab = 'today';
      refresh();
    } },
      h('label', { class: 'f', for: 's-url' }, 'API 網址（Apps Script 網頁應用程式，結尾 /exec）'),
      h('input', { type: 'url', id: 's-url', name: 'url', value: cfg.url, required: true, placeholder: 'https://script.google.com/macros/s/…/exec' }),
      h('label', { class: 'f', for: 's-secret' }, '暗號（APP_SECRET，只存在這支手機）'),
      h('input', { type: 'password', id: 's-secret', name: 'secret', value: cfg.secret, required: true, autocomplete: 'off' }),
      h('button', { class: 'btn primary', type: 'submit', style: 'margin-top:12px;width:100%' }, '儲存並同步'));
    var nodes = [h('h1', null, state.cfg ? '設定' : '第一次使用：連接你的資料庫'), form];
    if (state.cfg) {
      var sw = function (key, label, hint) {
        return h('label', { class: 'row f' }, h('input', { type: 'checkbox', checked: !!PREFS[key], onchange: function (ev) { PREFS[key] = ev.target.checked; savePrefs(); } }), h('span', null, ' ' + label, h('span', { class: 'muted' }, hint ? '　' + hint : '')));
      };
      nodes.push(h('h2', null, '回饋'));
      nodes.push(h('div', { class: 'card' }, sw('anim', '完成動畫', '不受系統「減少動態效果」影響'), sw('vibrate', '震動'), sw('sound', '提示音'), sw('launch', '開機訓練提醒', '打開 App 時顯示約 2.5 秒今日訓練，做完就不跳')));
    }
    if (state.cfg && state.data) {
      var extraIn = h('input', { type: 'text', id: 's-extra', value: (state.data.settings || {}).checkinExtra || '', maxlength: '40', placeholder: '例如：晨間狀態,專注（用逗號分隔，最多 4 個）' });
      nodes.push(h('h2', null, '每日自評'));
      nodes.push(h('div', { class: 'card' },
        h('label', { class: 'f', for: 's-extra' }, '額外的 1～5 分題目（選填，只有你看得到）'), extraIn,
        h('button', { class: 'btn small', style: 'margin-top:8px', onclick: function () {
          api('setSetting', { key: 'checkinExtra', value: extraIn.value }).then(refresh).catch(function (e) { toast(e.network ? '需要網路' : e.message); });
        } }, '儲存')));
    }
    nodes.push(h('p', { class: 'muted' }, '程式版本：' + VERSION));
    if (state.cfg) {
      nodes.push(h('p', { class: 'muted' }, '尚未送出的打卡：' + state.queue.length + ' 筆'));
      nodes.push(h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: function () { toast('同步中…'); refresh(); } }, '立即同步'),
        h('button', { class: 'btn danger', onclick: function () {
          if (!confirm('清除這支手機上的設定與暫存？雲端資料不會被刪除。')) return;
          ['habit.cfg', 'habit.data', 'habit.queue'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } });
          location.reload();
        } }, '清除本機資料')));
    }
    return nodes;
  }

  // ---- 努力 (weekly effort overview; facts only, see shared/effort.js) ----

  function effortData() { return { tasks: state.data.tasks, logs: state.data.logs, train: dget('train'), challenges: dget('challenges'), workouts: dget('workouts') }; }
  function effortMonday(offset) { var t = today(); return addDays(addDays(t, -(weekdayOf(t) - 1)), -7 * offset); }
  function minText(m) { return m >= 60 ? Math.floor(m / 60) + ' 小時' + (m % 60 ? ' ' + (m % 60) + ' 分' : '') : m + ' 分'; }
  function md(s) { return Number(s.slice(5, 7)) + '/' + Number(s.slice(8, 10)); }

  function effortDelta(now, prev, unit) {
    var d = now - prev;
    return h('span', { class: 'ef-delta' }, d === 0 ? '和上週一樣' : (d > 0 ? '比上週多 ' : '比上週少 ') + (unit === 'min' ? minText(Math.abs(d)) : Math.abs(d)));
  }

  // Each block can be folded; the choice is remembered on this phone only.
  var effortFold = LS.get('habit.effortFold', {});
  function foldCard(key, nameNodes, tag, body) {
    return h('details', { class: 'card ef-fold', open: !effortFold[key], ontoggle: function (ev) {
      if (ev.target.open) delete effortFold[key]; else effortFold[key] = 1;
      LS.set('habit.effortFold', effortFold);
    } }, h('summary', null, h('span', { class: 'name' }, nameNodes), tag ? h('span', { class: 'ef-tag' }, tag) : null), body);
  }
  function ico(c) { return h('span', { class: 'ico', 'aria-hidden': 'true' }, c); }

  function renderEffort() {
    var off = state.effortWeek || 0, mon = effortMonday(off), isNow = off === 0;
    var start = trainStart();
    var w = effortWeek(effortData(), mon, start), pv = effortWeek(effortData(), addDays(mon, -7), start), t = w.totals, pt = pv.totals;
    var sel = state.effortDay && state.effortDay >= w.start && state.effortDay <= w.end ? state.effortDay : null;
    var nodes = [
      h('div', { class: 'sticky' }, h('div', { class: 'row' },
        h('button', { class: 'btn small', 'aria-label': '前一週', onclick: function () { state.effortWeek = off + 1; state.effortDay = null; render(); } }, '‹'),
        h('h1', { class: 'grow' }, md(w.start) + ' – ' + md(w.end), h('span', { class: 'muted' }, isNow ? '　本週' : off === 1 ? '　上週' : '　' + off + ' 週前')),
        h('button', { class: 'btn small', 'aria-label': '後一週', disabled: isNow, onclick: function () { state.effortWeek = Math.max(0, off - 1); state.effortDay = null; render(); } }, '›')))
    ];

    function big(n, unit, label, delta) { return h('div', { class: 'ef-bigcell' }, h('div', { class: 'ef-num' }, String(n), h('small', null, unit)), h('div', { class: 'ef-lab' }, label), delta); }
    nodes.push(h('div', { class: 'card ef-hero' },
      h('div', { class: 'ef-bigs' },
        big(t.items, ' 項', '完成的運動', effortDelta(t.items, pt.items)),
        big(t.uniqueMin, ' 分', '運動時間', effortDelta(t.uniqueMin, pt.uniqueMin, 'min')),
        big(t.activeDays, ' / 7 天', '有動的日子', effortDelta(t.activeDays, pt.activeDays))),
      h('div', { class: 'muted' }, '完成的運動＝飯前後 ' + t.mealDone + ' ＋ 訓練 ' + t.trainSessions + ' ＋ 挑戰成功 ' + t.chOk + '。' +
        (t.sameN ? '運動時間裡，有 ' + t.sameN + ' 次訓練打勾和手錶紀錄是同一次，只算一次。' : '運動時間以手錶為準，沒有手錶的訓練打勾用你填的分鐘。') + '只是記錄，沒有目標。')));

    // Week strip: the bars are watch minutes, the three rows below count what else was done that day.
    var maxMin = Math.max(60, Math.max.apply(null, w.days.map(function (d) { return d.watchMin; })));
    var strip = h('div', { class: 'ef-week', role: 'group', 'aria-label': '這週每天' });
    w.days.forEach(function (d, i) {
      var future = d.date > today(), isSel = sel === d.date;
      function cell(cls, n) { return h('span', { class: 'ef-cell ' + cls + (n ? ' on' : '') }, n ? String(n) : ''); }
      strip.appendChild(h('button', { type: 'button', class: 'ef-col' + (isSel ? ' sel' : '') + (d.date === today() ? ' now' : '') + (future ? ' future' : ''), 'aria-pressed': String(isSel),
        'aria-label': '週' + WEEKDAY_NAMES[i] + ' ' + md(d.date) + '：手錶 ' + d.watchMin + ' 分、飯前後 ' + d.meal + '、訓練 ' + d.trainN + '、挑戰 ' + d.chOk,
        onclick: function () { state.effortDay = isSel ? null : d.date; render(); } },
        h('span', { class: 'ef-min' }, d.watchMin ? String(d.watchMin) : ''),
        h('span', { class: 'ef-barbox' }, h('i', { class: 'ef-bar', style: 'height:' + (d.watchMin ? Math.max(6, Math.round(d.watchMin / maxMin * 100)) : 0) + '%' })),
        h('span', { class: 'ef-wd' }, WEEKDAY_NAMES[i]),
        cell('ef-meal', d.meal), cell('ef-train', d.trainN), cell('ef-ch', d.chOk)));
    });
    nodes.push(foldCard('strip', '週軌跡', '', [
      h('div', { class: 'ef-strip' },
        h('div', { class: 'ef-legend' }, h('span', { class: 'ef-watch' }, '手錶長條（分）'), h('span', { class: 'ef-meal' }, '飯前後'), h('span', { class: 'ef-train' }, '訓練'), h('span', { class: 'ef-ch' }, '挑戰')),
        strip),
      h('div', { class: 'muted' }, '長條是手錶記到的運動分鐘；下面三排是當天完成的項數。點一天看明細。')]));

    if (sel) nodes.push(effortDayCard(sel, w));

    // 飯前後
    var meal = [];
    if (!w.mealRows.length) meal.push(h('div', { class: 'muted' }, '任務頁沒有名稱含「飯前」「飯後」的任務。'));
    var grid = h('div', { class: 'ef-mgrid' });
    grid.appendChild(h('span', null, ''));
    WEEKDAY_NAMES.forEach(function (n, i) { grid.appendChild(h('span', { class: 'ef-mh' + (w.days[i].date === today() ? ' now' : '') }, n)); });
    grid.appendChild(h('span', null, ''));
    w.mealRows.forEach(function (r) {
      grid.appendChild(h('span', { class: 'ef-mname' }, r.name));
      r.done.forEach(function (on, i) { grid.appendChild(h('span', { class: 'ef-dot' + (on ? ' on' : '') + (w.days[i].date > today() ? ' future' : ''), 'aria-label': on ? '有做' : '沒記錄' }, on ? '✓' : '')); });
      grid.appendChild(h('span', { class: 'ef-mcount' }, r.count + '/7'));
    });
    if (w.mealRows.length) meal.push(grid);
    if (w.reps.length) {
      meal.push(h('div', { class: 'ef-chips' }, w.reps.map(function (r) {
        return h('span', { class: 'chip on' }, r.move + ' ' + r.times + ' 次' + (r.reps ? '・約 ' + r.reps + ' 下' : ''));
      })));
      meal.push(h('div', { class: 'muted' }, '「約」是把你勾選的動作量加總，不是實際計次。'));
    }
    nodes.push(foldCard('meal', [ico('🤸'), '早中晚的飯前後運動'], t.mealDone + ' 次', meal));

    // 挑戰
    var ch = [];
    if (!w.challenges.length) ch.push(h('div', { class: 'muted' }, '這週還沒抽過挑戰。'));
    w.challenges.forEach(function (c) {
      ch.push(h('div', { class: 'ef-line' }, h('span', { class: 'muted' }, md(c.date)), h('span', { class: 'grow' }, c.move + ' ' + c.amount + (c.level ? '（' + c.level + '）' : '')), h('b', { class: c.ok ? 'ef-okmark' : 'muted' }, c.ok ? '成功' : (c.result || '—'))));
    });
    nodes.push(foldCard('ch', [ico('⏱'), '限時挑戰'], t.chOk + ' 成功 / 抽 ' + t.chTry + ' 次', ch));

    // 訓練: a tick that matches a watch session of the same day says so, so one run is never read as two
    var tr = [];
    if (!w.trainRows.length) tr.push(h('div', { class: 'muted' }, '這週還沒有訓練紀錄。'));
    w.trainRows.slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }).forEach(function (r) {
      tr.push(h('div', { class: 'ef-line' }, h('span', { class: 'muted' }, md(r.date)), h('span', { class: 'grow' }, r.title,
        r.watch ? h('span', { class: 'ef-same' }, '⌚ 同一次（手錶 ' + r.watch.type + ' ' + r.watch.minutes + ' 分）') : null),
        h('span', { class: 'muted' }, r.watch ? minText(r.watch.minutes) : (r.minutes ? minText(r.minutes) : ''))));
    });
    nodes.push(foldCard('train', [ico('🏋️'), '訓練'], t.trainSessions + ' 項', tr));

    // 手錶
    var wk = [];
    if (!w.watch.length) wk.push(h('div', { class: 'muted' }, '這週沒有手錶紀錄（要手機的「健康同步」App 傳上來）。'));
    var wmax = w.watch.length ? w.watch[0].minutes : 1;
    w.watch.forEach(function (r) {
      wk.push(h('div', { class: 'ef-wrow' }, h('div', { class: 'ef-line' }, h('span', { class: 'grow' }, r.type, r.linked ? h('span', { class: 'ef-same' }, '其中 ' + r.linked + ' 次也在訓練打勾') : null), h('span', { class: 'muted' }, r.n + ' 次・' + minText(r.minutes))),
        h('div', { class: 'bar thin' }, h('i', { style: 'width:' + Math.round(r.minutes / wmax * 100) + '%' }))));
    });
    nodes.push(foldCard('watch', [ico('⌚'), '手錶運動'], t.watchN + ' 次・' + minText(t.watchMin), wk));
    return nodes;
  }

  function effortDayCard(date, w) {
    var box = h('div', { class: 'card ef-day' }, h('div', { class: 'name' }, dateTitle(date))), any = false, di = weekdayOf(date) - 1;
    function line(cls, text, right) { any = true; box.appendChild(h('div', { class: 'ef-line' }, h('i', { class: 'ef-pip ' + cls, 'aria-hidden': 'true' }), h('span', { class: 'grow' }, text), right ? h('span', { class: 'muted' }, right) : null)); }
    w.mealRows.forEach(function (r) {
      if (!r.done[di]) return;
      var lg = state.data.logs.filter(function (l) { return l.date === date && l.taskId === r.id; })[0];
      line('ef-meal', r.name, lg && lg.note ? lg.note : '');
    });
    w.trainRows.filter(function (r) { return r.date === date; }).forEach(function (r) {
      line('ef-train', r.title + (r.watch ? '（手錶 ' + r.watch.type + '，同一次）' : ''), r.watch ? minText(r.watch.minutes) : (r.minutes ? minText(r.minutes) : ''));
    });
    w.challenges.filter(function (r) { return r.date === date; }).forEach(function (r) { line('ef-ch', r.move + ' ' + r.amount, r.result); });
    w.watchRows.filter(function (r) { return r.date === date && !r.trainItem; }).forEach(function (r) { line('ef-watch', r.type, minText(r.minutes)); });
    if (!any) box.appendChild(h('div', { class: 'muted' }, '這天沒有運動紀錄。'));
    return box;
  }

  // ---- shell ----

  function render() {
    var view = document.getElementById('view');
    var tab = state.cfg ? state.tab : 'settings';
    var nodes;
    if (tab !== 'settings' && !state.data) nodes = [h('p', { class: 'muted' }, '載入中…（第一次需要網路）')];
    else nodes = withBack(tab, tab === 'today' ? renderToday() : tab === 'ledger' ? renderLedger() : tab === 'train' ? renderTrain() : tab === 'effort' ? renderEffort() : tab === 'health' ? renderHealth() : tab === 'more' ? renderMore() : tab === 'game' ? renderGame() : tab === 'dreams' ? renderDreams() : tab === 'tasks' ? renderTasks() : tab === 'plan' ? renderPlan() : renderSettings());
    var focusId = document.activeElement && document.activeElement.id;
    var keepY = window.scrollY;
    view.textContent = '';
    nodes.forEach(function (n) { view.appendChild(n); });
    if (focusId && !state.modal) { var again = document.getElementById(focusId); if (again) again.focus(); }
    window.scrollTo(0, keepY);
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === navTabOf(tab));
      b.disabled = !state.cfg;
    });
    renderModal();
    if (state.pop) { if (state.pop.confetti) confetti(); if (PREFS.anim) buzz(); beep(); state.pop = null; }
  }

  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.addEventListener('click', function () { goTab(b.getAttribute('data-tab')); });
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && state.modal) closeModal(); });
  window.addEventListener('online', function () { refresh(); });
  // A tab that stays open and visible (desktop browser) never gets a visibilitychange, so changes made on the phone would not show up:
  // pull again when the window regains focus and once a minute, but only when nothing is being typed or shown over the page.
  window.addEventListener('focus', function () { refresh(true); });
  setInterval(function () {
    var el = document.activeElement, typing = el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
    if (document.hidden || !state.cfg || !state.data || state.modal || state.challenge || typing || state.queue.length || flushing) return;
    refresh(true);
  }, 60000);
  var hiddenAt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (hiddenAt && Date.now() - hiddenAt > 10 * 60 * 1000) setTimeout(showLaunchReminder, 300);   // came back after a while: same as opening the app
    if (state.openedOn !== today()) { state.openedOn = today(); state.date = today(); state.trainDate = today(); }
    state.date = state.date > today() ? today() : state.date;
    refresh();
  });
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });

  // ---- 開機訓練提醒: about 2.5 seconds, tap to close; not shown when today's training is all done ----
  function showLaunchReminder() {
    if (!PREFS.launch || !state.cfg || !state.data || document.getElementById('launch')) return;
    var start = state.data.settings && state.data.settings.trainStart;
    if (!start) return;
    var items = trainingReminder(today(), start, dget('train'));
    if (!items.length) return;
    var lines = items.map(function (it) { return h('div', { class: 'li' }, (it.icon || '•') + ' ' + it.title + (it.minutes ? '　' + it.minutes + ' 分' : '')); });
    var c = ctx(), early = c.tasks.filter(function (t) { return /晨間/.test(t.name || '') && isScheduled(t, today()); })[0];
    if (weekdayOf(today()) >= 6 && early && !isDone(early, today(), c.idx) && new Date().getHours() < WEEKEND_EARLY_HOUR) {
      lines.push(h('div', { class: 'li muted' }, '☀️ 假日早鳥：' + WEEKEND_EARLY_HOUR + ' 點前完成晨間鍛鍊 +' + WEEKEND_EARLY_COINS + ' ⭐'));
    }
    var box = h('div', { id: 'launch', class: 'launch', role: 'status', onclick: closeLaunch }, h('div', { class: 'launchbox' }, h('b', null, '今天的訓練'), lines));
    function closeLaunch() { if (box.parentNode) box.parentNode.removeChild(box); }
    document.body.appendChild(box);
    setTimeout(closeLaunch, 2500);
  }

  render();
  showLaunchReminder();
  if (location.hash === '#accum') setTimeout(function () { var el = document.getElementById('accum'); if (el) el.scrollIntoView(); }, 300);
  refresh();
}());
