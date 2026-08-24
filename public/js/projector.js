import { api, sfx, connectEvents, escapeHtml } from './ui.js';

const screen = document.getElementById('screen');
const featuredTpl = document.getElementById('tpl-featured');
const attractTpl = document.getElementById('tpl-attract');

let posters = [];
let featuredId = null;
let typing = null;

boot();

async function boot() {
  const state = await api('/api/state');
  featuredId = state.featuredId;
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
    session: () => {
      posters = [];
      featuredId = null;
      paint();
    },
  });
}

function paint() {
  clearTimeout(typing);
  const poster = posters.find((p) => p.id === featuredId);
  screen.innerHTML = '';
  screen.append(poster ? renderFeatured(poster) : renderAttract());
}

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
  if (!posters.length) return;
  const current = posters.findIndex((p) => p.id === featuredId);
  let next = null;

  if (event.key === 'ArrowRight') next = posters[(current + 1 + posters.length) % posters.length];
  else if (event.key === 'ArrowLeft')
    next = posters[(current - 1 + posters.length) % posters.length];
  else if (event.key === 'Escape') next = null;
  else if (event.key === 'f' || event.key === 'F') {
    document.fullscreenElement ? document.exitFullscreen() : document.body.requestFullscreen();
    return;
  } else return;

  event.preventDefault();
  await api('/api/featured', { method: 'POST', body: JSON.stringify({ id: next?.id ?? null }) });
});
