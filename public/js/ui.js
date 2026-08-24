/** Shared bits: fetch helpers, toasts, and synthesised menu blips. */

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    // Callers need the machine-readable code to pick the right message.
    throw Object.assign(new Error(data.error || `request failed (${res.status})`), {
      status: res.status,
      code: data.code,
      data,
    });
  }
  return data;
}

let toastEl;
let toastTimer;

export function toast(message, kind = 'ok') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.toggle('bad', kind === 'bad');
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

// ------------------------------------------------------------------- sound

/**
 * Square-wave blips built on the fly — no audio files to ship, and it makes the
 * menus feel like the thing they are dressed up as.
 */
const SOUND_KEY = 'warrior-wall:muted';
let audioCtx;
let muted = localStorage.getItem(SOUND_KEY) === '1';

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function blip(freq, duration = 0.07, type = 'square', gainValue = 0.045) {
  if (muted) return;
  try {
    const ac = ctx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ac.currentTime);
    gain.gain.setValueAtTime(gainValue, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + duration);
  } catch {
    /* audio is decoration; never let it break a submission */
  }
}

export const sfx = {
  move: () => blip(520, 0.05),
  select: () => blip(760, 0.08),
  confirm: () => {
    blip(660, 0.07);
    setTimeout(() => blip(880, 0.09), 70);
    setTimeout(() => blip(1180, 0.16), 150);
  },
  cancel: () => blip(220, 0.12, 'square', 0.05),
  error: () => blip(150, 0.22, 'sawtooth', 0.05),
  fanfare: () => {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => blip(f, 0.18), i * 110));
  },
  type: () => blip(1400, 0.015, 'square', 0.02),
  isMuted: () => muted,
  toggle() {
    muted = !muted;
    localStorage.setItem(SOUND_KEY, muted ? '1' : '0');
    if (!muted) blip(880, 0.08);
    return muted;
  },
};

/** Click blips on every button, without wiring each one by hand. */
export function wireSounds(root = document) {
  root.addEventListener('pointerdown', (event) => {
    const target = event.target.closest('button, .btn');
    if (target && !target.disabled && !target.dataset.silent) sfx.select();
  });
}

export function connectEvents(handlers) {
  const source = new EventSource('/api/events');
  for (const [name, fn] of Object.entries(handlers)) {
    source.addEventListener(name, (event) => fn(JSON.parse(event.data || '{}')));
  }
  return source;
}

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}
