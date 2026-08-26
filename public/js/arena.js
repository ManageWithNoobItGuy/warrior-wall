/**
 * The arena — everyone fights in one field, the losers drop out, and whoever
 * is left standing is the champion.
 *
 * Ported from the RPG-Seminar React build to plain DOM. Every position is
 * derived from `elapsed`, which is measured against the server's `startedAt`
 * rather than a timer started when this page loaded. A projector that
 * reconnects halfway through therefore shows the field in the correct state
 * immediately instead of replaying the tournament from the beginning.
 */

import { WAVE, aliveAtRound, skillOf, stanceIcon } from './rules.js';
import { escapeHtml } from './ui.js';

/** Token size by how many are still standing, authored against a field about
 *  620px tall and scaled to the real one at draw time. */
const TOKEN_SIZES = [
  [2, 128],
  [4, 96],
  [8, 76],
  [16, 60],
  [32, 48],
];
const REFERENCE_FIELD_H = 620;

function baseTokenSize(alive) {
  for (const [cap, size] of TOKEN_SIZES) if (alive <= cap) return size;
  return 40;
}

/**
 * The R2 low-discrepancy sequence — an even, organic-looking spread of points
 * with none of the clumping true randomness produces.
 *
 * Indexed by position in a sorted list so it stays identical between frames
 * and between screens, with a little hash-derived jitter so a class of twelve
 * does not visibly sit on a lattice.
 */
const PLASTIC = 1.324717957244746;
function scatterPoint(i, seed) {
  const a1 = 1 / PLASTIC;
  const a2 = 1 / (PLASTIC * PLASTIC);
  const frac = (v) => v - Math.floor(v);
  const jx = ((seed & 0xff) / 255 - 0.5) * 0.04;
  const jy = (((seed >> 8) & 0xff) / 255 - 0.5) * 0.04;
  return [
    Math.min(1, Math.max(0, frac(0.5 + a1 * (i + 1)) + jx)),
    Math.min(1, Math.max(0, frac(0.5 + a2 * (i + 1)) + jy)),
  ];
}

/**
 * A well-mixed hash, used to jitter the scatter above.
 *
 * The obvious `h * 31 + c` does not avalanche: student ids in a class run
 * S1, S2, S3…, whose hashes land within a few of each other, and taking them
 * modulo the field width piled every body into the same corner. FNV-1a plus a
 * murmur3 finaliser spreads neighbouring strings across the whole range.
 */
function hashN(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Arena {
  /**
   * @param root    element to draw into
   * @param payload { fighters, result, timeline, totalMs, startedAt }
   */
  constructor(root, payload) {
    this.root = root;
    this.payload = payload;
    this.byId = new Map(payload.fighters.map((f) => [f.playerId, f]));
    /** @type {Map<string, HTMLElement>} reused between frames — rebuilding the
     *  whole field every frame would restart the CSS transitions that carry
     *  the movement. */
    this.nodes = new Map();
    this.raf = 0;
    this.lastHitKey = new Map();

    const rounds = [...new Set(payload.result.matches.map((m) => m.round))].sort((a, b) => a - b);
    this.waves = rounds.map((round) => ({
      round,
      at: payload.timeline.find((t) => t.kind === 'wave' && t.round === round)?.at ?? 0,
      matches: payload.result.matches.filter((m) => m.round === round),
      alive: aliveAtRound(payload.result, round),
    }));

    this.build();
  }

  build() {
    this.root.innerHTML = `
      <div class="arena-wrap">
        <div class="arena"><div class="arena-floor"></div><div class="arena-cells"></div></div>
        <div class="arena-hud">
          <span class="arena-count"></span>
          <span class="arena-wave dim"></span>
          <div class="arena-kills"></div>
        </div>
        <div class="arena-ranks" hidden></div>
      </div>`;
    this.field = this.root.querySelector('.arena');
    this.cellHost = this.root.querySelector('.arena-cells');
    this.countEl = this.root.querySelector('.arena-count');
    this.waveEl = this.root.querySelector('.arena-wave');
    this.killsEl = this.root.querySelector('.arena-kills');
    this.ranksEl = this.root.querySelector('.arena-ranks');

    for (const fighter of this.payload.fighters) {
      const el = document.createElement('div');
      el.className = 'token';
      el.dataset.state = 'idle';
      el.innerHTML = `
        <div class="token-art">
          ${portraitHtml(fighter)}
          <span class="token-spark"></span>
          <span class="dmg"></span>
        </div>
        <div class="hpbar"><i></i></div>
        <span class="token-name">${escapeHtml(fighter.name)}</span>
        <span class="skill-tag"></span>`;
      this.field.append(el);
      this.nodes.set(fighter.playerId, el);
    }
  }

  start() {
    const tick = () => {
      this.frame(Date.now() - this.payload.startedAt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy() {
    this.stop();
    this.root.innerHTML = '';
  }

  /** True once the whole show, ranks and all, has played out. */
  get finished() {
    return Date.now() - this.payload.startedAt > this.payload.totalMs;
  }

  /**
   * How much bigger this field is than the one the sizes were authored for.
   *
   * The arena is nearly always full screen on a projector, where a 60px face
   * is unreadable from the back of a room. Clamped at both ends so a laptop
   * preview stays sane and a 4K screen does not fill itself with six faces.
   */
  get scale() {
    const h = this.field?.clientHeight ?? REFERENCE_FIELD_H;
    return Math.max(0.75, Math.min(2.4, h / REFERENCE_FIELD_H));
  }

  tokenSize(alive) {
    return Math.round(baseTokenSize(alive) * this.scale);
  }

  frame(elapsed) {
    const { slots, cells } = this.layout(elapsed);

    // Duel outlines: faint boxes so it reads as pairs rather than a crowd.
    while (this.cellHost.children.length < cells.length) {
      const cell = document.createElement('div');
      cell.className = 'duel-cell';
      this.cellHost.append(cell);
    }
    [...this.cellHost.children].forEach((el, i) => {
      const c = cells[i];
      el.hidden = !c;
      if (!c) return;
      el.style.cssText = `left:${c.x}%;top:${c.y}%;width:${c.w}%;height:${c.h}%`;
    });

    for (const slot of slots) {
      const el = this.nodes.get(slot.id);
      if (!el) continue;
      el.style.left = `${slot.x}%`;
      el.style.top = `${slot.y}%`;
      el.style.width = `${slot.size}px`;
      // Children size themselves off this. A percentage font-size would
      // resolve against the inherited 16px instead of the token, which is how
      // the champion ended up with six-pixel initials inside a 280px frame.
      el.style.setProperty('--size', `${slot.size}px`);
      el.style.setProperty('--facing', String(slot.facing));
      el.dataset.state = slot.state;

      const bar = el.querySelector('.hpbar');
      if (slot.hp) {
        const pct = Math.max(0, (slot.hp.now / Math.max(1, slot.hp.max)) * 100);
        bar.hidden = false;
        bar.firstElementChild.style.width = `${pct}%`;
        bar.firstElementChild.dataset.low = String(pct < 30);
      } else {
        bar.hidden = true;
      }

      const spark = el.querySelector('.token-spark');
      spark.textContent = slot.state === 'clash' ? stanceIcon(this.byId.get(slot.id)?.stance) : '';

      // The damage number is re-triggered by swapping the animation class only
      // when the hit actually changes, so it pops once per blow.
      const dmg = el.querySelector('.dmg');
      if (slot.hit && this.lastHitKey.get(slot.id) !== slot.hit.key) {
        this.lastHitKey.set(slot.id, slot.hit.key);
        dmg.textContent = `-${slot.hit.dmg}${slot.hit.crit ? '!' : ''}`;
        dmg.className = slot.hit.crit ? 'dmg crit' : 'dmg';
        dmg.classList.remove('pop');
        void dmg.offsetWidth;
        dmg.classList.add('pop');
      } else if (!slot.hit) {
        dmg.classList.remove('pop');
      }

      const tag = el.querySelector('.skill-tag');
      if (slot.skill) {
        tag.hidden = false;
        tag.textContent = `${slot.skill.icon} ${slot.skill.name}`;
      } else {
        tag.hidden = true;
      }
    }

    this.hud(slots, elapsed);
    this.ranks(elapsed);
  }

  hud(slots, elapsed) {
    const aliveCount = slots.filter((s) => s.state !== 'dead').length;
    this.countEl.textContent = `${aliveCount} LEFT`;

    const wave = this.waves.filter((w) => elapsed >= w.at).at(-1);
    this.waveEl.textContent =
      wave && aliveCount > 1 ? `WAVE ${wave.round} · ${wave.matches.length} DUELS` : '';

    // Call out the duels worth talking about, without covering the field.
    const done = this.waves.filter((w) => elapsed >= w.at + WAVE.enterMs + WAVE.clashMs);
    const last = done.at(-1);
    const kills = !last
      ? []
      : last.matches
          .filter((m) => m.crits > 0 || m.stanceEdge === 'win')
          .slice(0, 3)
          .map((m) => ({
            text: `${this.byId.get(m.winnerId)?.name ?? '?'} defeated ${this.byId.get(m.loserId)?.name ?? '?'}`,
            tag: m.stanceEdge === 'win' ? 'COUNTER' : `${m.crits}× CRIT`,
          }));
    const html = kills
      .map((k) => `<span class="tiny">${escapeHtml(k.text)} <b>${k.tag}</b></span>`)
      .join('');
    if (this.killsEl.innerHTML !== html) this.killsEl.innerHTML = html;
  }

  /** The countdown of places, read from tenth up to first. */
  ranks(elapsed) {
    const shown = this.payload.timeline.filter((t) => t.kind === 'rank' && elapsed >= t.at);
    if (!shown.length) {
      this.ranksEl.hidden = true;
      return;
    }
    this.ranksEl.hidden = false;
    const rows = shown
      .map((t) => this.payload.result.ranking.find((r) => r.rank === t.rank))
      .filter(Boolean)
      .sort((a, b) => a.rank - b.rank)
      .map((r) => {
        const f = this.byId.get(r.playerId);
        return `<div class="rank-row" data-top="${r.rank <= 3}">
          <b>#${r.rank}</b>
          <span>${escapeHtml(f?.name ?? '?')}</span>
          <i>${escapeHtml((f?.classId ?? '').toUpperCase())}</i>
        </div>`;
      })
      .join('');
    if (this.ranksEl.innerHTML !== rows) this.ranksEl.innerHTML = rows;
  }

  // ------------------------------------------------------------------ layout

  /**
   * Where everyone stands right now.
   *
   * Duels in a wave are laid out as a grid, one cell per pair, the two
   * fighters facing each other inside it. Each wave has fewer people left, so
   * the cells grow, until the final pair has the whole field.
   */
  layout(elapsed) {
    const all = this.payload.fighters.map((f) => f.playerId);
    const first = this.waves[0];

    // Before the first wave: everyone stands in a ring around the field.
    if (!first || elapsed < first.at) {
      return {
        cells: [],
        slots: all.map((id, i) => {
          const a = (i / all.length) * Math.PI * 2 - Math.PI / 2;
          return {
            id,
            x: 50 + Math.cos(a) * 34,
            y: 50 + Math.sin(a) * 32,
            size: this.tokenSize(all.length),
            facing: Math.cos(a) < 0 ? 1 : -1,
            state: 'idle',
          };
        }),
      };
    }

    const wave = this.waves.filter((w) => elapsed >= w.at).at(-1);
    const local = elapsed - wave.at;
    const phase =
      local < WAVE.enterMs ? 'enter' : local < WAVE.enterMs + WAVE.clashMs ? 'clash' : 'settle';

    const dead = new Set();
    for (const w of this.waves) {
      if (w.at > wave.at) break;
      const resolved = w.round < wave.round || phase === 'settle';
      if (resolved) for (const m of w.matches) dead.add(m.loserId);
    }

    const fighting = wave.matches;
    const byes = wave.alive.filter((id) => !fighting.some((m) => m.aId === id || m.bId === id));

    const cols = Math.ceil(Math.sqrt(Math.max(1, fighting.length)));
    const rows = Math.ceil(fighting.length / cols);
    const bandH = byes.length ? 66 : 76;
    const cellH = (bandH / rows) * 0.78;
    const size = this.tokenSize(wave.alive.length);

    // The gap inside a pair must stay smaller than the gap between pairs, or
    // the eye groups the wrong two people together.
    const cellW = 100 / cols;
    const gap = Math.min(16, cellW * 0.18);
    // Even mid-clash they need daylight between them: two gold avatar frames
    // touching read as one wide rectangle rather than two fighters.
    const closed = Math.min(7, cellW * 0.1);

    const slots = [];
    const cells = [];
    const clashProgress = Math.min(1, Math.max(0, (local - WAVE.enterMs) / WAVE.clashMs));

    fighting.forEach((m, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = ((col + 0.5) / cols) * 100;
      const cy = 12 + ((row + 0.5) / rows) * bandH;
      const spread = phase === 'enter' ? gap : closed;

      // Replay the exchange in step with the clock, so health drains blow by
      // blow instead of jumping to the final number.
      const shown = phase === 'enter' ? 0 : Math.floor(clashProgress * m.log.length);
      let hpA = m.hpA;
      let hpB = m.hpB;
      for (let k = 0; k < shown; k++) {
        const e = m.log[k];
        if (e.a === 0) hpB -= e.d;
        else hpA -= e.d;
      }
      const last = shown > 0 ? m.log[shown - 1] : undefined;

      cells.push({ x: cx, y: cy, w: cellW * 0.82, h: cellH });
      const loserDead = dead.has(m.loserId);

      for (const [id, dir] of [
        [m.aId, -1],
        [m.bId, 1],
      ]) {
        const isLoser = id === m.loserId;
        const isA = id === m.aId;
        const tookHit = last && (last.a === 0 ? !isA : isA);
        const fighter = this.byId.get(id);
        slots.push({
          id,
          x: cx + spread * dir,
          y: cy + (isLoser && loserDead ? 6 : 0),
          size,
          facing: dir === -1 ? 1 : -1,
          state: isLoser && loserDead ? 'dead' : phase === 'clash' ? 'clash' : 'idle',
          hp:
            phase === 'clash'
              ? { now: Math.max(0, isA ? hpA : hpB), max: isA ? m.hpA : m.hpB }
              : undefined,
          hit:
            phase === 'clash' && tookHit && last
              ? { dmg: last.d, crit: last.c === 1, key: `${wave.round}:${i}:${shown}` }
              : undefined,
          // The move name is pinned to the fighter, not the duel box: a label
          // centred on the box is wide enough to cover both their faces.
          skill: phase === 'enter' && fighter ? skillOf(fighter.classId, fighter.stance) : undefined,
        });
      }
    });

    // A bye waits at the edge of the field.
    byes.forEach((id, i) => {
      slots.push({
        id,
        x: ((i + 0.5) / Math.max(1, byes.length)) * 100,
        y: 90,
        size: size * 0.8,
        facing: 1,
        state: 'idle',
      });
    });

    // Everyone knocked out earlier stays as a faded body, so the field visibly
    // empties as the tournament goes on.
    //
    // Their positions come from a low-discrepancy sequence rather than a hash
    // of the id. A hash scatters, but scattering allows collisions, and two
    // bodies on the same spot read as one rendering fault; the sequence below
    // is guaranteed to keep every point away from its neighbours however many
    // there are.
    const fallen = all.filter((id) => !slots.some((s) => s.id === id)).sort();
    fallen.forEach((id, i) => {
      const rank = this.payload.result.ranking.find((r) => r.playerId === id);
      const [fx, fy] = scatterPoint(i, hashN(id));
      slots.push({
        id,
        x: 6 + fx * 88,
        y: 8 + fy * 80,
        size: size * 0.7,
        facing: 1,
        state: rank && rank.eliminatedRound === 0 ? 'champion' : 'dead',
      });
    });

    // One left standing: the champion takes the middle of the field, big.
    const aliveNow = slots.filter((s) => s.state !== 'dead');
    if (aliveNow.length === 1) {
      const champ = aliveNow[0];
      champ.x = 50;
      champ.y = 44;
      champ.size = Math.max(size * 2.2, 120 * this.scale);
      champ.state = 'champion';
    }

    return { slots, cells };
  }
}

/**
 * The fighter's face.
 *
 * Falls back to initials on a class-tinted plate. A student who skipped the
 * photo still has to be findable on the projector, and an empty frame in a
 * field of faces is worse than a letter.
 */
function portraitHtml(fighter) {
  const initials = String(fighter.name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
  const inner = fighter.avatarUrl
    ? `<img src="${escapeHtml(fighter.avatarUrl)}" alt="" loading="lazy"
         onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'token-initials',textContent:${JSON.stringify(initials)}}))">`
    : `<span class="token-initials">${escapeHtml(initials)}</span>`;
  return `<div class="token-face" data-class="${escapeHtml(fighter.classId ?? '')}">${inner}</div>`;
}
