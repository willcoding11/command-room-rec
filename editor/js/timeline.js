// Timeline: a ruler, the video lane (clips play back to back; drag to reorder, drag an edge to trim) and the music
// lane (songs placed freely; drag to move, edges to trim). The playhead follows playback; click or drag the ruler /
// an empty lane to seek. Ctrl+wheel zooms, wheel scrolls.
import { fmtTime } from './summary.js';

const EDGE = 7;
const h = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };

export class Timeline {
  constructor(root, app) {
    this.app = app; this.pps = 40; this.snap = true;
    root.innerHTML = '';
    this.root = root;
    const heads = h('div', 'tl-heads');
    heads.append(h('div', 'tl-head ruler-head'), this.headRow('VIDEO', 'Clips play back to back. Drag to reorder, drag an edge to trim. S splits at the playhead.'),
      this.headRow('MUSIC', 'The game’s songs. Drag from the Music panel or press + on a song. Drag to move, edges to trim; fades in the inspector.'));
    this.scroll = h('div', 'tl-scroll');
    this.inner = h('div', 'tl-inner');
    this.ruler = h('canvas', 'tl-ruler');
    this.vlane = h('div', 'tl-lane video');
    this.mlane = h('div', 'tl-lane music');
    this.playhead = h('div', 'tl-playhead'); this.playhead.append(h('div', 'tl-playhead-cap'));
    this.marker = h('div', 'tl-insert');
    this.inner.append(this.ruler, this.vlane, this.mlane, this.playhead, this.marker);
    this.scroll.append(this.inner);
    root.append(heads, this.scroll);
    this.bind();
    new ResizeObserver(() => this.render()).observe(this.scroll);
  }
  headRow(label, tip) { const d = h('div', 'tl-head'); d.textContent = label; d.dataset.tip = tip; return d; }
  x(t) { return 12 + t * this.pps; }
  tAt(clientX) { const r = this.inner.getBoundingClientRect(); return Math.max(0, (clientX - r.left - 12) / this.pps); }
  setZoom(pps, anchorClientX) {
    const old = this.pps; pps = Math.max(4, Math.min(400, pps));
    if (pps === old) return;
    const r = this.scroll.getBoundingClientRect(), ax = anchorClientX !== undefined ? anchorClientX - r.left : r.width / 2;
    const tA = (this.scroll.scrollLeft + ax - 12) / old;
    this.pps = pps; this.render();
    this.scroll.scrollLeft = Math.max(0, tA * pps + 12 - ax);
    this.app.onZoom && this.app.onZoom(pps);
  }
  fit() { const L = this.app.layout(); const w = this.scroll.clientWidth - 40; this.setZoom(L.duration > 0 ? Math.max(4, Math.min(200, w / Math.max(L.duration, 5))) : 40); this.scroll.scrollLeft = 0; }

  // ---------------------------------------------------------------- draw
  render() {
    if (this.dragging) { this.pending = true; return; }
    this.pending = false;
    const L = this.app.layout(), sel = this.app.sel;
    const width = Math.max(this.scroll.clientWidth, this.x(Math.max(L.duration, L.musicEnd) + 30));
    this.inner.style.width = width + 'px';
    this.drawRuler(width);
    this.vlane.innerHTML = ''; this.mlane.innerHTML = '';
    if (!L.clips.length) { const e = h('div', 'tl-empty', 'Pick a session on the left, mark In (I) and Out (O), then Add to timeline (Enter).'); this.vlane.append(e); }
    for (const c of L.clips) {
      const b = h('div', 'tl-clip' + (sel && sel.kind === 'clip' && sel.id === c.id ? ' sel' : ''));
      b.style.left = this.x(c.start) + 'px'; b.style.width = Math.max(4, c.dur * this.pps - 2) + 'px';
      b.style.setProperty('--c', this.app.colorOf(c.rec));
      const th = this.app.thumbs.get(c.id);
      if (th) b.style.backgroundImage = `linear-gradient(180deg, rgba(4,12,20,.15), rgba(4,12,20,.75)), url(${th.url})`;
      const lab = h('div', 'tl-label');
      lab.append(h('b', null, this.app.recLabel(c.rec)), h('span', null, ` ${fmtTime(c.in, true)}`));
      const tags = h('div', 'tl-tags');
      tags.append(h('span', 'tag cam', camTag(c.cam.mode)));
      if (!c.ui) tags.append(h('span', 'tag', 'NO UI'));
      if (c.mute || c.vol === 0) tags.append(h('span', 'tag', 'MUTED'));
      b.append(lab, tags, h('div', 'tl-dur', c.dur.toFixed(1) + ' s'), h('div', 'tl-edge l'), h('div', 'tl-edge r'));
      b.dataset.id = c.id; b.dataset.kind = 'clip';
      b.dataset.tip = `${this.app.recLabel(c.rec)} ${fmtTime(c.in, true)}–${fmtTime(c.out, true)} · camera: ${camTag(c.cam.mode).toLowerCase()} · drag to reorder, edges to trim`;
      this.vlane.append(b);
    }
    for (const m of L.music) {
      const b = h('div', 'tl-music' + (sel && sel.kind === 'music' && sel.id === m.id ? ' sel' : ''));
      b.style.left = this.x(m.start) + 'px'; b.style.width = Math.max(4, m.len * this.pps - 2) + 'px';
      const song = this.app.songOf(m.song);
      b.style.setProperty('--c', song ? song.color : '#3fa7ff');
      // fade ramps
      const fi = h('div', 'fade in'); fi.style.width = Math.min(m.fadeIn, m.len / 2) * this.pps + 'px';
      const fo = h('div', 'fade out'); fo.style.width = Math.min(m.fadeOut, m.len / 2) * this.pps + 'px';
      b.append(fi, fo, h('div', 'tl-label', `♪ ${song ? song.name : m.song}  ${Math.round(m.vol * 100)}%`), h('div', 'tl-edge l'), h('div', 'tl-edge r'));
      b.dataset.id = m.id; b.dataset.kind = 'music';
      b.dataset.tip = `${song ? song.name : m.song}: drag to move, edges to trim; volume and fades in the inspector`;
      this.mlane.append(b);
    }
    this.updatePlayhead(this.app.T);
  }
  drawRuler(width) {
    const c = this.ruler, dpr = devicePixelRatio || 1, H = 24;
    c.width = Math.ceil(width * dpr); c.height = H * dpr; c.style.width = width + 'px'; c.style.height = H + 'px';
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    g.fillStyle = '#07131d'; g.fillRect(0, 0, width, H);
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    const major = steps.find((s) => s * this.pps >= 70) || 300, minor = steps.filter((s) => s < major && s * this.pps >= 10).pop() || major;
    g.font = '10px ui-monospace, Consolas, monospace'; g.textBaseline = 'top';
    const tEnd = (width - 12) / this.pps;
    for (let t = 0; t <= tEnd; t += minor) {
      const x = Math.round(this.x(t)) + 0.5, isMaj = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      g.strokeStyle = isMaj ? 'rgba(120,220,255,.55)' : 'rgba(120,220,255,.2)';
      g.beginPath(); g.moveTo(x, isMaj ? 10 : 17); g.lineTo(x, H); g.stroke();
      if (isMaj) { g.fillStyle = 'rgba(160,230,255,.8)'; g.fillText(major < 1 ? fmtTime(t, true) : fmtTime(t), x + 3, 2); }
    }
  }
  updatePlayhead(T) { this.playhead.style.left = this.x(T) + 'px'; }
  updateSelection() {
    const s = this.app.sel;
    for (const b of this.inner.querySelectorAll('.tl-clip, .tl-music')) b.classList.toggle('sel', !!s && b.dataset.id === s.id);
  }
  ensureVisible(T) {
    const x = this.x(T), s = this.scroll;
    if (x < s.scrollLeft + 20 || x > s.scrollLeft + s.clientWidth - 40) s.scrollLeft = Math.max(0, x - s.clientWidth * 0.3);
  }

  // ---------------------------------------------------------------- interaction
  bind() {
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.setZoom(this.pps * Math.exp(-e.deltaY * 0.0015), e.clientX); }
      else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { e.preventDefault(); this.scroll.scrollLeft += e.deltaY; }
    }, { passive: false });
    this.inner.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const blk = e.target.closest('.tl-clip, .tl-music');
      if (!blk) { this.scrubDrag(e); return; }
      const kind = blk.dataset.kind, id = blk.dataset.id;
      this.app.select({ kind, id });
      const edge = e.target.classList.contains('tl-edge') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
      if (kind === 'clip') edge ? this.trimClip(e, id, edge) : this.moveClip(e, id);
      else this.dragMusic(e, id, edge || 'move');
    });
    this.inner.addEventListener('dblclick', (e) => { const blk = e.target.closest('.tl-clip'); if (blk) this.app.openClipInSource(blk.dataset.id); });
  }
  drag(e, onMove, onUp) {
    const el = this.inner;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
    this.dragging = true;
    const x0 = e.clientX;
    let moved = false;
    const mv = (ev) => { if (Math.abs(ev.clientX - x0) > 3) moved = true; onMove(ev, ev.clientX - x0, moved); };
    const up = (ev) => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); this.dragging = false; onUp && onUp(ev, moved); if (this.pending) this.render(); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }
  scrubDrag(e) {
    this.app.seek(this.tAt(e.clientX), 'program');
    this.drag(e, (ev) => this.app.seek(this.tAt(ev.clientX), 'program'));
  }
  snapT(t, exclude) {
    if (!this.snap) return t;
    const L = this.app.layout(), pts = [0, this.app.T, L.duration];
    for (const c of L.clips) pts.push(c.start, c.start + c.dur);
    for (const m of L.music) if (m.id !== exclude) pts.push(m.start, m.start + m.len);
    let best = t, bd = 8 / this.pps;
    for (const p of pts) if (Math.abs(p - t) < bd) { bd = Math.abs(p - t); best = p; }
    return best;
  }
  moveClip(e, id) {
    const L = this.app.layout(), c = L.clips.find((x) => x.id === id);
    const blk = e.target.closest('.tl-clip');
    let to = null;
    this.drag(e, (ev, dx, moved) => {
      if (!moved) return;
      blk.classList.add('dragging'); blk.style.transform = `translateX(${dx}px)`;
      const tc = c.start + c.dur / 2 + dx / this.pps;
      // insertion index among the other clips by their midpoints
      const others = L.clips.filter((x) => x.id !== id);
      to = others.filter((x) => x.start + x.dur / 2 < tc).length;
      const ref = others[to] ? others[to].start : others.length ? others[others.length - 1].start + others[others.length - 1].dur : 0;
      const shift = others[to] && others[to].start > c.start ? c.dur : 0;
      this.marker.style.display = 'block'; this.marker.style.left = this.x(ref - shift) + 'px';
    }, (ev, moved) => {
      this.marker.style.display = 'none';
      if (!moved) { this.app.seek(this.tAt(ev.clientX), 'program'); return; }
      if (to !== null) this.app.reorderClip(id, to); else this.render();
    });
  }
  trimClip(e, id, edge) {
    const clip = this.app.project.clips.find((x) => x.id === id);
    const in0 = clip.in, out0 = clip.out;
    this.drag(e, (ev, dx) => {
      const d = dx / this.pps;
      this.app.trimClip(id, edge === 'l' ? in0 + d : in0, edge === 'r' ? out0 + d : out0, false);
    }, (ev, moved) => { if (moved) this.app.commit('Trim clip'); });
  }
  dragMusic(e, id, mode) {
    const m = this.app.project.music.find((x) => x.id === id);
    const s0 = m.start, l0 = m.len, o0 = m.offset || 0;
    this.drag(e, (ev, dx, moved) => {
      if (!moved) return;
      const d = dx / this.pps;
      if (mode === 'move') m.start = Math.max(0, this.snapT(s0 + d, id));
      else if (mode === 'r') m.len = Math.max(0.5, this.snapT(s0 + l0 + d, id) - s0);
      else { const ns = Math.max(0, Math.min(s0 + l0 - 0.5, this.snapT(s0 + d, id))); m.offset = Math.max(0, o0 + (ns - s0)); m.len = l0 - (ns - s0); m.start = ns; }
      this.app.changed(false);
    }, (ev, moved) => { if (moved) this.app.commit('Move music'); else this.app.seek(this.tAt(ev.clientX), 'program'); });
  }
}
export function camTag(mode) { return { auto: 'AUTO', free: 'FREE', follow: 'FOLLOW', lookat: 'LOOK-AT', pov: 'PLAYER VIEW' }[mode] || mode; }
