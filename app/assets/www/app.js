/* Surveyor — offline field-survey map app (vanilla JS, runs under file:// in a WebView) */
(function () {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------- helpers
  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function svgEl(name, attrs, parent) {
    var n = document.createElementNS(SVGNS, name);
    if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  // "#rgb" | "#rrggbb" -> lowercase "#rrggbb"; anything else -> null
  function normHex(c) {
    if (typeof c !== 'string') return null;
    c = c.trim().toLowerCase();
    var m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
    if (m3) return '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
    if (/^#[0-9a-f]{6}$/.test(c)) return c;
    return null;
  }

  function darken(hex, f) {
    var h = normHex(hex) || '#888888';
    var r = Math.round(parseInt(h.slice(1, 3), 16) * f);
    var g = Math.round(parseInt(h.slice(3, 5), 16) * f);
    var b = Math.round(parseInt(h.slice(5, 7), 16) * f);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---------------------------------------------------------------- constants
  var PALETTE = [
    '#e53935', // red
    '#fb8c00', // orange
    '#fdd835', // yellow
    '#43a047', // green
    '#00897b', // teal
    '#1e88e5', // blue
    '#5e35b1', // purple
    '#d81b60', // pink
    '#6d4c41', // brown
    '#757575'  // gray
  ];
  var TAP_SLOP = 9;          // px of movement before a MOUSE press counts as a drag
  var TAP_SLOP_TOUCH = 18;   // fingers jitter far more than mice: quick taps on a
                             // touchscreen easily wander >9px and must still count
  var PIN_SIZE = 34;         // on-screen pin height in px (constant across zoom)
  var WHEEL_SENS = 0.0016;

  // ---------------------------------------------------------------- DOM refs
  var stage = $('stage'), layer = $('mapLayer'), baseImg = $('baseImg'), overlay = $('overlay');
  var gFills = $('gFills'), gLabels = $('gLabels'), gHits = $('gHits'),
      gFx = $('gFx'), gDetect = $('gDetect'), gPins = $('gPins'), gLoc = $('gLoc'),
      gRoutes = $('gRoutes');

  // ---------------------------------------------------------------- state
  var community = null;      // { id, name, dir }
  var data = null;           // MAP_DATA[community.id]
  var vb = { x: 0, y: 0, w: 1, h: 1 };

  var houseColors = {};      // { n -> "#rrggbb" }
  var legendEntries = [];    // [ { color, label } ] (insertion order preserved)
  var markers = [];          // [ { id, x, y, label } ]
  var routes = [];           // [ { id, label, color, pts:[[x,y],...] } ]
  var addrs = {};            // { n -> address string } user overrides; builtin
                             // addresses live on the building records (b.addr)

  var bldEls = {};           // n -> { fill, label } (created lazily)
  var bldByN = {};           // n -> building record (from MAP_DATA or user set)
  var bldHits = {};          // n -> hit <polygon>
  var pinEls = {};           // marker id -> <g>

  // transform: screen = layerLocal * s + (tx, ty); layerLocal = map - vb origin
  var tx = 0, ty = 0, s = 1;
  var fitWholeS = 1, minS = 0.02, maxS = 50;
  var flyToken = 0;          // cancels in-flight fly animations

  var markerMode = false;
  var editMode = false;      // building editor (user maps only)
  var isUserMap = false;     // active community is a user-uploaded map
  var userMaps = [];         // registry: [{id, name, blobKey, viewBox, created}]
  var loadedScripts = {};    // dir -> true once data.js script injected
  var userNavigated = false; // once true, resizes stop re-fitting the view

  // ---------------------------------------------------------------- storage
  function storeKey(kind) { return 'surveyor:' + community.id + ':' + kind; }
  function loadJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var v = JSON.parse(raw);
      return v == null ? fallback : v;
    } catch (e) { return fallback; }
  }
  function saveJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { toast('Could not save (storage full?)'); }
  }
  function saveColors()  { saveJSON(storeKey('colors'), houseColors); }
  function saveLegend()  { saveJSON(storeKey('legend'), legendEntries); }
  function saveMarkers() { saveJSON(storeKey('markers'), markers); }

  function loadState() {
    houseColors = {};
    var rawColors = loadJSON(storeKey('colors'), {});
    for (var k in rawColors) {
      var c = normHex(rawColors[k]);
      if (c) houseColors[k] = c;
    }
    legendEntries = [];
    var rawLegend = loadJSON(storeKey('legend'), []);
    for (var i = 0; i < rawLegend.length; i++) {
      var e = rawLegend[i];
      var col = e && normHex(e.color);
      if (col) legendEntries.push({ color: col, label: String(e.label || '') });
    }
    markers = [];
    var rawMarkers = loadJSON(storeKey('markers'), []);
    for (var j = 0; j < rawMarkers.length; j++) {
      var m = rawMarkers[j];
      if (m && isFinite(m.x) && isFinite(m.y)) {
        markers.push({ id: String(m.id || ('m' + j + '_' + Date.now())),
                       x: +m.x, y: +m.y, label: String(m.label || '') });
      }
    }
    addrs = {};
    var rawAddrs = loadJSON(storeKey('addrs'), {});
    for (var a in rawAddrs) {
      if (typeof rawAddrs[a] === 'string' && rawAddrs[a]) addrs[a] = rawAddrs[a];
    }
    routes = [];
    var rawRoutes = loadJSON(storeKey('routes'), []);
    for (var r = 0; r < rawRoutes.length; r++) {
      var rt = rawRoutes[r];
      if (rt && rt.pts && rt.pts.length >= 2) {
        routes.push({ id: String(rt.id || ('r' + r + '_' + Date.now())),
                      label: String(rt.label || ''),
                      color: normHex(rt.color) || '#1e88e5',
                      pts: rt.pts });
      }
    }
    renderRoutes();
  }

  // ------------------------------------------------- blob storage adapter
  // Order of preference per CONTRACT.md: SurveyorNative (Android bridge) ->
  // IndexedDB -> localStorage. All SurveyorNative access stays inside here.
  var BlobStore = (function () {
    var dbPromise = null;

    function native() {
      var n = window.SurveyorNative;
      return (n && typeof n.saveBlob === 'function' &&
              typeof n.loadBlob === 'function') ? n : null;
    }

    function openDb() {
      if (!dbPromise) {
        dbPromise = new Promise(function (resolve, reject) {
          try {
            var req = indexedDB.open('surveyor-blobs', 1);
            req.onupgradeneeded = function () { req.result.createObjectStore('blobs'); };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('idb open failed')); };
          } catch (e) { reject(e); }
        });
      }
      return dbPromise;
    }

    function idb(mode, fn) {
      return openDb().then(function (db) {
        return new Promise(function (resolve, reject) {
          var req = fn(db.transaction('blobs', mode).objectStore('blobs'));
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { reject(req.error || new Error('idb op failed')); };
        });
      });
    }

    var LS_PREFIX = 'surveyor:blob:';
    function lsSave(key, content) {
      return new Promise(function (resolve, reject) {
        try { localStorage.setItem(LS_PREFIX + key, content); resolve(); }
        catch (e) { reject(e); }
      });
    }
    function lsLoad(key) {
      try { return Promise.resolve(localStorage.getItem(LS_PREFIX + key)); }
      catch (e) { return Promise.resolve(null); }
    }
    function lsRemove(key) {
      try { localStorage.removeItem(LS_PREFIX + key); } catch (e) {}
      return Promise.resolve();
    }
    function lsList() {
      var out = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var k = localStorage.key(i);
          if (k && k.indexOf(LS_PREFIX) === 0) out.push(k.slice(LS_PREFIX.length));
        }
      } catch (e) {}
      return Promise.resolve(out);
    }

    return {
      save: function (key, content) {
        var nat = native();
        if (nat) {
          var r;
          try { r = String(nat.saveBlob(key, content)); }
          catch (e) { r = 'err:' + e.message; }
          return r === 'ok' ? Promise.resolve()
                            : Promise.reject(new Error(r.replace(/^err:/, '') || 'native save failed'));
        }
        if (window.indexedDB) {
          return idb('readwrite', function (st) { return st.put(content, key); })
            .catch(function () { return lsSave(key, content); });
        }
        return lsSave(key, content);
      },
      load: function (key) {
        var nat = native();
        if (nat) {
          try { return Promise.resolve(String(nat.loadBlob(key) || '') || null); }
          catch (e) { return Promise.resolve(null); }
        }
        if (window.indexedDB) {
          return idb('readonly', function (st) { return st.get(key); })
            .then(function (v) { return v == null ? lsLoad(key) : v; })
            .catch(function () { return lsLoad(key); });
        }
        return lsLoad(key);
      },
      remove: function (key) {
        var nat = native();
        if (nat) {
          try { nat.deleteBlob(key); } catch (e) {}
          return Promise.resolve();
        }
        if (window.indexedDB) {
          return idb('readwrite', function (st) { return st['delete'](key); })
            .then(function () { return lsRemove(key); })
            .catch(function () { return lsRemove(key); });
        }
        return lsRemove(key);
      },
      list: function () {
        var nat = native();
        if (nat && typeof nat.listBlobs === 'function') {
          try { return Promise.resolve(JSON.parse(nat.listBlobs()) || []); }
          catch (e) { return Promise.resolve([]); }
        }
        if (window.indexedDB) {
          return idb('readonly', function (st) { return st.getAllKeys(); })
            .catch(function () { return lsList(); });
        }
        return lsList();
      }
    };
  })();

  // ------------------------------------------------- user-map registry
  var USERMAPS_KEY = 'surveyor:userMaps';

  function loadUserMaps() {
    userMaps = [];
    var raw = loadJSON(USERMAPS_KEY, []);
    for (var i = 0; i < raw.length; i++) {
      var m = raw[i];
      if (m && typeof m.id === 'string' && typeof m.blobKey === 'string' &&
          m.viewBox && m.viewBox.length === 4 &&
          isFinite(m.viewBox[2]) && isFinite(m.viewBox[3])) {
        userMaps.push({
          id: m.id,
          name: String(m.name || 'My map'),
          blobKey: m.blobKey,
          viewBox: [+m.viewBox[0], +m.viewBox[1], +m.viewBox[2], +m.viewBox[3]],
          created: +m.created || 0
        });
      }
    }
  }
  function saveUserMaps() { saveJSON(USERMAPS_KEY, userMaps); }
  function userMapById(id) {
    for (var i = 0; i < userMaps.length; i++) if (userMaps[i].id === id) return userMaps[i];
    return null;
  }

  // ---------------------------------------------------------------- transform
  function stageSize() {
    return { w: stage.clientWidth || 1, h: stage.clientHeight || 1 };
  }

  function applyTransform() {
    layer.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + s + ')';
    counterScalePins();
    counterScaleLocDot();
  }

  function counterScalePins() {
    var inv = 1 / s;
    for (var id in pinEls) {
      var m = pinById(id);
      if (m) {
        pinEls[id].setAttribute('transform',
          'translate(' + m.x + ' ' + m.y + ') scale(' + inv + ')');
      }
    }
    var fx = gFx.firstChild;
    while (fx) {
      var px = fx.getAttribute('data-x'), py = fx.getAttribute('data-y');
      fx.setAttribute('transform', 'translate(' + px + ' ' + py + ') scale(' + inv + ')');
      fx = fx.nextSibling;
    }
  }

  function screenToMap(cx, cy) {
    var r = stage.getBoundingClientRect();
    return {
      x: vb.x + (cx - r.left - tx) / s,
      y: vb.y + (cy - r.top - ty) / s
    };
  }

  function zoomAt(cx, cy, ns) {
    ns = clamp(ns, minS, maxS);
    var r = stage.getBoundingClientRect();
    var lx = (cx - r.left - tx) / s, ly = (cy - r.top - ty) / s;
    tx = (cx - r.left) - lx * ns;
    ty = (cy - r.top) - ly * ns;
    s = ns;
    applyTransform();
  }

  // Content bounds (buildings + landmarks) so "fit" homes in on the community
  // instead of the huge mostly-empty sheet. Falls back to the full viewBox.
  function contentBounds() {
    var pad, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, found = false;
    // User-uploaded maps: the whole image is the content — never crop the fit
    // to the placed buildings (they start sparse while the map is being set up).
    if (isUserMap) return { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
    if (data && data.buildings) {
      for (var i = 0; i < data.buildings.length; i++) {
        var b = data.buildings[i];
        if (isFinite(b.cx) && isFinite(b.cy)) {
          found = true;
          if (b.cx < x0) x0 = b.cx; if (b.cx > x1) x1 = b.cx;
          if (b.cy < y0) y0 = b.cy; if (b.cy > y1) y1 = b.cy;
        }
      }
    }
    if (data && data.landmarks) {
      for (var j = 0; j < data.landmarks.length; j++) {
        var L = data.landmarks[j];
        if (isFinite(L.x) && isFinite(L.y)) {
          found = true;
          if (L.x < x0) x0 = L.x; if (L.x > x1) x1 = L.x;
          if (L.y < y0) y0 = L.y; if (L.y > y1) y1 = L.y;
        }
      }
    }
    if (!found) return { x: vb.x, y: vb.y, w: vb.w, h: vb.h };
    pad = Math.max((x1 - x0), (y1 - y0), 50) * 0.10;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    // clamp to the map sheet
    x0 = Math.max(x0, vb.x); y0 = Math.max(y0, vb.y);
    x1 = Math.min(x1, vb.x + vb.w); y1 = Math.min(y1, vb.y + vb.h);
    return { x: x0, y: y0, w: Math.max(x1 - x0, 1), h: Math.max(y1 - y0, 1) };
  }

  function computeZoomLimits() {
    var sz = stageSize();
    fitWholeS = Math.min(sz.w / vb.w, sz.h / vb.h);
    minS = fitWholeS * 0.5;
    maxS = Math.max(fitWholeS * 40, 12);
  }

  function fitView() {
    flyToken++;
    userNavigated = false;
    computeZoomLimits();
    var sz = stageSize();
    var cb = contentBounds();
    s = clamp(Math.min(sz.w / cb.w, sz.h / cb.h) * 0.95, minS, maxS);
    tx = sz.w / 2 - (cb.x + cb.w / 2 - vb.x) * s;
    ty = sz.h / 2 - (cb.y + cb.h / 2 - vb.y) * s;
    applyTransform();
  }

  function flyTo(mapX, mapY, targetS, done) {
    userNavigated = true;
    targetS = clamp(targetS, minS, maxS);
    var sz = stageSize();
    var tx1 = sz.w / 2 - (mapX - vb.x) * targetS;
    var ty1 = sz.h / 2 - (mapY - vb.y) * targetS;
    var tx0 = tx, ty0 = ty, s0 = s;
    var token = ++flyToken;
    if (document.hidden) {
      // rAF is paused while hidden — jump straight to the target
      s = targetS; tx = tx1; ty = ty1;
      applyTransform();
      if (done) done();
      return;
    }
    var t0 = performance.now(), DUR = 650;
    function step(now) {
      if (token !== flyToken) return;
      var t = clamp((now - t0) / DUR, 0, 1);
      var e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      s  = s0 + (targetS - s0) * e;
      tx = tx0 + (tx1 - tx0) * e;
      ty = ty0 + (ty1 - ty0) * e;
      applyTransform();
      if (t < 1) requestAnimationFrame(step);
      else if (done) done();
    }
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- gestures
  var pointers = {};   // pointerId -> {x, y}
  var nPointers = 0;
  var gesture = null;  // pan: {startX,startY,startTx,startTy,moved} | pinch: {...}

  function pointerList() {
    var out = [];
    for (var id in pointers) out.push(pointers[id]);
    return out;
  }

  stage.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { stage.setPointerCapture(e.pointerId); } catch (err) {}
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    nPointers++;
    if (nPointers === 1) {
      var slop = e.pointerType === 'touch' ? TAP_SLOP_TOUCH : TAP_SLOP;
      if (editMode) {
        // edit mode: one-finger drag draws a rectangle building (no panning)
        gesture = { mode: 'draw', moved: false, slop: slop,
                    downX: e.clientX, downY: e.clientY,
                    startMap: screenToMap(e.clientX, e.clientY) };
      } else {
        gesture = { mode: 'pan', startX: e.clientX, startY: e.clientY,
                    startTx: tx, startTy: ty, moved: false, slop: slop,
                    downX: e.clientX, downY: e.clientY };
      }
    } else if (nPointers === 2) {
      removeDrawPreview(); // a second finger cancels an in-progress rect
      var pts = pointerList();
      var dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      gesture = {
        mode: 'pinch',
        d0: Math.max(Math.hypot(dx, dy), 1),
        mid0: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        s0: s, tx0: tx, ty0: ty
      };
      flyToken++;
      userNavigated = true;
    } else {
      gesture = null; // 3+ fingers: ignore until they lift
    }
  });

  stage.addEventListener('pointermove', function (e) {
    var p = pointers[e.pointerId];
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (!gesture) return;

    if (gesture.mode === 'pan' && nPointers === 1) {
      var dx = e.clientX - gesture.startX, dy = e.clientY - gesture.startY;
      if (!gesture.moved &&
          Math.hypot(e.clientX - gesture.downX, e.clientY - gesture.downY) > (gesture.slop || TAP_SLOP)) {
        gesture.moved = true;
        flyToken++;
        userNavigated = true;
        stopFollowingLocation();   // a manual pan takes over the camera
      }
      if (gesture.moved) {
        tx = gesture.startTx + dx;
        ty = gesture.startTy + dy;
        applyTransform();
      }
    } else if (gesture.mode === 'draw' && nPointers === 1) {
      if (!gesture.moved &&
          Math.hypot(e.clientX - gesture.downX, e.clientY - gesture.downY) > (gesture.slop || TAP_SLOP)) {
        gesture.moved = true;
      }
      if (gesture.moved) updateDrawPreview(gesture.startMap, screenToMap(e.clientX, e.clientY));
    } else if (gesture.mode === 'pinch' && nPointers >= 2) {
      var pts = pointerList();
      var ddx = pts[1].x - pts[0].x, ddy = pts[1].y - pts[0].y;
      var d = Math.max(Math.hypot(ddx, ddy), 1);
      var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      var ns = clamp(gesture.s0 * d / gesture.d0, minS, maxS);
      var r = stage.getBoundingClientRect();
      // keep the map point that started under the pinch midpoint glued to it
      var lx = (gesture.mid0.x - r.left - gesture.tx0) / gesture.s0;
      var ly = (gesture.mid0.y - r.top  - gesture.ty0) / gesture.s0;
      s = ns;
      tx = (mid.x - r.left) - lx * ns;
      ty = (mid.y - r.top)  - ly * ns;
      applyTransform();
    }
  });

  function endPointer(e) {
    if (!pointers[e.pointerId]) return;
    delete pointers[e.pointerId];
    nPointers--;
    var g = gesture;
    if (nPointers === 0) {
      gesture = null;
      if (g && g.mode === 'pan' && !g.moved && e.type === 'pointerup') {
        handleTap(e.clientX, e.clientY);
      } else if (g && g.mode === 'draw') {
        removeDrawPreview();
        if (e.type === 'pointerup') {
          if (g.moved) finishDrawRect(g.startMap, screenToMap(e.clientX, e.clientY));
          else editTap(e.clientX, e.clientY);
        }
      }
    } else if (nPointers === 1) {
      if (editMode) {
        // pinch -> single finger in edit mode: do nothing until it lifts
        gesture = null;
      } else {
        // pinch -> single finger: continue as pan (never a tap)
        var rest = pointerList()[0];
        gesture = { mode: 'pan', startX: rest.x, startY: rest.y,
                    startTx: tx, startTy: ty, moved: true,
                    downX: rest.x, downY: rest.y };
      }
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    flyToken++;
    userNavigated = true;
    zoomAt(e.clientX, e.clientY, s * Math.exp(-e.deltaY * WHEEL_SENS));
  }, { passive: false });

  stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  window.addEventListener('resize', function () {
    if (!data) return;
    computeZoomLimits();
    // Until the user has panned/zoomed themselves, keep the map fitted —
    // this also fixes a fit computed before the WebView had its final size.
    if (!userNavigated) fitView();
  });

  // ---------------------------------------------------------------- tap routing
  function handleTap(cx, cy) {
    // Anything open? A tap on the map closes transient chrome first.
    hideMenu();
    hideSearchResults();

    if (calib.active) {
      calibMapTap(cx, cy);
      return;
    }
    if (routeMode) {
      routeAddVertex(cx, cy);
      return;
    }
    if (markerMode) {
      var pt = screenToMap(cx, cy);
      createMarker(pt.x, pt.y);
      return;
    }
    var elAt = document.elementFromPoint(cx, cy);
    if (elAt) {
      var pin = closestByClass(elAt, 'pin');
      if (pin) { openPinDialog(pin.getAttribute('data-mid')); return; }
      var routeHit = closestByClass(elAt, 'route-hit');
      if (routeHit) { openRouteDialog(routeHit.getAttribute('data-rid')); return; }
      var hit = closestByClass(elAt, 'hit');
      if (hit) { openColorSheet(hit.getAttribute('data-n')); return; }
    }
    closeSheet();
  }

  // .closest() with SVG in old WebViews can be finicky — walk manually.
  function closestByClass(node, cls) {
    while (node && node !== document) {
      var c = node.getAttribute && node.getAttribute('class');
      if (c && (' ' + c + ' ').indexOf(' ' + cls + ' ') >= 0) return node;
      node = node.parentNode;
    }
    return null;
  }

  // ---------------------------------------------------------------- buildings
  function polygonBBox(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var x = pts[i][0], y = pts[i][1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { w: x1 - x0, h: y1 - y0 };
  }

  function pointsAttr(b) {
    var pts = b.pts;
    if (!pts || pts.length < 3) {
      // defensive: synthesize a small square if a building has no polygon
      var r = 4;
      pts = [[b.cx - r, b.cy - r], [b.cx + r, b.cy - r], [b.cx + r, b.cy + r], [b.cx - r, b.cy + r]];
    }
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push(pts[i][0] + ',' + pts[i][1]);
    return out.join(' ');
  }

  function buildOverlay() {
    gFills.textContent = '';
    gLabels.textContent = '';
    gHits.textContent = '';
    gFx.textContent = '';
    gDetect.textContent = '';
    gPins.textContent = '';
    gRoutes.textContent = '';
    bldEls = {};
    bldByN = {};
    bldHits = {};
    if (!data || !data.buildings) return;
    for (var i = 0; i < data.buildings.length; i++) {
      var b = data.buildings[i];
      bldByN[b.n] = b;
      bldHits[b.n] = svgEl('polygon', { 'class': 'hit', points: pointsAttr(b), 'data-n': b.n }, gHits);
    }
  }

  function labelFontSize(b) {
    var bb = polygonBBox(b.pts && b.pts.length >= 3 ? b.pts
      : [[b.cx - 4, b.cy - 4], [b.cx + 4, b.cy + 4]]);
    var fs = Math.min(bb.w, bb.h) * 0.72;
    var digits = String(b.n).length;
    fs = Math.min(fs, (bb.w * 1.25) / (digits * 0.62)); // keep 3-digit numbers inside
    return clamp(fs, 2.6, 16);
  }

  function paintBuilding(n) {
    var b = bldByN[n];
    if (!b) return;
    var color = houseColors[n];
    var els = bldEls[n];
    if (!color) {
      if (els) {
        if (els.fill.parentNode) els.fill.parentNode.removeChild(els.fill);
        if (els.label.parentNode) els.label.parentNode.removeChild(els.label);
        delete bldEls[n];
      }
      return;
    }
    if (!els) {
      var fill = svgEl('polygon', { 'class': 'bld-fill', points: pointsAttr(b) }, gFills);
      var fs = labelFontSize(b);
      var label = svgEl('text', {
        'class': 'bld-label',
        x: b.cx, y: b.cy,
        dy: fs * 0.36,
        'font-size': fs,
        'stroke-width': Math.max(fs * 0.18, 0.5)
      }, gLabels);
      label.textContent = b.n;
      els = bldEls[n] = { fill: fill, label: label };
    }
    els.fill.setAttribute('fill', color);
    els.fill.setAttribute('stroke', darken(color, 0.55));
    els.fill.setAttribute('stroke-width', '0.35');
  }

  function repaintAll() {
    // remove stale fills, then paint everything saved
    for (var n in bldEls) if (!houseColors[n]) paintBuilding(n);
    for (var m in houseColors) paintBuilding(m);
  }

  // ------------------------------------------------- building editor (user maps)
  var drawRectEl = null;

  function saveBuildings() {
    if (isUserMap && data) saveJSON(storeKey('buildings'), data.buildings);
  }

  function nextBuildingNumber() {
    var max = 0;
    if (data && data.buildings) {
      for (var i = 0; i < data.buildings.length; i++) {
        var n = +data.buildings[i].n;
        if (isFinite(n) && n > max) max = n;
      }
    }
    return max + 1;
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  function updateDrawPreview(a, b) {
    if (!drawRectEl) drawRectEl = svgEl('rect', { 'class': 'draw-rect' }, gFx);
    drawRectEl.setAttribute('x', Math.min(a.x, b.x));
    drawRectEl.setAttribute('y', Math.min(a.y, b.y));
    drawRectEl.setAttribute('width', Math.abs(b.x - a.x));
    drawRectEl.setAttribute('height', Math.abs(b.y - a.y));
  }

  function removeDrawPreview() {
    if (drawRectEl && drawRectEl.parentNode) drawRectEl.parentNode.removeChild(drawRectEl);
    drawRectEl = null;
  }

  function insideMap(x, y) {
    return x >= vb.x && x <= vb.x + vb.w && y >= vb.y && y <= vb.y + vb.h;
  }

  function finishDrawRect(a, b) {
    var x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    var y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    // clamp to the map sheet, reject if fully outside
    x0 = Math.max(x0, vb.x); y0 = Math.max(y0, vb.y);
    x1 = Math.min(x1, vb.x + vb.w); y1 = Math.min(y1, vb.y + vb.h);
    var minSide = vb.w / 360;
    if (x1 - x0 < minSide || y1 - y0 < minSide) {
      toast('Drag a larger box on the map to add a building');
      return;
    }
    proposeBuilding(
      [[round1(x0), round1(y0)], [round1(x1), round1(y0)],
       [round1(x1), round1(y1)], [round1(x0), round1(y1)]],
      round1((x0 + x1) / 2), round1((y0 + y1) / 2));
  }

  function editTap(cx, cy) {
    hideMenu();
    hideSearchResults();
    var elAt = document.elementFromPoint(cx, cy);
    var pin = elAt && closestByClass(elAt, 'pin');
    if (pin) { openPinDialog(pin.getAttribute('data-mid')); return; }
    var hit = elAt && closestByClass(elAt, 'hit');
    if (hit) { openEditBuildingDialog(hit.getAttribute('data-n')); return; }
    var pt = screenToMap(cx, cy);
    if (!insideMap(pt.x, pt.y)) { toast('Tap on the map itself to add a building'); return; }
    var half = vb.w / 180;  // tap-placed square, side = viewBox width / 90
    proposeBuilding(
      [[round1(pt.x - half), round1(pt.y - half)], [round1(pt.x + half), round1(pt.y - half)],
       [round1(pt.x + half), round1(pt.y + half)], [round1(pt.x - half), round1(pt.y + half)]],
      round1(pt.x), round1(pt.y));
  }

  // Ask for the building number (prefilled), validate, then create.
  function proposeBuilding(pts, cx, cy) {
    promptBuildingNumber('Add building', String(nextBuildingNumber()), null, function (n) {
      var b = { n: n, cx: cx, cy: cy, pts: pts };
      data.buildings.push(b);
      bldByN[n] = b;
      bldHits[n] = svgEl('polygon', { 'class': 'hit', points: pointsAttr(b), 'data-n': n }, gHits);
      saveBuildings();
      toast('Building ' + n + ' added');
    });
  }

  // Shared number prompt with duplicate/format validation; re-opens on bad input.
  function promptBuildingNumber(title, prefill, allowN, cb) {
    showDialog({
      title: title,
      input: { value: prefill, placeholder: 'Building number', numeric: true },
      buttons: [
        { text: 'Cancel' },
        { text: 'Save', primary: true, onTap: function (val) {
            var n = parseInt(String(val).trim(), 10);
            if (!isFinite(n) || n < 1 || String(n) !== String(val).trim()) {
              toast('Enter a whole number (1 or higher)');
              promptBuildingNumber(title, String(val), allowN, cb);
              return;
            }
            if (bldByN[n] && n !== allowN) {
              toast('Number ' + n + ' is already used');
              promptBuildingNumber(title, String(n), allowN, cb);
              return;
            }
            cb(n);
          } }
      ]
    });
  }

  function openEditBuildingDialog(nStr) {
    var n = +nStr;
    if (!bldByN[n]) return;
    showDialog({
      title: 'Building ' + n,
      message: 'Edit this building.',
      buttons: [
        { text: 'Delete', danger: true, onTap: function () {
            showDialog({
              title: 'Delete building ' + n + '?',
              message: 'Its color is removed too.',
              buttons: [
                { text: 'Cancel' },
                { text: 'Delete', primary: true, danger: true,
                  onTap: function () { deleteBuilding(n); } }
              ]
            });
          } },
        { text: 'Renumber', onTap: function () {
            promptBuildingNumber('Renumber building ' + n, String(n), n, function (newN) {
              renumberBuilding(n, newN);
            });
          } },
        { text: 'Close', primary: true }
      ]
    });
  }

  function deleteBuilding(n) {
    for (var i = 0; i < data.buildings.length; i++) {
      if (+data.buildings[i].n === n) { data.buildings.splice(i, 1); break; }
    }
    delete houseColors[n];
    paintBuilding(n);          // removes fill + label
    var hit = bldHits[n];
    if (hit && hit.parentNode) hit.parentNode.removeChild(hit);
    delete bldHits[n];
    delete bldByN[n];
    saveBuildings();
    saveColors();
    renderLegend();
    toast('Building ' + n + ' deleted');
  }

  function renumberBuilding(oldN, newN) {
    if (oldN === newN) return;
    var b = bldByN[oldN];
    if (!b) return;
    b.n = newN;
    bldByN[newN] = b; delete bldByN[oldN];
    var hit = bldHits[oldN];
    if (hit) { hit.setAttribute('data-n', newN); bldHits[newN] = hit; delete bldHits[oldN]; }
    if (houseColors[oldN]) { houseColors[newN] = houseColors[oldN]; }
    delete houseColors[oldN];
    // rebuild fill/label so the label text + size match the new number
    var els = bldEls[oldN];
    if (els) {
      if (els.fill.parentNode) els.fill.parentNode.removeChild(els.fill);
      if (els.label.parentNode) els.label.parentNode.removeChild(els.label);
      delete bldEls[oldN];
    }
    paintBuilding(newN);
    saveBuildings();
    saveColors();
    renderLegend();
    toast('Building renumbered to ' + newN);
  }

  function setEditMode(on) {
    if (on && !isUserMap) return;
    if (on && markerMode) setMarkerMode(false);
    editMode = on;
    $('editBtn').classList.toggle('active', on);
    $('detectBtn').hidden = !on || !isUserMap;
    $('editHint').hidden = !on;
    stage.classList.toggle('editing', on);
    if (!on) { removeDrawPreview(); clearDetectPreview(); }
    if (on) closeSheet();
  }

  $('editBtn').addEventListener('click', function () {
    if (!data || !isUserMap) return;
    setEditMode(!editMode);
  });

  // ------------------------------------- auto-detect buildings (user maps only)
  // Scans the base image for compact, consistently-colored blobs the size and
  // shape of building footprints. All tunables live here.
  var DETECT = {
    maxEdge: 1400,      // detection resolution: long edge capped to this
    borderBand: 3,      // px frame sampled to estimate the background color
    borderShare: 0.15,  // a border bin must hold this share of border px to count
    bgDist: 40,         // rgb distance below which a color counts as background
    nestDrop: 0.45,     // drop a rect when this fraction of it lies inside a bigger one
    groupDist: 48,      // rgb distance for merging quantized bins into one group
    maxGroups: 12,      // candidate color groups examined
    minSide: 4,         // px at detection resolution
    maxSideFrac: 0.14,  // of the long edge (large schools/stores are ~0.13)
    minFill: 0.5,       // blob area / bbox area (tolerates number glyphs punched out)
    maxAspect: 6,
    minScoreFrac: 0.4,  // secondary color groups kept at >= this * best group score
    iouDrop: 0.3,       // detection dropped when overlapping an existing building
    cap: 1500
  };

  function binColor(bin) {
    return [((bin >> 8) & 15) * 16 + 8, ((bin >> 4) & 15) * 16 + 8, (bin & 15) * 16 + 8];
  }
  function rgbDist(a, b) {
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  }

  // One-pixel dilate then erode (4-neighbour) to bridge number glyphs and
  // JPEG speckle that punch holes in building interiors.
  function morphClose(mask, w, h) {
    var i, x, y, out = new Uint8Array(mask.length);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      if (mask[i] ||
          (x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) ||
          (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) out[i] = 1;
    }
    var res = new Uint8Array(mask.length);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      if (out[i] &&
          (x === 0 || out[i - 1]) && (x === w - 1 || out[i + 1]) &&
          (y === 0 || out[i - w]) && (y === h - 1 || out[i + w])) res[i] = 1;
    }
    return res;
  }

  // Connected components on a binary mask; returns building-like blobs only.
  function maskBlobs(mask, w, h) {
    var seen = new Uint8Array(mask.length);
    var stack = new Int32Array(mask.length);
    var blobs = [];
    var maxSide = Math.max(w, h) * DETECT.maxSideFrac;
    for (var start = 0; start < mask.length; start++) {
      if (!mask[start] || seen[start]) continue;
      var top = 0;
      stack[top++] = start; seen[start] = 1;
      var area = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
      while (top > 0) {
        var i = stack[--top];
        var x = i % w, y = (i / w) | 0;
        area++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
        if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
        if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[top++] = i - w; }
        if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[top++] = i + w; }
      }
      var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      var side = Math.min(bw, bh), big = Math.max(bw, bh);
      var fill = area / (bw * bh);
      // L/T-shaped footprints (schools, stores) fill little of their bbox —
      // allow lower fill for large, non-elongated blobs
      var fillOK = fill >= DETECT.minFill ||
                   (big >= Math.max(w, h) * 0.05 && fill >= 0.33 && big / side <= 3.5);
      if (side >= DETECT.minSide && big <= maxSide && fillOK &&
          big / side <= DETECT.maxAspect) {
        blobs.push({ x0: x0, y0: y0, x1: x1, y1: y1 });
      }
    }
    return blobs;
  }

  // Full pipeline: image -> candidate rects in detection-pixel space.
  function detectBlobsInImage(img) {
    var k = DETECT.maxEdge / Math.max(vb.w, vb.h);
    if (k > 1) k = 1;
    var w = Math.max(1, Math.round(vb.w * k)), h = Math.max(1, Math.round(vb.h * k));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    var px = ctx.getImageData(0, 0, w, h).data;

    // quantize to 4 bits/channel: 4096 bins
    var N = w * h;
    var bins = new Int16Array(N);
    var hist = new Int32Array(4096);
    for (var i = 0; i < N; i++) {
      var bin = ((px[i * 4] & 240) << 4) | (px[i * 4 + 1] & 240) | (px[i * 4 + 2] >> 4);
      bins[i] = bin; hist[bin]++;
    }

    // background = colors dominant in the border frame
    var bHist = new Int32Array(4096);
    var band = DETECT.borderBand, x, y;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      if (y < band || y >= h - band || x < band || x >= w - band) bHist[bins[y * w + x]]++;
    }
    var borderTotal = 0;
    for (var bt0 = 0; bt0 < 4096; bt0++) borderTotal += bHist[bt0];
    var borderTop = [];
    for (var pass = 0; pass < 3; pass++) {
      var bi = -1, bc = 0;
      for (var b2 = 0; b2 < 4096; b2++) {
        if (bHist[b2] > bc && borderTop.indexOf(b2) < 0) { bc = bHist[b2]; bi = b2; }
      }
      // ignore minor bins (JPEG ringing, roads clipped at the crop edge) —
      // they bridge background toward building colors and poison the test
      if (bi >= 0 && bc >= borderTotal * DETECT.borderShare) borderTop.push(bi);
    }
    var isBg = new Uint8Array(4096);
    for (var b3 = 0; b3 < 4096; b3++) {
      if (!hist[b3]) continue;
      for (var t = 0; t < borderTop.length; t++) {
        if (rgbDist(binColor(b3), binColor(borderTop[t])) <= DETECT.bgDist) { isBg[b3] = 1; break; }
      }
    }

    // candidate color groups: dominant non-background bins, merged by similarity
    var order = [];
    for (var b4 = 0; b4 < 4096; b4++) {
      if (hist[b4] >= 16 && !isBg[b4] && hist[b4] < N * 0.6) order.push(b4);
    }
    order.sort(function (a, b) { return hist[b] - hist[a]; });
    var claimed = new Uint8Array(4096);
    var groups = [];
    for (var oi = 0; oi < order.length && groups.length < DETECT.maxGroups; oi++) {
      var seed = order[oi];
      if (claimed[seed]) continue;
      var members = new Uint8Array(4096);
      for (var oj = oi; oj < order.length; oj++) {
        var cand = order[oj];
        if (!claimed[cand] && rgbDist(binColor(seed), binColor(cand)) <= DETECT.groupDist) {
          claimed[cand] = 1; members[cand] = 1;
        }
      }
      groups.push(members);
    }

    // score each group by how many building-like blobs it produces
    var results = [];
    for (var gi = 0; gi < groups.length; gi++) {
      var mask = new Uint8Array(N);
      for (var mi = 0; mi < N; mi++) if (groups[gi][bins[mi]]) mask[mi] = 1;
      var blobs = maskBlobs(morphClose(mask, w, h), w, h);
      results.push(blobs);
    }
    var best = 0;
    for (var ri = 0; ri < results.length; ri++) if (results[ri].length > best) best = results[ri].length;
    var rects = [];
    for (var rj = 0; rj < results.length; rj++) {
      if (results[rj].length >= Math.max(1, best * DETECT.minScoreFrac)) {
        rects = rects.concat(results[rj]);
      }
    }
    if (window.__detectDebug) {
      window.__detectDebug.last = {
        w: w, h: h, borderTop: borderTop.map(binColor),
        groups: groups.length,
        groupStats: results.map(function (r, gi2) {
          var m = null;
          for (var s2 = 0; s2 < 4096; s2++) if (groups[gi2][s2]) { m = binColor(s2); break; }
        return { firstColor: m, blobs: r.length };
        }),
        best: best, kept: rects.length
      };
    }
    return { rects: rects, detW: w, detH: h };
  }

  function bboxOfBuilding(b) {
    var pts = (b.pts && b.pts.length >= 3) ? b.pts
      : [[b.cx - 4, b.cy - 4], [b.cx + 4, b.cy + 4]];
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      var x = +pts[i][0], y = +pts[i][1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  function iou(a, b) {
    var ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    var iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (ix <= 0 || iy <= 0) return 0;
    var inter = ix * iy;
    var ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
    return ua > 0 ? inter / ua : 0;
  }

  // rows north->south, west->east within each row (same convention as the
  // Unalakleet sheet); row breaks at 0.8 * median blob height
  function sortReadingOrder(list) {
    if (!list.length) return list;
    var hs = list.map(function (r) { return r.y1 - r.y0; }).sort(function (a, b) { return a - b; });
    var mh = hs[(hs.length / 2) | 0] || 1;
    list.sort(function (a, b) { return (a.y0 + a.y1) - (b.y0 + b.y1); });
    var rows = [], row = null, rowCy = -1e9;
    for (var i = 0; i < list.length; i++) {
      var cy = (list[i].y0 + list[i].y1) / 2;
      if (cy - rowCy > mh * 0.8) { row = []; rows.push(row); rowCy = cy; }
      else rowCy = (rowCy + cy) / 2;
      row.push(list[i]);
    }
    var out = [];
    for (var r = 0; r < rows.length; r++) {
      rows[r].sort(function (a, b) { return (a.x0 + a.x1) - (b.x0 + b.x1); });
      out = out.concat(rows[r]);
    }
    return out;
  }

  var detectPreviewRects = null;

  function clearDetectPreview() {
    gDetect.textContent = '';
    detectPreviewRects = null;
  }

  function runDetect() {
    if (!isUserMap || !data || !data.baseImage) return;
    clearDetectPreview();
    showBusy('Scanning map for buildings…');
    var img = new Image();
    img.onerror = function () {
      hideBusy();
      uploadError('The map image could not be re-read for scanning.');
    };
    img.onload = function () {
      setTimeout(function () {   // let the busy overlay paint first
        var found;
        try { found = detectBlobsInImage(img); }
        catch (e) {
          hideBusy();
          uploadError('Scanning failed: ' + e.message);
          return;
        }
        hideBusy();
        // detection px -> map coords
        var kx = vb.w / found.detW, ky = vb.h / found.detH;
        var rects = [];
        for (var i = 0; i < found.rects.length; i++) {
          var r = found.rects[i];
          rects.push({
            x0: vb.x + r.x0 * kx, y0: vb.y + r.y0 * ky,
            x1: vb.x + (r.x1 + 1) * kx, y1: vb.y + (r.y1 + 1) * ky
          });
        }
        // drop rects mostly nested inside a bigger one: number glyphs printed
        // on buildings, and the same building found via both fill and outline
        rects.sort(function (a, b) {
          return (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0);
        });
        var keptRects = [];
        for (var di = 0; di < rects.length; di++) {
          var dr = rects[di], nested = false;
          var da = (dr.x1 - dr.x0) * (dr.y1 - dr.y0);
          for (var dj = 0; dj < keptRects.length; dj++) {
            var kr = keptRects[dj];
            var iw = Math.min(dr.x1, kr.x1) - Math.max(dr.x0, kr.x0);
            var ih = Math.min(dr.y1, kr.y1) - Math.max(dr.y0, kr.y0);
            if (iw > 0 && ih > 0 && (iw * ih) / da >= DETECT.nestDrop) { nested = true; break; }
          }
          if (!nested) keptRects.push(dr);
        }
        rects = keptRects;

        // drop detections that overlap existing buildings
        var existing = data.buildings.map(bboxOfBuilding);
        rects = rects.filter(function (r) {
          var cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
          for (var j = 0; j < existing.length; j++) {
            var e = existing[j];
            if ((cx >= e.x0 && cx <= e.x1 && cy >= e.y0 && cy <= e.y1) ||
                iou(r, e) > DETECT.iouDrop) return false;
          }
          return true;
        });
        if (!rects.length) {
          showDialog({
            title: 'No buildings found',
            message: 'Nothing on this map looked like a building footprint (or everything found is already added). You can add buildings by hand in edit mode: tap to place one, drag to draw one.',
            buttons: [{ text: 'OK', primary: true }]
          });
          return;
        }
        if (rects.length > DETECT.cap) {
          showDialog({
            title: 'Too many shapes found',
            message: 'The scan found ' + rects.length + ' possible buildings, which looks wrong for this image. Try a cleaner map image, or add buildings by hand in edit mode.',
            buttons: [{ text: 'OK', primary: true }]
          });
          return;
        }
        rects = sortReadingOrder(rects);
        showDetectPreview(rects);
      }, 30);
    };
    img.src = data.baseImage;
  }

  function showDetectPreview(rects) {
    detectPreviewRects = rects;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      svgEl('rect', {
        'class': 'detect-preview',
        x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0,
        'vector-effect': 'non-scaling-stroke'
      }, gDetect);
    }
    showDialog({
      title: 'Found ' + rects.length + ' building' + (rects.length === 1 ? '' : 's'),
      message: 'The dashed boxes show what was detected. Add them as numbered buildings? You can fix mistakes afterwards in edit mode: tap a building to renumber or delete it, drag to draw one that was missed.',
      buttons: [
        { text: 'Cancel', onTap: clearDetectPreview },
        { text: 'Add ' + rects.length, primary: true, onTap: commitDetected }
      ]
    });
  }

  function commitDetected() {
    var rects = detectPreviewRects || [];
    var n = nextBuildingNumber();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var b = {
        n: n, cx: round1((r.x0 + r.x1) / 2), cy: round1((r.y0 + r.y1) / 2),
        pts: [[round1(r.x0), round1(r.y0)], [round1(r.x1), round1(r.y0)],
              [round1(r.x1), round1(r.y1)], [round1(r.x0), round1(r.y1)]]
      };
      data.buildings.push(b);
      bldByN[n] = b;
      bldHits[n] = svgEl('polygon', { 'class': 'hit', points: pointsAttr(b), 'data-n': n }, gHits);
      n++;
    }
    clearDetectPreview();
    saveBuildings();
    toast('Added ' + rects.length + ' buildings — use edit mode to fix any mistakes');
  }

  function offerDetect() {
    showDialog({
      title: 'Detect buildings automatically?',
      message: 'Surveyor can scan this map image for building-shaped marks and number them for you (top row first, left to right). You can correct mistakes afterwards.',
      buttons: [
        { text: 'Skip' },
        { text: 'Detect', primary: true, onTap: runDetect }
      ]
    });
  }

  $('detectBtn').addEventListener('click', function () {
    if (editMode && isUserMap) runDetect();
  });

  // ---------------------------------------------------------------- color sheet
  var sheetN = null;

  function buildPalette() {
    var pal = $('palette');
    pal.textContent = '';
    for (var i = 0; i < PALETTE.length; i++) {
      (function (color) {
        var btn = document.createElement('button');
        btn.className = 'swatch';
        btn.style.background = color;
        btn.setAttribute('data-color', color);
        btn.setAttribute('aria-label', 'Color ' + color);
        btn.addEventListener('click', function () { applyColor(sheetN, color); });
        pal.appendChild(btn);
      })(PALETTE[i]);
    }
  }

  function saveAddrs() { saveJSON(storeKey('addrs'), addrs); }

  // user override wins; builtin data (from OSM/official sources) as fallback
  function effectiveAddr(n) {
    if (addrs[n]) return addrs[n];
    var b = bldByN[n];
    return (b && b.addr) ? String(b.addr) : '';
  }

  function refreshSheetAddr() {
    if (sheetN == null) return;
    var addr = effectiveAddr(sheetN);
    var el = $('sheetAddr');
    el.textContent = addr || 'No address recorded';
    el.className = addr ? '' : 'no-addr';
    $('editAddrBtn').textContent = addr ? 'Edit' : 'Add';
  }

  $('editAddrBtn').addEventListener('click', function () {
    if (sheetN == null) return;
    var n = sheetN;
    showDialog({
      title: 'Address of building ' + n,
      input: { value: effectiveAddr(n), placeholder: 'e.g. 23 Beach Road' },
      buttons: [
        { text: 'Cancel' },
        { text: 'Save', primary: true, onTap: function (val) {
            var v = String(val || '').trim();
            if (v) addrs[n] = v;
            else delete addrs[n];   // empty clears the override -> builtin
            saveAddrs();
            refreshSheetAddr();
          } }
      ]
    });
  });

  function openColorSheet(n) {
    sheetN = String(n);
    $('sheetTitle').textContent = 'Building ' + n;
    refreshSheetAddr();
    var current = houseColors[sheetN] || null;
    var btns = $('palette').children;
    for (var i = 0; i < btns.length; i++) {
      btns[i].className = 'swatch' +
        (btns[i].getAttribute('data-color') === current ? ' selected' : '');
    }
    if (current) $('customColor').value = current;
    $('clearColorBtn').style.visibility = current ? 'visible' : 'hidden';
    $('colorSheet').hidden = false;
    $('sheetScrim').hidden = false;
  }

  function closeSheet() {
    sheetN = null;
    $('colorSheet').hidden = true;
    $('sheetScrim').hidden = true;
  }

  function applyColor(n, color) {
    if (n == null) return;
    color = normHex(color);
    if (!color) return;
    houseColors[n] = color;
    paintBuilding(n);
    ensureLegendEntry(color);
    saveColors();
    renderLegend();
    closeSheet();
  }

  function clearColor(n) {
    if (n == null) return;
    delete houseColors[n];
    paintBuilding(n);
    saveColors();
    renderLegend();
    closeSheet();
  }

  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetScrim').addEventListener('click', closeSheet);
  $('clearColorBtn').addEventListener('click', function () { clearColor(sheetN); });
  $('customColor').addEventListener('change', function () {
    applyColor(sheetN, this.value);
  });
  // v1.7: RGB wheel replaces the native slider picker when available. Capture
  // phase so the label's default input-open never fires.
  $('customColorLbl').addEventListener('click', function (ev) {
    if (!(window.ColorWheel && window.ColorWheel.open)) return; // native fallback
    ev.preventDefault();
    ev.stopPropagation();
    var n = sheetN;
    var current = (n != null && houseColors[n]) || '#0ea5e9';
    window.ColorWheel.open({
      initial: current,
      onPick: function (hex) { applyColor(n, hex); },
      onCancel: function () {}
    });
  }, true);

  // ---------------------------------------------------------------- legend
  function ensureLegendEntry(color) {
    for (var i = 0; i < legendEntries.length; i++) {
      if (legendEntries[i].color === color) return;
    }
    legendEntries.push({ color: color, label: '' });
    saveLegend();
  }

  function legendCounts() {
    var counts = {};
    for (var n in houseColors) {
      counts[houseColors[n]] = (counts[houseColors[n]] || 0) + 1;
    }
    return counts;
  }

  function renderLegend() {
    var counts = legendCounts();

    // make sure every in-use color has an entry (e.g. restored from storage)
    for (var c in counts) ensureLegendEntry(c);

    // drop entries with zero houses AND no user label
    var kept = [];
    for (var i = 0; i < legendEntries.length; i++) {
      var e = legendEntries[i];
      if ((counts[e.color] || 0) > 0 || e.label.trim() !== '') kept.push(e);
    }
    if (kept.length !== legendEntries.length) {
      legendEntries = kept;
      saveLegend();
    }

    var legend = $('legend'), body = $('legendBody'), sw = $('legendSwatches');
    if (legendEntries.length === 0) {
      legend.hidden = true;
      body.textContent = '';
      sw.textContent = '';
      return;
    }
    legend.hidden = false;

    sw.textContent = '';
    for (var j = 0; j < Math.min(legendEntries.length, 4); j++) {
      var dot = document.createElement('i');
      dot.style.background = legendEntries[j].color;
      sw.appendChild(dot);
    }

    body.textContent = '';
    for (var k = 0; k < legendEntries.length; k++) {
      (function (entry) {
        var row = document.createElement('div');
        row.className = 'legend-row';

        var chip = document.createElement('span');
        chip.className = 'legend-color';
        chip.style.background = entry.color;

        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'legend-label';
        input.placeholder = 'Label…';
        input.value = entry.label;
        input.maxLength = 40;
        input.addEventListener('input', function () {
          entry.label = input.value;
          saveLegend();
        });
        input.addEventListener('blur', function () {
          // prune if it emptied out and nothing uses the color anymore
          if (entry.label.trim() === '' && !(legendCounts()[entry.color] > 0)) {
            renderLegend();
          }
        });
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') input.blur();
        });

        var count = document.createElement('span');
        count.className = 'legend-count';
        count.textContent = counts[entry.color] || 0;

        row.appendChild(chip);
        row.appendChild(input);
        row.appendChild(count);
        body.appendChild(row);
      })(legendEntries[k]);
    }
  }

  $('legendHeader').addEventListener('click', function () {
    var lg = $('legend');
    lg.classList.toggle('collapsed');
    this.setAttribute('aria-expanded', lg.classList.contains('collapsed') ? 'false' : 'true');
  });

  // ---------------------------------------------------------------- markers
  function pinById(id) {
    for (var i = 0; i < markers.length; i++) if (markers[i].id === id) return markers[i];
    return null;
  }

  function renderPin(m) {
    var old = pinEls[m.id];
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var g = svgEl('g', { 'class': 'pin', 'data-mid': m.id }, gPins);
    // ~PIN_SIZE px tall at any zoom; tip sits at the marker point
    svgEl('path', {
      'class': 'pin-body',
      d: 'M0 0 C -3.4 -8 -10.5 -12.2 -10.5 -22.5 A 10.5 10.5 0 1 1 10.5 -22.5 C 10.5 -12.2 3.4 -8 0 0 Z'
    }, g);
    svgEl('circle', { 'class': 'pin-dot', cx: 0, cy: -22.5, r: 4 }, g);
    g.setAttribute('transform', 'translate(' + m.x + ' ' + m.y + ') scale(' + (1 / s) + ')');
    pinEls[m.id] = g;
  }

  function renderAllPins() {
    gPins.textContent = '';
    pinEls = {};
    for (var i = 0; i < markers.length; i++) renderPin(markers[i]);
  }

  function createMarker(x, y) {
    var m = { id: 'm' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
              x: x, y: y, label: '' };
    markers.push(m);
    renderPin(m);
    setMarkerMode(false);
    showDialog({
      title: 'New marker',
      input: { value: '', placeholder: 'Label (e.g. "Locked gate")' },
      buttons: [
        { text: 'Cancel', onTap: function () {   // cancel = remove the pin
            removeMarker(m.id, true);
          } },
        { text: 'Save', primary: true, onTap: function (val) {
            m.label = val.trim() || 'Marker';
            saveMarkers();
          } }
      ]
    });
  }

  function removeMarker(id, skipSave) {
    for (var i = 0; i < markers.length; i++) {
      if (markers[i].id === id) { markers.splice(i, 1); break; }
    }
    var g = pinEls[id];
    if (g && g.parentNode) g.parentNode.removeChild(g);
    delete pinEls[id];
    if (!skipSave) saveMarkers();
  }

  function openPinDialog(id) {
    var m = pinById(id);
    if (!m) return;
    showDialog({
      title: m.label || 'Marker',
      buttons: [
        { text: 'Delete', danger: true, onTap: function () {
            showDialog({
              title: 'Delete marker?',
              message: '“' + (m.label || 'Marker') + '” will be removed.',
              buttons: [
                { text: 'Cancel' },
                { text: 'Delete', primary: true, danger: true,
                  onTap: function () { removeMarker(id); } }
              ]
            });
          } },
        { text: 'Rename', onTap: function () {
            showDialog({
              title: 'Rename marker',
              input: { value: m.label, placeholder: 'Label' },
              buttons: [
                { text: 'Cancel' },
                { text: 'Save', primary: true, onTap: function (val) {
                    m.label = val.trim() || m.label;
                    saveMarkers();
                  } }
              ]
            });
          } },
        { text: 'Close', primary: true }
      ]
    });
  }

  function setMarkerMode(on) {
    if (on && editMode) setEditMode(false);
    markerMode = on;
    $('markerBtn').classList.toggle('active', on);
    $('markerHint').hidden = !on;
    stage.classList.toggle('marker-mode', on);
  }

  $('markerBtn').addEventListener('click', function () {
    if (!data) return;
    setMarkerMode(!markerMode);
  });

  // ---------------------------------------------------------------- modal
  function showDialog(opts) {
    var scrim = $('modalScrim'), title = $('modalTitle'), msg = $('modalMsg'),
        input = $('modalInput'), btns = $('modalBtns');
    title.textContent = opts.title || '';
    if (opts.message) { msg.textContent = opts.message; msg.hidden = false; }
    else msg.hidden = true;
    if (opts.input) {
      input.hidden = false;
      input.value = opts.input.value || '';
      input.placeholder = opts.input.placeholder || '';
      if (opts.input.numeric) input.setAttribute('inputmode', 'numeric');
      else input.removeAttribute('inputmode');
    } else input.hidden = true;

    btns.textContent = '';
    var primaryAction = null;
    function close() { scrim.hidden = true; }
    for (var i = 0; i < opts.buttons.length; i++) {
      (function (spec) {
        var b = document.createElement('button');
        b.textContent = spec.text;
        if (spec.primary) b.classList.add('primary');
        if (spec.danger) b.classList.add('danger');
        var act = function () {
          close();
          if (spec.onTap) spec.onTap(input.hidden ? undefined : input.value);
        };
        if (spec.primary) primaryAction = act;
        b.addEventListener('click', act);
        btns.appendChild(b);
      })(opts.buttons[i]);
    }
    input.onkeydown = function (ev) {
      if (ev.key === 'Enter' && primaryAction) primaryAction();
    };
    scrim.hidden = false;
    if (opts.input) setTimeout(function () { input.focus(); input.select(); }, 60);
  }

  $('modalScrim').addEventListener('click', function (e) {
    if (e.target === this) this.hidden = true;
  });

  // ---------------------------------------------------------------- search
  var searchInput = $('searchInput'), searchResults = $('searchResults');

  function hideSearchResults() { searchResults.hidden = true; }

  function runSearch(q) {
    searchResults.textContent = '';
    q = q.trim();
    if (!q) { hideSearchResults(); return; }
    if (!data) {
      addNoResult('No map loaded');
      searchResults.hidden = false;
      return;
    }

    var out = [];
    if (/^\d+$/.test(q)) {
      var nums = [];
      for (var n in bldByN) if (String(n).indexOf(q) === 0) nums.push(+n);
      nums.sort(function (a, b) { return a - b; });
      for (var i = 0; i < Math.min(nums.length, 8); i++) {
        out.push({ kind: 'building', n: nums[i] });
      }
    }
    var lq = q.toLowerCase();
    // addresses: user overrides + builtin, substring match (also for numeric
    // queries — "23" should surface "23 Beach Road" alongside building 23)
    var seen = {};
    for (var i2 = 0; i2 < out.length; i2++) if (out[i2].n != null) seen[out[i2].n] = true;
    for (var an in bldByN) {
      if (out.length >= 10) break;
      if (seen[an]) continue;
      var addr = effectiveAddr(an);
      if (addr && addr.toLowerCase().indexOf(lq) >= 0) {
        out.push({ kind: 'building', n: +an, addr: addr, byAddr: true });
        seen[an] = true;
      }
    }
    var lms = (data.landmarks || []);
    for (var j = 0; j < lms.length && out.length < 12; j++) {
      if (String(lms[j].label || '').toLowerCase().indexOf(lq) >= 0) {
        out.push({ kind: 'landmark', lm: lms[j] });
      }
    }

    if (out.length === 0) {
      addNoResult('No matches for “' + q + '”');
    } else {
      for (var k = 0; k < out.length; k++) addResult(out[k]);
    }
    searchResults.hidden = false;
  }

  function addNoResult(text) {
    var d = document.createElement('div');
    d.className = 'result-none';
    d.textContent = text;
    searchResults.appendChild(d);
  }

  function addResult(r) {
    var b = document.createElement('button');
    b.className = 'result-item' + (r.kind === 'landmark' ? ' landmark' : '');
    var iconTxt = r.kind === 'landmark' ? '★' : '#';
    var labelTxt, subTxt = '';
    if (r.kind === 'landmark') {
      labelTxt = String(r.lm.label);
    } else if (r.byAddr) {
      labelTxt = r.addr;                       // matched by address: lead with it
      subTxt = 'Building ' + r.n;
    } else {
      labelTxt = 'Building ' + r.n;
      subTxt = effectiveAddr(r.n);
    }
    b.innerHTML = '<span class="r-icon">' + iconTxt + '</span><span>' +
                  escapeHtml(labelTxt) +
                  (subTxt ? '<span class="r-sub">' + escapeHtml(subTxt) + '</span>' : '') +
                  '</span>';
    b.addEventListener('click', function () {
      hideSearchResults();
      searchInput.blur();
      if (r.kind === 'building') jumpToBuilding(r.n);
      else jumpToPoint(r.lm.x, r.lm.y, fitWholeS * 10);
    });
    searchResults.appendChild(b);
  }

  function jumpToBuilding(n) {
    var b = bldByN[n];
    if (!b) { toast('Building ' + n + ' not found'); return; }
    var bb = polygonBBox(b.pts && b.pts.length >= 3 ? b.pts
      : [[b.cx - 4, b.cy - 4], [b.cx + 4, b.cy + 4]]);
    var size = Math.max(bb.w, bb.h, 4);
    jumpToPoint(b.cx, b.cy, clamp(64 / size, fitWholeS * 6, maxS * 0.85));
  }

  function jumpToPoint(x, y, targetS) {
    flyTo(x, y, targetS, function () { pulseAt(x, y); });
  }

  function pulseAt(x, y) {
    gFx.textContent = '';
    var g = svgEl('g', { 'data-x': x, 'data-y': y }, gFx);
    svgEl('circle', { 'class': 'pulse-core', cx: 0, cy: 0, r: 5 }, g);
    svgEl('circle', { 'class': 'pulse-ring', cx: 0, cy: 0, r: 10 }, g);
    g.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + (1 / s) + ')');
    setTimeout(function () {
      if (g.parentNode) g.parentNode.removeChild(g);
    }, 3600);
  }

  searchInput.addEventListener('input', function () {
    $('searchClear').hidden = this.value === '';
    runSearch(this.value);
  });
  searchInput.addEventListener('focus', function () {
    if (this.value.trim()) runSearch(this.value);
  });
  $('searchClear').addEventListener('click', function () {
    searchInput.value = '';
    this.hidden = true;
    hideSearchResults();
    searchInput.focus();
  });

  // ---------------------------------------------------------------- menu
  function hideMenu() { $('menuDropdown').hidden = true; }
  $('menuBtn').addEventListener('click', function (e) {
    e.stopPropagation();
    var dd = $('menuDropdown');
    dd.hidden = !dd.hidden;
  });
  document.addEventListener('click', function (e) {
    if (!$('menuDropdown').hidden &&
        e.target !== $('menuBtn') && !$('menuDropdown').contains(e.target)) {
      hideMenu();
    }
    if (!searchResults.hidden && !$('searchWrap').contains(e.target)) {
      hideSearchResults();
    }
  });

  $('resetDataBtn').addEventListener('click', function () {
    hideMenu();
    if (!community) return;
    showDialog({
      title: 'Reset ' + community.name + '?',
      message: 'All house colors, legend labels, markers, and routes for this community will be permanently deleted.',
      buttons: [
        { text: 'Cancel' },
        { text: 'Reset', primary: true, danger: true, onTap: function () {
            try {
              localStorage.removeItem(storeKey('colors'));
              localStorage.removeItem(storeKey('legend'));
              localStorage.removeItem(storeKey('markers'));
              localStorage.removeItem(storeKey('routes'));
            } catch (err) {}
            houseColors = {}; legendEntries = []; markers = []; routes = [];
            renderRoutes();
            repaintAll();
            gFills.textContent = ''; gLabels.textContent = ''; bldEls = {};
            renderAllPins();
            renderLegend();
            toast('Community data reset');
          } }
      ]
    });
  });

  // ---------------------------------------------------------------- zoom buttons
  $('zoomInBtn').addEventListener('click', function () {
    var sz = stageSize();
    flyToken++;
    userNavigated = true;
    zoomAt(stage.getBoundingClientRect().left + sz.w / 2,
           stage.getBoundingClientRect().top + sz.h / 2, s * 1.6);
  });
  $('zoomOutBtn').addEventListener('click', function () {
    var sz = stageSize();
    flyToken++;
    userNavigated = true;
    zoomAt(stage.getBoundingClientRect().left + sz.w / 2,
           stage.getBoundingClientRect().top + sz.h / 2, s / 1.6);
  });
  $('fitBtn').addEventListener('click', function () { if (data) fitView(); });

  // ---------------------------------------------------------------- busy overlay
  function showBusy(text) {
    $('busyText').textContent = text || 'Working…';
    $('busy').hidden = false;
  }
  function hideBusy() { $('busy').hidden = true; }

  // ---------------------------------------------------------------- community
  var ADD_MAP_VALUE = '__addmap__';

  function builtins() { return window.COMMUNITIES || []; }

  function findCommunity(id) {
    var list = builtins();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    var um = userMapById(id);
    if (um) return { id: um.id, name: um.name, user: true, entry: um };
    return null;
  }

  function rebuildCommunitySelect() {
    var sel = $('communitySelect');
    sel.textContent = '';
    var list = builtins(), i, opt;
    for (i = 0; i < list.length; i++) {
      opt = document.createElement('option');
      opt.value = list[i].id;
      opt.textContent = list[i].name;
      sel.appendChild(opt);
    }
    for (i = 0; i < userMaps.length; i++) {   // user maps below built-ins
      opt = document.createElement('option');
      opt.value = userMaps[i].id;
      opt.textContent = userMaps[i].name;
      sel.appendChild(opt);
    }
    opt = document.createElement('option');
    opt.value = ADD_MAP_VALUE;
    opt.textContent = '+ Add map…';
    sel.appendChild(opt);
    if (community) sel.value = community.id;
  }

  function showEmptyState(msg) {
    data = null;
    isUserMap = false;
    setEditMode(false);
    $('editBtn').hidden = true;
    $('emptyMsg').textContent = msg;
    $('emptyState').hidden = false;
    $('legend').hidden = true;
    baseImg.removeAttribute('src');
    gFills.textContent = ''; gLabels.textContent = ''; gHits.textContent = '';
    gFx.textContent = ''; gPins.textContent = '';
  }

  function setCommunity(id) {
    community = findCommunity(id);
    if (!community) { showEmptyState('Unknown community.'); return; }

    try { localStorage.setItem('surveyor:lastCommunity', id); } catch (e) {}
    setMarkerMode(false);
    setEditMode(false);
    closeSheet();
    searchInput.value = '';
    $('searchClear').hidden = true;
    hideSearchResults();
    updateMenuForCommunity();

    if (community.user) { loadUserMap(community.entry); return; }

    window.MAP_DATA = window.MAP_DATA || {};
    if (window.MAP_DATA[community.id]) { initBuiltin(); return; }
    if (loadedScripts[community.dir]) {
      // script already injected but data never appeared
      showEmptyState('Map data for ' + community.name + ' could not be loaded.');
      return;
    }
    loadedScripts[community.dir] = true;
    var scr = document.createElement('script');
    scr.src = community.dir + '/data.js';
    var target = community;
    scr.onload = function () {
      if (community !== target) return; // user switched away meanwhile
      if (window.MAP_DATA[target.id]) initBuiltin();
      else showEmptyState('Map data for ' + target.name + ' is invalid or missing.');
    };
    scr.onerror = function () {
      if (community !== target) return;
      showEmptyState('Map data for ' + target.name + ' hasn’t been installed yet. (' +
                     target.dir + '/data.js not found)');
    };
    document.body.appendChild(scr);
  }

  function initBuiltin() {
    data = window.MAP_DATA[community.id];
    isUserMap = false;
    initView();
  }

  function loadUserMap(entry) {
    showBusy('Loading map…');
    BlobStore.load(entry.blobKey).then(function (content) {
      hideBusy();
      if (!community || community.id !== entry.id) return; // switched away
      if (!content) {
        showEmptyState('The stored image for “' + entry.name + '” is missing.');
        return;
      }
      data = {
        name: entry.name,
        viewBox: entry.viewBox,
        baseImage: content,
        buildings: sanitizeBuildings(loadJSON('surveyor:' + entry.id + ':buildings', [])),
        landmarks: loadJSON('surveyor:' + entry.id + ':landmarks', [])
      };
      isUserMap = true;
      initView();
    }).catch(function () {
      hideBusy();
      if (community && community.id === entry.id) {
        showEmptyState('Could not load “' + entry.name + '” from storage.');
      }
    });
  }

  function sanitizeBuildings(raw) {
    var out = [];
    if (!raw || !raw.length) return out;
    for (var i = 0; i < raw.length; i++) {
      var b = raw[i];
      if (b && isFinite(b.n) && isFinite(b.cx) && isFinite(b.cy) &&
          b.pts && b.pts.length >= 3) {
        var clean = { n: +b.n, cx: +b.cx, cy: +b.cy, pts: b.pts };
        if (typeof b.addr === 'string' && b.addr) clean.addr = b.addr;
        out.push(clean);
      }
    }
    return out;
  }

  // Common init once `data` + `isUserMap` are set.
  function initView() {
    var v = data.viewBox || [0, 0, 1000, 1000];
    vb = { x: +v[0], y: +v[1], w: +v[2], h: +v[3] };

    $('emptyState').hidden = true;
    $('editBtn').hidden = !isUserMap;

    baseImg.onerror = function () {
      toast('Base map image failed to load');
    };
    baseImg.src = data.baseImage || data.baseSvg;
    baseImg.style.width = vb.w + 'px';
    baseImg.style.height = vb.h + 'px';

    overlay.setAttribute('viewBox', vb.x + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
    overlay.setAttribute('width', vb.w);
    overlay.setAttribute('height', vb.h);
    layer.style.width = vb.w + 'px';
    layer.style.height = vb.h + 'px';

    buildOverlay();
    loadState();
    repaintAll();
    renderAllPins();
    renderLegend();
    fitView();
    setEditMode(false);
    if (markerMode) setMarkerMode(false);
    // location state never carries across maps (different georefs)
    if (calib.active) calibCancel();
    setLocState(false);
    locStop();
    if (routeMode) setRouteMode(false);

    if (isUserMap && pendingDetectOfferId === community.id) {
      pendingDetectOfferId = null;
      if (!data.buildings.length) offerDetect();
    }
  }

  // ---------------------------------------------------------------- add map flow
  function openAddMapFlow() {
    var fp = $('filePicker');
    fp.value = '';
    fp.click();
  }

  $('filePicker').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (f) handleUpload(f);
  });

  function uploadError(msg) {
    hideBusy();
    showDialog({
      title: 'Couldn’t add map',
      message: msg,
      buttons: [{ text: 'OK', primary: true }]
    });
  }

  function handleUpload(file) {
    var fname = file.name || 'map';
    var lower = fname.toLowerCase();
    var isJson = /\.json$/.test(lower) || file.type === 'application/json';
    var isSvg = /\.svg$/.test(lower) || file.type === 'image/svg+xml';
    var baseName = fname.replace(/\.[^.]+$/, '') || 'My map';

    showBusy('Reading file…');
    var reader = new FileReader();
    reader.onerror = function () { uploadError('The file could not be read.'); };
    reader.onload = function () {
      hideBusy();
      var content = reader.result;
      if (isJson) {
        var pkg;
        try { pkg = JSON.parse(content); }
        catch (e) { uploadError('That JSON file is not valid.'); return; }
        askMapName(String((pkg && pkg.name) || baseName), function (mapName) {
          importPackage(pkg, mapName);
        });
      } else if (isSvg) {
        askMapName(baseName, function (mapName) { importSvg(content, mapName); });
      } else {
        askMapName(baseName, function (mapName) { importRaster(content, mapName); });
      }
    };
    if (isJson || isSvg) reader.readAsText(file);
    else reader.readAsDataURL(file);
  }

  function askMapName(prefill, cb) {
    showDialog({
      title: 'Name this map',
      input: { value: prefill, placeholder: 'Map name' },
      buttons: [
        { text: 'Cancel' },
        { text: 'Add map', primary: true, onTap: function (val) {
            cb(String(val || '').trim() || 'My map');
          } }
      ]
    });
  }

  var MAX_RASTER_EDGE = 3000;

  function importRaster(dataUrl, mapName) {
    showBusy('Processing image…');
    var img = new Image();
    img.onerror = function () { uploadError('That file is not a readable image.'); };
    img.onload = function () {
      // let the busy overlay paint before the (synchronous) canvas work
      setTimeout(function () {
        try {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { uploadError('That image is empty.'); return; }
          var k = Math.min(1, MAX_RASTER_EDGE / Math.max(w, h));
          var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
          var cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          var ctx = cv.getContext('2d');
          ctx.fillStyle = '#ffffff';               // white under any transparency
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(img, 0, 0, cw, ch);
          var jpeg = cv.toDataURL('image/jpeg', 0.85);
          finishImport(jpeg, [0, 0, cw, ch], mapName, null);
        } catch (e) {
          uploadError('Could not process the image: ' + e.message);
        }
      }, 30);
    };
    img.src = dataUrl;
  }

  function importSvg(text, mapName) {
    var doc, root, vbAttr, parts = null;
    try {
      doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      root = doc.documentElement;
      if (!root || root.nodeName.toLowerCase() !== 'svg' ||
          doc.getElementsByTagName('parsererror').length) {
        uploadError('That SVG file could not be parsed.');
        return;
      }
      vbAttr = root.getAttribute('viewBox');
      if (vbAttr) {
        var nums = vbAttr.trim().split(/[\s,]+/).map(Number);
        if (nums.length === 4 && nums.every(isFinite) && nums[2] > 0 && nums[3] > 0) {
          parts = nums;
        }
      }
      if (!parts) {
        var w = parseFloat(root.getAttribute('width')),
            h = parseFloat(root.getAttribute('height'));
        if (isFinite(w) && isFinite(h) && w > 0 && h > 0) parts = [0, 0, w, h];
      }
    } catch (e) {
      uploadError('That SVG file could not be parsed.');
      return;
    }
    if (!parts) {
      uploadError('The SVG has no viewBox or width/height, so its size is unknown.');
      return;
    }
    var dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    finishImport(dataUrl, parts, mapName, null);
  }

  function importPackage(pkg, mapName) {
    if (!pkg || typeof pkg !== 'object') { uploadError('Invalid map package.'); return; }
    var v = pkg.viewBox;
    if (!v || v.length !== 4 || !isFinite(+v[2]) || !isFinite(+v[3]) ||
        +v[2] <= 0 || +v[3] <= 0) {
      uploadError('The package has no valid viewBox.');
      return;
    }
    if (typeof pkg.baseImage !== 'string' || pkg.baseImage.indexOf('data:') !== 0) {
      uploadError('The package has no baseImage data URL.');
      return;
    }
    var extra = { buildings: sanitizeBuildings(pkg.buildings) };
    if (pkg.landmarks && pkg.landmarks.length) {
      extra.landmarks = [];
      for (var i = 0; i < pkg.landmarks.length; i++) {
        var L = pkg.landmarks[i];
        if (L && L.label && isFinite(L.x) && isFinite(L.y)) {
          extra.landmarks.push({ label: String(L.label), x: +L.x, y: +L.y });
        }
      }
    }
    finishImport(pkg.baseImage, [+v[0], +v[1], +v[2], +v[3]], mapName, extra);
  }

  var pendingDetectOfferId = null;   // offer auto-detect once the new map loads

  function finishImport(dataUrl, vbArr, mapName, extra) {
    var id = 'user_' + Date.now();
    var blobKey = 'map_' + id;
    // packages arrive with real buildings; images get the auto-detect offer
    if (!extra || !extra.buildings || !extra.buildings.length) pendingDetectOfferId = id;
    showBusy('Saving map…');
    BlobStore.save(blobKey, dataUrl).then(function () {
      if (extra && extra.buildings && extra.buildings.length) {
        saveJSON('surveyor:' + id + ':buildings', extra.buildings);
      }
      if (extra && extra.landmarks && extra.landmarks.length) {
        saveJSON('surveyor:' + id + ':landmarks', extra.landmarks);
      }
      userMaps.push({ id: id, name: mapName, blobKey: blobKey,
                      viewBox: vbArr, created: Date.now() });
      saveUserMaps();
      rebuildCommunitySelect();
      hideBusy();
      $('communitySelect').value = id;
      setCommunity(id);
      toast('Map “' + mapName + '” added');
    }).catch(function (e) {
      uploadError('Could not save the map — storage may be full. (' +
                  ((e && e.message) || 'unknown error') + ')');
    });
  }

  // ---------------------------------------------------------------- manage user maps
  function updateMenuForCommunity() {
    var isUser = !!(community && community.user);
    $('renameMapBtn').hidden = !isUser;
    $('deleteMapBtn').hidden = !isUser;
    $('calibrateBtn').hidden = !isUser;
  }

  $('addMapBtn').addEventListener('click', function () {
    hideMenu();
    openAddMapFlow();
  });

  $('renameMapBtn').addEventListener('click', function () {
    hideMenu();
    if (!community || !community.user) return;
    var entry = community.entry;
    showDialog({
      title: 'Rename map',
      input: { value: entry.name, placeholder: 'Map name' },
      buttons: [
        { text: 'Cancel' },
        { text: 'Save', primary: true, onTap: function (val) {
            entry.name = String(val || '').trim() || entry.name;
            community.name = entry.name;
            if (data) data.name = entry.name;
            saveUserMaps();
            rebuildCommunitySelect();
            toast('Map renamed');
          } }
      ]
    });
  });

  $('deleteMapBtn').addEventListener('click', function () {
    hideMenu();
    if (!community || !community.user) return;
    var entry = community.entry;
    showDialog({
      title: 'Delete “' + entry.name + '”?',
      message: 'The map image and all its survey data (colors, legend, markers, buildings) will be permanently deleted.',
      buttons: [
        { text: 'Cancel' },
        { text: 'Delete', primary: true, danger: true, onTap: function () {
            BlobStore.remove(entry.blobKey);
            var kinds = ['colors', 'legend', 'markers', 'buildings', 'landmarks',
                         'routes', 'georef', 'addrs'];
            for (var i = 0; i < kinds.length; i++) {
              try { localStorage.removeItem('surveyor:' + entry.id + ':' + kinds[i]); }
              catch (e) {}
            }
            for (var j = 0; j < userMaps.length; j++) {
              if (userMaps[j].id === entry.id) { userMaps.splice(j, 1); break; }
            }
            saveUserMaps();
            community = null;
            rebuildCommunitySelect();
            var home = builtins().length ? builtins()[0].id : null;
            if (home) {
              $('communitySelect').value = home;
              setCommunity(home);
            } else {
              showEmptyState('No maps left. Add one from the menu.');
            }
            toast('Map deleted');
          } }
      ]
    });
  });

  // --------------------------------------- live location (blue dot)
  // GPS lat/lon -> map coords via an affine georef: builtin maps carry it in
  // MAP_DATA, user maps get one from the in-app calibration below.
  var LOC = {
    degLatMeters: 111320,          // meters per degree latitude
    offMapMargin: 0.25,            // viewBox fractions before "off this map"
    calibMinFixAcc: 35,            // m — reject calibration fixes worse than this
    calibMinSpread: 30             // m — min ground distance between calib points
  };

  var locOn = false, locFollow = false, locLastFix = null, locOffMapToasted = false;
  var locAccEl = null, locDotG = null, locArrowG = null, locHeading = null;

  // The compass reports degrees clockwise from true north; add the map's own
  // rotation relative to north (from the georef: where +latitude points).
  function mapNorthOffsetDeg() {
    var g = getGeoref();
    if (!g) return 0;
    var vx = g.toMap[1], vy = g.toMap[4];   // map-space direction of +1° latitude
    return Math.atan2(vx, -vy) * 180 / Math.PI;
  }

  function updateLocArrow() {
    if (!locArrowG) return;
    if (locHeading == null) { locArrowG.style.display = 'none'; return; }
    locArrowG.style.display = '';
    locArrowG.setAttribute('transform',
      'rotate(' + ((locHeading + mapNorthOffsetDeg()) % 360) + ')');
  }

  window.__headingEvent = function (ev) {
    if (!ev) return;
    if (ev.phase === 'unavailable') { locHeading = null; updateLocArrow(); return; }
    if (isFinite(ev.deg)) { locHeading = +ev.deg; updateLocArrow(); }
  };

  function getGeoref() {
    if (data && data.georef && data.georef.toMap) return data.georef;
    if (isUserMap) {
      var g = loadJSON(storeKey('georef'), null);
      if (g && g.toMap && g.toMap.length === 6) return g;
    }
    return null;
  }

  function lonLatToMap(lon, lat, g) {
    var m = g.toMap;
    return { x: m[0] * lon + m[1] * lat + m[2],
             y: m[3] * lon + m[4] * lat + m[5] };
  }

  function counterScaleLocDot() {
    if (locDotG && locDotG.parentNode && locLastFix) {
      locDotG.setAttribute('transform',
        'translate(' + locDotG.getAttribute('data-x') + ' ' +
        locDotG.getAttribute('data-y') + ') scale(' + (1 / s) + ')');
    }
  }

  function removeLocDot() {
    gLoc.textContent = '';
    locAccEl = null; locDotG = null; locArrowG = null;
  }

  function drawLocFix(fix) {
    var g = getGeoref();
    if (!g) return;
    var p = lonLatToMap(fix.lon, fix.lat, g);
    var mx = vb.w * LOC.offMapMargin, my = vb.h * LOC.offMapMargin;
    var off = p.x < vb.x - mx || p.x > vb.x + vb.w + mx ||
              p.y < vb.y - my || p.y > vb.y + vb.h + my;
    if (off) {
      removeLocDot();
      if (!locOffMapToasted) { toast('You appear to be off this map'); locOffMapToasted = true; }
      return;
    }
    locOffMapToasted = false;
    if (!locAccEl) {
      locAccEl = svgEl('circle', { 'class': 'loc-acc' }, gLoc);
      locDotG = svgEl('g', {}, gLoc);
      svgEl('circle', { 'class': 'loc-dot-pulse', r: 7 }, locDotG);
      locArrowG = svgEl('g', { 'class': 'loc-arrow-g' }, locDotG);
      svgEl('path', { 'class': 'loc-arrow',
                      d: 'M0,-19 L7.5,-8.5 Q0,-12 -7.5,-8.5 Z' }, locArrowG);
      locArrowG.style.display = locHeading == null ? 'none' : '';
      updateLocArrow();
      svgEl('circle', { 'class': 'loc-dot-outer', r: 8 }, locDotG);
      svgEl('circle', { 'class': 'loc-dot-inner', r: 5.5 }, locDotG);
    }
    var upm = g.unitsPerMeter || 1;
    locAccEl.setAttribute('cx', p.x);
    locAccEl.setAttribute('cy', p.y);
    locAccEl.setAttribute('r', Math.max((fix.accuracy || 0) * upm, 1));
    locDotG.setAttribute('data-x', p.x);
    locDotG.setAttribute('data-y', p.y);
    counterScaleLocDot();
    if (locFollow) centerOn(p.x, p.y);
  }

  function centerOn(mapX, mapY) {
    var sz = stageSize();
    tx = sz.w / 2 - (mapX - vb.x) * s;
    ty = sz.h / 2 - (mapY - vb.y) * s;
    applyTransform();
  }

  // Native bridge if present, browser geolocation as the dev fallback.
  var browserWatchId = null;
  function locStart() {
    if (window.SurveyorNative && SurveyorNative.startLocation) {
      var res = 'err:no response';
      try { res = SurveyorNative.startLocation(); } catch (e) { res = 'err:' + e.message; }
      if (String(res).indexOf('ok') !== 0) {
        toast('Location unavailable (' + res + ')');
        setLocState(false);
        return;
      }
      if (SurveyorNative.startCompass) {
        try { SurveyorNative.startCompass(); } catch (e2) {}
      }
    } else if (navigator.geolocation) {
      browserWatchId = navigator.geolocation.watchPosition(function (pos) {
        window.__locationEvent({ phase: 'fix', lat: pos.coords.latitude,
          lon: pos.coords.longitude, accuracy: pos.coords.accuracy, ts: pos.timestamp });
      }, function () {
        window.__locationEvent({ phase: 'denied' });
      }, { enableHighAccuracy: true, maximumAge: 2000 });
    } else {
      toast('No location source available');
      setLocState(false);
    }
  }
  function locStop() {
    if (window.SurveyorNative && SurveyorNative.stopLocation) {
      try { SurveyorNative.stopLocation(); } catch (e) {}
    }
    if (window.SurveyorNative && SurveyorNative.stopCompass) {
      try { SurveyorNative.stopCompass(); } catch (e2) {}
    }
    locHeading = null;
    if (browserWatchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(browserWatchId);
      browserWatchId = null;
    }
  }

  function setLocState(on, follow) {
    locOn = on;
    locFollow = !!(on && follow);
    var btn = $('locBtn');
    btn.classList.toggle('active', locOn && locFollow);
    btn.classList.toggle('searching', locOn && !locFollow);
    if (!on) { removeLocDot(); locLastFix = null; locOffMapToasted = false; }
  }

  window.__locationEvent = function (ev) {
    if (!ev) return;
    if (ev.phase === 'fix') {
      locLastFix = ev;
      if (calib.active) { calibFixUpdated(); return; }
      if (locOn) drawLocFix(ev);
    } else if (ev.phase === 'denied') {
      toast('Location permission was denied');
      if (calib.active) calibCancel();
      setLocState(false); locStop();
    } else if (ev.phase === 'unavailable') {
      toast('Location is turned off on this phone');
      if (calib.active) calibCancel();
      setLocState(false); locStop();
    }
  };

  $('locBtn').addEventListener('click', function () {
    if (!data) return;
    if (calib.active) return;
    if (!getGeoref()) {
      if (isUserMap) offerCalibration();
      else toast('This map has no location reference');
      return;
    }
    if (!locOn) {
      setLocState(true, true);
      locStart();
      toast('Finding your location…');
    } else if (!locFollow) {
      locFollow = true;
      setLocState(true, true);
      if (locLastFix) drawLocFix(locLastFix);
    } else {
      setLocState(false);
      locStop();
    }
  });

  // Called from the pan gesture: a manual pan stops following (the dot stays).
  function stopFollowingLocation() {
    if (locFollow) setLocState(true, false);
  }

  // ---------------------------- calibration (user maps without a georef)
  var calib = { active: false, pairs: [] };

  function offerCalibration() {
    showDialog({
      title: 'Link this map to GPS',
      message: 'This map isn’t connected to real-world coordinates yet. To calibrate: walk to a spot you can identify on the map (a corner, a building), then tap that exact spot. Repeat at a second spot at least ' + LOC.calibMinSpread + ' m away.',
      buttons: [
        { text: 'Cancel' },
        { text: 'Start', primary: true, onTap: calibStart }
      ]
    });
  }

  function calibStart() {
    calib.active = true;
    calib.pairs = [];
    setEditMode(false);
    if (markerMode) setMarkerMode(false);
    locStart();
    calibHint();
  }

  function calibHint(msg) {
    var h = $('locHint');
    h.textContent = msg ||
      ('Point ' + (calib.pairs.length + 1) + ': stand at a recognizable spot, then tap it on the map' +
       (calib.pairs.length >= 2 ? ' — or use the ✓ in the menu' : ''));
    h.hidden = false;
  }

  function calibFixUpdated() { /* the hint could show accuracy; keep it simple */ }

  function calibCancel() {
    calib.active = false;
    calib.pairs = [];
    $('locHint').hidden = true;
    setLocState(false);
    locStop();
  }

  function calibMapTap(cx, cy) {
    var fix = locLastFix;
    if (!fix) { toast('Waiting for a GPS fix — stay in the open for a moment'); return; }
    if (fix.accuracy > LOC.calibMinFixAcc) {
      toast('GPS accuracy is ' + Math.round(fix.accuracy) + ' m — wait for a better fix');
      return;
    }
    var pt = screenToMap(cx, cy);
    if (!insideMap(pt.x, pt.y)) { toast('Tap on the map itself'); return; }
    // ground distance to previous points must be meaningful
    for (var i = 0; i < calib.pairs.length; i++) {
      var q = calib.pairs[i];
      var dE = (fix.lon - q.lon) * LOC.degLatMeters * Math.cos(fix.lat * Math.PI / 180);
      var dN = (fix.lat - q.lat) * LOC.degLatMeters;
      if (Math.sqrt(dE * dE + dN * dN) < LOC.calibMinSpread) {
        toast('Too close to point ' + (i + 1) + ' — walk further before adding this one');
        return;
      }
    }
    calib.pairs.push({ lon: fix.lon, lat: fix.lat, x: pt.x, y: pt.y });
    svgEl('circle', { cx: pt.x, cy: pt.y, r: 4, fill: '#1e88e5',
                      stroke: '#fff', 'stroke-width': 1.5 }, gLoc);
    if (calib.pairs.length < 2) {
      toast('Point 1 saved');
      calibHint();
    } else {
      showDialog({
        title: calib.pairs.length + ' points set',
        message: 'Two points are enough. A third point improves accuracy, especially if the map is at an angle.',
        buttons: [
          { text: 'Add another', onTap: function () { calibHint(); } },
          { text: 'Finish', primary: true, onTap: calibFinish }
        ]
      });
    }
  }

  function calibFinish() {
    var georef = solveGeoref(calib.pairs);
    calib.active = false;
    $('locHint').hidden = true;
    gLoc.textContent = '';
    if (!georef) {
      toast('Calibration failed — the points were too close together');
      setLocState(false); locStop();
      return;
    }
    saveJSON(storeKey('georef'), georef);
    toast('Map linked to GPS');
    setLocState(true, true);
    if (locLastFix) drawLocFix(locLastFix);
  }

  // 2 pairs: similarity (scale+rotation+translation) on north-flipped local
  // meters; 3+: full least-squares affine. Returns the contract georef object.
  function solveGeoref(pairs) {
    if (!pairs || pairs.length < 2) return null;
    var lat0 = pairs[0].lat, lon0 = pairs[0].lon;
    var kE = LOC.degLatMeters * Math.cos(lat0 * Math.PI / 180), kN = LOC.degLatMeters;
    // ground coords in meters, N flipped so y-down maps need no reflection
    var g = pairs.map(function (p) {
      return { u: (p.lon - lon0) * kE, v: -(p.lat - lat0) * kN, x: p.x, y: p.y };
    });
    var A, B, C, D, E, F; // x = A*u + B*v + C ; y = D*u + E*v + F
    if (pairs.length === 2) {
      var du = g[1].u - g[0].u, dv = g[1].v - g[0].v;
      var dx = g[1].x - g[0].x, dy = g[1].y - g[0].y;
      var den = du * du + dv * dv;
      if (den < 1) return null;
      // complex division (dx+idy)/(du+idv): rotation+uniform scale
      var re = (dx * du + dy * dv) / den, im = (dy * du - dx * dv) / den;
      A = re; B = -im; D = im; E = re;
      C = g[0].x - (A * g[0].u + B * g[0].v);
      F = g[0].y - (D * g[0].u + E * g[0].v);
    } else {
      var fitX = lstsq3(g, 'x'), fitY = lstsq3(g, 'y');
      if (!fitX || !fitY) return null;
      A = fitX[0]; B = fitX[1]; C = fitX[2];
      D = fitY[0]; E = fitY[1]; F = fitY[2];
    }
    var scale = (Math.sqrt(A * A + D * D) + Math.sqrt(B * B + E * E)) / 2;
    if (!isFinite(scale) || scale <= 0) return null;
    // compose with u = (lon-lon0)*kE, v = -(lat-lat0)*kN into lon/lat terms
    var a = A * kE, b = -B * kN, c = C - a * lon0 - b * lat0;
    var d = D * kE, e = -E * kN, f = F - d * lon0 - e * lat0;
    return { type: 'affine', toMap: [a, b, c, d, e, f], unitsPerMeter: scale };
  }

  // least squares for t = p0*u + p1*v + p2 over the pairs (t = 'x'|'y')
  function lstsq3(g, key) {
    var Suu = 0, Suv = 0, Su = 0, Svv = 0, Sv = 0, n = g.length;
    var Sut = 0, Svt = 0, St = 0;
    for (var i = 0; i < n; i++) {
      var u = g[i].u, v = g[i].v, t = g[i][key];
      Suu += u * u; Suv += u * v; Su += u; Svv += v * v; Sv += v;
      Sut += u * t; Svt += v * t; St += t;
    }
    // solve [Suu Suv Su; Suv Svv Sv; Su Sv n] p = [Sut Svt St]
    var m = [[Suu, Suv, Su, Sut], [Suv, Svv, Sv, Svt], [Su, Sv, n, St]];
    for (var col = 0; col < 3; col++) {
      var piv = col;
      for (var r2 = col + 1; r2 < 3; r2++) {
        if (Math.abs(m[r2][col]) > Math.abs(m[piv][col])) piv = r2;
      }
      if (Math.abs(m[piv][col]) < 1e-9) return null;
      var tmp = m[col]; m[col] = m[piv]; m[piv] = tmp;
      for (var r3 = 0; r3 < 3; r3++) {
        if (r3 === col) continue;
        var k = m[r3][col] / m[col][col];
        for (var c2 = col; c2 < 4; c2++) m[r3][c2] -= k * m[col][c2];
      }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  }

  $('calibrateBtn').addEventListener('click', function () {
    hideMenu();
    if (!isUserMap || !data) return;
    offerCalibration();
  });

  // --------------------------------------- planned routes (polylines)
  var routeMode = false;
  var routeDraft = [];       // [[x,y],...] while drawing
  var ROUTE_DEFAULT_COLOR = '#1e88e5';

  function saveRoutes() { saveJSON(storeKey('routes'), routes); }

  function routePointsAttr(pts) {
    var out = [];
    for (var i = 0; i < pts.length; i++) out.push(pts[i][0] + ',' + pts[i][1]);
    return out.join(' ');
  }

  function renderRoutes() {
    gRoutes.textContent = '';
    for (var i = 0; i < routes.length; i++) {
      var r = routes[i];
      svgEl('polyline', { 'class': 'route-line', points: routePointsAttr(r.pts),
                          stroke: r.color }, gRoutes);
      svgEl('polyline', { 'class': 'route-hit', points: routePointsAttr(r.pts),
                          'data-rid': r.id }, gRoutes);
    }
    if (routeMode) renderRouteDraft();
  }

  function renderRouteDraft() {
    var old = gRoutes.querySelectorAll('.route-draft');
    for (var i = old.length - 1; i >= 0; i--) old[i].parentNode.removeChild(old[i]);
    if (!routeDraft.length) return;
    if (routeDraft.length >= 2) {
      svgEl('polyline', { 'class': 'route-line route-draft',
                          points: routePointsAttr(routeDraft),
                          stroke: ROUTE_DEFAULT_COLOR,
                          'stroke-dasharray': '7 5' }, gRoutes);
    }
    for (var j = 0; j < routeDraft.length; j++) {
      svgEl('circle', { 'class': 'route-draft', cx: routeDraft[j][0], cy: routeDraft[j][1],
                        r: 3.5, fill: '#fff', stroke: ROUTE_DEFAULT_COLOR,
                        'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }, gRoutes);
    }
  }

  function routeAddVertex(cx, cy) {
    var pt = screenToMap(cx, cy);
    if (!insideMap(pt.x, pt.y)) { toast('Tap on the map itself'); return; }
    routeDraft.push([round1(pt.x), round1(pt.y)]);
    renderRouteDraft();
  }

  function setRouteMode(on) {
    routeMode = on;
    $('routeBtn').classList.toggle('active', on);
    $('routeHint').hidden = !on;
    if (on) {
      routeDraft = [];
      setEditMode(false);
      if (markerMode) setMarkerMode(false);
      closeSheet();
    } else {
      routeDraft = [];
      renderRoutes();
    }
  }

  $('routeBtn').addEventListener('click', function () {
    if (!data) return;
    if (!routeMode) { setRouteMode(true); return; }
    // finishing
    var pts = routeDraft.slice();
    if (pts.length < 2) {
      setRouteMode(false);
      toast('Route discarded — add at least two points next time');
      return;
    }
    setRouteMode(false);
    showDialog({
      title: 'Save route',
      input: { value: 'Route ' + (routes.length + 1), placeholder: 'Route name' },
      buttons: [
        { text: 'Discard' },
        { text: 'Save', primary: true, onTap: function (val) {
            routes.push({ id: 'r' + Date.now(), label: String(val || '').trim() || 'Route',
                          color: ROUTE_DEFAULT_COLOR, pts: pts });
            saveRoutes();
            renderRoutes();
            toast('Route saved — tap it any time to rename, recolor, or delete');
          } }
      ]
    });
  });

  function routeById(id) {
    for (var i = 0; i < routes.length; i++) if (routes[i].id === id) return routes[i];
    return null;
  }

  function openRouteDialog(id) {
    var r = routeById(id);
    if (!r) return;
    showDialog({
      title: r.label || 'Route',
      buttons: [
        { text: 'Delete', danger: true, onTap: function () {
            showDialog({
              title: 'Delete “' + (r.label || 'Route') + '”?',
              buttons: [
                { text: 'Cancel' },
                { text: 'Delete', primary: true, danger: true, onTap: function () {
                    for (var i = 0; i < routes.length; i++) {
                      if (routes[i].id === id) { routes.splice(i, 1); break; }
                    }
                    saveRoutes(); renderRoutes();
                    toast('Route deleted');
                  } }
              ]
            });
          } },
        { text: 'Color', onTap: function () { pickColor(r.color, function (hex) {
            r.color = hex; saveRoutes(); renderRoutes();
          }); } },
        { text: 'Rename', onTap: function () {
            showDialog({
              title: 'Rename route',
              input: { value: r.label, placeholder: 'Route name' },
              buttons: [
                { text: 'Cancel' },
                { text: 'Save', primary: true, onTap: function (val) {
                    r.label = String(val || '').trim() || r.label;
                    saveRoutes();
                  } }
              ]
            });
          } },
        { text: 'Close', primary: true }
      ]
    });
  }

  // Shared custom-color entry point: RGB wheel when available, native input
  // as the fallback (dev browsers, or if colorwheel.js failed to load).
  function pickColor(initial, cb) {
    if (window.ColorWheel && window.ColorWheel.open) {
      window.ColorWheel.open({ initial: initial, onPick: cb, onCancel: function () {} });
    } else {
      var inp = $('customColor');
      inp.value = normHex(initial) || '#e53935';
      var once = function () { inp.removeEventListener('change', once); cb(inp.value); };
      inp.addEventListener('change', once);
      inp.click();
    }
  }

  // --------------------------------------- self-update (GitHub releases)
  var UPDATE = {
    api: 'https://api.github.com/repos/ManxomeFoe/surveyor/releases/latest',
    apkUrl: 'https://github.com/ManxomeFoe/surveyor/releases/latest/download/surveyor.apk',
    page: 'https://github.com/ManxomeFoe/surveyor/releases/latest',
    fallbackVersion: '1.8',          // used when the native bridge is absent
    checkEveryMs: 24 * 3600 * 1000   // automatic checks at most once a day
  };

  function appVersion() {
    try {
      if (window.SurveyorNative && SurveyorNative.getAppVersion) {
        var v = JSON.parse(SurveyorNative.getAppVersion());
        if (v && v.versionName) return String(v.versionName);
      }
    } catch (e) {}
    return UPDATE.fallbackVersion;
  }

  // numeric per-component compare of "1.10" vs "v1.9" style strings
  function cmpVersions(a, b) {
    var pa = String(a).replace(/^v/i, '').split('.');
    var pb = String(b).replace(/^v/i, '').split('.');
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var na = parseInt(pa[i], 10) || 0, nb = parseInt(pb[i], 10) || 0;
      if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
  }

  function checkForUpdate(manual) {
    if (!window.fetch) return;
    if (!manual) {
      var last = 0;
      try { last = +localStorage.getItem('surveyor:lastUpdateCheck') || 0; } catch (e) {}
      if (Date.now() - last < UPDATE.checkEveryMs) return;
    }
    try { localStorage.setItem('surveyor:lastUpdateCheck', String(Date.now())); } catch (e) {}
    if (manual) toast('Checking for updates…');
    fetch(UPDATE.api, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (rel) {
        var latest = rel && rel.tag_name;
        if (latest && cmpVersions(latest, appVersion()) > 0) {
          showUpdateDialog(latest, rel);
        } else if (manual) {
          toast('Surveyor is up to date (v' + appVersion() + ')');
        }
      })
      .catch(function () {
        if (manual) toast('Could not reach GitHub to check for updates');
      });
  }

  function showUpdateDialog(tag, rel) {
    var notes = String((rel && rel.body) || '').split('\n')[0].slice(0, 160);
    showDialog({
      title: 'Update available: ' + tag,
      message: 'You have v' + appVersion() + '. Download and install the new version?' +
               (notes ? '\n\n' + notes : '') +
               '\n\nYour survey data stays on the phone.',
      buttons: [
        { text: 'Later' },
        { text: 'Update', primary: true, onTap: startUpdate }
      ]
    });
  }

  function startUpdate() {
    if (window.SurveyorNative && SurveyorNative.startUpdateDownload) {
      window.__updateEvent = function (ev) {
        if (!ev) return;
        if (ev.phase === 'progress') {
          $('busyText').textContent = 'Downloading update… ' +
            (isFinite(ev.pct) ? Math.round(ev.pct) + '%' : '');
        } else if (ev.phase === 'done') {
          hideBusy();
          toast('Opening the installer…');
        } else if (ev.phase === 'error') {
          hideBusy();
          showDialog({
            title: 'Update failed',
            message: (ev.message || 'Download error') +
                     ' — you can download the update in your browser instead.',
            buttons: [
              { text: 'Close' },
              { text: 'Open browser', primary: true,
                onTap: function () { window.open(UPDATE.page, '_blank'); } }
            ]
          });
        }
      };
      showBusy('Downloading update…');
      var res = 'err:no response';
      try { res = SurveyorNative.startUpdateDownload(UPDATE.apkUrl); } catch (e) { res = 'err:' + e.message; }
      if (String(res).indexOf('ok') !== 0) {
        hideBusy();
        toast('Could not start the download (' + res + ')');
      }
    } else {
      // dev / plain-browser fallback
      window.open(UPDATE.page, '_blank');
    }
  }

  $('updateBtn').addEventListener('click', function () {
    hideMenu();
    checkForUpdate(true);
  });

  // ---------------------------------------------------------------- boot
  function boot() {
    buildPalette();
    loadUserMaps();
    var sel = $('communitySelect');
    sel.addEventListener('change', function () {
      if (this.value === ADD_MAP_VALUE) {
        this.value = community ? community.id : (builtins().length ? builtins()[0].id : '');
        openAddMapFlow();
        return;
      }
      setCommunity(this.value);
    });
    rebuildCommunitySelect();
    if (!builtins().length && !userMaps.length) {
      showEmptyState('No communities are configured (maps/index.js missing or empty).');
      return;
    }
    var last = null;
    try { last = localStorage.getItem('surveyor:lastCommunity'); } catch (e) {}
    var startId = (last && findCommunity(last)) ? last
                : (builtins().length ? builtins()[0].id : userMaps[0].id);
    $('communitySelect').value = startId;
    setCommunity(startId);

    // auto-check for updates once the map is up; never blocks offline use
    setTimeout(function () { checkForUpdate(false); }, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
