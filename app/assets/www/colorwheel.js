/* ColorWheel — self-contained HSV color picker widget (Surveyor contract,
   "Color wheel widget"). No dependencies, ES5 only, builds and destroys its
   own DOM. API: window.ColorWheel.open({ initial, onPick, onCancel }). */
(function () {
  'use strict';

  var DEFAULT_HEX = '#e53935';

  // ------------------------------------------------------------ color math
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function parseHex(str) {
    if (typeof str !== 'string') return null;
    var s = str.trim().toLowerCase();
    var m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
    if (m3) s = '#' + m3[1] + m3[1] + m3[2] + m3[2] + m3[3] + m3[3];
    if (!/^#[0-9a-f]{6}$/.test(s)) return null;
    return {
      r: parseInt(s.substr(1, 2), 16),
      g: parseInt(s.substr(3, 2), 16),
      b: parseInt(s.substr(5, 2), 16)
    };
  }

  function pad2(n) {
    var h = n.toString(16);
    return h.length < 2 ? '0' + h : h;
  }

  function rgbToHex(r, g, b) {
    return ('#' + pad2(r) + pad2(g) + pad2(b)).toUpperCase();
  }

  // h in [0,360), s,v in [0,1] -> {r,g,b} ints 0-255
  function hsvToRgb(h, s, v) {
    var c = v * s;
    var hp = (h % 360) / 60;
    var x = c * (1 - Math.abs(hp % 2 - 1));
    var r1 = 0, g1 = 0, b1 = 0;
    if (hp < 1)      { r1 = c; g1 = x; }
    else if (hp < 2) { r1 = x; g1 = c; }
    else if (hp < 3) { g1 = c; b1 = x; }
    else if (hp < 4) { g1 = x; b1 = c; }
    else if (hp < 5) { r1 = x; b1 = c; }
    else             { r1 = c; b1 = x; }
    var m = v - c;
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255)
    };
  }

  function rgbToHsv(r, g, b) {
    var rf = r / 255, gf = g / 255, bf = b / 255;
    var max = Math.max(rf, gf, bf), min = Math.min(rf, gf, bf);
    var d = max - min;
    var h = 0;
    if (d > 0) {
      if (max === rf)      h = 60 * (((gf - bf) / d) % 6);
      else if (max === gf) h = 60 * ((bf - rf) / d + 2);
      else                 h = 60 * ((rf - gf) / d + 4);
      if (h < 0) h += 360;
    }
    return { h: h, s: max === 0 ? 0 : d / max, v: max };
  }

  // ------------------------------------------------------------ disk render
  // The disk is painted once per open() at full brightness (v = 1); the
  // value/brightness is applied visually by a black overlay whose opacity is
  // (1 - v) — black at alpha (1-v) over a color is exactly color * v.
  function renderDisk(canvas, cssSize) {
    var dpr = window.devicePixelRatio || 1;
    var px = Math.max(2, Math.round(cssSize * dpr));
    canvas.width = px;
    canvas.height = px;
    canvas.style.width = cssSize + 'px';
    canvas.style.height = cssSize + 'px';
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(px, px);
    var d = img.data;
    var C = px / 2, R = px / 2;
    var i = 0;
    for (var y = 0; y < px; y++) {
      var dy = y + 0.5 - C;
      for (var x = 0; x < px; x++, i += 4) {
        var dx = x + 0.5 - C;
        var r = Math.sqrt(dx * dx + dy * dy);
        if (r > R + 1) continue;               // fully transparent outside
        var h = Math.atan2(dy, dx) * 57.29577951308232;
        if (h < 0) h += 360;
        var s = r / R;
        if (s > 1) s = 1;
        var rgb = hsvToRgb(h, s, 1);
        d[i] = rgb.r; d[i + 1] = rgb.g; d[i + 2] = rgb.b;
        var a = R + 1 - r;                     // 1px antialiased rim
        d[i + 3] = a >= 1 ? 255 : (a <= 0 ? 0 : Math.round(a * 255));
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------ widget
  var active = null; // the currently-open instance, if any

  function el(tag, cls, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (parent) parent.appendChild(n);
    return n;
  }

  // Generic drag binding using pointer events + capture. All listeners live
  // on elements inside the widget DOM, so removing the DOM removes them.
  function bindDrag(target, onPoint) {
    var activeId = null;
    target.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      activeId = e.pointerId;
      try { target.setPointerCapture(e.pointerId); } catch (err) {}
      onPoint(e.clientX, e.clientY);
      if (e.cancelable) e.preventDefault();
    });
    target.addEventListener('pointermove', function (e) {
      if (activeId !== e.pointerId) return;
      onPoint(e.clientX, e.clientY);
    });
    function end(e) {
      if (activeId === e.pointerId) activeId = null;
    }
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  }

  function destroy(inst) {
    if (!inst || inst.destroyed) return;
    inst.destroyed = true;
    document.removeEventListener('keydown', inst.onKeyDown, true);
    if (inst.scrim && inst.scrim.parentNode) {
      inst.scrim.parentNode.removeChild(inst.scrim);
    }
    if (active === inst) active = null;
  }

  function open(opts) {
    opts = opts || {};
    if (active) destroy(active);   // one picker at a time

    var rgb = parseHex(opts.initial) || parseHex(DEFAULT_HEX);
    var hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);

    var inst = {
      h: hsv.h, s: hsv.s, v: hsv.v,
      onPick: typeof opts.onPick === 'function' ? opts.onPick : null,
      onCancel: typeof opts.onCancel === 'function' ? opts.onCancel : null,
      destroyed: false
    };
    active = inst;

    // ---- geometry: disk diameter ~min(80vw, 320px), never taller than fits
    var D = Math.round(Math.min(
      (window.innerWidth || 360) * 0.8 - 60,   // leave room for the slider
      (window.innerHeight || 640) * 0.45,
      320));
    if (D < 160) D = 160;
    inst.D = D;

    // ---- DOM
    var scrim = inst.scrim = el('div', 'cw-scrim', document.body);
    var card = el('div', 'cw-card', scrim);
    el('h3', 'cw-title', card).textContent = 'Pick a color';

    var main = el('div', 'cw-main', card);

    var diskWrap = el('div', 'cw-diskwrap', main);
    diskWrap.style.width = D + 'px';
    diskWrap.style.height = D + 'px';
    var canvas = el('canvas', 'cw-disk', diskWrap);
    var dim = el('div', 'cw-dim', diskWrap);
    var knob = el('div', 'cw-knob', diskWrap);

    var sliderWrap = el('div', 'cw-sliderwrap', main);
    sliderWrap.style.height = D + 'px';
    var track = el('div', 'cw-slidertrack', sliderWrap);
    var sKnob = el('div', 'cw-sliderknob', sliderWrap);

    var prevRow = el('div', 'cw-preview-row', card);
    var swatch = el('span', 'cw-swatch', prevRow);
    var hexOut = el('span', 'cw-hex', prevRow);

    var btnRow = el('div', 'cw-btnrow', card);
    var cancelBtn = el('button', 'cw-btn cw-cancel', btnRow);
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    var okBtn = el('button', 'cw-btn cw-ok', btnRow);
    okBtn.type = 'button';
    okBtn.textContent = 'OK';

    renderDisk(canvas, D);

    // ---- rendering of the dynamic bits
    function currentHex() {
      var c = hsvToRgb(inst.h, inst.s, inst.v);
      return rgbToHex(c.r, c.g, c.b);
    }

    function render() {
      var R = D / 2;
      var rad = inst.h * Math.PI / 180;
      var kx = R + Math.cos(rad) * inst.s * R;
      var ky = R + Math.sin(rad) * inst.s * R;
      knob.style.left = kx + 'px';
      knob.style.top = ky + 'px';
      var full = hsvToRgb(inst.h, inst.s, 1);
      knob.style.background = rgbToHex(full.r, full.g, full.b);
      dim.style.opacity = String(1 - inst.v);

      track.style.background = 'linear-gradient(to bottom, ' +
        rgbToHex(full.r, full.g, full.b) + ', #000000)';
      sKnob.style.top = ((1 - inst.v) * D) + 'px';

      var hex = currentHex();
      swatch.style.background = hex;
      hexOut.textContent = hex;
    }

    // ---- interactions
    bindDrag(diskWrap, function (cx, cy) {
      var rect = diskWrap.getBoundingClientRect();
      var R = rect.width / 2;
      var dx = cx - (rect.left + R);
      var dy = cy - (rect.top + R);
      var h = Math.atan2(dy, dx) * 180 / Math.PI;
      if (h < 0) h += 360;
      inst.h = h;
      inst.s = clamp(Math.sqrt(dx * dx + dy * dy) / R, 0, 1); // rim-clamped
      render();
    });

    bindDrag(sliderWrap, function (cx, cy) {
      var rect = sliderWrap.getBoundingClientRect();
      inst.v = clamp(1 - (cy - rect.top) / rect.height, 0, 1);
      render();
    });

    okBtn.addEventListener('click', function () {
      var hex = currentHex();
      destroy(inst);
      if (inst.onPick) inst.onPick(hex);
    });

    function cancel() {
      destroy(inst);
      if (inst.onCancel) inst.onCancel();
    }
    cancelBtn.addEventListener('click', cancel);
    scrim.addEventListener('click', function (e) {
      if (e.target === scrim) cancel();
    });

    inst.onKeyDown = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) cancel();
    };
    document.addEventListener('keydown', inst.onKeyDown, true);

    render();
    return {
      close: function () { destroy(inst); },
      isOpen: function () { return !inst.destroyed; }
    };
  }

  window.ColorWheel = { open: open };
})();
