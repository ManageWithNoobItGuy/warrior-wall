/**
 * The arena screen on a student's phone.
 *
 * Owns everything between "my character exists" and "I know where I placed":
 * the live quiz, the stance choice, and the result. The pledge form on either
 * side of it is still student.js's business.
 *
 * Two rules shape this file:
 *
 *  - The server is the only clock. Every deadline is computed from the
 *    `startedAt` it sends, never from a timer this page started, so a phone
 *    that was locked in a pocket for a minute rejoins at the right moment
 *    instead of giving its owner a fresh 25 seconds.
 *  - Nothing here is trusted with a score. The page shows what the room
 *    reports back; it never computes a stat of its own.
 */

import { api, toast, sfx } from './ui.js';
import { STANCES, STAT_KEYS, STAT_LABELS, STAT_MAX, stanceById } from './rules.js';

const STORE_KEY = 'warrior-wall:player';

const el = (id) => document.getElementById(id);

export const play = {
  identity: null, // { sessionId, studentId, token }
  player: null, // the character, as the room reports it
  game: null, // room phase
  tier: null,
  jobs: [],
  view: 'idle',
  onCharacter: null, // called whenever the character changes
  deadlineRaf: 0,
  answeredThisQuestion: false,
};

// ------------------------------------------------------------------ identity

/**
 * The token proves this phone owns this student id.
 *
 * Held per class session: a new session is a new room, and reusing last
 * week's token there would have the room reject an answer with no way for the
 * student to see why.
 */
function loadIdentity(sessionId) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (saved?.sessionId === sessionId) return saved;
  } catch {
    /* corrupt or unavailable storage just means a fresh identity */
  }
  return null;
}

function saveIdentity(identity) {
  play.identity = identity;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(identity));
  } catch {
    // Private browsing. The identity still works for this page's lifetime;
    // only surviving a reload is lost.
  }
}

// ------------------------------------------------------------------ lifecycle

export function initPlay({ sessionId, jobs, onCharacter }) {
  play.jobs = jobs ?? [];
  play.onCharacter = onCharacter;
  play.identity = loadIdentity(sessionId);
  renderStances();
  return play.identity;
}

/**
 * Creates the character, or reattaches to one this phone already made.
 *
 * The token is minted here rather than by the room, because the room never
 * sends a token back — it would have to travel in a payload other pages can
 * ask for. This device generates one, keeps it, and the room simply remembers
 * which token claimed which student id first.
 */
export async function createCharacter({ sessionId, studentId, name, job }) {
  const existing = play.identity?.studentId === studentId ? play.identity : null;
  const token = existing?.token ?? crypto.randomUUID();
  const data = await api('/api/game/join', {
    method: 'POST',
    body: JSON.stringify({ studentId, name, job, token }),
  });
  saveIdentity({ sessionId, studentId, token });
  applyMe(data);
  return play.player;
}

/**
 * Is there already a character under this student id?
 *
 * The route back in for a student on a second device — a dead battery, a
 * borrowed phone, a browser that cleared its storage. The id alone is enough,
 * because it is the identity; see the note on `join` in the Durable Object.
 *
 * Returns the character if one exists, null otherwise. Never throws: failing
 * to find an old character must not stop someone making a new one.
 */
export async function lookupCharacter({ sessionId, studentId }) {
  try {
    const data = await api(`/api/game/me?studentId=${encodeURIComponent(studentId)}`);
    if (!data.player) return null;
    // Mint this device its own token. It no longer proves anything, but it is
    // what lets this phone restore itself on the next reload without asking.
    saveIdentity({ sessionId, studentId, token: play.identity?.token ?? crypto.randomUUID() });
    applyMe(data);
    return play.player;
  } catch {
    return null;
  }
}

/** Pulls the authoritative view of this player and the room. */
export async function refresh() {
  if (!play.identity) return;
  try {
    const data = await api(
      `/api/game/me?studentId=${encodeURIComponent(play.identity.studentId)}&token=${encodeURIComponent(play.identity.token)}`,
    );
    applyMe(data);
  } catch (err) {
    if (err.code === 'BAD_TOKEN') {
      toast('That student ID is already in use on another phone.', 'bad');
    }
  }
}

function applyMe(data) {
  if (data.player) play.player = data.player;
  if (data.roll) play.tier = data.roll;
  if (data.game) play.game = data.game;
  play.answeredThisQuestion = Boolean(data.answered);
  if (data.choiceIdx !== undefined && data.choiceIdx !== null) {
    play.lastChoice = data.choiceIdx;
  }
  renderSheet();
  syncView(data.lastGain);
  play.onCharacter?.(play.player);
}

// ------------------------------------------------------------------ the sheet

/** The accent colour of a class, as the server reported it. */
export function accentOf(job) {
  return play.jobs.find((j) => j.id === job)?.accent ?? '#63e7ff';
}

function renderSheet() {
  const sheet = el('my-sheet');
  if (!play.player) {
    sheet.hidden = true;
    return;
  }
  sheet.hidden = false;
  el('my-name').textContent = play.player.name;
  // The ID is how a student is addressed on the wall and how they get back
  // into this character on another phone, so it belongs on the sheet next to
  // the name rather than only on the card at the end.
  el('my-id').textContent = `ID ${play.player.studentId}`;
  el('my-class').textContent = (play.player.job ?? '').toUpperCase();
  el('my-class').dataset.job = play.player.job ?? '';
  el('my-score').textContent = play.player.score;

  // The face that will fight. Their own portrait if one was uploaded, the
  // class artwork otherwise — an empty frame next to a stat sheet reads as
  // something that failed to load.
  const portrait = el('my-portrait');
  if (portrait) {
    const own = play.player.hasPortrait
      ? `/av/${encodeURIComponent(play.player.studentId)}.jpg`
      : null;
    const fallback = play.player.job ? `/portraits/${play.player.job}.webp` : null;
    const src = own ?? fallback;
    if (src && portrait.dataset.src !== src) {
      portrait.dataset.src = src;
      portrait.src = src;
      // A portrait that 404s (uploaded late, or not at all) drops back to the
      // class artwork rather than leaving a broken image on the sheet.
      portrait.onerror = () => {
        if (fallback && portrait.src.endsWith('.jpg')) portrait.src = fallback;
      };
    }
    portrait.hidden = !src;
  }

  el('my-stats').innerHTML = statRadar(play.player.stats, {
    accent: accentOf(play.player.job),
  });
  el('my-tier').textContent = play.tier?.label ?? '';
  el('my-tier').dataset.tone = play.tier?.tone ?? 'normal';
  el('my-record').textContent = play.player.answered
    ? `${play.player.correct}/${play.player.answered} CORRECT · BEST STREAK ${play.player.bestStreak}`
    : '';
}

/**
 * The five stats as a pentagon.
 *
 * Bars answer "how much"; a radar answers "what kind of fighter am I", which
 * is the question a student actually has while choosing a class and while
 * watching their character grow. Drawn as inline SVG — no library, scales to
 * any screen, and the shape animates by itself when the numbers change.
 *
 * Axis order runs HP, ATK, DEF, SPD, LUK clockwise from the top, so the same
 * class always produces the same silhouette and they become recognisable at a
 * glance across the room.
 */
export function statRadar(stats, { accent = '#63e7ff', gained = null } = {}) {
  if (!stats) return '';
  const n = STAT_KEYS.length;
  // The box is wider than it is tall on purpose. Labels sit at 1.42× the
  // radius, and the two left-hand vertices push their text further out than
  // any other; a square box left them hanging outside it, close enough to the
  // portrait to look like a collision.
  const cx = 68;
  const cy = 58;
  const r = 34;

  const point = (i, f) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(a) * r * f, cy + Math.sin(a) * r * f];
  };
  const poly = (f) =>
    STAT_KEYS.map((_, i) => point(i, f).map((v) => v.toFixed(1)).join(',')).join(' ');

  // A stat at zero would collapse the shape onto the centre and read as a
  // rendering fault, so the plot floors at a visible sliver.
  const shape = STAT_KEYS.map((key, i) => {
    const f = Math.max(0.08, Math.min(1, (stats[key] ?? 0) / STAT_MAX[key]));
    return point(i, f).map((v) => v.toFixed(1)).join(',');
  }).join(' ');

  const rings = [0.25, 0.5, 0.75, 1]
    .map(
      (f) =>
        `<polygon points="${poly(f)}" fill="none" stroke="rgba(255,255,255,.13)" stroke-width="0.7"/>`,
    )
    .join('');

  const spokes = STAT_KEYS.map((_, i) => {
    const [x, y] = point(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,.13)" stroke-width="0.7"/>`;
  }).join('');

  const labels = STAT_KEYS.map((key, i) => {
    const [x, y] = point(i, 1.42);
    // Anchor by which side of the centre the vertex sits on, or a label on the
    // left runs back over the chart.
    const anchor = x < cx - 2 ? 'end' : x > cx + 2 ? 'start' : 'middle';
    const gain = gained?.[key] ?? 0;
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}"
        class="radar-label">${STAT_LABELS[key]}</text>
      <text x="${x.toFixed(1)}" y="${(y + 7).toFixed(1)}" text-anchor="${anchor}"
        class="radar-value">${stats[key] ?? 0}${gain ? `<tspan class="radar-gain"> +${gain}</tspan>` : ''}</text>`;
  }).join('');

  const label = STAT_KEYS.map((k) => `${STAT_LABELS[k]} ${stats[k] ?? 0}`).join(', ');

  return `<svg class="radar" viewBox="0 0 136 116" role="img" aria-label="${label}">
      ${rings}${spokes}
      <polygon class="radar-shape" points="${shape}"
        fill="${accent}" fill-opacity="0.32" stroke="${accent}" stroke-width="1.6"
        stroke-linejoin="round"/>
      ${labels}
    </svg>`;
}

export function statBars(stats, gained = null) {
  if (!stats) return '';
  return STAT_KEYS.map((key) => {
    const value = stats[key] ?? 0;
    const pct = Math.min(100, (value / STAT_MAX[key]) * 100);
    const gain = gained?.[key] ?? 0;
    return `<div class="statbar" data-stat="${key}">
        <span class="statbar-label">${STAT_LABELS[key]}</span>
        <span class="statbar-track"><i style="width:${pct}%"></i></span>
        <span class="statbar-value">${value}${gain ? `<b class="up">+${gain}</b>` : ''}</span>
      </div>`;
  }).join('');
}

/** What a class starts with, shown before the student commits to one. */
export function previewStats(job) {
  const base = { hp: 100, atk: 10, def: 10, spd: 10, luk: 5 };
  const mod = job?.modifier ?? {};
  const out = {};
  for (const key of STAT_KEYS) out[key] = base[key] + (mod[key] ?? 0);
  return out;
}

// ------------------------------------------------------------------ views

function setView(name) {
  play.view = name;
  for (const view of document.querySelectorAll('#arena-views .arena-view')) {
    view.hidden = view.dataset.view !== name;
  }
  const titles = {
    idle: 'YOUR CHARACTER',
    question: 'QUESTION',
    reveal: 'RESULT',
    stance: 'CHOOSE YOUR STANCE',
    battle: 'THE ARENA',
    done: 'FINAL STANDING',
  };
  el('arena-title').textContent = titles[name] ?? 'YOUR CHARACTER';
}

/** Maps the room's phase onto what this phone should be showing. */
function syncView(lastGain) {
  const phase = play.game?.phase ?? 'lobby';
  if (!play.player) return setView('idle');

  // setView first, then render. The countdown below schedules its next frame
  // only while this page is showing the question, and rendering before the
  // view was switched left it reading the *previous* view on its first tick —
  // so the clock painted once and then stood still.
  if (phase === 'question') {
    setView('question');
    renderQuestion();
    return;
  }
  if (phase === 'reveal') {
    setView('reveal');
    renderReveal(lastGain);
    return;
  }
  if (phase === 'stance') {
    setView('stance');
    renderStanceState();
    return;
  }
  if (phase === 'battle') {
    // The room has no idea when the show is over — the timeline does. Rather
    // than have the server run a timer for something only the screens care
    // about, each page works it out from the same two numbers.
    const over =
      play.game.battleStartedAt &&
      Date.now() > play.game.battleStartedAt + play.game.battleTotalMs;
    if (over) {
      renderFinal();
      return setView('done');
    }
    el('battle-stance').textContent = play.player.stance
      ? `Your stance: ${stanceById(play.player.stance).name}`
      : '';
    return setView('battle');
  }
  if (phase === 'done') {
    renderFinal();
    return setView('done');
  }

  // Lobby, and everything in between questions.
  el('idle-message').textContent = play.game?.askedCount
    ? 'Nice work. Keep this page open — there is more to come.'
    : 'Your character is ready. Keep this page open and watch the big screen.';
  el('idle-sub').textContent = 'WAITING FOR THE INSTRUCTOR…';
  setView('idle');
}

// ------------------------------------------------------------------ question

function renderQuestion() {
  const g = play.game;
  if (!g?.choices) return;
  el('q-num').textContent = `Q${(g.questionIndex ?? 0) + 1}${g.questionTotal ? ` / ${g.questionTotal}` : ''}`;
  el('q-text').textContent = g.text ?? '';

  const host = el('choices');
  const wanted = g.choices
    .map(
      (choice, i) =>
        `<button type="button" class="choice" data-choice="${i}">
           <span class="choice-key">${'ABCD'[i]}</span><span>${escapeText(choice)}</span>
         </button>`,
    )
    .join('');
  if (host.dataset.qid !== g.questionId) {
    host.dataset.qid = g.questionId;
    host.innerHTML = wanted;
  }
  markAnswered();
  startCountdown();
}

function markAnswered() {
  const answered = play.answeredThisQuestion;
  for (const button of document.querySelectorAll('#choices .choice')) {
    button.disabled = answered;
    button.classList.toggle('picked', answered && Number(button.dataset.choice) === play.lastChoice);
  }
  el('q-status').textContent = answered
    ? 'Locked in. Wait for the reveal.'
    : 'Tap your answer — faster answers are worth more.';
}

/**
 * The clock, driven off the server's start time.
 *
 * It keeps running past zero on purpose rather than disabling the buttons: the
 * server holds a grace window for the round trip, and a phone whose clock is a
 * few seconds fast should not lock its owner out of an answer the room would
 * still have accepted.
 */
function startCountdown() {
  cancelAnimationFrame(play.deadlineRaf);
  const g = play.game;
  if (!g?.startedAt) return;

  const tick = () => {
    const left = g.startedAt + g.timeLimitMs - Date.now();
    const pct = Math.max(0, Math.min(100, (left / g.timeLimitMs) * 100));
    el('q-bar').style.width = `${pct}%`;
    el('q-bar').dataset.low = String(pct < 25);
    el('q-clock').textContent = left > 0 ? `${Math.ceil(left / 1000)}s` : 'TIME';
    // Keep going while the room is still on this question and this page is
    // still showing it. Checking the room's phase as well as the view means a
    // stale loop cannot outlive the question it belongs to.
    if (play.view === 'question' && play.game?.phase === 'question') {
      play.deadlineRaf = requestAnimationFrame(tick);
    }
  };
  tick();
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('#choices .choice');
  if (!button || button.disabled) return;
  const choiceIdx = Number(button.dataset.choice);

  // Locked immediately rather than on the reply: on classroom wifi the round
  // trip is long enough to tap twice, and the second tap is rejected as a
  // duplicate, which looks like the app eating the answer.
  play.answeredThisQuestion = true;
  play.lastChoice = choiceIdx;
  markAnswered();

  try {
    await api('/api/game/answer', {
      method: 'POST',
      body: JSON.stringify({ ...play.identity, choiceIdx }),
    });
    sfx.select();
  } catch (err) {
    if (err.code === 'DUPLICATE') return; // already counted, nothing to undo
    play.answeredThisQuestion = false;
    markAnswered();
    sfx.error();
    toast(err.code === 'LATE' ? 'Too late for that one.' : err.message, 'bad');
  }
});

// ------------------------------------------------------------------ reveal

function renderReveal(lastGain) {
  const g = play.game;
  const gain = lastGain ?? null;
  const answered = gain !== null;
  const correct = gain?.correct === true;

  const verdict = el('verdict');
  verdict.textContent = !answered ? 'NO ANSWER' : correct ? 'CORRECT!' : 'WRONG';
  verdict.dataset.tone = !answered ? 'idle' : correct ? 'good' : 'bad';

  const rightIdx = g?.correctIdx ?? gain?.correctIdx;
  el('reveal-answer').textContent =
    rightIdx !== null && rightIdx !== undefined && g?.choices
      ? `Answer: ${'ABCD'[rightIdx]}. ${g.choices[rightIdx]}`
      : '';

  const why = el('reveal-why');
  why.hidden = !g?.explanation;
  why.textContent = g?.explanation ?? '';

  const gains = Object.entries(gain?.gained ?? {}).filter(([, v]) => v);
  el('gains').innerHTML = gains.length
    ? `<div class="gain-row">${gains
        .map(([k, v]) => `<span class="gain" data-stat="${k}">${STAT_LABELS[k]} +${v}</span>`)
        .join('')}</div>
       <p class="hint">${(gain?.reasons ?? []).map(escapeText).join(' · ')}</p>`
    : `<p class="hint">${answered ? 'No stat gain this time — keep going.' : 'Answer the next one to grow your character.'}</p>`;

  if (correct) sfx.confirm();
}

// ------------------------------------------------------------------ stance

function renderStances() {
  const host = el('stance-grid');
  if (!host) return;
  host.innerHTML = STANCES.map(
    (stance) => `
      <button type="button" class="stance-btn" data-stance="${stance.id}">
        <span class="stance-icon">${stance.icon}</span>
        <b>${stance.name}</b>
        <small>${escapeText(stance.blurb)}</small>
      </button>`,
  ).join('');
}

function renderStanceState() {
  const picked = play.player?.stance;
  for (const button of document.querySelectorAll('#stance-grid .stance-btn')) {
    button.classList.toggle('selected', button.dataset.stance === picked);
  }
  el('stance-note').textContent = picked
    ? `Locked in: ${stanceById(picked).name}. You can still change it until the battle starts.`
    : 'Pick one. If you do not, the arena picks for you when the battle starts.';
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('#stance-grid .stance-btn');
  if (!button) return;
  const stance = button.dataset.stance;
  try {
    await api('/api/game/stance', {
      method: 'POST',
      body: JSON.stringify({ ...play.identity, stance }),
    });
    play.player.stance = stance;
    renderStanceState();
    sfx.confirm();
  } catch (err) {
    sfx.error();
    toast(err.code === 'LOCKED' ? 'The battle has already started.' : err.message, 'bad');
  }
});

// ------------------------------------------------------------------ result

function renderFinal() {
  const rank = play.player?.rank;
  el('rank-badge').textContent = rank ? `#${rank}` : '—';
  el('rank-badge').dataset.top = String(Boolean(rank && rank <= 3));

  const total = play.game?.players ?? 0;
  el('rank-message').textContent =
    rank === 1
      ? 'Champion of the arena. Nobody left standing but you.'
      : rank
        ? `You placed ${ordinal(rank)} out of ${total}.`
        : 'The tournament is over.';

  const p = play.player;
  el('final-record').innerHTML = `<div class="gain-row">
      <span class="gain">${p?.score ?? 0} PTS</span>
      <span class="gain">${p?.correct ?? 0}/${p?.answered ?? 0} CORRECT</span>
      <span class="gain">${p?.damage ?? 0} DAMAGE</span>
      ${p?.stance ? `<span class="gain">${stanceById(p.stance).name}</span>` : ''}
    </div>`;
  if (rank === 1) sfx.fanfare();
}

function ordinal(n) {
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10];
  return `${n}${suffix}`;
}

function escapeText(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// ------------------------------------------------------------------ live wire

/**
 * Room events. Each one only nudges this page to re-ask the server what is
 * true, rather than carrying the truth itself — the stream is public, and a
 * page that believed it could be told its own score by a broadcast would be
 * telling everyone else's phone too.
 */
export const playEvents = {
  question: () => {
    play.answeredThisQuestion = false;
    play.lastChoice = null;
    refresh();
    sfx.move();
  },
  reveal: () => refresh(),
  stance: () => {
    refresh();
    sfx.move();
  },
  battle: () => refresh(),
  phase: () => refresh(),
  gameReset: () => {
    play.player = null;
    play.identity = null;
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {
      /* nothing to clean up */
    }
    toast('The instructor started a new class.', 'bad');
  },
};

/** The room does not broadcast when a battle finishes — the timeline decides
 *  that — so the phone checks back while one is running. */
export function watchBattle() {
  setInterval(() => {
    if (play.game?.phase === 'battle' || play.game?.phase === 'stance') refresh();
  }, 5000);
}
