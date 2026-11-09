/* Animath editor, laid out like a phone video editor: preview on top, a timeline that is always visible
   and scrolls under a fixed centre playhead, a toolbar along the bottom, and pop-up panels for editing. */
(function () {
  'use strict';
  const A = window.Animath;
  const $ = s => document.querySelector(s);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k);
    return el;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };
  const uid = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);
  const clone = o => JSON.parse(JSON.stringify(o, (k, v) => k[0] === '_' ? undefined : v));
  const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
  const snap = v => Math.round(v * 20) / 20;
  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  function toast(msg) { document.querySelectorAll('.toast').forEach(t => t.remove()); const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2400); }
  function ask(msg, ok = 'OK') {
    return new Promise(res => {
      const d = h('dialog', { class: 'ask' });
      d.append(h('div', { class: 'dlg' }, h('p', {}, msg), h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn quiet', onclick: () => { d.close(); res(false); } }, 'Cancel'),
        h('button', { type: 'button', class: 'btn danger', onclick: () => { d.close(); res(true); } }, ok))));
      d.addEventListener('close', () => setTimeout(() => d.remove(), 50));
      document.body.append(d); d.showModal();
    });
  }

  const ASPECTS = [['16:9', 'Landscape 16:9'], ['9:16', 'Portrait 9:16'], ['1:1', 'Square 1:1'], ['4:5', 'Portrait 4:5'], ['4:3', 'Classic 4:3'], ['21:9', 'Cinema 21:9']];
  const BGS = [['#000000', 'Black (Manim)'], ['#1E1E24', 'Charcoal'], ['#0E1A2B', 'Navy'], ['#FBF8F1', 'Paper'], ['#FFFFFF', 'White']];
  const SWATCH = ['WHITE', 'GREY', 'BLUE', 'TEAL', 'GREEN', 'YELLOW', 'GOLD', 'ORANGE', 'RED', 'MAROON', 'PURPLE', 'PINK', 'INK'];
  const ratio = a => { const [w, hh] = a.split(':').map(Number); return w / hh; };
  const isLight = bg => { const c = String(A.color(bg)).replace('#', ''); const n = parseInt(c.length === 3 ? c.split('').map(x => x + x).join('') : c, 16); return ((n >> 16 & 255) * 0.3 + (n >> 8 & 255) * 0.59 + (n & 255) * 0.11) > 150; };
  const fmtT = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };

  // ---------- state ----------
  let scene = null, projId = null, sel = null, time = 0, playing = false, t0 = 0, guides = false, pps = 56;
  let hist = [], hi = -1, saveT = null, dirty = true, sheetKind = null;
  const stage = $('#stage'), sctx = stage.getContext('2d');

  function newScene(name) { return { v: 1, name: name || 'Untitled', aspect: '16:9', bg: '#000000', duration: 10, objects: [] }; }
  function makeObj(type, over = {}) {
    const T = A.TYPES[type];
    const n = scene.objects.filter(o => o.type === type).length + 1;
    const props = clone(T.defaults);
    if (isLight(scene.bg)) for (const k of ['color', 'axis']) if (props[k] === 'WHITE') props[k] = 'INK';
    const textish = ['text', 'math', 'title', 'truth'].includes(type);
    const o = {
      id: uid(), type, name: T.label + ' ' + n, start: round(time, 2), end: 0, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1,
      props, anIn: { type: textish ? 'write' : type === 'sticker' ? 'grow' : 'create', dur: type === 'graph' ? 2 : 1, rate: 'smooth' },
      anOut: { type: 'fadeout', dur: 0.6, rate: 'smooth' }, emph: [], keys: {}, loop: type === 'sticker' ? 'bob' : 'none'
    };
    o.end = round(o.start + 4, 2);
    Object.assign(o, over);
    if (over.props) o.props = Object.assign(props, over.props);
    return o;
  }

  // ---------- persistence and undo ----------
  const index = () => store.get('animath.index', []);
  function saveNow() {
    if (!scene || !projId) return;
    store.set('animath.p.' + projId, clone(scene));
    const ix = index().filter(p => p.id !== projId);
    ix.unshift({ id: projId, name: scene.name, updated: Date.now() });
    store.set('animath.index', ix);
  }
  function commit() {
    const s = JSON.stringify(clone(scene));
    if (hist[hi] === s) return;
    hist = hist.slice(0, hi + 1); hist.push(s); if (hist.length > 80) hist.shift(); hi = hist.length - 1;
    clearTimeout(saveT); saveT = setTimeout(saveNow, 300);
    updUndo();
  }
  let commitT = null;
  const commitSoon = () => { clearTimeout(commitT); commitT = setTimeout(commit, 400); };
  function undo(d) {
    const j = hi + d;
    if (j < 0 || j >= hist.length) return;
    hi = j; scene = JSON.parse(hist[hi]);
    if (sel && !scene.objects.some(o => o.id === sel)) sel = null;
    clearTimeout(saveT); saveT = setTimeout(saveNow, 300);
    refreshAll(); updUndo();
  }
  function updUndo() { $('#undo').disabled = hi <= 0; $('#redo').disabled = hi >= hist.length - 1; }
  function openProject(id) {
    const s = store.get('animath.p.' + id, null);
    if (!s) return false;
    projId = id; scene = s; sel = null; time = 0; playing = false;
    store.set('animath.current', id);
    hist = [JSON.stringify(clone(scene))]; hi = 0; updUndo();
    closeSheet(); refreshAll(); fillProjects();
    return true;
  }
  function createProject(s) { projId = uid(); scene = s; saveNow(); if (!openProject(projId)) { hist = [JSON.stringify(clone(scene))]; hi = 0; refreshAll(); fillProjects(); } }
  function fillProjects() {
    const p = $('#proj'); p.textContent = '';
    const ix = index();
    if (!ix.some(x => x.id === projId)) ix.unshift({ id: projId, name: scene.name });
    for (const it of ix) p.append(h('option', { value: it.id }, it.name));
    p.value = projId;
  }

  // ---------- stage ----------
  const narrow = () => matchMedia('(max-width: 899px)').matches;
  function sizeStage() {
    const wrap = $('#stageWrap');
    const r = ratio(scene.aspect);
    const colW = $('#col').clientWidth;
    const maxW = colW - 16, maxH = Math.max(150, window.innerHeight * (narrow() ? 0.42 : 0.52));
    let w = maxW, hh = w / r;
    if (hh > maxH) { hh = maxH; w = hh * r; }
    w = Math.floor(w); hh = Math.floor(hh);
    stage.style.width = w + 'px'; stage.style.height = hh + 'px';
    wrap.style.height = (hh + 16) + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    stage.width = Math.round(w * dpr); stage.height = Math.round(hh * dpr);
    document.documentElement.style.setProperty('--sheet-top', (wrap.getBoundingClientRect().bottom) + 'px');
    dirty = true;
    syncScroll();
  }
  function draw() {
    const W = stage.width, H = stage.height;
    A.render(sctx, scene, time, W, H);
    const ppu = H / 8;
    if (guides) {
      sctx.save(); sctx.strokeStyle = isLight(scene.bg) ? 'rgba(0,0,0,.12)' : 'rgba(255,255,255,.12)'; sctx.lineWidth = 1;
      const uw = W / ppu / 2;
      for (let x = -Math.floor(uw); x <= uw; x++) { sctx.beginPath(); sctx.moveTo(W / 2 + x * ppu, 0); sctx.lineTo(W / 2 + x * ppu, H); sctx.stroke(); }
      for (let y = -4; y <= 4; y++) { sctx.beginPath(); sctx.moveTo(0, H / 2 - y * ppu); sctx.lineTo(W, H / 2 - y * ppu); sctx.stroke(); }
      sctx.strokeStyle = isLight(scene.bg) ? 'rgba(0,0,0,.3)' : 'rgba(255,255,255,.3)';
      sctx.beginPath(); sctx.moveTo(W / 2, 0); sctx.lineTo(W / 2, H); sctx.moveTo(0, H / 2); sctx.lineTo(W, H / 2); sctx.stroke();
      sctx.restore();
    }
    const o = selObj();
    if (o && o._hit && !playing) {
      const g = boxGeom(o, W, H), k = W / stage.getBoundingClientRect().width || 1;
      sctx.save();
      sctx.strokeStyle = '#FFFFFF'; sctx.lineWidth = 1.5 * k; sctx.shadowColor = 'rgba(0,0,0,.6)'; sctx.shadowBlur = 3 * k;
      sctx.beginPath(); g.corners.forEach(([x, y], i) => i ? sctx.lineTo(x, y) : sctx.moveTo(x, y)); sctx.closePath(); sctx.stroke();
      sctx.beginPath(); sctx.moveTo(...g.top); sctx.lineTo(...g.rot); sctx.stroke();
      sctx.fillStyle = '#FFFFFF';
      for (const [x, y] of g.corners) { sctx.beginPath(); sctx.rect(x - 5 * k, y - 5 * k, 10 * k, 10 * k); sctx.fill(); }
      for (const [x, y, ax] of g.sides) { sctx.save(); sctx.translate(x, y); sctx.rotate(ax); sctx.beginPath(); (sctx.roundRect ? sctx.roundRect(-7 * k, -3 * k, 14 * k, 6 * k, 3 * k) : sctx.rect(-7 * k, -3 * k, 14 * k, 6 * k)); sctx.fill(); sctx.restore(); }
      sctx.beginPath(); sctx.arc(g.rot[0], g.rot[1], 8 * k, 0, 7); sctx.fill();
      sctx.strokeStyle = '#111'; sctx.lineWidth = 1.6 * k; sctx.shadowBlur = 0;
      sctx.beginPath(); sctx.arc(g.rot[0], g.rot[1], 4 * k, -0.3, 4.4); sctx.stroke();
      sctx.restore();
    }
    $('#time').textContent = fmtT(time);
    $('#dur').textContent = fmtT(scene.duration);
    const kb = $('#keyBtn');
    if (kb) { const on = o && Object.values(o.keys || {}).some(k => k.some(q => Math.abs(q.t - time) < 0.026)); kb.classList.toggle('on', !!on); kb.disabled = !o; }
  }
  function loop() {
    if (playing) {
      time = (performance.now() - t0) / 1000;
      if (time >= scene.duration) {
        if ($('#loopBtn').getAttribute('aria-pressed') === 'true') { t0 = performance.now(); time = 0; }
        else { time = scene.duration; setPlaying(false); }
      }
      draw(); syncScroll();
    } else if (dirty) { draw(); dirty = false; }
    requestAnimationFrame(loop);
  }
  function setPlaying(on) {
    playing = on;
    if (on) { if (time >= scene.duration - 0.01) time = 0; t0 = performance.now() - time * 1000; }
    document.querySelectorAll('.playbtn').forEach(b => { b.textContent = on ? '❚❚' : '▶'; b.setAttribute('aria-label', on ? 'Pause' : 'Play'); });
    dirty = true;
    if (!on) refreshSheetValues();
  }
  function setTime(t, fromScroll) {
    time = Math.max(0, Math.min(scene.duration, t)); dirty = true;
    if (!fromScroll) syncScroll();
    if (!playing) refreshSheetValues();
  }
  const selObj = () => (scene && scene.objects.find(o => o.id === sel)) || null;
  function select(id) {
    sel = id; dirty = true;
    renderTools(); renderTimeline();
    if (sheetKind && !['scene', 'add'].includes(sheetKind.split(':')[0])) { if (id) openSheet(sheetKind); else closeSheet(); }
  }

  // ---------- transform box: corners scale evenly, side bars stretch one way, the round handle rotates ----------
  function boxGeom(o, W, H) {
    const { st, bb } = o._hit, ppu = H / 8;
    const c = Math.cos(st.rotation), s2 = Math.sin(st.rotation);
    const P = (lx, ly) => { const X = lx * st.scale * st.sx, Y = -ly * st.scale * st.sy; const wx = st.x + X * c - Y * s2, wy = st.y + X * s2 + Y * c; return [W / 2 + wx * ppu, H / 2 - wy * ppu]; };
    const px = 0.13 / Math.max(0.02, Math.abs(st.scale * st.sx)), py = 0.13 / Math.max(0.02, Math.abs(st.scale * st.sy));
    const x0 = bb[0] - px, x1 = bb[2] + px, y0 = bb[1] - py, y1 = bb[3] + py, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const corners = [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)];
    const top = P(cx, y0), center = P(cx, cy);
    const dx = top[0] - center[0], dy = top[1] - center[1], L = Math.hypot(dx, dy) || 1, k = W / (stage.getBoundingClientRect().width || W);
    const rot = [top[0] + dx / L * 30 * k, top[1] + dy / L * 30 * k];
    const ang = -st.rotation;
    const sides = [[...top, ang], [...P(x1, cy), ang + Math.PI / 2], [...P(cx, y1), ang], [...P(x0, cy), ang + Math.PI / 2]];
    return { corners, sides, top, rot, center };
  }
  let sdrag = null;
  const toUnits = (e, r) => { const ppu = r.height / 8; return [(e.clientX - r.left - r.width / 2) / ppu, -(e.clientY - r.top - r.height / 2) / ppu]; };
  stage.addEventListener('pointerdown', e => {
    const r = stage.getBoundingClientRect();
    const [ux, uy] = toUnits(e, r);
    const cur = selObj();
    if (cur && cur._hit && !playing) {
      const g = boxGeom(cur, r.width, r.height), mx = e.clientX - r.left, my = e.clientY - r.top;
      const near = ([x, y]) => Math.hypot(x - mx, y - my) < 20;
      let mode = null;
      if (near(g.rot)) mode = 'rot';
      else if (g.corners.some(near)) mode = 'corner';
      else { const i = g.sides.findIndex(near); if (i >= 0) mode = i % 2 ? 'sx' : 'sy'; }
      if (mode) {
        const k = p => A.keyVal(cur, p, time);
        sdrag = { o: cur, mode, ux, uy, x0: k('x'), y0: k('y'), s0: k('scale'), sx0: k('sx'), sy0: k('sy'), r0: k('rotation'), moved: false };
        stage.setPointerCapture(e.pointerId);
        return;
      }
    }
    const o = A.hitTest(scene, ux, uy);
    if (!o) { if (sel) select(null); return; }
    if (o.id !== sel) select(o.id);
    if (playing) setPlaying(false);
    sdrag = { o, mode: 'move', ux, uy, x0: A.keyVal(o, 'x', time), y0: A.keyVal(o, 'y', time), moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener('pointermove', e => {
    if (!sdrag) return;
    const r = stage.getBoundingClientRect();
    const [ux, uy] = toUnits(e, r);
    const d = sdrag;
    if (!d.moved && Math.hypot(ux - d.ux, uy - d.uy) < 0.05) return;
    d.moved = true;
    const o = d.o, cx = d.x0, cy = d.y0;
    if (d.mode === 'move') {
      let nx = d.x0 + ux - d.ux, ny = d.y0 + uy - d.uy;
      if (guides) { nx = Math.round(nx * 4) / 4; ny = Math.round(ny * 4) / 4; }
      setProp(o, 'x', round(nx, 2)); setProp(o, 'y', round(ny, 2));
    } else if (d.mode === 'corner') {
      const f = Math.hypot(ux - cx, uy - cy) / (Math.hypot(d.ux - cx, d.uy - cy) || 1);
      setProp(o, 'scale', round(Math.max(0.05, d.s0 * f), 3));
    } else if (d.mode === 'sx' || d.mode === 'sy') {
      const a = d.r0 * Math.PI / 180, ax = d.mode === 'sx' ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)];
      const p0 = (d.ux - cx) * ax[0] + (d.uy - cy) * ax[1], p1 = (ux - cx) * ax[0] + (uy - cy) * ax[1];
      let v = (d.mode === 'sx' ? d.sx0 : d.sy0) * (p1 / (p0 || 1e-6));
      if (Math.abs(v) < 0.05) v = 0.05 * (Math.sign(v) || 1);
      setProp(o, d.mode, round(v, 3));
    } else if (d.mode === 'rot') {
      let deg = d.r0 + (Math.atan2(uy - cy, ux - cx) - Math.atan2(d.uy - cy, d.ux - cx)) * 180 / Math.PI;
      const snapTo = Math.round(deg / 15) * 15;
      if (Math.abs(deg - snapTo) < 4) deg = snapTo;
      setProp(o, 'rotation', round(deg, 1));
    }
    dirty = true; refreshSheetValues();
  });
  const endDrag = () => { if (sdrag && sdrag.moved) { commit(); renderTimeline(); } sdrag = null; };
  stage.addEventListener('pointerup', endDrag); stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', () => { if (selObj()) openSheet('edit'); });

  function setProp(o, p, v) {
    const k = o.keys[p];
    if (k && k.length) {
      const t = round(time, 2);
      const ex = k.find(q => Math.abs(q.t - t) < 0.026);
      if (ex) ex.v = v; else { k.push({ t, v }); k.sort((a, b) => a.t - b.t); }
    } else o[p] = v;
  }
  function keyHere(o) { return Object.values(o.keys || {}).some(k => k.some(q => Math.abs(q.t - time) < 0.026)); }
  function toggleAllKeys() {
    const o = selObj(); if (!o) return;
    const t = round(time, 2);
    if (keyHere(o)) {
      for (const p of Object.keys(o.keys)) { o.keys[p] = o.keys[p].filter(q => Math.abs(q.t - t) >= 0.026); if (!o.keys[p].length) delete o.keys[p]; }
      toast('Keyframe removed at ' + fmtT(t));
    } else {
      for (const p of A.KEYABLE) { const k = o.keys[p] || (o.keys[p] = []); k.push({ t, v: A.keyVal(o, p, time) }); k.sort((a, b) => a.t - b.t); }
      toast('Keyframe added. Move the playhead, then drag or edit the object.');
    }
    commit(); renderTimeline(); dirty = true; refreshSheet();
  }
  function toggleKey(o, p) {
    const t = round(time, 2);
    const k = o.keys[p] || (o.keys[p] = []);
    const i = k.findIndex(q => Math.abs(q.t - t) < 0.026);
    if (i >= 0) { k.splice(i, 1); if (!k.length) delete o.keys[p]; }
    else { k.push({ t, v: A.keyVal(o, p, time) }); k.sort((a, b) => a.t - b.t); }
    commit(); refreshSheet(); renderTimeline(); dirty = true;
  }

  // ---------- add catalogue ----------
  const CATS = {
    text: { label: 'Text', icon: 'T', items: [['title', {}, 'Title card', 'H'], ['text', {}, 'Text', 'T'], ['math', {}, 'Maths', '∑'], ['math', { props: { tex: 'f(x) &= x^2 + 2x + 1 \\\\ &= (x+1)^2' } }, 'Working', '≡'], ['text', { props: { text: 'Note', size: 0.45, font: 'sans', color: 'GREY' } }, 'Caption', 'a']] },
    shapes: { label: 'Shapes', icon: '◯', items: [['shape', { props: { shape: 'circle' } }, 'Circle', '◯'], ['shape', { props: { shape: 'square', fo: 0.3 } }, 'Square', '□'], ['shape', { props: { shape: 'rect', color: 'WHITE', fill: 'WHITE', fo: 0 } }, 'Rectangle', '▭'],
      ['shape', { props: { shape: 'polygon', n: 6, color: 'TEAL', fill: 'TEAL', fo: 0.2 } }, 'Polygon', '⬡'], ['shape', { props: { shape: 'star', n: 5, color: 'GOLD', fill: 'GOLD', fo: 0.6 } }, 'Star', '☆'], ['shape', { props: { shape: 'ellipse', color: 'GREEN', fill: 'GREEN', fo: 0.2 } }, 'Ellipse', '⬭'],
      ['shape', { props: { shape: 'arrow', color: 'WHITE' } }, 'Arrow', '→'], ['shape', { props: { shape: 'darrow', color: 'WHITE' } }, 'Both ways', '↔'], ['shape', { props: { shape: 'line', color: 'WHITE' } }, 'Line', '—'],
      ['shape', { props: { shape: 'dot', color: 'YELLOW' } }, 'Dot', '•'], ['shape', { props: { shape: 'arc', color: 'YELLOW' } }, 'Arc', '◠'], ['shape', { props: { shape: 'brace', w: 3, color: 'WHITE' } }, 'Brace', '⏟'],
      ['geom', {}, 'Triangle', '△'], ['geom', { props: { pts: '-2,-1.2  2,-1.2  -2,1.6', labels: 'A B C', sides: 'a b c' } }, 'Right triangle', '◺']] },
    graph: { label: 'Graph', icon: '∿', items: [['graph', {}, 'sin & cos', '∿'], ['graph', { props: { f1: 'x^2/2', l1: 'y = \\tfrac{x^2}{2}', f2: '', xmin: -4, xmax: 4, ymin: -1, ymax: 6, area: true, a: 0, b: 2 } }, 'Area', '∫'],
      ['graph', { props: { f1: 'exp(x)', l1: 'e^x', f2: 'ln(x)', l2: '\\ln x', xmin: -3, xmax: 5, ymin: -3, ymax: 5, grid: true } }, 'Exp & log', 'eˣ'], ['graph', { props: { f1: '1/(1+exp(-x))', l1: '\\sigma(x)', f2: '', xmin: -6, xmax: 6, ymin: -0.2, ymax: 1.2, tracer: true } }, 'Sigmoid', 'σ'],
      ['graph', { props: { f1: '', f2: '', l1: '', xmin: -5, xmax: 5, ymin: -3, ymax: 3, grid: true } }, 'Empty axes', '┼']] },
    logic: { label: 'Logic', icon: '∀', items: [['venn', {}, 'Venn 2', '◎'], ['venn', { props: { n: 3, shade: '(A ∩ B) ∪ C' } }, 'Venn 3', '⊛'], ['truth', {}, 'Truth table', '⊤'], ['truth', { props: { formula: '~(P & Q) <-> ~P | ~Q' } }, 'De Morgan', '¬'],
      ['math', { props: { tex: '\\forall x \\, (P(x) \\to Q(x))' } }, 'Quantifier', '∀'], ['math', { props: { tex: 'A \\cup B = \\{ x \\mid x \\in A \\lor x \\in B \\}' } }, 'Set builder', '∪'],
      ['math', { props: { tex: '\\Box P \\to \\Diamond P' } }, 'Modal', '□'], ['math', { props: { tex: 'P \\to Q,\\; P \\vdash Q' } }, 'Sequent', '⊢']] },
    nodes: { label: 'Nodes', icon: '⋰', items: [['net', {}, 'Ring', '◯'], ['net', { props: { layout: 'complete', n: 6, motion: 'breathe' } }, 'Complete K₆', '✳'], ['net', { props: { layout: 'star', n: 8, nodec: 'GOLD' } }, 'Star', '✶'],
      ['net', { props: { layout: 'tree', n: 15, motion: 'none', nodec: 'GREEN', node: 0.14 } }, 'Tree', '⊥'], ['net', { props: { layout: 'grid', n: 16, motion: 'wave', node: 0.12, nodec: 'TEAL' } }, 'Grid', '#'],
      ['net', { props: { layout: 'random', n: 12, nodec: 'PINK', node: 0.13 } }, 'Random', '⁘'], ['net', { props: { layout: 'petersen', nodec: 'PURPLE', motion: 'rotate' } }, 'Petersen', '⬠'],
      ['net', { props: { layout: 'ring', n: 6, directed: true, curved: true, labels: 'abc', nodec: 'YELLOW', motion: 'none' } }, 'Directed', '↻'], ['net', { props: { layout: 'wheel', n: 9, labels: 'num', node: 0.2, motion: 'jitter', speed: 0.5 } }, 'Wheel', '⊛']] },
    geometry: { label: 'Geometry', icon: '∞', items: [['curve', {}, 'Lissajous', '∞'], ['curve', { props: { shape: 'rose', k: 5, color: 'PINK' } }, 'Rose', '✿'], ['curve', { props: { shape: 'spiral', color: 'GOLD' } }, 'Spiral', '@'],
      ['curve', { props: { shape: 'heart', color: 'RED' } }, 'Heart', '♡'], ['curve', { props: { shape: 'butterfly', color: 'PURPLE' } }, 'Butterfly', 'ʚɞ'], ['curve', { props: { shape: 'spiro', color: 'GREEN' } }, 'Spirograph', '❁'],
      ['curve', { props: { shape: 'epicycloid', k: 4, color: 'YELLOW' } }, 'Epicycloid', '✧'], ['curve', { props: { shape: 'custom' } }, 'x(t), y(t)', 'ƒ'],
      ['fractal', {}, 'Koch snowflake', '❄'], ['fractal', { props: { kind: 'sierpinski', depth: 5, color: 'YELLOW' } }, 'Sierpiński', '△'], ['fractal', { props: { kind: 'tree', depth: 8, color: 'GREEN' } }, 'Fractal tree', 'Y'],
      ['fractal', { props: { kind: 'dragon', depth: 8, color: 'ORANGE' } }, 'Dragon', '⌇'], ['fractal', { props: { kind: 'hilbert', depth: 4, color: 'TEAL' } }, 'Hilbert', '⊓'], ['fractal', { props: { kind: 'carpet', depth: 3, color: 'PURPLE' } }, 'Carpet', '▦']] },
    solids: { label: '3D', icon: '⬢', items: [['solid', { props: { shape: 'cube' } }, 'Cube', '◫'], ['solid', { props: { shape: 'tetrahedron', color: 'GOLD' } }, 'Tetrahedron', '△'], ['solid', { props: { shape: 'octahedron', color: 'GREEN' } }, 'Octahedron', '◇'],
      ['solid', {}, 'Icosahedron', '⬡'], ['solid', { props: { shape: 'dodecahedron', color: 'PURPLE' } }, 'Dodecahedron', '⬠'], ['solid', { props: { shape: 'sphere', style: 'wire', color: 'BLUE', tilt: 10 } }, 'Sphere', '◍'],
      ['solid', { props: { shape: 'torus', color: 'PINK', pitch: 55 } }, 'Torus', '◎'], ['solid', { props: { shape: 'cylinder', color: 'TEAL' } }, 'Cylinder', '▯'], ['solid', { props: { shape: 'cone', color: 'ORANGE' } }, 'Cone', '▲'],
      ['solid', { props: { shape: 'pyramid', color: 'YELLOW' } }, 'Pyramid', '⏶'], ['solid', { props: { shape: 'prism', color: 'RED' } }, 'Prism', '⧋']] },
    stickers: { label: 'Stickers', icon: '★', items: ['star', 'heart', 'check', 'cross', 'bulb', 'speech', 'thought', 'sparkle', 'arrow', 'question', 'exclaim', 'pin', 'brain'].map(k => ['sticker', { props: { kind: k } }, k[0].toUpperCase() + k.slice(1), { star: '★', heart: '♥', check: '✓', cross: '✕', bulb: '◍', speech: '❝', thought: '◌', sparkle: '✦', arrow: '➜', question: '?', exclaim: '!', pin: '⌖', brain: '❦' }[k]]) }
  };
  function addObj(type, over) {
    if (playing) setPlaying(false);
    const o = makeObj(type, clone(over || {}));
    if (o.end > scene.duration) scene.duration = Math.ceil(o.end);
    scene.objects.push(o);
    commit(); sel = o.id; renderTools(); renderTimeline(); dirty = true;
    openSheet('edit');
  }

  // ---------- toolbar ----------
  function tool(icon, label, fn, cls, id) { return h('button', { type: 'button', class: 'tool ' + (cls || ''), onclick: fn, id: id || null }, h('span', { class: 'ti' }, icon), h('span', { class: 'tlab' }, label)); }
  function renderTools() {
    const bar = $('#tools'); bar.textContent = '';
    const o = selObj();
    if (!o) {
      for (const [k, c] of Object.entries(CATS)) bar.append(tool(c.icon, c.label, () => openSheet('add:' + k), sheetKind === 'add:' + k ? 'active' : ''));
      bar.append(tool('▣', 'Scene', () => openSheet('scene'), sheetKind === 'scene' ? 'active' : ''));
    } else {
      bar.append(tool('‹', 'Done', () => select(null), 'back'));
      bar.append(tool('✎', 'Edit', () => openSheet('edit'), sheetKind === 'edit' ? 'active' : ''));
      bar.append(tool('◐', 'Animate', () => { if (animTab === 'effects') animTab = 'in'; openSheet('animate'); }, sheetKind === 'animate' && animTab !== 'effects' ? 'active' : ''));
      bar.append(tool('✺', 'Effects', () => { animTab = 'effects'; openSheet('animate'); }, sheetKind === 'animate' && animTab === 'effects' ? 'active' : ''));
      bar.append(tool('☀', 'Glow', () => openSheet('style'), sheetKind === 'style' ? 'active' : ''));
      bar.append(tool('◆', 'Keyframe', toggleAllKeys, keyHere(o) ? 'on' : '', 'keyBtn'));
      bar.append(tool('⤨', 'Position', () => openSheet('position'), sheetKind === 'position' ? 'active' : ''));
      bar.append(tool('⧉', 'Copy', dup));
      bar.append(tool('⇡', 'Forward', () => move(1)));
      bar.append(tool('⇣', 'Back', () => move(-1)));
      bar.append(tool('⌫', 'Delete', del, 'danger'));
    }
  }

  // ---------- sheets ----------
  function openSheet(kind) {
    sheetKind = kind;
    document.body.classList.add('sheet-open');
    $('#sheet').hidden = false;
    renderSheet(); renderTools();
    if (!narrow()) sizeStage();
  }
  function closeSheet() {
    sheetKind = null;
    document.body.classList.remove('sheet-open');
    $('#sheet').hidden = true;
    if (scene) { renderTools(); if (!narrow()) sizeStage(); }
  }
  function refreshSheet() { if (sheetKind) renderSheet(); }
  function renderSheet() {
    const body = $('#sheetBody'); const title = $('#sheetTitle');
    previews.clear();
    const keepScroll = body.scrollTop;
    body.textContent = '';
    const k = sheetKind || '';
    const o = selObj();
    if (k.startsWith('add:')) {
      const c = CATS[k.slice(4)];
      title.textContent = 'Add ' + c.label.toLowerCase();
      const g = h('div', { class: 'addgrid' });
      for (const [type, over, label, icon] of c.items) g.append(h('button', { type: 'button', class: 'addbtn', onclick: () => addObj(type, over) }, h('span', { class: 'ic' }, icon), h('span', {}, label)));
      body.append(g, h('p', { class: 'muted small' }, 'It’s added at the playhead (' + fmtT(time) + ') for 4 seconds. Drag it on the preview to place it.'));
    } else if (k === 'scene') { title.textContent = 'Scene'; sceneSheet(body); }
    else if (!o) { closeSheet(); return; }
    else if (k === 'edit') { title.textContent = o.name; editSheet(body, o); }
    else if (k === 'position') { title.textContent = 'Position & keyframes'; positionSheet(body, o); }
    else if (k === 'animate') { title.textContent = 'Animate'; animateSheet(body, o); }
    else if (k === 'style') { title.textContent = 'Glow & style'; styleSheet(body, o); }
    body.scrollTop = keepScroll;
  }
  $('#sheetClose').addEventListener('click', closeSheet);

  // form helpers
  function colorField(val, onset, allowBlank) {
    const wrap = h('div', { class: 'swatches' });
    const cur = A.color(val) || '';
    const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#ffffff', title: 'Custom colour', 'aria-label': 'Custom colour' });
    inp.addEventListener('input', () => { onset(inp.value.toUpperCase()); mark(inp.value.toUpperCase()); });
    function mark(v) { wrap.querySelectorAll('.sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === v || (v && A.color(b.dataset.v) === A.color(v)))); }
    if (allowBlank) wrap.append(h('button', { type: 'button', class: 'sw blank', 'data-v': '', title: 'Default', onclick: () => { onset(''); mark(''); } }, '∅'));
    for (const s of SWATCH) wrap.append(h('button', { type: 'button', class: 'sw', 'data-v': s, title: s.toLowerCase(), 'aria-label': s.toLowerCase(), style: 'background:' + A.color(s), onclick: () => { onset(s); mark(s); } }));
    wrap.append(inp);
    mark(val || '');
    return wrap;
  }
  const field = (label, control) => h('label', { class: 'fld' }, h('span', { class: 'fl' }, label), control);
  function numInput(v, step, on, id) {
    const i = h('input', { type: 'number', step: step || 0.1, value: v, inputmode: 'decimal', id: id || null });
    i.addEventListener('input', () => { const n = parseFloat(i.value); if (isFinite(n)) on(n); });
    return i;
  }
  function selectInput(opts, v, on) {
    const s = h('select', { onchange: () => on(s.value) }, opts.map(([k, l]) => h('option', { value: k }, l)));
    s.value = v; return s;
  }
  function stepper(v, step, on) {
    const i = numInput(v, step, on);
    const bump = d => { const n = round((parseFloat(i.value) || 0) + d, 3); i.value = n; on(n); };
    return h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Decrease', onclick: () => bump(-step) }, '−'), i, h('button', { type: 'button', 'aria-label': 'Increase', onclick: () => bump(step) }, '+'));
  }
  const group = (title, ...kids) => h('section', { class: 'grp' }, title ? h('h3', {}, title) : null, ...kids);

  function editSheet(body, o) {
    const T = A.TYPES[o.type];
    const P = Object.assign({}, T.defaults, o.props);
    const changed = tl => { dirty = true; commitSoon(); if (tl) renderTimeline(); };
    const name = h('input', { type: 'text', value: o.name, 'aria-label': 'Name' });
    name.addEventListener('input', () => { o.name = name.value; $('#sheetTitle').textContent = o.name; changed(true); });
    body.append(field('Name', name));
    const err = h('div', { class: 'err', hidden: true });
    function validate() {
      let msg = '';
      try {
        if (o.type === 'graph') { A.compileFn(o.props.f1 ?? P.f1); A.compileFn(o.props.f2 ?? P.f2); }
        if (o.type === 'venn') A.parseSet(o.props.shade ?? P.shade);
        if (o.type === 'truth') A.parseLogic(o.props.formula ?? P.formula);
      } catch (e) { msg = e.message; }
      err.hidden = !msg; err.textContent = msg;
    }
    const conditional = T.fields.some(f => f[4]);
    for (const [key, label, kind, opt, when] of T.fields) {
      if (when && !when(P)) continue;
      const set = v => { o.props[key] = v; changed(); if (conditional) setTimeout(refreshSheetIfNotTyping, 0); };
      let c;
      if (kind === 'textarea' || kind === 'text') {
        c = h(kind === 'textarea' ? 'textarea' : 'input', kind === 'textarea' ? { rows: 2, spellcheck: 'false', autocapitalize: 'off' } : { type: 'text', spellcheck: 'false', autocapitalize: 'off' });
        c.value = P[key];
        c.addEventListener('input', () => { o.props[key] = c.value; changed(); validate(); });
        if (key === 'tex' || (o.type === 'text' && key === 'text')) { body.append(field(label, c), texKeys(c, v => { o.props[key] = v; changed(); })); continue; }
      }
      else if (kind === 'num') c = stepper(P[key], opt, set);
      else if (kind === 'select') c = selectInput(opt.map(x => [String(x[0]), x[1]]), String(P[key]), v => set(isNaN(+v) || v === '' ? v : +v));
      else if (kind === 'bool') { c = h('input', { type: 'checkbox' }); c.checked = !!P[key]; c.addEventListener('change', () => set(c.checked)); body.append(h('label', { class: 'chk' }, c, h('span', {}, label))); continue; }
      else if (kind === 'color') c = colorField(P[key], set, key === 'fill' && o.type === 'sticker');
      body.append(field(label, c));
    }
    body.append(err); validate();
    if (o.type === 'math') body.append(h('p', { class: 'muted small' }, 'LaTeX: \\frac{a}{b}, \\sqrt{x}, x^2, x_i, \\sum_{n=1}^{\\infty}, \\int_a^b, \\alpha … \\omega, \\forall \\exists \\land \\lor \\neg \\to \\vdash \\models, \\in \\cup \\cap \\subseteq \\emptyset, \\mathbb{R}, \\color{BLUE}{x}, \\text{words}. Use \\\\ for a new line and & to line equations up.'));
    if (o.type === 'text') body.append(h('p', { class: 'muted small' }, 'Put maths between dollar signs: The area is $\\pi r^2$.'));
    body.append(group('On screen', h('div', { class: 'two' },
      field('From (s)', numInput(o.start, 0.1, v => { o.start = Math.max(0, Math.min(v, o.end - 0.1)); changed(true); })),
      field('To (s)', numInput(o.end, 0.1, v => { o.end = Math.max(v, o.start + 0.1); if (o.end > scene.duration) scene.duration = Math.ceil(o.end); changed(true); })))));
  }
  function refreshSheetIfNotTyping() { const a = document.activeElement; if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'))) return; refreshSheet(); }
  // quick-insert keys for LaTeX on a phone keyboard
  function texKeys(ta, onv) {
    const keys = [['\\', '\\'], ['{ }', '{}', 1], ['^', '^{}', 1], ['_', '_{}', 1], ['frac', '\\frac{}{}', 6], ['√', '\\sqrt{}', 1], ['∑', '\\sum_{}^{}', 4], ['∫', '\\int_{}^{}', 4], ['α', '\\alpha '], ['π', '\\pi '], ['θ', '\\theta '],
      ['∀', '\\forall '], ['∃', '\\exists '], ['∧', '\\land '], ['∨', '\\lor '], ['¬', '\\neg '], ['→', '\\to '], ['↔', '\\leftrightarrow '], ['⊢', '\\vdash '], ['∈', '\\in '], ['∪', '\\cup '], ['∩', '\\cap '], ['⊆', '\\subseteq '], ['∅', '\\emptyset '], ['ℝ', '\\mathbb{R}'], ['≤', '\\leq '], ['≠', '\\neq '], ['×', '\\times '], ['$', '$$', 1]];
    const bar = h('div', { class: 'texkeys' });
    for (const [lab, ins, back] of keys) bar.append(h('button', { type: 'button', onpointerdown: e => e.preventDefault(), onclick: () => {
      const a = ta.selectionStart ?? ta.value.length, b = ta.selectionEnd ?? a;
      ta.value = ta.value.slice(0, a) + ins + ta.value.slice(b);
      const p = a + ins.length - (back || 0);
      ta.focus(); ta.setSelectionRange(p, p); onv(ta.value);
    } }, lab));
    return bar;
  }
  function positionSheet(body, o) {
    const props = [['x', 'Across (x)', 0.25], ['y', 'Up (y)', 0.25], ['scale', 'Size', 0.1], ['sx', 'Stretch wide', 0.1], ['sy', 'Stretch tall', 0.1], ['rotation', 'Rotation (°)', 15], ['opacity', 'Opacity', 0.1]];
    body.append(h('p', { class: 'muted small' }, 'On the preview: drag a corner to resize, a side bar to stretch one way (drag past the middle to mirror it), and the round handle to rotate (it clicks to every 15°).'));
    body.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { for (const [p, v] of [['scale', 1], ['sx', 1], ['sy', 1], ['rotation', 0]]) setProp(o, p, v); commit(); refreshSheet(); dirty = true; } }, 'Reset size & rotation'),
      h('button', { type: 'button', class: 'btn', onclick: () => { setProp(o, 'sx', -A.keyVal(o, 'sx', time)); commit(); refreshSheet(); dirty = true; } }, '⇋ Mirror'),
      h('button', { type: 'button', class: 'btn', onclick: () => { setProp(o, 'sy', -A.keyVal(o, 'sy', time)); commit(); refreshSheet(); dirty = true; } }, '⇵ Flip')));
    for (const [p, label, step] of props) {
      const k = o.keys[p] || [];
      const here = k.some(q => Math.abs(q.t - time) < 0.026);
      const kb = h('button', { type: 'button', class: 'keybtn' + (here ? ' on' : k.length ? ' some' : ''), title: here ? 'Remove keyframe here' : 'Add keyframe here', 'aria-label': (here ? 'Remove ' : 'Add ') + label + ' keyframe', onclick: () => toggleKey(o, p) }, here ? '◆' : '◇');
      const st = stepper(round(A.keyVal(o, p, time), 2), step, v => { setProp(o, p, v); dirty = true; commitSoon(); if (k.length) renderTimelineSoon(); });
      st.querySelector('input').dataset.prop = p;
      body.append(h('div', { class: 'kfrow' }, h('span', { class: 'fl' }, label), st, kb));
    }
    const kt = [...new Set(Object.values(o.keys).flat().map(q => q.t))].sort((a, b) => a - b);
    if (kt.length) {
      body.append(h('div', { class: 'kchips' }, kt.map(t => h('button', { type: 'button', class: 'chip', onclick: () => setTime(t) }, '◆ ' + fmtT(t))),
        h('button', { type: 'button', class: 'chip quiet', onclick: () => { o.keys = {}; commit(); refreshSheet(); renderTimeline(); dirty = true; } }, 'Clear all')));
      body.append(h('p', { class: 'muted small' }, 'A property with keyframes animates between them. Changing it, or dragging the object, sets a keyframe at the playhead.'));
    } else body.append(h('p', { class: 'muted small' }, 'To animate movement: tap ◆ Keyframe in the toolbar, move the playhead along the timeline, then drag the object to its new place. Tap ◇ here to keyframe one property only.'));
    body.append(h('label', { class: 'chk' }, (() => { const c = h('input', { type: 'checkbox' }); c.checked = guides; c.addEventListener('change', () => { guides = c.checked; $('#guides').setAttribute('aria-pressed', guides); dirty = true; }); return c; })(), h('span', {}, 'Show the coordinate grid and snap to quarter units')));
  }
  // ---------- animation presets with live preview tiles ----------
  let animTab = 'in';
  const previews = new Map();
  let pvRaf = 0, pvLast = 0;
  function miniScene(o, tab, k) {
    const m = clone(o);
    Object.assign(m, { id: 'pv', x: 0, y: 0, keys: {}, emph: [], loop: 'none', rotation: 0, opacity: 1, sx: 1, sy: 1, scale: 1 });
    const b = A.build(m), bw = (b.bb[2] - b.bb[0]) || 1, bh = (b.bb[3] - b.bb[1]) || 1;
    m.scale = Math.min(8.4 / bw, 5.2 / bh, 2.5);
    let cycle = 2;
    if (tab === 'in') Object.assign(m, { start: 0, end: 999, anIn: { type: k, dur: 1, rate: k === 'write' ? 'linear' : 'smooth' }, anOut: { type: 'none', dur: 0 } });
    else if (tab === 'out') { Object.assign(m, { start: -10, end: 1.3, anIn: { type: 'appear', dur: 0 }, anOut: { type: k === 'transform' ? 'fadeout' : k, dur: 1 } }); cycle = 2.2; }
    else if (tab === 'loop') Object.assign(m, { start: 0, end: 1e6, anIn: { type: 'appear', dur: 0 }, anOut: { type: 'none', dur: 0 }, loop: k });
    else { Object.assign(m, { start: -10, end: 1e6, anIn: { type: 'appear', dur: 0 }, anOut: { type: 'none', dur: 0 }, emph: [{ type: k, t: 0.25, dur: 1.2 }] }); cycle = 1.9; }
    return { scene: { bg: '#000', duration: 1e6, objects: [m] }, cycle, tab };
  }
  function pvLoop(now) {
    pvRaf = 0;
    if (!previews.size || sheetKind !== 'animate') return;
    if (now - pvLast > 33) {
      pvLast = now;
      const tt = now / 1000, vh = innerHeight;
      for (const [c, d] of previews) {
        if (!c.isConnected) { previews.delete(c); continue; }
        const r = c.getBoundingClientRect();
        if (r.bottom < 0 || r.top > vh) continue;
        const t = d.tab === 'loop' ? tt : tt % d.cycle;
        A.render(c.getContext('2d'), d.scene, t, c.width, c.height);
      }
    }
    pvRaf = requestAnimationFrame(pvLoop);
  }
  function animateSheet(body, o) {
    const changed = tl => { dirty = true; commitSoon(); if (tl) renderTimeline(); };
    const rates = [['smooth', 'Smooth'], ['linear', 'Linear'], ['easeIn', 'Ease in'], ['easeOut', 'Ease out'], ['backOut', 'Overshoot'], ['bounce', 'Bounce'], ['elastic', 'Elastic']];
    body.append(h('div', { class: 'tabs', role: 'tablist' }, [['in', 'In'], ['out', 'Out'], ['loop', 'Loop'], ['effects', 'Effects']].map(([k, l]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': animTab === k, class: 'tab' + (animTab === k ? ' on' : ''), onclick: () => { animTab = k; refreshSheet(); renderTools(); } }, l))));
    const list = animTab === 'in' ? A.ANIM_IN : animTab === 'out' ? A.ANIM_OUT : animTab === 'loop' ? A.LOOPS : A.EMPH;
    const cur = animTab === 'in' ? o.anIn.type : animTab === 'out' ? o.anOut.type : animTab === 'loop' ? (o.loop || 'none') : null;
    const others = scene.objects.filter(x => x !== o);
    const pick = k => {
      if (animTab === 'in') { o.anIn.type = k; changed(true); refreshSheet(); previewRange(o.start, o.start + Math.max(o.anIn.dur, 0.6) + 0.4); }
      else if (animTab === 'out') {
        o.anOut.type = k;
        if (k === 'transform' && !o.anOut.target) { const t = others.find(x => x.start >= o.end - 0.3) || others[0]; if (t) linkTransform(o, t); }
        changed(true); refreshSheet(); previewRange(Math.max(0, o.end - o.anOut.dur - 0.4), o.end + 0.3);
      } else if (animTab === 'loop') { o.loop = k; changed(); refreshSheet(); if (k !== 'none') previewRange(Math.max(o.start, time), Math.max(o.start, time) + 2.5); }
      else { const t = Math.max(o.start + (o.anIn.dur || 0), Math.min(time, o.end - 1.2)); o.emph.push({ type: k, t: round(t, 2), dur: 1.2 }); commit(); refreshSheet(); renderTimeline(); dirty = true; previewRange(t - 0.2, t + 1.4); }
    };
    if (animTab === 'effects') body.append(h('p', { class: 'muted small' }, 'Tap an effect to add it at the playhead. It shows as a yellow mark on the clip, which you can drag.'));
    for (const g of [...new Set(list.map(x => x[2]))]) {
      body.append(h('div', { class: 'glab' }, g));
      const grid = h('div', { class: 'animgrid' });
      for (const [k, l] of list.filter(x => x[2] === g)) {
        const c = h('canvas', { class: 'apv', width: 192, height: 128, 'aria-hidden': 'true' });
        grid.append(h('button', { type: 'button', class: 'atile' + (k === cur ? ' on' : ''), 'aria-pressed': k === cur, onclick: () => pick(k) }, c, h('span', {}, l)));
        if (!(animTab === 'out' && k === 'transform') && k !== 'none' && k !== 'appear') previews.set(c, miniScene(o, animTab, k));
        else { const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, 192, 128); x.fillStyle = '#666'; x.font = '40px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(k === 'transform' ? '⇢' : '∅', 96, 64); }
      }
      body.append(grid);
    }
    if (!pvRaf) pvRaf = requestAnimationFrame(pvLoop);
    if (animTab === 'in') body.append(group('Timing', h('div', { class: 'two' }, field('Seconds', stepper(o.anIn.dur, 0.25, v => { o.anIn.dur = Math.max(0.05, v); changed(true); })), field('Easing', selectInput(rates, o.anIn.rate || 'smooth', v => { o.anIn.rate = v; changed(); })))));
    if (animTab === 'out') {
      const kids = [h('div', { class: 'two' }, field('Seconds', stepper(o.anOut.dur, 0.25, v => { o.anOut.dur = Math.max(0.05, v); changed(true); })), field('Easing', selectInput(rates, o.anOut.rate || 'smooth', v => { o.anOut.rate = v; changed(); })))];
      if (o.anOut.type === 'transform') {
        kids.push(field('Transform into', selectInput([['', '— choose —'], ...others.map(x => [x.id, x.name])], o.anOut.target || '', v => { const t = scene.objects.find(x => x.id === v); if (t) linkTransform(o, t); else o.anOut.target = ''; changed(true); })));
        kids.push(h('p', { class: 'muted small' }, 'Morphs this into the chosen object, like Manim’s Transform. That object is moved to start as this one ends.'));
      }
      body.append(group('Timing', ...kids));
    }
    if (animTab === 'effects' && (o.emph || []).length) {
      body.append(group('On this clip', ...(o.emph || []).map((e, i) => h('div', { class: 'emrow' },
        selectInput(A.EMPH.map(x => [x[0], x[1]]), e.type, v => { e.type = v; commitSoon(); renderTimeline(); dirty = true; }),
        h('label', { class: 'mini' }, 'at (s)', numInput(e.t, 0.1, v => { e.t = v; commitSoon(); renderTimeline(); dirty = true; })),
        h('label', { class: 'mini' }, 'for (s)', numInput(e.dur, 0.1, v => { e.dur = Math.max(0.1, v); commitSoon(); renderTimeline(); dirty = true; })),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Play this effect', onclick: () => previewRange(e.t - 0.2, e.t + e.dur + 0.2) }, '▶'),
        h('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Remove effect', onclick: () => { o.emph.splice(i, 1); commit(); refreshSheet(); renderTimeline(); dirty = true; } }, '✕')))));
    }
  }
  function styleSheet(body, o) {
    const set = (k, v) => { o[k] = v; dirty = true; commitSoon(); };
    body.append(h('p', { class: 'muted small' }, 'Glow lights the object from within, in its own colours or one you pick. For a pulsing glow, use Animate → Loop → Glow pulse, or Effects → Glow.'));
    body.append(field('Presets', h('div', { class: 'chips' }, [[0, 'None'], [0.35, 'Soft'], [0.7, 'Neon'], [1.2, 'Blazing']].map(([v, l]) =>
      h('button', { type: 'button', class: 'pick' + (Math.abs((o.glow || 0) - v) < 0.01 ? ' on' : ''), onclick: () => { set('glow', v); refreshSheet(); } }, l)))));
    body.append(field('Glow amount', stepper(o.glow || 0, 0.1, v => set('glow', Math.max(0, Math.min(1.5, v))))));
    body.append(field('Glow colour (∅ = the object’s own colours)', colorField(o.glowColor || '', v => set('glowColor', v), true)));
  }
  function sceneSheet(body) {
    const name = h('input', { type: 'text', value: scene.name });
    name.addEventListener('input', () => { scene.name = name.value; commitSoon(); clearTimeout(fpT); fpT = setTimeout(() => { saveNow(); fillProjects(); }, 500); });
    body.append(field('Project name', name));
    body.append(field('Shape of the video', h('div', { class: 'chips' }, ASPECTS.map(([k, l]) => h('button', { type: 'button', class: 'pick' + (scene.aspect === k ? ' on' : ''), onclick: () => { scene.aspect = k; commit(); sizeStage(); refreshSheet(); updAspect(); } }, l)))));
    body.append(field('Background', h('div', { class: 'chips' }, BGS.map(([k, l]) => h('button', { type: 'button', class: 'pick' + (scene.bg === k ? ' on' : ''), onclick: () => { scene.bg = k; commit(); dirty = true; refreshSheet(); } }, h('i', { class: 'bgdot', style: 'background:' + k }), l)),
      (() => { const c = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(scene.bg) ? scene.bg : '#000000', 'aria-label': 'Custom background' }); c.addEventListener('input', () => { scene.bg = c.value; dirty = true; commitSoon(); }); return c; })())));
    body.append(field('Length (seconds)', stepper(scene.duration, 1, v => { scene.duration = Math.max(1, v); commitSoon(); renderTimeline(); dirty = true; })));
    body.append(h('p', { class: 'muted small' }, 'The frame is 8 units tall with (0, 0) in the middle, as in Manim. Paper and White switch new objects to dark ink.'));
  }
  let fpT = null;
  function refreshSheetValues() {
    const o = selObj();
    if (sheetKind === 'position' && o) {
      document.querySelectorAll('#sheetBody .kfrow').forEach(row => {
        const inp = row.querySelector('input'), p = inp.dataset.prop;
        if (document.activeElement !== inp) inp.value = round(A.keyVal(o, p, time), 2);
        const k = o.keys[p] || [], here = k.some(q => Math.abs(q.t - time) < 0.026);
        const b = row.querySelector('.keybtn'); b.className = 'keybtn' + (here ? ' on' : k.length ? ' some' : ''); b.textContent = here ? '◆' : '◇';
      });
    }
    if (sheetKind && sheetKind.startsWith('add:')) { const p = document.querySelector('#sheetBody .small'); if (p) p.textContent = 'It’s added at the playhead (' + fmtT(time) + ') for 4 seconds. Drag it on the preview to place it.'; }
  }
  let prevT = null;
  function previewRange(a, b) {
    clearTimeout(prevT);
    setTime(Math.max(0, a)); setPlaying(true);
    prevT = setTimeout(() => { if (playing) { setPlaying(false); } }, Math.max(300, (b - a) * 1000));
  }
  function linkTransform(o, t) {
    o.anOut.target = t.id;
    const len = Math.max(1, t.end - t.start);
    t.start = round(o.end, 2); t.end = round(t.start + len, 2);
    t.anIn = Object.assign({}, t.anIn, { type: 'appear' });
    if (t.end > scene.duration) scene.duration = Math.ceil(t.end);
  }
  function move(d) {
    const i = scene.objects.findIndex(o => o.id === sel), j = i + d;
    if (j < 0 || j >= scene.objects.length) { toast(d > 0 ? 'Already at the front' : 'Already at the back'); return; }
    const a = scene.objects; [a[i], a[j]] = [a[j], a[i]];
    commit(); renderTimeline(); dirty = true; toast(d > 0 ? 'Moved forward' : 'Moved back');
  }
  function dup() {
    const o = selObj(); if (!o) return;
    const c = clone(o); c.id = uid(); c.name = o.name + ' copy'; c.x = round(c.x + 0.5); c.y = round(c.y - 0.5);
    scene.objects.push(c); commit(); select(c.id); toast('Copied');
  }
  async function del() {
    const o = selObj(); if (!o) return;
    scene.objects = scene.objects.filter(x => x !== o);
    scene.objects.forEach(x => { if (x.anOut.target === o.id) { x.anOut.target = ''; x.anOut.type = 'fadeout'; } });
    commit(); closeSheet(); select(null); toast('Deleted. Undo with ↶');
  }

  // ---------- timeline: scrolls under a fixed centre playhead ----------
  const tl = $('#timeline');
  const scr = h('div', { class: 'tl-scroll' });
  tl.append(scr, h('div', { class: 'tl-ph', 'aria-hidden': 'true' }),
    h('div', { class: 'tl-zoom' }, h('button', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoom(1 / 1.4) }, '−'), h('button', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoom(1.4) }, '+')));
  let lastProg = -1, half = 0;
  function zoom(f) { pps = Math.max(12, Math.min(320, pps * f)); renderTimeline(); }
  function syncScroll() { if (!scene) return; const x = Math.round(time * pps); if (Math.abs(scr.scrollLeft - x) > 0.5) { lastProg = x; scr.scrollLeft = x; } }
  scr.addEventListener('scroll', () => {
    if (Math.abs(scr.scrollLeft - lastProg) <= 1) return;
    lastProg = -1;
    if (tdrag && tdrag.moved) return;
    if (playing) setPlaying(false);
    setTime(scr.scrollLeft / pps, true);
  }, { passive: true });
  function renderTimeline() {
    if (!scene) return;
    half = Math.round(scr.clientWidth / 2);
    const D = scene.duration;
    const inner = h('div', { class: 'tl-inner', style: 'width:' + (half * 2 + D * pps) + 'px' });
    const ruler = h('div', { class: 'tl-ruler' });
    const step = pps > 110 ? 0.5 : pps > 40 ? 1 : pps > 20 ? 2 : 5;
    for (let t = 0; t <= D + 1e-9; t += step) {
      const major = Math.abs(t / (step * 2) - Math.round(t / (step * 2))) < 1e-6;
      ruler.append(h('span', { class: 'tick' + (major ? '' : ' minor'), style: 'left:' + (half + t * pps) + 'px' }, major ? (Number.isInteger(t) ? fmtShort(t) : t.toFixed(1)) : ''));
    }
    ruler.append(h('div', { class: 'tl-endmark', style: 'left:' + (half + D * pps) + 'px' }));
    inner.append(ruler);
    const rows = h('div', { class: 'tl-rows' });
    // pack clips into shared lanes (like a phone video editor); the front-most layer goes on top
    const lanes = [];
    const laneOf = new Map();
    scene.objects.forEach(o => {
      let li = lanes.findIndex(L => L.every(q => o.start >= q.end - 1e-6 || o.end <= q.start + 1e-6));
      if (li < 0) { lanes.push([]); li = lanes.length - 1; }
      lanes[li].push(o); laneOf.set(o.id, li);
    });
    const laneEls = lanes.map(() => h('div', { class: 'tl-row' }));
    scene.objects.forEach(o => {
      const { inD, outD } = A.phases(o);
      const isSel = o.id === sel;
      const clip = h('div', { class: 'tl-clip t-' + o.type + (isSel ? ' sel' : ''), 'data-id': o.id, 'data-mode': 'move', style: 'left:' + (half + o.start * pps) + 'px;width:' + Math.max(8, (o.end - o.start) * pps) + 'px' },
        h('div', { class: 'ph in', style: 'width:' + inD * pps + 'px' }), h('div', { class: 'ph out', style: 'width:' + outD * pps + 'px' }),
        h('span', { class: 'clabel' }, h('b', {}, A.TYPES[o.type].icon), ' ', (o.anOut.type === 'transform' ? '⇢ ' : '') + o.name));
      if (isSel) clip.append(h('div', { class: 'hd l', 'data-id': o.id, 'data-mode': 'left', 'aria-label': 'Trim start' }), h('div', { class: 'hd r', 'data-id': o.id, 'data-mode': 'right', 'aria-label': 'Trim end' }));
      (o.emph || []).forEach((e, i) => clip.append(h('div', { class: 'em', 'data-id': o.id, 'data-mode': 'emph', 'data-i': i, title: e.type, style: 'left:' + (e.t - o.start) * pps + 'px;width:' + Math.max(8, e.dur * pps) + 'px' })));
      [...new Set(Object.values(o.keys || {}).flat().map(q => q.t))].forEach(t => clip.append(h('div', { class: 'kf', 'data-id': o.id, 'data-mode': 'key', 'data-t': t, style: 'left:' + (t - o.start) * pps + 'px' })));
      laneEls[laneOf.get(o.id)].append(clip);
    });
    laneEls.slice().reverse().forEach(el => rows.append(el));
    rows.append(h('div', { class: 'tl-row add' }, h('button', { type: 'button', class: 'tl-add', style: 'left:' + (half + time * pps + 8) + 'px', onclick: () => { select(null); openSheet('add:text'); } }, '＋ Add')));
    inner.append(rows);
    const keepY = scr.scrollTop;
    scr.textContent = '';
    scr.append(inner);
    scr.scrollTop = keepY;
    lastProg = Math.round(time * pps); scr.scrollLeft = lastProg;
  }
  const fmtShort = t => t >= 60 ? Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0') : t + 's';
  let rtT = null; const renderTimelineSoon = () => { clearTimeout(rtT); rtT = setTimeout(renderTimeline, 120); };

  let tdrag = null;
  scr.addEventListener('click', e => {
    if (tdrag && tdrag.moved) return;
    const c = e.target.closest('.tl-clip');
    if (c) { if (c.dataset.id !== sel) select(c.dataset.id); return; }
    if (e.target.closest('.tl-ruler')) { const r = scr.getBoundingClientRect(); setTime((e.clientX - r.left + scr.scrollLeft - half) / pps); return; }
    if (!e.target.closest('button') && sel) select(null);
  });
  scr.addEventListener('pointerdown', e => {
    const t = e.target, m = t.dataset.mode;
    if (!m || !t.dataset.id || t.dataset.id !== sel) return;
    const o = selObj(); if (!o) return;
    tdrag = { mode: m, o, x0: e.clientX, snap0: clone(o), i: +t.dataset.i, kt: +t.dataset.t, moved: false, pid: e.pointerId };
    scr.setPointerCapture(e.pointerId);
  });
  scr.addEventListener('pointermove', e => {
    if (!tdrag) return;
    const d = snap((e.clientX - tdrag.x0) / pps);
    if (!tdrag.moved && Math.abs(e.clientX - tdrag.x0) < 5) return;
    tdrag.moved = true;
    const o = tdrag.o, s = tdrag.snap0;
    if (tdrag.mode === 'move') {
      const dd = Math.max(-s.start, d);
      o.start = round(s.start + dd); o.end = round(s.end + dd);
      o.emph = s.emph.map(x => Object.assign({}, x, { t: round(x.t + dd) }));
      o.keys = Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, v.map(q => ({ t: round(q.t + dd), v: q.v, ease: q.ease }))]));
    } else if (tdrag.mode === 'left') o.start = round(Math.max(0, Math.min(s.start + d, s.end - 0.2)));
    else if (tdrag.mode === 'right') o.end = round(Math.max(s.end + d, s.start + 0.2));
    else if (tdrag.mode === 'emph') o.emph[tdrag.i].t = round(Math.max(0, s.emph[tdrag.i].t + d));
    else if (tdrag.mode === 'key') {
      const nt = round(Math.max(0, tdrag.kt + d));
      o.keys = Object.fromEntries(Object.entries(s.keys).map(([k, v]) => [k, v.map(q => Math.abs(q.t - tdrag.kt) < 1e-6 ? { t: nt, v: q.v, ease: q.ease } : q).sort((a, b) => a.t - b.t)]));
    }
    if (o.end > scene.duration) scene.duration = Math.ceil(o.end);
    dirty = true;
    renderTimeline();
  });
  const tup = () => {
    if (!tdrag) return;
    const td = tdrag;
    setTimeout(() => { tdrag = null; }, 0);
    if (!td.moved) { if (td.mode === 'key') setTime(td.kt); else if (td.mode === 'emph') setTime(td.o.emph[td.i].t); return; }
    scene.objects.forEach(x => { if (x.anOut.type === 'transform' && x.anOut.target) { const t = scene.objects.find(y => y.id === x.anOut.target); if (t && (x === td.o || t === td.o)) { if (t === td.o) x.end = t.start; else { const len = t.end - t.start; t.start = x.end; t.end = round(t.start + len); } } } });
    commit(); renderTimeline(); refreshSheet();
  };
  scr.addEventListener('pointerup', tup); scr.addEventListener('pointercancel', tup);
  // pinch to zoom the timeline
  let pinch = null;
  scr.addEventListener('touchstart', e => { if (e.touches.length === 2) { pinch = { d: Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1, p: pps }; } }, { passive: true });
  scr.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) { e.preventDefault(); const d = Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1; pps = Math.max(12, Math.min(320, pinch.p * d / pinch.d)); renderTimeline(); }
  }, { passive: false });
  scr.addEventListener('touchend', () => { pinch = null; });

  // ---------- export ----------
  function pickMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    const c = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    return c.find(m => MediaRecorder.isTypeSupported(m)) || '';
  }
  function exportSize(short) {
    const r = ratio(scene.aspect);
    return r >= 1 ? [Math.round(short * r / 2) * 2, short] : [short, Math.round(short / r / 2) * 2];
  }
  const slug = () => (scene.name || 'animation').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'animation';
  function download(name, blob) { const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click(); a.remove(); }
  function openExport() {
    setPlaying(false);
    const dlg = $('#exportDlg'); dlg.textContent = '';
    const mime = pickMime();
    const res = selectInput([['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['2160', '4K (slow on phones)']], '1080', () => info());
    const fps = selectInput([['30', '30 fps'], ['60', '60 fps']], '30', () => {});
    const sz = h('p', { class: 'muted small' });
    function info() { const [W, H] = exportSize(+res.value); sz.textContent = W + ' × ' + H + ' · ' + scene.aspect + ' · ' + fmtT(scene.duration) + ' · ' + (mime === null ? 'this browser can’t record video' : mime.includes('mp4') ? 'MP4' : 'WebM'); }
    info();
    const prog = h('progress', { max: 1, value: 0, hidden: true });
    const status = h('p', { class: 'small', 'aria-live': 'polite' });
    const out = h('div', { class: 'exportout' });
    let cancel = null;
    const go = h('button', { type: 'button', class: 'btn primary', disabled: mime === null, onclick: () => {
      go.disabled = true; prog.hidden = false; out.textContent = '';
      cancel = recordVideo(+res.value, +fps.value, mime, (p, msg) => { prog.value = p; status.textContent = msg; }, (blob, ext) => {
        go.disabled = false; prog.hidden = true;
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        out.append(h('video', { src: url, controls: true, playsinline: true, loop: true }));
        out.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => download(slug() + ext, blob) }, '⤓ Save video')));
        if (inFrame) out.append(h('p', { class: 'muted small' }, 'This preview inside Claude can’t save files, so Save may do nothing here. It works in the version you install from GitHub.'));
      });
    } }, '● Record video');
    const png = h('button', { type: 'button', class: 'btn', onclick: () => {
      const [W, H] = exportSize(+res.value);
      const c = h('canvas'); c.width = W; c.height = H;
      A.render(c.getContext('2d'), scene, time, W, H);
      c.toBlob(b => { out.textContent = ''; out.append(h('img', { src: URL.createObjectURL(b), alt: 'Frame at ' + fmtT(time) })); out.append(h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => download(slug() + '-' + time.toFixed(1) + 's.png', b) }, '⤓ Save image'))); }, 'image/png');
    } }, '◻ This frame as an image');
    dlg.append(h('div', { class: 'dlg' },
      h('h2', {}, 'Export'),
      h('div', { class: 'two' }, field('Resolution', res), field('Frame rate', fps)), sz,
      h('p', { class: 'muted small' }, 'Recording plays the scene in real time, so it takes as long as the scene. Keep the screen on until it finishes.'),
      prog, status, out,
      h('div', { class: 'row' }, go, png, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn quiet', onclick: () => { if (cancel) cancel(); dlg.close(); } }, 'Close'))));
    dlg.showModal();
  }
  function recordVideo(short, fps, mime, onProg, onDone) {
    const [W, H] = exportSize(short);
    const c = h('canvas', { style: 'position:fixed;left:-99999px;top:0;width:10px;height:10px' }); c.width = W; c.height = H;
    document.body.append(c);
    const ctx = c.getContext('2d');
    A.render(ctx, scene, 0, W, H);
    let rec;
    try { rec = new MediaRecorder(c.captureStream(fps), Object.assign(mime ? { mimeType: mime } : {}, { videoBitsPerSecond: Math.round(Math.min(40e6, W * H * fps * 0.12)) })); }
    catch (e) { onProg(0, 'This browser can’t record video: ' + e.message); onDone(null); c.remove(); return null; }
    const chunks = [];
    let stopped = false, raf = 0;
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = () => {
      cancelAnimationFrame(raf); c.remove();
      if (stopped === 'cancel') { onProg(0, 'Cancelled.'); onDone(null); return; }
      const type = rec.mimeType || mime || 'video/webm';
      const blob = new Blob(chunks, { type });
      const ext = type.includes('mp4') ? '.mp4' : '.webm';
      onProg(1, 'Done: ' + (blob.size / 1e6).toFixed(1) + ' MB ' + (ext === '.mp4' ? 'MP4' : 'WebM') + '.');
      if (!inFrame) download(slug() + ext, blob);
      onDone(blob, ext);
    };
    rec.start(500);
    const start = performance.now(), D = scene.duration;
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      A.render(ctx, scene, Math.min(t, D), W, H);
      onProg(Math.min(1, t / D), 'Recording… ' + fmtT(Math.min(t, D)) + ' of ' + fmtT(D));
      if (t >= D + 0.25) { stopped = true; rec.stop(); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (!stopped) { stopped = 'cancel'; rec.stop(); } };
  }

  // ---------- project menu ----------
  function openMenu() {
    const dlg = $('#menuDlg'); dlg.textContent = '';
    const act = (label, fn, cls) => h('button', { type: 'button', class: 'btn ' + (cls || ''), onclick: () => { dlg.close(); fn(); } }, label);
    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
    fileIn.addEventListener('change', async () => {
      const f = fileIn.files[0]; if (!f) return;
      try { const s = JSON.parse(await f.text()); if (!s.objects) throw new Error('that file isn’t an Animath project'); createProject(s); toast('Opened “' + s.name + '”'); } catch (e) { toast('Couldn’t open it: ' + e.message); }
    });
    dlg.append(h('div', { class: 'dlg' }, h('h2', {}, 'Projects'), h('div', { class: 'menu' },
      act('＋ New blank project', () => createProject(newScene('Untitled ' + (index().length + 1)))),
      act('＋ New copy of the demo', () => createProject(demoScene())),
      act('⧉ Duplicate this project', () => { const s = clone(scene); s.name += ' copy'; createProject(s); }),
      act('⤓ Save project file (.json)', () => download(slug() + '.animath.json', new Blob([JSON.stringify(clone(scene), null, 1)], { type: 'application/json' }))),
      act('⤒ Open a project file', () => fileIn.click()),
      act('⌫ Delete this project', async () => {
        if (!await ask('Delete “' + scene.name + '”? This can’t be undone.', 'Delete')) return;
        store.del('animath.p.' + projId);
        store.set('animath.index', index().filter(p => p.id !== projId));
        const next = index()[0];
        if (!(next && openProject(next.id))) createProject(demoScene());
      }, 'quiet')),
      h('p', { class: 'muted small' }, inFrame ? 'In this preview, projects are kept in this browser only. Saving and opening files works in the version you install from GitHub.' : 'Projects are saved in this app on this device. Save a project file now and then as a backup.'),
      fileIn,
      h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => dlg.close() }, 'Close'))));
    dlg.showModal();
  }

  // ---------- demo ----------
  function demoScene() {
    const s = newScene('Demo');
    s.duration = 26;
    const keep = scene, keepT = time; scene = s;
    const O = (type, over) => { time = over.start; const o = makeObj(type, over); s.objects.push(o); return o; };
    O('title', { name: 'Title', start: 0, end: 3.6, props: { title: 'Animath', subtitle: 'Manim-style animation, on your phone' }, anIn: { type: 'write', dur: 1.6, rate: 'linear' } });
    const e1 = O('math', { name: 'Euler', start: 3.6, end: 6.6, props: { tex: 'e^{i\\pi} + 1 = 0', size: 1.3 } });
    const e2 = O('math', { name: 'Basel', start: 6.6, end: 10, props: { tex: '\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}', size: 1.1 }, emph: [{ type: 'circumscribe', t: 7.6, dur: 1.4 }] });
    e1.anOut = { type: 'transform', target: e2.id, dur: 1.2, rate: 'smooth' }; e2.anIn = { type: 'appear', dur: 0.5 };
    O('graph', { name: 'Graph', start: 10, end: 16, props: { f2: 'cos(x)', l2: '\\cos x', tracer: true }, anIn: { type: 'create', dur: 2.2, rate: 'smooth' } });
    O('venn', { name: 'Venn', start: 16, end: 21.5, x: -3.3, y: 0.2, scale: 0.85, props: { shade: 'A ∩ B' }, anIn: { type: 'create', dur: 1.5 } });
    O('truth', { name: 'Truth table', start: 16.6, end: 21.5, x: 3.4, y: 0, props: { formula: '(P -> Q) & P -> Q' }, emph: [{ type: 'indicate', t: 19.3, dur: 1 }] });
    O('sticker', { name: 'Sparkle', start: 18.6, end: 21.5, x: 6, y: 3, scale: 0.6, props: { kind: 'sparkle' }, anIn: { type: 'spin', dur: 0.8 }, loop: 'pulse' });
    const sq = O('shape', { name: 'Square', start: 21.5, end: 23.2, x: -2, props: { shape: 'square', fill: 'BLUE', fo: 0.5, color: 'BLUE' } });
    const ci = O('shape', { name: 'Circle', start: 23.2, end: 26, x: -2, props: { shape: 'circle', color: 'PINK', fill: 'PINK', fo: 0.5 }, keys: { x: [{ t: 23.6, v: -2 }, { t: 25, v: 2 }] } });
    sq.anOut = { type: 'transform', target: ci.id, dur: 1, rate: 'smooth' }; ci.anIn = { type: 'appear', dur: 0.5 };
    scene = keep; time = keepT;
    return s;
  }

  // ---------- wiring ----------
  function refreshAll() {
    sizeStage(); renderTools(); renderTimeline(); refreshSheet(); updAspect(); dirty = true;
    document.title = scene.name + ' · Animath';
  }
  document.querySelectorAll('.playbtn').forEach(b => b.addEventListener('click', () => setPlaying(!playing)));
  $('#toStart').addEventListener('click', () => { setPlaying(false); setTime(0); });
  $('#loopBtn').addEventListener('click', e => { const b = e.currentTarget; b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); });
  $('#guides').addEventListener('click', e => { guides = !guides; e.currentTarget.setAttribute('aria-pressed', guides); dirty = true; });
  $('#undo').addEventListener('click', () => undo(-1));
  $('#redo').addEventListener('click', () => undo(1));
  $('#exportBtn').addEventListener('click', openExport);
  $('#aspectBtn').addEventListener('click', () => {
    const d = h('dialog', { class: 'aspectdlg', 'aria-label': 'Video shape' });
    const grid = h('div', { class: 'aspgrid' });
    for (const [k, l] of ASPECTS) {
      const [w, hh] = k.split(':').map(Number), sc = 46 / Math.max(w, hh);
      grid.append(h('button', { type: 'button', class: 'asp' + (scene.aspect === k ? ' on' : ''), onclick: () => { scene.aspect = k; commit(); sizeStage(); refreshSheet(); updAspect(); d.close(); } },
        h('i', { style: 'width:' + Math.round(w * sc) + 'px;height:' + Math.round(hh * sc) + 'px' }), h('b', {}, k), h('span', {}, l.replace(/\s*\d+:\d+$/, ''))));
    }
    d.append(h('div', { class: 'dlg' }, h('h2', {}, 'Video shape'), grid, h('p', { class: 'muted small' }, 'Objects keep their positions in units, so a wider frame shows more around them.'), h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn quiet', onclick: () => d.close() }, 'Close'))));
    d.addEventListener('close', () => setTimeout(() => d.remove(), 50));
    document.body.append(d); d.showModal();
  });
  function updAspect() { $('#aspectBtn').textContent = scene.aspect + ' ▾'; }
  $('#menuBtn').addEventListener('click', openMenu);
  $('#proj').addEventListener('change', e => openProject(e.target.value));
  addEventListener('resize', () => { sizeStage(); renderTimeline(); });
  addEventListener('keydown', e => {
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey ? 1 : -1); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undo(1); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); dup(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); del(); }
    else if (e.key === 'ArrowLeft') setTime(time - (e.shiftKey ? 1 : 0.1));
    else if (e.key === 'ArrowRight') setTime(time + (e.shiftKey ? 1 : 0.1));
    else if (e.key === 'k' && sel) toggleAllKeys();
    else if (e.key === 'Escape') { if (sheetKind) closeSheet(); else select(null); }
  });
  if (document.fonts) {
    Promise.all(['20px LM', 'italic 20px LM', 'bold 20px LM', 'italic bold 20px LM', '20px LMMath', '20px "IBM Plex Sans"', '20px "IBM Plex Mono"'].map(f => document.fonts.load(f).catch(() => null)))
      .then(() => { A.fontsChanged(); dirty = true; });
  }

  const cur = store.get('animath.current', null);
  if (!(cur && openProject(cur))) { const first = index()[0]; if (!(first && openProject(first.id))) createProject(demoScene()); }
  requestAnimationFrame(() => { renderTimeline(); syncScroll(); });
  requestAnimationFrame(loop);
  window.AnimathEditor = { get scene() { return scene; }, setTime, select, addObj, setPlaying, openSheet, get time() { return time; } };
})();
