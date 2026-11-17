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
    // 旅人標記（向量）
    var m = window.roadmapPoint(wp, pos), mx = m.x * W, my = m.y * H, s = W * 0.032;
    o.push('<g class="rm-marker' + (opts.anim ? ' rm-pulse' : '') + '" transform="translate(' + mx.toFixed(1) + ' ' + my.toFixed(1) + ')">' +
      '<path d="M0 ' + (-s * 0.2).toFixed(1) + ' L' + s.toFixed(1) + ' ' + (s * 1.6).toFixed(1) + ' L' + (-s).toFixed(1) + ' ' + (s * 1.6).toFixed(1) + ' Z" fill="' + TERRA + '" stroke="' + INK + '" stroke-width="5"/>' +
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
      return '<button class="rm-entry' + (e ? ' placed' : '') + '" data-skill="' + s + '"' + style + '><b>' + s + '</b><span>Lv' + sk.level + '</span><i class="rm-bar"><u style="width:' + pct + '%"></u></i></button>';
    }).join('');
    var img = cfg && cfg.world ? '<img class="rm-worldimg" src="map/' + cfg.world.image + '" alt="世界地圖" onerror="this.parentNode.classList.add(\'rm-nomap\');this.remove()">' : '';
    return '<div class="rm-world' + (img ? '' : ' rm-nomap') + '">' + img + btns + '</div>';
  }

  window.RoadmapView = { load: load, regionSvg: regionSvg, worldHtml: worldHtml };
})();
