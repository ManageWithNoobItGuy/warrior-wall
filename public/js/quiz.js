/**
 * The instructor's game controls: the question bank, and running the room.
 *
 * Deliberately one screen with no wizard. Everything here is pressed while
 * standing in front of a class, often mid-sentence — OPEN, CLOSE, and START
 * BATTLE have to be reachable without navigating anywhere, and the editor is
 * folded away below them rather than on a page of its own.
 */

import {
  api, toast, sfx, connectEvents, escapeHtml, guarded, reportFailure, askConfirm,
} from './ui.js';

const el = (id) => document.getElementById(id);

const gm = {
  questions: [],
  game: { phase: 'lobby' },
  /** Which question the OPEN button will open. Follows the room while it is
   *  running, and is nudged by the arrows between questions. */
  cursor: 0,
};

export async function initQuiz() {
  // Never let a failed load take the panel down with it — an instructor
  // looking at a blank GAME MASTER box has no way to tell a broken page from
  // an empty question bank.
  await Promise.all([loadQuestions(), loadGame()]);
  render();

  connectEvents({
    question: () => loadGame().then(render),
    reveal: (payload) => {
      gm.reveal = payload;
      loadGame().then(render);
    },
    answered: ({ count, total }) => {
      el('gm-answered').textContent = `${count} / ${total}`;
    },
    stanceCount: ({ picked, total }) => {
      el('gm-stances').textContent = `${picked} / ${total}`;
    },
    stance: () => loadGame().then(render),
    battle: () => loadGame().then(render),
    phase: () => loadGame().then(render),
    roster: ({ count }) => {
      el('gm-players').textContent = count;
    },
    gameReset: () => loadGame().then(render),
    questions: () => loadQuestions().then(render),
  });
}

/** Reads are resilient: on failure they report once and keep whatever the
 *  panel already had, rather than rejecting into nothing. */
async function loadQuestions() {
  try {
    gm.questions = (await api('/api/questions')).questions ?? [];
  } catch (err) {
    reportFailure(err, 'Could not load the question bank');
  }
}

async function loadGame() {
  try {
    gm.game = await api('/api/game/state');
  } catch (err) {
    reportFailure(err, 'Could not read the room');
    return;
  }
  // While a question is live the cursor belongs to the room, not the arrows.
  if (gm.game.phase === 'question' || gm.game.phase === 'reveal') {
    gm.cursor = gm.game.questionIndex ?? gm.cursor;
  }
}

// ------------------------------------------------------------------ rendering

function render() {
  const g = gm.game;
  el('gm-players').textContent = g.players ?? 0;
  el('gm-phase').textContent = (g.phase ?? 'lobby').toUpperCase();
  el('gm-answered').textContent =
    g.phase === 'question' || g.phase === 'reveal' ? `${g.answered ?? 0} / ${g.players ?? 0}` : '—';
  el('gm-stances').textContent = g.players ? `${g.stancePicked ?? 0} / ${g.players}` : '—';
  el('gm-count').textContent = gm.questions.length;

  const current = gm.questions[gm.cursor];
  el('gm-current').textContent = !gm.questions.length
    ? 'No questions yet — add some below.'
    : g.phase === 'question'
      ? `LIVE · Q${gm.cursor + 1}: ${current?.text ?? ''}`
      : g.phase === 'reveal'
        ? `REVEALED · Q${gm.cursor + 1}: ${current?.text ?? ''}`
        : `NEXT UP · Q${gm.cursor + 1} of ${gm.questions.length}: ${current?.text ?? ''}`;

  // Only ever offer the move that makes sense from here — a CLOSE button with
  // nothing open is one more thing to think about while a room watches.
  const live = g.phase === 'question';
  el('gm-open').disabled = live || !gm.questions.length;
  el('gm-close').disabled = !live;
  el('gm-prev').disabled = live || gm.cursor <= 0;
  el('gm-next').disabled = live || gm.cursor >= gm.questions.length - 1;
  el('gm-stance').disabled = live || !g.players;
  el('gm-battle').disabled = live || (g.players ?? 0) < 2;
  // One way only, so once the room is writing there is nothing left to press.
  el('gm-pledge').disabled = Boolean(g.pledgeOpen) || !g.players;
  el('gm-pledge').textContent = g.pledgeOpen ? 'PLEDGING IS OPEN' : 'OPEN PLEDGING';

  el('gm-hint').textContent =
    (g.players ?? 0) < 2
      ? 'At least 2 characters have to be in the room before a battle can run.'
      : g.phase === 'battle'
        ? 'The battle is playing on the projector.'
        : g.phase === 'stance'
          ? 'Students are picking stances. Start the battle when enough have chosen.'
          : '';

  renderBoard();
  if (!el('gm-list').childElementCount || gm.listDirty !== gm.questions.length) renderEditor();
}

function renderBoard() {
  const rows = gm.reveal?.leaderboard ?? [];
  el('gm-board').innerHTML = rows.length
    ? `<b class="pixel">LEADERS</b><div class="gm-board-rows">${rows
        .map(
          (p, i) =>
            `<div class="board-row"><b>#${i + 1}</b><span>${escapeHtml(p.name)}</span><i>${p.score}</i></div>`,
        )
        .join('')}</div>`
    : '';
}

// ------------------------------------------------------------------ editor

/**
 * The bank is edited as plain inputs and saved whole.
 *
 * Reordering and deleting questions is common enough that diffing rows would
 * be more code and more ways to leave a gap in the ordering, so SAVE sends the
 * list exactly as it appears.
 */
function renderEditor() {
  gm.listDirty = gm.questions.length;
  el('gm-list').innerHTML = gm.questions
    .map(
      (q, i) => `
      <div class="gm-q" data-i="${i}">
        <div class="gm-q-head">
          <span class="num">${i + 1}</span>
          <input class="gm-q-text" value="${escapeHtml(q.text)}" placeholder="Question text"
                 maxlength="400" />
          <input class="gm-q-time" type="number" min="5" max="300" value="${q.timeLimitSec}"
                 title="Seconds" />
          <button class="btn--sm btn--ghost" data-move="-1" title="Move up">▲</button>
          <button class="btn--sm btn--ghost" data-move="1" title="Move down">▼</button>
          <button class="btn--sm btn--danger" data-del title="Delete">✕</button>
        </div>
        <div class="gm-choices">
          ${[0, 1, 2, 3]
            .map(
              (c) => `
            <label class="gm-choice">
              <input type="radio" name="correct-${i}" value="${c}" ${
                q.correctIdx === c ? 'checked' : ''
              } title="Mark as the correct answer" />
              <span class="choice-key">${'ABCD'[c]}</span>
              <input class="gm-choice-text" value="${escapeHtml(q.choices[c] ?? '')}"
                     placeholder="${c < 2 ? 'Choice (required)' : 'Choice (optional)'}"
                     maxlength="200" />
            </label>`,
            )
            .join('')}
        </div>
        <input class="gm-q-why" value="${escapeHtml(q.explanation ?? '')}"
               placeholder="Explanation shown after the reveal (optional)" maxlength="400" />
      </div>`,
    )
    .join('');
}

/** Reads the DOM back into the model. Called before anything that reorders or
 *  saves, so typing that has not left the field is never lost. */
function harvest() {
  gm.questions = [...document.querySelectorAll('.gm-q')].map((node, i) => ({
    id: gm.questions[i]?.id,
    text: node.querySelector('.gm-q-text').value,
    timeLimitSec: Number(node.querySelector('.gm-q-time').value) || 25,
    explanation: node.querySelector('.gm-q-why').value,
    choices: [...node.querySelectorAll('.gm-choice-text')].map((input) => input.value),
    correctIdx: Number(node.querySelector('input[type=radio]:checked')?.value ?? 0),
  }));
}

el('gm-add').addEventListener('click', () => {
  harvest();
  gm.questions.push({
    text: '',
    choices: ['', '', '', ''],
    correctIdx: 0,
    timeLimitSec: 25,
    explanation: '',
  });
  renderEditor();
  render();
});

el('gm-list').addEventListener('click', (event) => {
  const row = event.target.closest('.gm-q');
  if (!row) return;
  const i = Number(row.dataset.i);

  if (event.target.closest('[data-del]')) {
    harvest();
    gm.questions.splice(i, 1);
    renderEditor();
    render();
  }

  const move = event.target.closest('[data-move]')?.dataset.move;
  if (move) {
    harvest();
    const to = i + Number(move);
    if (to < 0 || to >= gm.questions.length) return;
    [gm.questions[i], gm.questions[to]] = [gm.questions[to], gm.questions[i]];
    renderEditor();
  }
});

el('gm-save').addEventListener('click', async () => {
  harvest();
  // Trailing empty choices are how you write a two-option question, so they
  // are dropped here rather than rejected by the server.
  const payload = gm.questions.map((q) => ({
    ...q,
    choices: q.choices.map((c) => c.trim()).filter(Boolean),
  }));
  try {
    gm.questions = (await api('/api/questions', {
      method: 'PUT',
      body: JSON.stringify({ questions: payload }),
    })).questions;
    renderEditor();
    render();
    toast(`Saved ${gm.questions.length} questions.`);
  } catch (err) {
    reportFailure(err, 'Could not save the question bank');
  }
});

// ------------------------------------------------------------------ running

el('gm-prev').addEventListener('click', () => {
  gm.cursor = Math.max(0, gm.cursor - 1);
  render();
});

el('gm-next').addEventListener('click', () => {
  gm.cursor = Math.min(gm.questions.length - 1, gm.cursor + 1);
  render();
});

el('gm-open').addEventListener('click', async () => {
  try {
    await api('/api/game/open', { method: 'POST', body: JSON.stringify({ index: gm.cursor }) });
    gm.reveal = null;
    await loadGame();
    render();
    sfx.confirm();
  } catch (err) {
    reportFailure(err);
  }
});

el('gm-close').addEventListener('click', async () => {
  try {
    gm.reveal = await api('/api/game/close', { method: 'POST', body: '{}' });
    await loadGame();
    // Land on the next question so OPEN is the only button to press next.
    if (gm.cursor < gm.questions.length - 1) gm.cursor += 1;
    render();
    sfx.confirm();
  } catch (err) {
    reportFailure(err);
  }
});

el('gm-lobby').addEventListener('click', async () => {
  await guarded('Could not clear the screen', async () => {
    await api('/api/game/lobby', { method: 'POST', body: '{}' });
    gm.reveal = null;
    await loadGame();
    render();
  });
});

el('gm-stance').addEventListener('click', async () => {
  await guarded('Could not open stance picking', async () => {
    await api('/api/game/stance/open', { method: 'POST', body: '{}' });
    await loadGame();
    render();
    toast('Students can pick their stance now.');
  });
});

el('gm-pledge').addEventListener('click', async () => {
  const go = await askConfirm({
    title: 'OPEN PLEDGING',
    message:
      'Every phone in the room moves to KEY TAKEAWAYS now. Do this once the battle is over — it cannot be undone.',
    confirmLabel: 'OPEN IT',
  });
  if (!go) return;
  await guarded('Could not open pledging', async () => {
    await api('/api/game/pledge/open', { method: 'POST', body: '{}' });
    await loadGame();
    render();
    toast('The room is writing their cards.');
  });
});

el('gm-battle').addEventListener('click', async () => {
  const unpicked = (gm.game.players ?? 0) - (gm.game.stancePicked ?? 0);
  if (unpicked > 0) {
    const go = await askConfirm({
      title: 'START THE BATTLE',
      message: `${unpicked} of ${gm.game.players} have not picked a stance. The arena will pick for them.`,
      confirmLabel: '⚔ FIGHT',
    });
    if (!go) return;
  }
  try {
    const result = await api('/api/game/battle/start', { method: 'POST', body: '{}' });
    await loadGame();
    render();
    sfx.fanfare();
    toast(`Battle started — ${result.count} warriors, about ${Math.round(result.totalMs / 1000)}s.`);
  } catch (err) {
    reportFailure(err);
  }
});

el('gm-reset').addEventListener('click', async () => {
  const sure = await askConfirm({
    title: 'RESET THE ROOM',
    message:
      'Every character, stat and battle result is deleted and students start over. The pledge cards on the wall are not touched.',
    confirmLabel: 'RESET',
    danger: true,
  });
  if (!sure) return;
  await guarded('Could not reset the room', async () => {
    await api('/api/game/reset', { method: 'POST', body: '{}' });
    gm.reveal = null;
    await loadGame();
    render();
    toast('Room reset.');
  });
});
