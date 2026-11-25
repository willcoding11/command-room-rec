// Audio: each clip's game sound (the recording's audio, kept in sync with its scene time) plus the music lane
// (the game's three songs, rendered offline from music.js by tools/render-music.mjs). One mix graph, used for live
// preview on an AudioContext and for export on an OfflineAudioContext, so what you hear is what you export:
//   clip audio -> clip gain --> game bus --\
//   song loops -> fades/gain -> music bus --+-> master -> limiter -> out
export const SONGS = [
  { id: 'lobby', name: 'Lobby', desc: 'Slow ambient pad, D minor. 128 s loop.', file: 'music/lobby.ogg', color: '#3fa7ff' },
  { id: 'battle-calm', name: 'Battle (calm)', desc: '112 BPM, low intensity: kick, bass, pad, hats. 120 s loop.', file: 'music/battle-calm.ogg', color: '#29d0c8' },
  { id: 'battle-intense', name: 'Battle (intense)', desc: '112 BPM, full intensity: drums, 16th arpeggio, octave bass. 120 s loop.', file: 'music/battle-intense.ogg', color: '#ff6a5a' },
];
// Builds that have in-game music (v1 and v2 had none): their recorded audio has the music mixed into the effects.
export const hasGameMusic = (version) => { const n = parseInt(String(version || '').replace(/\D/g, ''), 10); return !(n === 1 || n === 2); };

export class AudioEngine {
  constructor() { this.ctx = null; this.songBufs = new Map(); this.live = null; }
  context() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000, latencyHint: 'interactive' });
    return this.ctx;
  }
  song(id) {
    let p = this.songBufs.get(id);
    if (!p) {
      const s = SONGS.find((x) => x.id === id);
      p = (async () => { const r = await fetch(s.file); if (!r.ok) throw new Error('missing ' + s.file); return this.context().decodeAudioData(await r.arrayBuffer()); })();
      this.songBufs.set(id, p);
    }
    return p;
  }
  // everything the mix needs, decoded: { clipBufs: Map(clipId -> AudioBuffer|null), songBufs: Map(songId -> AudioBuffer) }
  async buffers(timeline, recs) {
    const ctx = this.context();
    const clipBufs = new Map(), songBufs = new Map();
    for (const c of timeline.clips) { const r = recs.get(c.rec); clipBufs.set(c.id, r ? await r.audioBuffer(ctx) : null); }
    for (const m of timeline.music) if (!songBufs.has(m.song)) songBufs.set(m.song, await this.song(m.song));
    return { clipBufs, songBufs };
  }
  // schedule [T0, T1) of the timeline at context time `when`; returns the nodes (stop them to cancel)
  static schedule(ctx, timeline, recs, bufs, T0, T1, when, dest) {
    const nodes = [];
    const master = ctx.createGain(); master.gain.value = 1;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 2; lim.ratio.value = 16; lim.attack.value = 0.002; lim.release.value = 0.12;
    master.connect(lim).connect(dest);
    nodes.push(master, lim);
    const at = (x) => when + (x - T0);
    const F = 0.004;   // click-free cuts
    for (const c of timeline.clips) {
      const S = c.start, E = c.start + c.dur;
      if (E <= T0 || S >= T1 || c.mute || !(c.vol > 0)) continue;
      const buf = bufs.clipBufs.get(c.id), rec = recs.get(c.rec);
      if (!buf || !rec) continue;
      const a = Math.max(T0, S), b = Math.min(T1, E);
      let off = rec.audioOffset(c.in + (a - S)), start = a;
      if (off < 0) { start = a - off; off = 0; }
      if (start >= b || off >= buf.duration) continue;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const g = ctx.createGain();
      g.gain.setValueAtTime(start > S + F ? c.vol : 0, at(start));
      if (start <= S + F) g.gain.linearRampToValueAtTime(c.vol, at(start) + F);
      g.gain.setValueAtTime(c.vol, Math.max(at(start) + F, at(b) - F));
      if (b >= E - 1e-6) g.gain.linearRampToValueAtTime(0, at(b));
      src.connect(g).connect(master);
      src.start(at(start), off, b - start);
      nodes.push(src, g);
    }
    for (const m of timeline.music) {
      const S = m.start, E = m.start + m.len;
      if (E <= T0 || S >= T1 || !(m.vol > 0)) continue;
      const buf = bufs.songBufs.get(m.song);
      if (!buf) continue;
      const a = Math.max(T0, S), b = Math.min(T1, E);
      const fi = Math.max(F, Math.min(m.fadeIn || 0, m.len / 2)), fo = Math.max(F, Math.min(m.fadeOut || 0, m.len / 2));
      const env = (x) => m.vol * Math.min(1, Math.max(0, (x - S) / fi)) * Math.min(1, Math.max(0, (E - x) / fo));
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration;
      const g = ctx.createGain();
      const pts = [a];
      if (S + fi > a && S + fi < b) pts.push(S + fi);
      if (E - fo > a && E - fo < b) pts.push(E - fo);
      pts.push(b);
      pts.sort((x, y) => x - y);
      g.gain.setValueAtTime(env(a), at(a));
      for (let i = 1; i < pts.length; i++) g.gain.linearRampToValueAtTime(env(pts[i]), at(pts[i]));
      src.connect(g).connect(master);
      const pos = ((m.offset || 0) + (a - S)) % buf.duration;
      src.start(at(a), pos);
      src.stop(at(b));
      nodes.push(src, g);
    }
    return nodes;
  }
  async play(timeline, recs, T0) {
    this.stop();
    const ctx = this.context();
    if (ctx.state !== 'running') await ctx.resume();
    const bufs = await this.buffers(timeline, recs);
    const when = ctx.currentTime + 0.06;
    const nodes = AudioEngine.schedule(ctx, timeline, recs, bufs, T0, timeline.duration + 1, when, ctx.destination);
    this.live = { nodes, when, T0 };
    return this.live;
  }
  stop() {
    if (!this.live) return;
    for (const n of this.live.nodes) { try { if (n.stop) n.stop(); } catch (e) { /* not started */ } try { n.disconnect(); } catch (e) { /* */ } }
    this.live = null;
  }
  now() { return this.live ? this.live.T0 + (this.ctx.currentTime - this.live.when) : null; }
  // the whole timeline mixed offline (export)
  async render(timeline, recs, sampleRate = 48000) {
    const bufs = await this.buffers(timeline, recs);
    const len = Math.max(1, Math.ceil(timeline.duration * sampleRate));
    const off = new OfflineAudioContext(2, len, sampleRate);
    AudioEngine.schedule(off, timeline, recs, bufs, 0, timeline.duration, 0, off.destination);
    return off.startRendering();
  }
  // preview one song from the media panel
  async audition(id) {
    this.stopAudition();
    const ctx = this.context(); if (ctx.state !== 'running') await ctx.resume();
    const buf = await this.song(id);
    const src = ctx.createBufferSource(), g = ctx.createGain(); src.buffer = buf; g.gain.value = 0.7;
    src.connect(g).connect(ctx.destination); src.start();
    this.aud = { src, id };
    src.onended = () => { if (this.aud && this.aud.src === src) this.aud = null; };
  }
  stopAudition() { if (this.aud) { try { this.aud.src.stop(); } catch (e) { /* */ } this.aud = null; } }
}
