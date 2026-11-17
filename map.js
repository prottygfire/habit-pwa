// 冒險地圖的畫面：產生 SVG／HTML 字串，由 app.js 放進頁面。
// 依賴 logic.js 的 roadmapPoint、roadmapTrail、roadmapPos、SKILLS（全域）。資料只用內部設定（map/maps.json），沒有使用者輸入，所以直接拼字串。
(function () {
  var PAPER = '#E8D9B0', INK = '#3B2A1A', GOLD = '#C9A24B', TERRA = '#B5603A', GLOW = '#FFE08A';
  var cache = null;

  // 讀路徑設定；讀不到（離線、檔案還沒放）回 null，畫面照樣顯示
  function load() {
    if (cache) return cache;
    if (typeof fetch !== 'function') { cache = Promise.resolve(null); return cache; }
    cache = fetch('map/maps.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    return cache;
  }

  function pts(list, W, H) { return list.map(function (p) { return (p.x * W).toFixed(1) + ',' + (p.y * H).toFixed(1); }).join(' '); }

  function emptySvg(text) {
    return '<svg class="rm-svg" viewBox="0 0 600 900" role="img" aria-label="' + text + '"><rect width="600" height="900" fill="' + PAPER + '"/>' +
      '<text x="300" y="450" text-anchor="middle" font-size="28" fill="' + INK + '">' + text + '</text></svg>';
  }

  // opts: {anim, debug, level, uid}
  function regionSvg(cfg, pos, prev, opts) {
    opts = opts || {};
    if (!cfg) return emptySvg('地圖還沒準備好');
    var W = cfg.w, H = cfg.h, wp = cfg.waypoints, level = opts.level || 1, uid = opts.uid || 'a';
    var R = cfg.reveal * W, full = level >= 20;
    var o = ['<svg class="rm-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="冒險地圖">'];
    o.push('<rect width="' + W + '" height="' + H + '" fill="' + PAPER + '"/>');
    o.push('<image href="map/' + cfg.image + '" x="0" y="0" width="' + W + '" height="' + H + '" preserveAspectRatio="xMidYMid slice"/>');
    // 走過的路（實線），再疊今天新走的一段（發亮）
    if (prev > 0) o.push('<polyline class="rm-walked" points="' + pts(window.roadmapTrail(wp, 0, prev, Math.max(2, Math.ceil(prev * 6))), W, H) + '" fill="none" stroke="#A8741E" stroke-opacity="0.9" stroke-width="' + (W * 0.016).toFixed(1) + '" stroke-linecap="round" stroke-linejoin="round"/>');
    if (pos > prev) o.push('<polyline class="rm-new' + (opts.anim ? ' rm-glow' : '') + '" points="' + pts(window.roadmapTrail(wp, prev, pos, 12), W, H) + '" fill="none" stroke="' + GLOW + '" stroke-width="' + (W * 0.02).toFixed(1) + '" stroke-linecap="round"/>');
    // 20 個路標：已到達的亮起
    for (var i = 0; i < wp.length; i++) {
      var lit = i <= level - 1;
      o.push('<circle data-dot="' + (i + 1) + '" class="rm-dot' + (lit ? ' lit' : '') + '" cx="' + (wp[i].x * W).toFixed(1) + '" cy="' + (wp[i].y * H).toFixed(1) + '" r="' + (W * (lit ? 0.017 : 0.011)).toFixed(1) + '" fill="' + (lit ? GOLD : PAPER) + '" stroke="' + INK + '" stroke-width="4"/>');
    }
    // 終點地標（霧蓋住時只剩剪影）
    o.push('<circle class="rm-landmark" cx="' + (cfg.landmark.x * W).toFixed(1) + '" cy="' + (cfg.landmark.y * H).toFixed(1) + '" r="' + (R * 0.45).toFixed(1) + '" fill="none" stroke="' + GOLD + '" stroke-width="6"/>');
    // 羊皮紙迷霧：遮罩白色處有霧；走過的地方（黑）揭開，終點地標處半透明
    if (full) {
      o.push('<g data-fog="clear"></g>');
    } else {
      var trail = window.roadmapTrail(wp, 0, pos, Math.max(4, Math.ceil(pos * 4)));
      o.push('<defs><filter id="rmb' + uid + '" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="' + (R * 0.35).toFixed(1) + '"/></filter>');
      o.push('<mask id="rmm' + uid + '"><rect width="' + W + '" height="' + H + '" fill="#fff"/><g filter="url(#rmb' + uid + ')">');
      o.push('<circle cx="' + (cfg.landmark.x * W).toFixed(1) + '" cy="' + (cfg.landmark.y * H).toFixed(1) + '" r="' + (R * 0.9).toFixed(1) + '" fill="#808080"/>');
      trail.forEach(function (p) { o.push('<circle cx="' + (p.x * W).toFixed(1) + '" cy="' + (p.y * H).toFixed(1) + '" r="' + R.toFixed(1) + '" fill="#000"/>'); });
      o.push('</g></mask></defs>');
      o.push('<rect data-fog="on" width="' + W + '" height="' + H + '" fill="' + PAPER + '" opacity="0.92" mask="url(#rmm' + uid + ')"/>');
    }
    // 精通星：Lv20 之後每多一級一顆，排在地圖左上角（半透明底，各區都不會被畫面邊緣切到；最多畫 10 顆，超過的看彈窗）
    var nStars = Math.min(10, window.roadmapStars({ level: level }));
    if (nStars) {
      var gap = W * 0.04, sr = W * 0.017, x0 = W * 0.045, y0 = H * 0.04, padX = W * 0.02;
      o.push('<rect x="' + (x0 - padX).toFixed(1) + '" y="' + (y0 - sr * 1.5).toFixed(1) + '" width="' + ((nStars - 1) * gap + padX * 2).toFixed(1) + '" height="' + (sr * 3).toFixed(1) + '" rx="' + (sr * 1.5).toFixed(1) + '" fill="rgba(59,42,26,0.6)"/>');
      for (var si = 0; si < nStars; si++) {
        var sx = x0 + si * gap, spts = [];
        for (var q = 0; q < 10; q++) { var ang = -Math.PI / 2 + q * Math.PI / 5, rr = q % 2 ? sr * 0.45 : sr; spts.push((sx + Math.cos(ang) * rr).toFixed(1) + ',' + (y0 + Math.sin(ang) * rr).toFixed(1)); }
        o.push('<polygon data-star="' + (si + 1) + '" points="' + spts.join(' ') + '" fill="#FFD34D" stroke="' + INK + '" stroke-width="2" stroke-linejoin="round"/>');
      }
    }
    // 點擊範圍：每個路標一個透明大圓（霧上面也點得到）
    for (var h2 = 0; h2 < wp.length; h2++) {
      o.push('<circle data-hit="' + (h2 + 1) + '" cx="' + (wp[h2].x * W).toFixed(1) + '" cy="' + (wp[h2].y * H).toFixed(1) + '" r="' + (W * 0.035).toFixed(1) + '" fill="rgba(0,0,0,0)" style="pointer-events:all;cursor:pointer"/>');
    }
    // 旅人標記（向量）
    var m = window.roadmapPoint(wp, pos), mx = m.x * W, my = m.y * H, s = W * 0.032;
    o.push('<g class="rm-marker' + (opts.anim ? ' rm-pulse' : '') + '" style="cursor:pointer" transform="translate(' + mx.toFixed(1) + ' ' + my.toFixed(1) + ')">' +
      '<path d="M0 ' + (-s * 0.2).toFixed(1) + ' L' + s.toFixed(1) + ' ' + (s * 1.6).toFixed(1) + ' L' + (-s).toFixed(1) + ' ' + (s * 1.6).toFixed(1) + ' Z" fill="' + TERRA + '" stroke="' + INK + '" stroke-width="5"/>' +
      '<circle cx="0" cy="0" r="' + (s * 2).toFixed(1) + '" fill="rgba(0,0,0,0)" style="pointer-events:all"/>' +
      '<circle cx="0" cy="' + (-s * 0.9).toFixed(1) + '" r="' + (s * 0.8).toFixed(1) + '" fill="' + PAPER + '" stroke="' + INK + '" stroke-width="5"/></g>');
    if (opts.debug) {
      for (var j = 0; j < wp.length; j++) o.push('<text data-debug="1" x="' + (wp[j].x * W + 16).toFixed(1) + '" y="' + (wp[j].y * H - 12).toFixed(1) + '" font-size="34" fill="#c00" stroke="#fff" stroke-width="1">' + (j + 1) + '</text>');
    }
    o.push('</svg>');
    return o.join('');
  }

  // 世界總覽：圖上放五個入口；圖還沒有時入口直接排成清單
  function worldHtml(cfg, skills) {
    var names = ['體能', '健康', '財商', '學習', '關係'];
    var btns = names.map(function (s) {
      var sk = skills[s] || { level: 1, sp: 0, levelStart: 0, nextAt: 1, gain: 0 };
      var pct = Math.round(window.roadmapPos(sk) / 19 * 100);
      var e = cfg && cfg.world && cfg.world.entries && cfg.world.entries[s];
      var style = e ? ' style="left:' + (e.x * 100).toFixed(1) + '%;top:' + (e.y * 100).toFixed(1) + '%"' : '';
      return '<button class="rm-entry' + (e ? ' placed' : '') + '" data-skill="' + s + '"' + style + '><b>' + s + '</b><span>Lv' + sk.level + (sk.level > 20 ? ' ★' + (sk.level - 20) : '') + '</span><i class="rm-bar"><u style="width:' + pct + '%"></u></i></button>';
    }).join('');
    var img = cfg && cfg.world ? '<img class="rm-worldimg" src="map/' + cfg.world.image + '" alt="世界地圖" onerror="this.parentNode.classList.add(\'rm-nomap\');this.remove()">' : '';
    return '<div class="rm-world' + (img ? '' : ' rm-nomap') + '">' + img + btns + '</div>';
  }

  // ---- 互動：點標記／路標彈說明、縮放與拖曳、升級時標記逐站走過去 ----

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }

  // box：放地圖的容器；o：{cfg, skill, sk, pos, prev, view, seen, anim, debug, onSeen}
  // view 是會跨重畫保存的狀態 {zoom, cx, cy, tip}；seen 是上次看過的 {pos, level}（沒有就不播動畫）
  function mountRegion(box, o) {
    var cfg = o.cfg && o.cfg[o.skill], view = o.view, sk = o.sk;
    if (!cfg) { box.innerHTML = regionSvg(null, 0, 0, {}); return { destroy: function () {} }; }
    var W = cfg.w, H = cfg.h, wp = cfg.waypoints;
    var alive = true, busy = false;
    var tools = el('div', 'rm-tools');
    var zoomLabel = el('span', 'muted');
    var bOut = el('button', 'btn small', '－'), bIn = el('button', 'btn small', '＋'), bMe = el('button', 'btn small', '📍 回到旅人');
    [bOut, bIn, bMe].forEach(function (b) { b.type = 'button'; });
    tools.appendChild(bOut); tools.appendChild(bIn); tools.appendChild(bMe); tools.appendChild(zoomLabel);
    var scroll = el('div', 'rm-scroll'), inner = el('div', 'rm-inner');
    scroll.appendChild(inner);
    box.textContent = '';
    box.appendChild(tools); box.appendChild(scroll);

    function updateLabel() { zoomLabel.textContent = '×' + view.zoom.toFixed(1); bOut.disabled = view.zoom <= 1; bIn.disabled = view.zoom >= 4; }
    function applyZoom() { inner.style.width = (view.zoom * 100) + '%'; updateLabel(); }
    function centerOn(fx, fy) {
      scroll.scrollLeft = fx * scroll.scrollWidth - scroll.clientWidth / 2;
      scroll.scrollTop = fy * scroll.scrollHeight - scroll.clientHeight / 2;
    }
    function saveCenter() {
      if (!scroll.scrollWidth) return;
      view.cx = (scroll.scrollLeft + scroll.clientWidth / 2) / scroll.scrollWidth;
      view.cy = (scroll.scrollTop + scroll.clientHeight / 2) / scroll.scrollHeight;
    }
    // 縮放到 z；錨點（畫面座標）下的那一點盡量不動，沒給就以目前中心為準
    function setZoom(z, ax, ay) {
      z = window.roadmapZoomClamp(z);
      var r = scroll.getBoundingClientRect();
      var px = ax === undefined ? r.width / 2 : ax - r.left, py = ay === undefined ? r.height / 2 : ay - r.top;
      var fx = (scroll.scrollLeft + px) / (scroll.scrollWidth || 1), fy = (scroll.scrollTop + py) / (scroll.scrollHeight || 1);
      view.zoom = z; applyZoom();
      scroll.scrollLeft = fx * scroll.scrollWidth - px;
      scroll.scrollTop = fy * scroll.scrollHeight - py;
      saveCenter();
    }
    function markerPoint() { return window.roadmapPoint(wp, o.pos); }

    function tipPoint() {
      if (!view.tip) return null;
      return view.tip.kind === 'dot' ? wp[view.tip.n - 1] : markerPoint();
    }
    function drawTip() {
      var old = inner.querySelector('.rm-tip');
      if (old) old.remove();
      var pt = tipPoint();
      if (!pt) return;
      var t = el('div', 'rm-tip' + (pt.y < 0.14 ? ' below' : ''), window.roadmapTipText(o.skill, sk, view.tip.kind, view.tip.n));
      t.style.left = Math.max(22, Math.min(78, pt.x * 100)).toFixed(1) + '%';
      t.style.top = (pt.y * 100).toFixed(1) + '%';
      inner.appendChild(t);
    }
    function draw(pos, level, prev) {
      var keep = scroll.scrollLeft, keepY = scroll.scrollTop;
      inner.innerHTML = regionSvg(cfg, pos, prev, { anim: o.anim, debug: o.debug, level: level, uid: 'r' });
      scroll.scrollLeft = keep; scroll.scrollTop = keepY;
      drawTip();
    }

    inner.addEventListener('click', function (e) {
      if (busy) return;
      var t = e.target, kind = null, n = 0;
      if (t.closest && t.closest('.rm-marker')) kind = 'marker';
      else if (t.getAttribute && t.getAttribute('data-hit')) { kind = 'dot'; n = +t.getAttribute('data-hit'); }
      if (!kind || (view.tip && view.tip.kind === kind && view.tip.n === n)) view.tip = null;
      else view.tip = { kind: kind, n: n };
      drawTip();
    });
    bIn.addEventListener('click', function () { setZoom(view.zoom * 1.5); });
    bOut.addEventListener('click', function () { setZoom(view.zoom / 1.5); });
    bMe.addEventListener('click', function () { var m = markerPoint(); centerOn(m.x, m.y); saveCenter(); });
    scroll.addEventListener('scroll', saveCenter);
    // 兩指縮放（CSS touch-action 已擋掉瀏覽器自己的縮放）
    var pinch = null;
    function dist(ts) { return Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY); }
    scroll.addEventListener('touchstart', function (e) { if (e.touches.length === 2) pinch = { d: dist(e.touches), z: view.zoom }; });
    scroll.addEventListener('touchmove', function (e) {
      if (!pinch || e.touches.length !== 2) return;
      setZoom(pinch.z * dist(e.touches) / pinch.d, (e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
    });
    scroll.addEventListener('touchend', function (e) { if (e.touches.length < 2) pinch = null; });

    applyZoom();
    var willPlay = !!(o.anim && o.seen && o.seen.level < sk.level && window.roadmapStops(o.seen.pos, o.pos).length);
    if (willPlay) draw(o.seen.pos, o.seen.level, o.seen.pos); else draw(o.pos, sk.level, o.prev);
    // 放大時：有存過視野就回到那裡，第一次則對準旅人
    if (view.zoom > 1) {
      if (view.cx === undefined) { var m0 = markerPoint(); view.cx = m0.x; view.cy = m0.y; }
      centerOn(view.cx, view.cy);
    }
    if (o.onSeen) o.onSeen();

    // 升級：標記沿路走，經過每個新路標停一下、路標亮起、霧退開
    function playLevelUp() {
      var stops = window.roadmapStops(o.seen.pos, o.pos), fast = stops.length > 6, cur = o.seen.pos;
      var moveMs = fast ? 250 : 700, pauseMs = fast ? 250 : 800;
      busy = true;
      function stillHere() { return alive && box.isConnected; }
      function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
      function move(to) {
        return new Promise(function (resolve) {
          var from = cur, t0 = null;
          function frame(ts) {
            if (!stillHere()) return resolve();
            if (t0 === null) t0 = ts;
            var k = Math.min(1, (ts - t0) / moveMs), p = window.roadmapPoint(wp, from + (to - from) * k);
            var mk = inner.querySelector('.rm-marker');
            if (mk) mk.setAttribute('transform', 'translate(' + (p.x * W).toFixed(1) + ' ' + (p.y * H).toFixed(1) + ')');
            if (k < 1) setTimeout(function () { frame(performance.now()); }, 16); else { cur = to; resolve(); }
          }
          frame(performance.now());
        });
      }
      var chain = Promise.resolve();
      stops.forEach(function (k) {
        chain = chain.then(function () { if (!stillHere()) return; return move(k); }).then(function () {
          if (!stillHere()) return;
          draw(k, k + 1, k);
          var dot = inner.querySelector('[data-dot="' + (k + 1) + '"]');
          if (dot) dot.setAttribute('class', 'rm-dot lit rm-pop');
          return wait(pauseMs);
        });
      });
      chain.then(function () { if (!stillHere()) return; return move(o.pos); }).then(function () {
        if (stillHere()) draw(o.pos, sk.level, o.prev);
      }).then(function () { busy = false; }, function () { busy = false; });
    }
    if (willPlay) setTimeout(function () { if (alive && box.isConnected) playLevelUp(); }, 400);
    return { destroy: function () { alive = false; } };
  }

  window.RoadmapView = { load: load, regionSvg: regionSvg, worldHtml: worldHtml, mountRegion: mountRegion };
})();
