import { api, toast, sfx, wireSounds, connectEvents, escapeHtml } from './ui.js';

const roster = document.getElementById('roster');
const emptyState = document.getElementById('empty');
const countEl = document.getElementById('count');
const titleInput = document.getElementById('title');

let posters = [];
let featuredId = null;

wireSounds();
boot();

async function boot() {
  const state = await api('/api/state');
  titleInput.value = state.session.title;
  featuredId = state.featuredId;
  setJoinUrl(state.joinUrl);
  posters = (await api('/api/posters')).posters;
  render();

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
    session: ({ title }) => {
      titleInput.value = title;
      posters = [];
      featuredId = null;
      render();
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
    await api('/api/featured', { method: 'POST', body: JSON.stringify({ id: next }) });
    toast(next ? 'Now on the projector.' : 'Cleared the projector.');
  }

  if (action === 'delete') {
    const poster = posters.find((p) => p.id === id);
    if (!confirm(`Delete the card for ${poster?.name ?? 'this student'}?`)) return;
    await api(`/api/posters/${id}`, { method: 'DELETE' });
  }
});

// ---------------------------------------------------------------- session bar

document.getElementById('save-title').addEventListener('click', async () => {
  await api('/api/session/title', {
    method: 'POST',
    body: JSON.stringify({ title: titleInput.value }),
  });
  toast('Class name updated.');
});

document.getElementById('new-session').addEventListener('click', async () => {
  const title = prompt('Name for the new session:', titleInput.value);
  if (title === null) return;
  if (
    !confirm(
      'Start a new session? Every card in the current session leaves the wall, and avatar quotas reset.',
    )
  )
    return;
  await api('/api/session', { method: 'POST', body: JSON.stringify({ title }) });
  toast('New session started.');
});

document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm(`Delete all ${posters.length} cards in this session? This cannot be undone.`)) return;
  await api('/api/session/clear', { method: 'POST' });
  toast('Wall cleared.');
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
