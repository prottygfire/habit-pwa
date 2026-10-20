// Habit PWA. Data lives in the Google Sheet behind the Apps Script endpoint; this file only draws and syncs.
// Check-ins are applied locally first and queued, so tapping works offline and syncs when the network returns.
(function () {
  'use strict';

  var VERSION = '2026-10-20 v8';
  var SLOT_ORDER = ['早', '午', '晚', '不限'];
  var DIMS = ['健康', '財商', '學習', '情緒', '工作', '娛樂'];
  var FREQ_LABEL = {
    daily: '每天', weekdays: '指定星期', weekly_n: '每週 N 次', monthly_n: '每月 N 次', quarterly_n: '每季 N 次',
    weekly_min: '每週累計 N 分鐘', monthly_min: '每月累計 N 分鐘'
  };
  var UNIT = { weekly_n: '週', monthly_n: '月', quarterly_n: '季', weekly_min: '週', monthly_min: '月' };
  var WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];
  var ICON_CHOICES = ['💪', '🏃', '🚶', '🤸', '🏋️', '🧘', '🙆', '👟', '💧', '😴', '🧴', '🥗', '📖', '✍️', '💰', '📒', '🎯', '🎮', '🎨', '🧹', '💊', '☀️', '🌙'];
  var TABS = ['today', 'train', 'game', 'tasks', 'plan', 'settings'];

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: run without persistence */ } }
  };

  // Animation, vibration and sound switches. Animations ignore the system "reduce motion" setting on purpose.
  var PREFS = Object.assign({ anim: true, vibrate: true, sound: false }, LS.get('habit.prefs', {}));
  function savePrefs() { LS.set('habit.prefs', PREFS); }

  function localDate(d) {
    return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
  }

  var state = {
    cfg: LS.get('habit.cfg', null),
    data: LS.get('habit.data', null),
    queue: LS.get('habit.queue', []),
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
    challenge: LS.get('habit.challenge', null)
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
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 3200);
  }

  // ---- API ----

  function api(action, payload) {
    var body = JSON.stringify(Object.assign({ secret: state.cfg.secret, action: action }, payload || {}));
    return fetch(state.cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' })
      .then(function (r) { return r.json(); }, function () { var e = new Error('連不上伺服器'); e.network = true; throw e; })
      .then(function (res) {
        if (!res.ok) { var e = new Error(res.error === 'unauthorized' ? '暗號不正確' : res.error); e.unauthorized = res.error === 'unauthorized'; throw e; }
        return res;
      });
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
      if (e.network) return;
      if (e.unauthorized) { toast('暗號不正確，請到設定重新輸入'); state.tab = 'settings'; return; }
      state.queue.shift();
      LS.set('habit.queue', state.queue);
      toast('有一筆沒送出：' + e.message);
    }).then(function () { flushing = false; });
  }

  function refresh() {
    if (!state.cfg) { render(); return Promise.resolve(); }
    return flush().then(function () {
      if (state.queue.length) return;
      return api('bootstrap').then(function (res) {
        state.data = { tasks: res.tasks, logs: res.logs, leave: res.leave, goals: res.goals, history: res.history, train: res.train || [], settings: res.settings || {},
          slipItems: res.slipItems || [], slips: res.slips || [], rewards: res.rewards || [], redemptions: res.redemptions || [],
          library: res.library || [], challenges: res.challenges || [], exempts: res.exempts || [] };
        state.rev++;
        LS.set('habit.data', state.data);
      });
    }).catch(function (e) {
      if (e.unauthorized) { toast('暗號不正確，請到設定重新輸入'); state.tab = 'settings'; }
      else if (!e.network) toast(e.message);
    }).then(function () { render(); celebrate(); });
  }

  function enqueue(action, payload) {
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
    return { tasks: d.tasks, logs: d.logs, idx: indexLogs(d.logs, d.exempts || []), leave: indexLeave(d.leave) };
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
      redemptions: dget('redemptions'), challenges: dget('challenges'), exempts: dget('exempts'), settings: d.settings || {} };
  }

  var gameCache = { rev: -1, today: '', g: null };
  function game() {
    if (gameCache.rev !== state.rev || gameCache.today !== today()) gameCache = { rev: state.rev, today: today(), g: computeGame(gameData(), today()) };
    return gameCache.g;
  }

  function fmtPts(n) { return n % 1 ? n.toFixed(1) : String(n); }

  function perfectNow(date) {
    var st = dayStats(state.data.tasks, date, indexLogs(state.data.logs, dget('exempts')), indexLeave(state.data.leave));
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
    var colors = ['#4cc38a', '#f0b84a', '#6aa3f0', '#d783c4', '#f29058'];
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
  }

  function trainUndo(item, date) {
    setTrainLocal(item.id, date, null);
    enqueue('trainSet', { date: date, item: item.id, done: false });
    var rt = runTask();
    if (item.isRun && rt) saveMinutes(rt, date, 0);
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
    host.appendChild(m.type === 'options' ? optionsModal(m, c) : m.type === 'tier' ? tierModal(m, c) : m.type === 'train' ? trainModal(m) : m.type === 'redeem' ? redeemModal() : minutesModal(m, c));
    var first = host.querySelector('input,button');
    if (first) first.focus();
  }

  // ---- today ----

  function taskItem(t, c, date) {
    var done = isDone(t, date, c.idx), tier = tierOn(t, date, c.idx), note = noteOn(t, date, c.idx);
    var streak = taskStreak(t, date, c.idx, c.leave);
    var tiered = !!(t.tierUp || t.tierDown), ex = isExempt(t, date, c.idx);
    var sub = [h('span', { class: 'chip dc' }, t.dim)];
    if (ex) sub.push(h('span', { class: 'chip on' }, '🎫 免責'));
    if (isBonus(t)) sub.push(h('span', { class: 'chip' }, '加分'));
    if (done && tier && tier !== '標準') sub.push(h('span', { class: 'chip on' }, tier));
    if (streak > 0) sub.push(h('span', { class: 'muted' }, '🔥' + streak + '天'));
    var tap = function () {
      if (hasOptions(t)) { state.modal = { type: 'options', task: t, date: date }; renderModal(); }
      else if (done) uncheckTask(t, date);
      else checkTask(t, date, '標準', '');
    };
    return h('div', { class: 'card item row ' + dimCls(t.dim) + (done ? ' done' : '') + (isBonus(t) ? ' bonus' : '') + (ex ? ' exempt' : '') },
      h('button', { class: 'check' + (state.pop && state.pop.id === t.id && PREFS.anim ? ' pop' : ''), 'aria-pressed': String(done), 'aria-label': (done ? '取消完成 ' : '完成 ') + t.name, onclick: tap }, '✓'),
      state.pop && state.pop.id === t.id && state.pop.text && PREFS.anim ? h('span', { class: 'float', 'aria-hidden': 'true' }, state.pop.text) : null,
      h('div', { class: 'grow' },
        nameLine(t),
        h('div', null, sub),
        done && note ? h('div', { class: 'muted' }, note) : null,
        !done && hasOptions(t) ? h('div', { class: 'muted' }, '點勾選，選今天做了什麼') : null),
      ex ? h('button', { class: 'btn small', 'aria-label': '取消免責 ' + t.name, onclick: function () { unexemptTask(t, date); } }, '取消免責') : null,
      canExempt(t, date, c) ? h('button', { class: 'btn small', 'aria-label': '用免責券抵免 ' + t.name, onclick: function () { exemptTask(t, date); } }, '🎫') : null,
      tiered ? h('button', { class: 'btn small', 'aria-label': t.name + ' 選擇進階或最低', onclick: function () { state.modal = { type: 'tier', task: t, date: date }; renderModal(); } }, '⋯') : null,
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
      nodes.push(h('h2', null, slot === '不限' ? '全天' : slot));
      list.forEach(function (t) { nodes.push(taskItem(t, c, date)); });
    });
  }

  function renderToday() {
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
    if (onLeave) nodes.push(h('p', { class: 'muted' }, '請假日不提醒，也不計入完成率。'));
    groupBySlot(daily, c, date, nodes);
    if (accum.length) {
      nodes.push(h('h2', { id: 'accum' }, '累計目標'));
      accum.forEach(function (t) { nodes.push(accumItem(t, c, date)); });
    }
    if (!daily.length && !accum.length) nodes.push(h('p', { class: 'muted' }, '這天沒有任務。到「任務」頁新增。'));
    renderSlips(date).forEach(function (n) { nodes.push(n); });
    return nodes;
  }

  function gainLine() {
    var g = game(), pts = 0;
    SKILLS.forEach(function (s) { pts += g.skills[s].gain; });
    return h('div', { class: 'gainline' }, h('span', null, '今天 +' + fmtPts(pts) + ' 技能點'), h('span', null, '⭐ ' + g.coins.balance));
  }

  // ---- 小失誤 (扣分項): recorded only, never subtracted ----

  function slipCount(id, date) { return dget('slips').filter(function (r) { return r.item === id && r.date === date; }).length; }

  function slipChange(item, date, delta) {
    var d = state.data;
    if (delta > 0) d.slips = dget('slips').concat([{ date: date, item: item.id }]);
    else {
      var list = dget('slips').slice(), i;
      for (i = list.length - 1; i >= 0; i--) if (list[i].item === item.id && list[i].date === date) break;
      if (i >= 0) list.splice(i, 1);
      d.slips = list;
    }
    enqueue('slip', { date: date, item: item.id, delta: delta });
  }

  function renderSlips(date) {
    var items = dget('slipItems').filter(function (i) { return i.active; });
    if (!items.length) return [];
    var row = h('div', { class: 'slips' }, items.map(function (i) {
      var n = slipCount(i.id, date);
      return h('div', { class: 'slip' + (n ? ' has' : '') },
        h('button', { class: 'slipmain', 'aria-label': '記一筆 ' + i.name, onclick: function () { slipChange(i, date, 1); } }, h('span', { class: 'ico', 'aria-hidden': 'true' }, i.icon || '•'), i.name, n ? h('b', null, ' ×' + n) : null),
        n ? h('button', { class: 'slipundo', 'aria-label': '少記一筆 ' + i.name, onclick: function () { slipChange(i, date, -1); } }, '−') : null);
    }));
    return [h('h2', null, '小失誤（只記錄，不扣分）'), row];
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

  function drawNow() {
    var c = drawChallenge(dget('library'), trainStateOn(today()), Math.random());
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
    var row = { date: c.date, move: c.move, amount: c.amount, level: c.level, minutes: c.minutes, result: result, secs: Math.round((Date.now() - c.startedAt) / 1000) };
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
      box.appendChild(h('div', { class: 'muted' }, challengeText(c) + '（' + c.level + '量）'));
      box.appendChild(h('div', { id: 'ch-timer', class: 'timer' + (over ? ' over' : '') }, over ? '時間到' : fmtTime(chRemaining())));
      box.appendChild(h('div', { class: 'row', style: 'margin-top:8px' },
        over ? null : h('button', { class: 'btn primary grow', onclick: function () { resolveChallenge('成功'); } }, '完成了'),
        h('button', { class: 'btn' + (over ? ' primary grow' : ''), onclick: function () { resolveChallenge(over ? '失敗' : '放棄'); } }, over ? '結束' : '放棄')));
    } else if (state.preview) {
      box.appendChild(h('div', { class: 'timer small' }, challengeText(state.preview)));
      box.appendChild(h('div', { class: 'muted' }, state.preview.level + '量（依今天的狀態）・按「開始」才計時，也才用掉一次機會'));
      box.appendChild(h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn primary grow', onclick: startChallenge }, '開始'),
        h('button', { class: 'btn', onclick: function () { state.preview = null; render(); } }, '先不要')));
    } else {
      box.appendChild(h('div', { class: 'muted' }, '隨機從你的動作庫抽一個，時間內完成有加分，沒完成不扣分。今天還有 ' + left + ' 次。'));
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
      nodes.push(h('div', { class: 'seg' }, TRAIN_STATES.map(function (s) {
        return h('button', { class: 'btn' + (st === s ? ' on' : ''), 'aria-pressed': String(st === s), disabled: future, onclick: function () { setTrainState(date, s); } }, s);
      })));
      nodes.push(h('p', { class: 'muted' }, st === '疲勞' ? '疲勞：卡片會改給輕鬆版，需要的話直接休息。' : st === '精神好' ? '精神好：有進階版的項目會多給一個選擇。' : '選今天的狀態，建議會跟著調整（可不選）。'));
      renderChallenge(date).forEach(function (n) { nodes.push(n); });
      nodes.push(h('div', { class: 'card' }, h('div', null, '本週已做 ', h('b', null, sum.sessions), ' 項、累計 ', h('b', null, sum.minutes), ' 分鐘'), h('div', { class: 'muted' }, '只是記錄，這裡沒有目標，也不影響必做完成率。')));
      var fixed = menu.items.filter(function (i) { return i.fixed; }), free = menu.items.filter(function (i) { return !i.fixed; });
      if (fixed.length) { nodes.push(h('h2', null, '已排定')); fixed.forEach(function (i) { nodes.push(trainCard(i, date, st)); }); }
      if (free.length) { nodes.push(h('h2', null, '可以做')); free.forEach(function (i) { nodes.push(trainCard(i, date, st)); }); }
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
    state.busy = true; render();
    api('saveTask', { task: task }).then(function () { state.editing = null; toast('已儲存'); }).catch(function (e) { toast(e.network ? '需要網路才能修改任務' : e.message); })
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
      h('label', { class: 'f', for: 'f-link' }, '連結（選填，https://）'),
      h('input', { type: 'url', id: 'f-link', name: 'link', value: t.link }),
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

  function renderTasks() {
    if (state.editing) return [h('h1', null, state.editing.id ? '編輯任務' : '新增任務'), renderTaskForm(state.editing)];
    var nodes = [h('div', { class: 'row' }, h('h1', { class: 'grow' }, '任務'), h('button', { class: 'btn primary', onclick: function () { state.editing = blankTask(); render(); } }, '＋ 新增'))];
    state.data.tasks.forEach(function (t, i, all) {
      var extras = (hasOptions(t) ? '・' + t.options.length + ' 個選項' : '') + (t.tierUp || t.tierDown ? '・有進階/最低' : '');
      function move(dir) { api('moveTask', { id: t.id, dir: dir }).then(refresh).catch(function (e) { toast(e.network ? '需要網路才能調整順序' : e.message); }); }
      nodes.push(h('div', { class: 'card item ' + dimCls(t.dim) + (t.active ? '' : ' inactive') },
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
    });
    if (!state.data.tasks.length) nodes.push(h('p', { class: 'muted' }, '還沒有任務。'));
    return nodes;
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
    var rows = state.data.history;
    if (!rows.length) return [];
    var months = [], items = [], cell = {};
    rows.forEach(function (r) {
      if (months.indexOf(r.month) < 0) months.push(r.month);
      if (items.indexOf(r.item) < 0) items.push(r.item);
      cell[r.month + '|' + r.item] = r.count;
    });
    months.sort();
    return [h('h2', null, '歷史對照（2026 月統計，來自舊紀錄）'),
      h('div', { class: 'card scroll' }, h('table', null,
        h('thead', null, h('tr', null, [h('th', null, '')].concat(months.map(function (m) { return h('th', null, m.slice(5) + '月'); })))),
        h('tbody', null, items.map(function (it) {
          return h('tr', null, [h('td', null, it)].concat(months.map(function (m) { var v = cell[m + '|' + it]; return h('td', null, v === undefined ? '' : v); })));
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
      nodes.push(h('div', { class: 'card' }, sw('anim', '完成動畫', '不受系統「減少動態效果」影響'), sw('vibrate', '震動'), sw('sound', '提示音')));
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

  // ---- shell ----

  function render() {
    var view = document.getElementById('view');
    var tab = state.cfg ? state.tab : 'settings';
    var nodes;
    if (tab !== 'settings' && !state.data) nodes = [h('p', { class: 'muted' }, '載入中…（第一次需要網路）')];
    else nodes = tab === 'today' ? renderToday() : tab === 'train' ? renderTrain() : tab === 'game' ? renderGame() : tab === 'tasks' ? renderTasks() : tab === 'plan' ? renderPlan() : renderSettings();
    var focusId = document.activeElement && document.activeElement.id;
    var keepY = window.scrollY;
    view.textContent = '';
    nodes.forEach(function (n) { view.appendChild(n); });
    if (focusId && !state.modal) { var again = document.getElementById(focusId); if (again) again.focus(); }
    window.scrollTo(0, keepY);
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
      b.disabled = !state.cfg;
    });
    renderModal();
    if (state.pop) { if (state.pop.confetti) confetti(); if (PREFS.anim) buzz(); beep(); state.pop = null; }
  }

  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); state.editing = null; state.modal = null; render(); window.scrollTo(0, 0); });
  });
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && state.modal) closeModal(); });
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (state.openedOn !== today()) { state.openedOn = today(); state.date = today(); state.trainDate = today(); }
    state.date = state.date > today() ? today() : state.date;
    refresh();
  });
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });

  render();
  if (location.hash === '#accum') setTimeout(function () { var el = document.getElementById('accum'); if (el) el.scrollIntoView(); }, 300);
  refresh();
}());
