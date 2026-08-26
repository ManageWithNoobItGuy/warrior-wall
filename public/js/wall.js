import {
  api, toast, sfx, wireSounds, connectEvents, escapeHtml, guarded, askText, askConfirm,
} from './ui.js';
import { initQuiz } from './quiz.js';

const roster = document.getElementById('roster');
const emptyState = document.getElementById('empty');
const countEl = document.getElementById('count');
const titleInput = document.getElementById('title');

let posters = [];
let featuredId = null;

wireSounds();
boot();
// The game panel keeps its own state and its own subscription; it shares only
// the page with the wall below it. Its own failures are reported inside it;
// this catch is the backstop so a rejection here never goes unhandled.
initQuiz().catch(() => {});

async function boot() {
  const state = await api('/api/state').catch((err) => {
    toast(`Could not load the class: ${err.message}`, 'bad');
    throw err;
  });
  titleInput.value = state.session.title;
  featuredId = state.featuredId;
  setJoinUrl(state.joinUrl);
  posters = (await api('/api/posters')).posters;
  render();
  loadSessions();

  connectEvents({
    poster: (poster) => {
      posters.push(poster);
      render(poster.id);
      sfx.fanfare();
      toast(`A NEW CHALLENGER! ${poster.name}`);
    },
    removed: ({ id }) => {
      posters = posters.filter((p) => p.id !== id);
      if (featuredId === id) featuredId = null;
      render();
    },
    featured: ({ id }) => {
      featuredId = id;
      render();
    },
    cleared: () => {
      posters = [];
      featuredId = null;
      render();
    },
    renamed: ({ title }) => {
      titleInput.value = title;
      loadSessions();
    },
    session: ({ title }) => {
      titleInput.value = title;
      posters = [];
      featuredId = null;
      render();
      loadSessions();
    },
  });
}

function setJoinUrl(url) {
  document.getElementById('join-url').textContent = url;
  document.getElementById('join-url-big').textContent = url;
  const qrSrc = `/api/qr.svg?url=${encodeURIComponent(url)}`;
  document.getElementById('qr').src = qrSrc;
  document.getElementById('qr-big').src = qrSrc;
  document.getElementById('copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied.');
    } catch {
      toast('Could not copy — select the text manually.', 'bad');
    }
  };
}

function render(newId = null) {
  countEl.textContent = posters.length;
  emptyState.hidden = posters.length > 0;
  document.getElementById('zip').classList.toggle('is-disabled', !posters.length);

  roster.innerHTML = posters
    .map(
      (poster) => `
      <article class="card ${poster.id === featuredId ? 'is-featured' : ''} ${
        poster.id === newId ? 'is-new' : ''
      }" data-id="${poster.id}">
        ${poster.id === featuredId ? '<span class="badge featured-flag">ON SCREEN</span>' : ''}
        <img src="/p/${poster.id}.png" alt="Card for ${escapeHtml(poster.name)}" loading="lazy"
             data-action="project" title="Click to put on the projector" />
        <div class="card-bar">
          <span class="card-name">${escapeHtml(poster.name)}<small>${escapeHtml(
            poster.studentId,
          )}</small></span>
        </div>
        <div class="card-actions">
          <button class="btn--sm btn--primary" data-action="project">SHOW</button>
          <a class="btn btn--sm btn--ghost" href="/p/full/${poster.id}.png" download="warrior-${escapeHtml(
            poster.studentId,
          )}.png" title="Download">⬇</a>
          <button class="btn--sm btn--danger" data-action="delete" title="Delete">✕</button>
        </div>
      </article>`,
    )
    .join('');
}

roster.addEventListener('click', async (event) => {
  const card = event.target.closest('.card');
  if (!card) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  const id = card.dataset.id;

  if (action === 'project') {
    const next = featuredId === id ? null : id;
    await guarded('Could not change the projector', async () => {
      await api('/api/featured', { method: 'POST', body: JSON.stringify({ id: next }) });
      toast(next ? 'Now on the projector.' : 'Cleared the projector.');
    });
  }

  if (action === 'delete') {
    const poster = posters.find((p) => p.id === id);
    const sure = await askConfirm({
      title: 'DELETE CARD',
      message: `Delete the card for ${poster?.name ?? 'this student'}? This cannot be undone.`,
      confirmLabel: 'DELETE',
      danger: true,
    });
    if (!sure) return;
    await guarded('Could not delete that card', () =>
      api(`/api/posters/${id}`, { method: 'DELETE' }),
    );
  }
});

// ---------------------------------------------------------------- classes

/**
 * The class list: switch between sessions, rename them, delete old ones.
 *
 * Switching is lossless. Cards are filed in D1 by session, and since each
 * session has its own room in the Durable Object, the characters and the
 * question bank of the class you switch away from are still there when you
 * switch back.
 */
const sessionList = document.getElementById('session-list');

async function loadSessions() {
  await guarded('Could not load the class list', async () => {
    const { sessions } = await api('/api/sessions');
    document.getElementById('session-count').textContent = `${sessions.length}`;
    sessionList.innerHTML = sessions
      .map((s) => {
        const when = new Date(s.createdAt).toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
        return `<div class="session-row" data-active="${s.active}" data-id="${escapeHtml(s.id)}">
          <div class="session-name">
            <b>${escapeHtml(s.title)}</b>
            <span class="session-meta">
              ${when} · ${s.cards} CARD${s.cards === 1 ? '' : 'S'}
              ${s.active ? '<b class="session-live">· LIVE NOW</b>' : ''}
            </span>
          </div>
          <div class="session-actions">
            ${
              s.active
                ? '<span class="session-meta session-live">IN USE</span>'
                : '<button class="btn--sm btn--primary" data-act="switch">SWITCH TO</button>'
            }
            <button class="btn--sm btn--ghost" data-act="rename">RENAME</button>
            ${
              s.active
                ? ''
                : '<button class="btn--sm btn--danger" data-act="delete" title="Delete this class and its cards">✕</button>'
            }
          </div>
        </div>`;
      })
      .join('');
  });
}

sessionList.addEventListener('click', async (event) => {
  const row = event.target.closest('.session-row');
  const act = event.target.closest('[data-act]')?.dataset.act;
  if (!row || !act) return;
  const id = row.dataset.id;
  const name = row.querySelector('.session-name b').textContent;

  if (act === 'switch') {
    const go = await askConfirm({
      title: 'SWITCH CLASS',
      message: `Make "${name}" the live class. Its cards, question bank and characters all come back exactly as you left them. Nothing is deleted from the class you are leaving.`,
      confirmLabel: 'SWITCH ▶',
    });
    if (!go) return;
    await guarded('Could not switch class', async () => {
      await api('/api/sessions/activate', { method: 'POST', body: JSON.stringify({ id }) });
      toast(`Now teaching "${name}".`);
      // Everything on this page belongs to the old class; start clean.
      window.location.reload();
    });
  }

  if (act === 'rename') {
    const title = await askText({
      title: 'RENAME CLASS',
      message: 'The name shown on the wall and printed on every card made from now on.',
      label: 'CLASS NAME',
      value: name,
      confirmLabel: 'RENAME',
    });
    if (!title) return;
    await guarded('Could not rename that class', async () => {
      await api('/api/sessions/rename', { method: 'POST', body: JSON.stringify({ id, title }) });
      if (row.dataset.active === 'true') titleInput.value = title;
      toast('Renamed.');
      await loadSessions();
    });
  }

  if (act === 'delete') {
    const cards = row.querySelector('.session-meta').textContent.match(/(\d+) CARD/)?.[1] ?? '0';
    const sure = await askConfirm({
      title: 'DELETE CLASS',
      message: `Permanently delete "${name}" and all ${cards} of its cards, questions and results. This cannot be undone.`,
      confirmLabel: 'DELETE FOREVER',
      danger: true,
    });
    if (!sure) return;
    await guarded('Could not delete that class', async () => {
      await api('/api/sessions/delete', { method: 'POST', body: JSON.stringify({ id }) });
      toast(`Deleted "${name}".`);
      await loadSessions();
    });
  }
});

// ---------------------------------------------------------------- session bar

document.getElementById('save-title').addEventListener('click', async () => {
  await guarded('Could not rename the class', async () => {
    await api('/api/session/title', {
      method: 'POST',
      body: JSON.stringify({ title: titleInput.value }),
    });
    toast('Class name updated.');
  });
});

document.getElementById('new-session').addEventListener('click', async () => {
  const title = await askText({
    title: 'NEW SESSION',
    message:
      'Starts a fresh class. The cards on the wall now stay in the database but leave the wall, every character is cleared, and AI avatar quotas reset. Nothing is deleted.',
    label: 'CLASS NAME',
    value: titleInput.value,
    confirmLabel: 'START ▶',
  });
  if (!title) return;
  await guarded('Could not start a new session', async () => {
    await api('/api/session', { method: 'POST', body: JSON.stringify({ title }) });
    toast('New session started.');
    await loadSessions();
  });
});

document.getElementById('clear').addEventListener('click', async () => {
  const sure = await askConfirm({
    title: 'CLEAR THE WALL',
    message: `Permanently delete all ${posters.length} cards in this session. This cannot be undone — use NEW SESSION instead if you only want a fresh wall.`,
    confirmLabel: 'DELETE THEM ALL',
    danger: true,
  });
  if (!sure) return;
  await guarded('Could not clear the wall', async () => {
    await api('/api/session/clear', { method: 'POST' });
    toast('Wall cleared.');
  });
});

document.getElementById('zip').addEventListener('click', (event) => {
  if (!posters.length) {
    event.preventDefault();
    toast('No cards to download yet.', 'bad');
  }
});

// ---------------------------------------------------------------- QR modal

const qrModal = document.getElementById('qr-modal');
document.getElementById('fullscreen-qr').addEventListener('click', () => qrModal.showModal());
document.getElementById('close-qr').addEventListener('click', () => qrModal.close());

// ---------------------------------------------------------------- sound

const muteBtn = document.getElementById('mute');
muteBtn.textContent = sfx.isMuted() ? 'SOUND: OFF' : 'SOUND: ON';
muteBtn.addEventListener('click', () => {
  muteBtn.textContent = sfx.toggle() ? 'SOUND: OFF' : 'SOUND: ON';
});
