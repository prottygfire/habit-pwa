// Habit PWA. Data lives in the Google Sheet behind the Apps Script endpoint; this file only draws and syncs.
// Check-ins are applied locally first and queued, so tapping works offline and syncs when the network returns.
(function () {
  'use strict';

  var SLOT_ORDER = ['早', '午', '晚', '不限'];
  var DIMS = ['健康', '財商', '學習', '情緒', '工作', '娛樂'];
  var FREQ_LABEL = { daily: '每天', weekdays: '指定星期', weekly_n: '每週 N 次', monthly_n: '每月 N 次', quarterly_n: '每季 N 次' };
  var UNIT = { weekly_n: '週', monthly_n: '月', quarterly_n: '季' };
  var WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

  var LS = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode: run without persistence */ } }
  };

  function localDate(d) {
    return d.getFullYear() + '-' + pad2_(d.getMonth() + 1) + '-' + pad2_(d.getDate());
  }

  var state = {
    cfg: LS.get('habit.cfg', null),
    data: LS.get('habit.data', null),
    queue: LS.get('habit.queue', []),
    tab: 'today',
    date: localDate(new Date()),
    planMode: 'month',
    editing: null,
    busy: false
  };

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
        state.data = { tasks: res.tasks, logs: res.logs, leave: res.leave, goals: res.goals, history: res.history };
        LS.set('habit.data', state.data);
      });
    }).catch(function (e) {
      if (e.unauthorized) { toast('暗號不正確，請到設定重新輸入'); state.tab = 'settings'; }
      else if (!e.network) toast(e.message);
    }).then(render);
  }

  function enqueue(action, payload) {
    state.queue.push({ action: action, payload: payload });
    LS.set('habit.queue', state.queue);
    LS.set('habit.data', state.data);
    render();
    flush().then(render);
  }

  // ---- derived data ----

  function ctx() {
    var d = state.data;
    return { tasks: d.tasks, idx: indexLogs(d.logs), leave: indexLeave(d.leave) };
  }

  function dateTitle(s) {
    var d = toDate_(s);
    return (d.getUTCMonth() + 1) + ' 月 ' + d.getUTCDate() + ' 日（週' + WEEKDAY_NAMES[weekdayOf(s) - 1] + '）';
  }

  function pct(r) { return r === null || r === undefined ? '—' : Math.round(r * 100) + '%'; }

  // ---- today ----

  function toggleTask(t, date, done) {
    var d = state.data;
    d.logs = d.logs.filter(function (l) { return !(l.date === date && l.taskId === t.id); });
    if (done) d.logs.push({ date: date, taskId: t.id });
    enqueue('toggle', { date: date, taskId: t.id, done: done });
  }

  function toggleLeave(date, on) {
    var d = state.data;
    d.leave = d.leave.filter(function (x) { return x !== date; });
    if (on) d.leave.push(date);
    enqueue('setLeave', { date: date, on: on });
  }

  function taskItem(t, c, date) {
    var done = isDone(t, date, c.idx);
    var streak = taskStreak(t, date, c.idx, c.leave);
    var sub = [h('span', { class: 'chip' }, t.dim)];
    if (isCountFreq(t.freq)) {
      var p = progress(t, date, c.idx);
      sub.push(h('span', { class: 'muted' }, '本' + UNIT[t.freq] + ' ' + p.done + '/' + p.target));
    }
    if (streak > 0) sub.push(h('span', { class: 'muted' }, ' 🔥' + streak + (isCountFreq(t.freq) ? UNIT[t.freq] : '天')));
    return h('div', { class: 'card item row' + (done ? ' done' : '') },
      h('button', { class: 'check', 'aria-pressed': String(done), 'aria-label': (done ? '取消完成 ' : '完成 ') + t.name, onclick: function () { toggleTask(t, date, !done); } }, '✓'),
      h('div', { class: 'grow' },
        h('div', { class: 'name' }, t.name),
        h('div', null, sub)),
      t.link ? h('a', { href: t.link, target: '_blank', rel: 'noopener', class: 'btn small' }, '開啟') : null);
  }

  function renderToday() {
    var c = ctx(), date = state.date, isToday = date === today(), onLeave = !!c.leave[date];
    var due = c.tasks.filter(function (t) { return isDue(t, date, c.idx); });
    var st = dayStats(c.tasks, date, c.idx, c.leave);
    var overall = overallStreak(c.tasks, date, c.idx, c.leave);
    var nodes = [
      h('div', { class: 'row' },
        h('button', { class: 'btn small', 'aria-label': '前一天', onclick: function () { state.date = addDays(date, -1); render(); } }, '‹'),
        h('h1', { class: 'grow' }, dateTitle(date) + (isToday ? ' · 今天' : '')),
        h('button', { class: 'btn small', 'aria-label': '後一天', disabled: date >= today(), onclick: function () { state.date = addDays(date, 1); render(); } }, '›')),
      h('div', { class: 'card' },
        h('div', { class: 'stat' }, h('span', null, '完成率 ', h('b', null, pct(st.rate))), h('span', null, '🔥 連續 ', h('b', null, overall), ' 天')),
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuenow': st.rate === null ? 0 : Math.round(st.rate * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
          h('i', { style: 'width:' + (st.rate === null ? 0 : Math.round(st.rate * 100)) + '%' })),
        h('div', { class: 'muted' }, st.due + ' 項固定任務，已完成 ' + st.done + ' 項（完成率 ≥ 80% 才算連續一天）')),
      h('button', { class: 'btn small' + (onLeave ? ' primary' : ''), onclick: function () { toggleLeave(date, !onLeave); } }, onLeave ? '已請假（點一下取消）' : '這天請假（不影響連續天數）')
    ];
    if (onLeave) nodes.push(h('p', { class: 'muted' }, '請假日不提醒，也不計入完成率。'));
    SLOT_ORDER.forEach(function (slot) {
      var items = due.filter(function (t) { return (t.slot || '不限') === slot; });
      if (!items.length) return;
      nodes.push(h('h2', null, slot === '不限' ? '全天' : slot));
      items.forEach(function (t) { nodes.push(taskItem(t, c, date)); });
    });
    if (!due.length) nodes.push(h('p', { class: 'muted' }, '這天沒有任務。到「任務」頁新增。'));
    return nodes;
  }

  // ---- tasks ----

  function blankTask() {
    return { id: '', name: '', dim: '健康', freq: 'daily', param: '', slot: '不限', remind: true, active: true, link: '' };
  }

  function saveTaskForm(form, original) {
    var f = form.elements;
    var freq = f.freq.value, param = '';
    if (freq === 'weekdays') param = Array.prototype.filter.call(form.querySelectorAll('input[name=wd]'), function (x) { return x.checked; }).map(function (x) { return x.value; }).join(',');
    if (isCountFreq(freq)) param = f.n.value;
    var task = { id: original.id, name: f.name.value, dim: f.dim.value, freq: freq, param: param, slot: f.slot.value, remind: f.remind.checked, active: f.active.checked, link: f.link.value };
    state.busy = true; render();
    api('saveTask', { task: task }).then(function () { state.editing = null; toast('已儲存'); }).catch(function (e) { toast(e.network ? '需要網路才能修改任務' : e.message); })
      .then(function () { state.busy = false; return refresh(); });
  }

  function renderTaskForm(t) {
    var wds = String(t.param).split(',');
    var form = h('form', { class: 'card', onsubmit: function (ev) { ev.preventDefault(); saveTaskForm(form, t); } },
      h('label', { class: 'f', for: 'f-name' }, '名稱'),
      h('input', { type: 'text', id: 'f-name', name: 'name', value: t.name, required: true, maxlength: '80' }),
      h('label', { class: 'f', for: 'f-dim' }, '維度'),
      h('select', { id: 'f-dim', name: 'dim' }, DIMS.map(function (d) { return h('option', { value: d, selected: d === t.dim }, d); })),
      h('label', { class: 'f', for: 'f-freq' }, '頻率'),
      h('select', { id: 'f-freq', name: 'freq', onchange: function (ev) { sync(ev.target.value); } },
        Object.keys(FREQ_LABEL).map(function (k) { return h('option', { value: k, selected: k === t.freq }, FREQ_LABEL[k]); })),
      h('div', { id: 'f-days', class: 'days' }, WEEKDAY_NAMES.map(function (n, i) {
        return h('label', null, h('input', { type: 'checkbox', name: 'wd', value: String(i + 1), checked: wds.indexOf(String(i + 1)) >= 0 }), h('span', null, n));
      })),
      h('div', { id: 'f-n' }, h('label', { class: 'f', for: 'f-nn' }, '次數'), h('input', { type: 'number', id: 'f-nn', name: 'n', min: '1', value: isCountFreq(t.freq) ? t.param : '3' })),
      h('label', { class: 'f', for: 'f-slot' }, '時段（影響午間提醒）'),
      h('select', { id: 'f-slot', name: 'slot' }, SLOT_ORDER.map(function (s) { return h('option', { value: s, selected: s === t.slot }, s); })),
      h('label', { class: 'f', for: 'f-link' }, '連結（選填，https://）'),
      h('input', { type: 'url', id: 'f-link', name: 'link', value: t.link }),
      h('label', { class: 'row f' }, h('input', { type: 'checkbox', name: 'remind', checked: t.remind }), ' 用 Telegram 提醒'),
      h('label', { class: 'row f' }, h('input', { type: 'checkbox', name: 'active', checked: t.active }), ' 啟用（取消勾選＝暫停）'),
      h('div', { class: 'row', style: 'margin-top:12px' },
        h('button', { class: 'btn primary grow', type: 'submit', disabled: state.busy }, '儲存'),
        h('button', { class: 'btn', type: 'button', onclick: function () { state.editing = null; render(); } }, '取消')));
    function sync(freq) {
      form.querySelector('#f-days').style.display = freq === 'weekdays' ? '' : 'none';
      form.querySelector('#f-n').style.display = isCountFreq(freq) ? '' : 'none';
    }
    sync(t.freq);
    return form;
  }

  function freqText(t) {
    if (t.freq === 'weekdays') return '每週' + String(t.param).split(',').map(function (n) { return WEEKDAY_NAMES[n - 1]; }).join('、');
    if (isCountFreq(t.freq)) return '每' + UNIT[t.freq] + ' ' + t.param + ' 次';
    return '每天';
  }

  function renderTasks() {
    if (state.editing) return [h('h1', null, state.editing.id ? '編輯任務' : '新增任務'), renderTaskForm(state.editing)];
    var nodes = [h('div', { class: 'row' }, h('h1', { class: 'grow' }, '任務'), h('button', { class: 'btn primary', onclick: function () { state.editing = blankTask(); render(); } }, '＋ 新增'))];
    state.data.tasks.forEach(function (t) {
      nodes.push(h('div', { class: 'card item row' + (t.active ? '' : ' inactive') },
        h('div', { class: 'grow' }, h('div', { class: 'name' }, t.name),
          h('div', null, h('span', { class: 'chip' }, t.dim), h('span', { class: 'muted' }, freqText(t) + (t.slot !== '不限' ? '・' + t.slot : '') + (t.remind ? '・提醒' : '') + (t.active ? '' : '・已暫停')))),
        h('button', { class: 'btn small', onclick: function () { state.editing = JSON.parse(JSON.stringify(t)); render(); } }, '編輯'),
        h('button', { class: 'btn small danger', onclick: function () {
          if (!confirm('刪除「' + t.name + '」？打卡紀錄會保留。')) return;
          api('deleteTask', { id: t.id }).then(refresh).catch(function (e) { toast(e.network ? '需要網路才能刪除' : e.message); });
        } }, '刪除')));
    });
    if (!state.data.tasks.length) nodes.push(h('p', { class: 'muted' }, '還沒有任務。'));
    return nodes;
  }

  // ---- month / quarter ----

  function bar(label, right, rate) {
    return h('div', { style: 'margin:8px 0' },
      h('div', { class: 'row' }, h('span', { class: 'grow' }, label), h('span', { class: 'muted' }, right)),
      h('div', { class: 'bar' }, h('i', { style: 'width:' + Math.round(Math.min(1, rate || 0) * 100) + '%' })));
  }

  function renderGoals(key) {
    var mine = state.data.goals.filter(function (g) { return g.period === key; });
    var nodes = [h('h2', null, '一次性事項（' + key + '）')];
    mine.forEach(function (g) {
      nodes.push(h('div', { class: 'card item row' + (g.done ? ' done' : '') },
        h('button', { class: 'check', 'aria-pressed': String(g.done), 'aria-label': g.name, onclick: function () {
          g.done = !g.done;
          api('toggleGoal', { id: g.id, done: g.done }).then(refresh).catch(function (e) { g.done = !g.done; toast(e.network ? '需要網路' : e.message); render(); });
          render();
        } }, '✓'),
        h('div', { class: 'grow' }, h('div', { class: 'name' }, g.name), h('span', { class: 'chip' }, g.dim)),
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
    nodes.push(h('h2', null, '四維度完成率（固定任務）'));
    var any = false;
    DIMS.forEach(function (d) {
      if (!rates[d]) return;
      any = true;
      nodes.push(bar(d, pct(rates[d].rate) + '（' + rates[d].done + '/' + rates[d].due + '）', rates[d].rate));
    });
    if (!any) nodes.push(h('p', { class: 'muted' }, '還沒有資料，從今天開始打卡。'));
    var counts = c.tasks.filter(function (t) { return t.active && isCountFreq(t.freq) && (mode === 'quarter' || t.freq !== 'quarterly_n') && (mode === 'month' || t.freq !== 'weekly_n'); });
    if (counts.length) {
      nodes.push(h('h2', null, '次數目標'));
      counts.forEach(function (t) { var p = progress(t, t0, c.idx); nodes.push(bar(t.name + '（每' + UNIT[t.freq] + '）', p.done + '/' + p.target, p.done / p.target)); });
    }
    var trend = dailyRates(c.tasks, range.start, range.end < t0 ? range.end : t0, c.idx, c.leave);
    nodes.push(h('h2', null, '每日完成率趨勢'));
    nodes.push(h('div', { class: 'card' }, h('div', { class: 'trend', role: 'img', 'aria-label': '每日完成率趨勢' }, trend.map(function (x) {
      return h('i', { class: x.rate === null ? 'none' : '', style: 'height:' + (x.rate === null ? 3 : Math.max(4, Math.round(x.rate * 100))) + '%', title: x.date + ' ' + pct(x.rate) });
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
    else nodes = tab === 'today' ? renderToday() : tab === 'tasks' ? renderTasks() : tab === 'plan' ? renderPlan() : renderSettings();
    var focusId = document.activeElement && document.activeElement.id;
    view.textContent = '';
    nodes.forEach(function (n) { view.appendChild(n); });
    if (focusId) { var again = document.getElementById(focusId); if (again) again.focus(); }
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
      b.disabled = !state.cfg;
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
    b.addEventListener('click', function () { state.tab = b.getAttribute('data-tab'); state.editing = null; render(); });
  });
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { state.date = state.date > today() ? today() : state.date; refresh(); } });
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(function () { /* offline shell is optional */ });

  render();
  refresh();
}());
