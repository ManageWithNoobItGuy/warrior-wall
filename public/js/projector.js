import { api, sfx, connectEvents, escapeHtml } from './ui.js';
import { Arena } from './arena.js';
import { STANCES, STAT_KEYS, STAT_LABELS } from './rules.js';

const screen = document.getElementById('screen');
const featuredTpl = document.getElementById('tpl-featured');
const attractTpl = document.getElementById('tpl-attract');

let posters = [];
let featuredId = null;
let typing = null;
let game = { phase: 'lobby' };
/** The live arena, kept across repaints — rebuilding it would restart the
 *  tournament from the walk-on every time a card arrived on the wall. */
let arena = null;
let arenaKey = null;

boot();

async function boot() {
  const state = await api('/api/state');
  featuredId = state.featuredId;
  game = state.game ?? game;
  posters = (await api('/api/posters')).posters;
  paint();

  connectEvents({
    poster: (poster) => {
      posters.push(poster);
      if (!featuredId) paint();
    },
    removed: ({ id }) => {
      posters = posters.filter((p) => p.id !== id);
      if (featuredId === id) featuredId = null;
      paint();
    },
    featured: ({ id }) => {
      featuredId = id;
      paint();
    },
    cleared: () => {
      posters = [];
      featuredId = null;
      paint();
    },
    renamed: () => {
      // Only the banner on future cards changes; nothing on screen has to move.
    },
    session: () => {
      posters = [];
      featuredId = null;
      paint();
    },

    // ---- the game
    question: () => syncGame(),
    reveal: (payload) => syncGame(payload),
    stance: () => syncGame(),
    answered: ({ count, total }) => {
      // Just a counter ticking up — repainting the whole question for it would
      // restart the entrance animation on every single answer.
      const el = document.getElementById('answer-count');
      if (el) el.textContent = `${count} / ${total}`;
    },
    stanceCount: ({ picked, total }) => {
      const el = document.getElementById('stance-count');
      if (el) el.textContent = `${picked} / ${total}`;
    },
    battle: () => syncGame(),
    phase: () => syncGame(),
    gameReset: () => syncGame(),
  });

  // The battle ends when its timeline runs out, which nothing broadcasts.
  setInterval(() => {
    if (game.phase === 'battle' && arena?.finished) paint();
  }, 1000);
}

async function syncGame(revealPayload) {
  const state = await api('/api/game/state');
  game = state;
  if (revealPayload) game.reveal = revealPayload;
  paint();
}

// ------------------------------------------------------------------ painting

const GAME_VIEWS = new Set(['question', 'reveal', 'stance', 'battle', 'done']);

/** How long the champion keeps the battlefield before the board takes over. */
const CHAMPION_DWELL = 4000;
let resultsAt = 0;

function paint() {
  // A live game outranks the wall: whatever the room is doing right now is
  // what the projector is for.
  if (GAME_VIEWS.has(game.phase)) return paintGame();

  teardownArena();
  clearTimeout(typing);
  const poster = posters.find((p) => p.id === featuredId);
  screen.innerHTML = '';
  screen.append(poster ? renderFeatured(poster) : renderAttract());
}

function teardownArena() {
  arena?.destroy();
  arena = null;
  arenaKey = null;
  resultsAt = 0;
}

async function paintGame() {
  if (game.phase === 'battle') return paintBattle();
  if (game.phase === 'done') return paintResults();

  teardownArena();
  clearTimeout(typing);

  if (game.phase === 'question') return renderQuestionScreen();
  if (game.phase === 'reveal') return renderRevealScreen();
  if (game.phase === 'stance') return renderStanceScreen();
}

function renderQuestionScreen() {
  screen.innerHTML = `
    <div class="proj-game">
      <div class="proj-game-head">
        <span class="q-num">Q${(game.questionIndex ?? 0) + 1}${game.questionTotal ? ` / ${game.questionTotal}` : ''}</span>
        <span class="spacer"></span>
        <span class="q-num">ANSWERED <b id="answer-count">${game.answered ?? 0} / ${game.players ?? 0}</b></span>
      </div>
      <h1 class="proj-question">${escapeHtml(game.text ?? '')}</h1>
      <div class="proj-choices">
        ${(game.choices ?? [])
          .map(
            (choice, i) =>
              `<div class="proj-choice"><span class="choice-key">${'ABCD'[i]}</span><span>${escapeHtml(choice)}</span></div>`,
          )
          .join('')}
      </div>
      <p class="press blink">ANSWER ON YOUR PHONE</p>
    </div>`;
  sfx.select();
}

function renderRevealScreen() {
  const reveal = game.reveal ?? {};
  const dist = reveal.distribution ?? [];
  const answered = reveal.answered ?? game.answered ?? 0;

  screen.innerHTML = `
    <div class="proj-game">
      <div class="proj-game-head">
        <span class="q-num">ANSWER</span>
        <span class="spacer"></span>
        <span class="q-num">${reveal.correct ?? 0} / ${answered} CORRECT</span>
      </div>
      <h1 class="proj-question">${escapeHtml(game.text ?? '')}</h1>
      <div class="proj-choices">
        ${(game.choices ?? [])
          .map((choice, i) => {
            const n = dist[i] ?? 0;
            const pct = answered ? Math.round((n / answered) * 100) : 0;
            const right = i === game.correctIdx;
            return `<div class="proj-choice" data-right="${right}">
              <span class="choice-key">${'ABCD'[i]}</span>
              <span>${escapeHtml(choice)}</span>
              <span class="proj-dist"><i style="width:${pct}%"></i><b>${n}</b></span>
            </div>`;
          })
          .join('')}
      </div>
      ${game.explanation ? `<p class="proj-why">${escapeHtml(game.explanation)}</p>` : ''}
      ${renderLeaderboard(reveal.leaderboard ?? [])}
    </div>`;
  sfx.confirm();
}

function renderLeaderboard(rows) {
  if (!rows.length) return '';
  return `<div class="proj-board">
    <b class="pixel">LEADERS</b>
    ${rows
      .slice(0, 8)
      .map(
        (p, i) =>
          `<div class="board-row"><b>#${i + 1}</b><span>${escapeHtml(p.name)}</span><i>${p.score}</i></div>`,
      )
      .join('')}
  </div>`;
}

function renderStanceScreen() {
  screen.innerHTML = `
    <div class="proj-game">
      <h1 class="proj-question">CHOOSE YOUR STANCE</h1>
      <div class="proj-stances">
        ${STANCES.map(
          (s) =>
            `<div class="proj-stance"><span>${s.icon}</span><b>${s.name}</b><small>${escapeHtml(s.blurb)}</small></div>`,
        ).join('')}
      </div>
      <p class="proj-why">Strike beats Cast · Cast beats Guard · Guard beats Strike</p>
      <p class="press">PICKED <b id="stance-count">${game.stancePicked ?? 0} / ${game.players ?? 0}</b></p>
    </div>`;
}

/**
 * The tournament.
 *
 * Mounted once per battle and left running. `startedAt` is the key: a second
 * battle in the same class is a new show, but a repaint during one is not.
 */
async function paintBattle() {
  if (arenaKey === game.battleStartedAt && arena) {
    if (arena.finished) renderChampionOverlay();
    return;
  }

  const { battle } = await api('/api/game/battle');
  if (!battle) return;

  teardownArena();
  screen.innerHTML = '<div class="proj-arena"></div>';
  arena = new Arena(screen.firstElementChild, battle);
  arena.start();
  arenaKey = game.battleStartedAt;
  sfx.fanfare();
}

/**
 * The end of the lesson's tournament, as a board a whole room can read.
 *
 * Two orders of merit, because the arena deliberately does not settle the
 * quiz: answering well buys stats, not victory, so the student who knew the
 * most and the student left standing are often different people and both
 * deserve their name up.
 *
 * The champion keeps the battlefield for a moment first — that beat is the
 * point of the show. A projector that connects after it is all over has no
 * banner to wait for and goes straight to the board.
 */
async function paintResults() {
  if (arena?.finished) {
    if (!resultsAt) resultsAt = Date.now() + CHAMPION_DWELL;
    if (Date.now() < resultsAt) {
      renderChampionOverlay();
      clearTimeout(typing);
      typing = setTimeout(() => {
        if (game.phase === 'done') paint();
      }, resultsAt - Date.now() + 50);
      return;
    }
  }

  if (screen.querySelector('.results-board')) return;

  const [{ battle }, roster] = await Promise.all([
    api('/api/game/battle'),
    api('/api/game/roster').catch(() => ({ players: [] })),
  ]);
  if (!battle) return;

  teardownArena();

  const byId = new Map(battle.fighters.map((f) => [f.playerId, f]));
  const arenaRows = [...battle.result.ranking]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8)
    .map((entry) => {
      const fighter = byId.get(entry.playerId);
      return {
        rank: entry.rank,
        name: fighter?.name ?? entry.playerId,
        job: fighter?.classId ?? '',
        detail: `${entry.damageDealt} DMG`,
      };
    });

  // Most correct wins; a tie goes to the one who needed fewer questions to get
  // there, then to points, so the order is never arbitrary.
  const quizRows = (roster.players ?? [])
    .filter((p) => (p.answered ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.correct ?? 0) - (a.correct ?? 0) ||
        (a.answered ?? 0) - (b.answered ?? 0) ||
        (b.score ?? 0) - (a.score ?? 0),
    )
    .slice(0, 8)
    .map((player, i) => ({
      rank: i + 1,
      name: player.name,
      job: player.job ?? '',
      detail: `${player.correct ?? 0}/${player.answered ?? 0}`,
    }));

  const table = (title, rows, empty) => `
    <div class="results-col">
      <b class="results-head pixel">${title}</b>
      ${
        rows.length
          ? `<ol class="results-list">${rows
              .map(
                (row) => `
          <li class="${row.rank === 1 ? 'is-first' : ''}">
            <span class="results-rank">${row.rank}</span>
            <span class="results-name">${escapeHtml(row.name)}</span>
            <span class="results-job" data-job="${escapeHtml(row.job)}">${escapeHtml(
              row.job.toUpperCase(),
            )}</span>
            <span class="results-detail">${escapeHtml(row.detail)}</span>
          </li>`,
              )
              .join('')}</ol>`
          : `<p class="results-empty">${empty}</p>`
      }
    </div>`;

  const champion = byId.get(battle.result.championId);
  const sharpest = quizRows[0];

  screen.innerHTML = `
    <div class="results-board">
      <b class="results-title pixel">FINAL RESULTS</b>
      <div class="results-cols">
        ${table('ARENA', arenaRows, 'No tournament was run.')}
        ${table('QUIZ', quizRows, 'No questions were asked.')}
      </div>
      <div class="results-crowns">
        ${champion ? `<span>CHAMPION <b>${escapeHtml(champion.name)}</b></span>` : ''}
        ${sharpest ? `<span>SHARPEST <b>${escapeHtml(sharpest.name)}</b></span>` : ''}
      </div>
    </div>`;
  sfx.fanfare();
}

/** Once the places have been read out, the champion's name stays up. */
function renderChampionOverlay() {
  if (screen.querySelector('.champion-banner')) return;
  const champion = arena.byId.get(arena.payload.result.championId);
  if (!champion) return;
  const banner = document.createElement('div');
  banner.className = 'champion-banner';
  banner.innerHTML = `
    <b class="pixel">CHAMPION</b>
    <h1>${escapeHtml(champion.name)}</h1>
    <span class="pixel" data-job="${escapeHtml(champion.classId)}">${escapeHtml((champion.classId ?? '').toUpperCase())}</span>
    <div class="champion-stats">${STAT_KEYS.map(
      (k) => `<span>${STAT_LABELS[k]} <b>${champion.stats[k]}</b></span>`,
    ).join('')}</div>`;
  screen.append(banner);
  sfx.fanfare();
}

// ------------------------------------------------------------ the wall views

function renderFeatured(poster) {
  const node = featuredTpl.content.cloneNode(true);
  node.querySelector('[data-poster]').src = `/p/${poster.id}.png`;
  node.querySelector('[data-poster]').alt = `Card for ${poster.name}`;
  node.querySelector('[data-name]').textContent = poster.name;
  node.querySelector('[data-id]').textContent = `ID ${poster.studentId}`;

  const list = node.querySelector('[data-actions]');
  poster.actions.forEach((action, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="bullet">${i + 1}</span><span class="text"></span>`;
    list.append(li);
  });

  node.querySelector('[data-takeaways]').innerHTML =
    `<b class="pixel" style="font-size:0.7em;color:var(--cyan)">KEY TAKEAWAYS</b><br>` +
    poster.takeaways.map((t, i) => `${i + 1}. ${escapeHtml(t)}`).join(' &nbsp;·&nbsp; ');

  // typewriter, one action after another — the JRPG dialogue cadence
  queueMicrotask(() => typeOut([...list.querySelectorAll('.text')], poster.actions));
  sfx.confirm();
  return node;
}

function typeOut(targets, texts) {
  let index = 0;
  let char = 0;

  const tick = () => {
    if (index >= targets.length) return;
    const target = targets[index];
    const full = texts[index];
    char += 1;
    target.textContent = full.slice(0, char);
    if (char % 3 === 0) sfx.type();
    if (char >= full.length) {
      index += 1;
      char = 0;
      typing = setTimeout(tick, 260);
    } else {
      typing = setTimeout(tick, 26);
    }
  };
  tick();
}

function renderAttract() {
  const node = attractTpl.content.cloneNode(true);
  const strip = node.querySelector('[data-strip]');
  posters.slice(-9).forEach((poster) => {
    const img = document.createElement('img');
    img.src = `/p/${poster.id}.png`;
    img.alt = '';
    strip.append(img);
  });
  return node;
}

// -------------------------------------------------------------- remote control

document.addEventListener('keydown', async (event) => {
  if (event.key === 'f' || event.key === 'F') {
    document.fullscreenElement ? document.exitFullscreen() : document.body.requestFullscreen();
    return;
  }
  // Arrow keys browse the wall. While a game is on screen they would fight the
  // instructor's own controls, so they are ignored until the room is idle.
  if (GAME_VIEWS.has(game.phase) || !posters.length) return;

  const current = posters.findIndex((p) => p.id === featuredId);
  let next = null;

  if (event.key === 'ArrowRight') next = posters[(current + 1 + posters.length) % posters.length];
  else if (event.key === 'ArrowLeft')
    next = posters[(current - 1 + posters.length) % posters.length];
  else if (event.key === 'Escape') next = null;
  else return;

  event.preventDefault();
  await api('/api/featured', { method: 'POST', body: JSON.stringify({ id: next?.id ?? null }) });
});
