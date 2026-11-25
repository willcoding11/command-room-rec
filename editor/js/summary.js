// What is in a recording: ships per side per second, kills / losses, runs (from the game's own messages) and the
// best 8 s windows. A browser port of tools/inspect.mjs (same rules), fed frame by frame by the index pass.
export const summarize = {
  collector(rec) {
    // ship sides from the material colour (red = enemy, cyan = player side, gold = squadron gold pair / aces)
    const matColor = new Map();
    for (const d of rec.defs) if (d.k === 'mat' && !matColor.has(d.id)) matColor.set(d.id, d.json && d.json.color !== undefined ? d.json.color : 0xffffff);
    const sides = new Map();
    for (const id of rec.SHIPS.shipIds) {
      const d = rec.objDefs.get(id); const c = matColor.get([].concat(d.mat)[0]) ?? 0xffffff;
      const R = (c >> 16) & 255, G = (c >> 8) & 255, B = c & 255;
      sides.set(id, R > G * 1.3 && R > B * 1.3 ? 'red' : (B > R * 1.3 && G > R * 1.3) ? 'cyan' : (R > B * 1.5 && G > B * 1.5) ? 'gold' : 'other');
    }
    const player = new Set();
    for (const d of rec.objDefs.values()) if (d.name === 'player-ship' || (d.anc || []).includes('player-ship')) player.add(d.id);
    const secs = [];
    const hides = [];      // [t, id] ship hidden
    const shows = new Map();   // id -> [t...]
    return {
      frame(fr, t, vis) {
        const s = Math.floor(t);
        while (secs.length <= s) secs.push({ s: secs.length, cyan: 0, red: 0, gold: 0, kills: 0, deaths: 0 });
        let cyan = 0, red = 0, gold = 0;
        for (const id of vis) { const sd = sides.get(id); if (sd === 'cyan') cyan++; else if (sd === 'red') red++; else if (sd === 'gold') gold++; }
        const x = secs[s]; x.cyan = Math.max(x.cyan, cyan); x.red = Math.max(x.red, red); x.gold = Math.max(x.gold, gold);
        let nh = 0;
        for (const id of fr.hidden) if (sides.has(id)) nh++;
        if (nh >= 5) { hides.push([t, -1]); return; }   // a mass hide = round / box reset
        for (const id of fr.hidden) if (sides.has(id)) hides.push([t, id]);
        for (const id of fr.shown) if (sides.has(id)) { let a = shows.get(id); if (!a) shows.set(id, a = []); a.push(t); }
      },
      finish() {
        const events = [];
        for (const [t, id] of hides) {
          if (id < 0) { events.push({ t, type: 'reset' }); continue; }
          const a = shows.get(id) || [];
          if (a.some((x) => x > t && x < t + 0.5)) continue;
          if (player.has(id)) events.push({ t, type: 'player-death' });
          else if (sides.get(id) === 'red' || sides.get(id) === 'gold') events.push({ t, type: 'kill' });
          else if (sides.get(id) === 'cyan') events.push({ t, type: 'wingman-lost' });
        }
        for (const e of events) { const x = secs[Math.floor(e.t)]; if (!x) continue; if (e.type === 'kill') x.kills++; else if (e.type !== 'reset') x.deaths++; }
        // best moments: 8 s windows ranked by kills*3 + enemies + losses*2
        const wins = [];
        for (let s = 0; s + 8 <= secs.length; s++) {
          let score = 0, kills = 0; for (let i = s; i < s + 8; i++) { const x = secs[i]; score += x.kills * 3 + Math.min(x.red, 8) * 0.25 + x.deaths * 2; kills += x.kills; }
          wins.push({ from: s, to: s + 8, score, kills });
        }
        const best = [];
        for (const w of wins.sort((a, b) => b.score - a.score)) { if (w.score <= 0 || best.length >= 8) break; if (best.some((b) => Math.abs(b.from - w.from) < 8)) continue; best.push(w); }
        best.sort((a, b) => a.from - b.from);
        const totals = { kills: events.filter((e) => e.type === 'kill').length, playerDeaths: events.filter((e) => e.type === 'player-death').length, wingmenLost: events.filter((e) => e.type === 'wingman-lost').length };
        return { secs, events, best, totals, sides };
      },
    };
  },
};

// Runs from the game's messages: "ROUND 1 ..." starts a run; SHIP DESTROYED / SQUADRON LOST / FLEET LOST ends it.
// The message is title+subtitle run together ("ROUND 5" + "10 hostiles" = "ROUND 510 hostiles"), so round numbers
// come only from "ROUND n CLEARED" and "Reached round n". v1/v2 say WAVE, later builds ROUND.
export function runsFromMessages(msgs, dur, secs = null, events = null) {
  const runs = [];
  let cur = null;
  for (const m of msgs) {
    const tx = String(m.text || '').toUpperCase().replace(/\bWAVE\b/g, 'ROUND');
    const opener = /^ROUND 1\d* ?HOSTILES/.test(tx);
    if (cur && opener && cur.rounds < 9 && (cur.rounds > 1 || m.t - cur.from > 20)) { cur.to = m.t; cur.end = 'left to lobby'; runs.push(cur); cur = null; }
    if (!cur && /^ROUND \d+ ?\d* ?HOSTILES/.test(tx)) { cur = { from: m.t, to: null, mode: null, rounds: 1, end: null, score: null, notes: [] }; continue; }
    if (!cur) continue;
    const r = tx.match(/^ROUND (\d+) CLEARED/); if (r) cur.rounds = Math.max(cur.rounds, +r[1] + 1);
    const rr = tx.match(/REACHED ROUND (\d+)/) || tx.match(/SCORE [\d,]+ +ROUND (\d+)/); if (rr) cur.rounds = +rr[1];
    if (/SQUADRON|FORMATION|WINGMAN/.test(tx)) cur.mode = cur.mode || 'squadron';
    if (/OUTPOST|ENDLESS|LANDED|LAUNCH/.test(tx)) cur.mode = cur.mode || 'endless';
    const note = tx.match(/ACE DOWN|LEADER DOWN|ACE IS BACK|ESCAPED|WINGMAN DOWN|BOX RESET/);
    if (note) cur.notes.push({ t: m.t, text: note[0] });
    const end = tx.match(/SHIP DESTROYED|SQUADRON LOST|FLEET LOST|RUN OVER|GAME OVER/);
    if (end) {
      cur.end = end[0].toLowerCase(); cur.to = m.t;
      const sc = tx.match(/SCORE ([\d,]+)/); if (sc) cur.score = sc[1];
      if (end[0] === 'SHIP DESTROYED' && !cur.mode) cur.mode = 'fighter';
      if (end[0] === 'SQUADRON LOST') cur.mode = 'squadron';
      runs.push(cur); cur = null;
    }
  }
  if (cur) { cur.to = dur; cur.end = 'recording ended'; runs.push(cur); }
  for (const r of runs) {
    if (!r.mode) {
      if (secs) { const cy = secs.filter((x) => x.s >= r.from && x.s <= r.to).map((x) => x.cyan).sort((a, b) => a - b); r.mode = cy.length && cy[Math.floor(cy.length * 0.5)] >= 3 ? 'squadron' : 'fighter'; }
      else r.mode = 'run';
    }
    if (events) r.kills = events.filter((e) => e.type === 'kill' && e.t >= r.from && e.t <= r.to + 1).length;
  }
  return runs;
}

export const fmtTime = (s, frac = false) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), x = s - m * 60;
  return frac ? `${m}:${x.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.floor(x)).padStart(2, '0')}`;
};
export function runLine(r) {
  const mode = r.mode ? r.mode[0].toUpperCase() + r.mode.slice(1) : 'Run';
  const bits = [`${mode} ${fmtTime(r.from)}–${fmtTime(r.to)}`];
  if (r.rounds) bits.push(`round ${r.rounds}`);
  if (r.score) bits.push(r.score);
  if (r.kills !== undefined) bits.push(`${r.kills} kills`);
  return bits.join(' · ');
}
