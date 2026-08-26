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

// --------------------------------------------------------------- dialogs

/**
 * In-page replacements for `prompt()` and `confirm()`.
 *
 * The native ones cannot be relied on. Chrome offers "prevent this page from
 * creating additional dialogs" the second time a page opens one, and once that
 * is ticked every later call returns null or false *without showing anything*
 * — which the calling code reads as "the user cancelled". The result is a
 * button that silently does nothing, with no way to tell that from a bug.
 * Mid-class, on the button that starts the session, that is unacceptable.
 *
 * These also let the prompts look like the rest of the app and work the same
 * way on a phone.
 */
function openDialog(build) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'window window--gold app-dialog';
    const finish = (value) => {
      resolve(value);
      dialog.close();
      dialog.remove();
    };
    build(dialog, finish);
    document.body.append(dialog);
    // Escape and the backdrop both count as cancelling.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.showModal();
    dialog.querySelector('input, button')?.focus();
  });
}

/** Asks for a line of text. Resolves to the string, or null if cancelled. */
export function askText({ title, message, label, value = '', confirmLabel = 'OK ▶', maxLength = 60 }) {
  return openDialog((dialog, finish) => {
    dialog.innerHTML = `
      <span class="window-title">${escapeHtml(title)}</span>
      <div class="stack">
        <p class="speech">${escapeHtml(message)}</p>
        <div>
          <label for="dlg-input">${escapeHtml(label)}</label>
          <input id="dlg-input" type="text" maxlength="${maxLength}">
        </div>
      </div>
      <div class="row" style="margin-top:18px">
        <button class="btn--ghost" data-cancel>CANCEL</button>
        <span class="spacer"></span>
        <button class="btn--primary" data-ok>${escapeHtml(confirmLabel)}</button>
      </div>`;
    const input = dialog.querySelector('#dlg-input');
    input.value = value;
    const submit = () => finish(input.value.trim() || null);
    dialog.querySelector('[data-ok]').addEventListener('click', submit);
    dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }).then((v) => v);
}

/** Asks a yes/no question. Resolves true only on an explicit yes. */
export function askConfirm({ title, message, confirmLabel = 'CONFIRM ▶', danger = false }) {
  return openDialog((dialog, finish) => {
    dialog.innerHTML = `
      <span class="window-title">${escapeHtml(title)}</span>
      <div class="stack"><p class="speech">${escapeHtml(message)}</p></div>
      <div class="row" style="margin-top:18px">
        <button class="btn--ghost" data-cancel>CANCEL</button>
        <span class="spacer"></span>
        <button class="${danger ? 'btn--danger' : 'btn--primary'}" data-ok>${escapeHtml(confirmLabel)}</button>
      </div>`;
    dialog.querySelector('[data-ok]').addEventListener('click', () => finish(true));
    dialog.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
  }).then((v) => v === true);
}

/**
 * Reports a failed instructor action.
 *
 * These buttons are pressed while someone is standing in front of a class, so
 * a request that fails quietly is worse than one that fails loudly: the wall
 * simply does not change, and there is nothing to react to. Every one of them
 * used to be an unguarded `await`.
 *
 * A 401 gets its own path because it has one cause and one fix — the passcode
 * cookie expired, or the passcode was rotated while this tab stayed open —
 * and neither is guessable from a generic error message.
 */
export function reportFailure(err, what = 'That did not work') {
  sfx.error();
  if (err?.status === 401) {
    toast('Instructor session expired — returning to the passcode screen.', 'bad');
    setTimeout(() => window.location.assign(window.location.pathname), 1800);
    return;
  }
  toast(`${what}: ${err?.message ?? 'unknown error'}`, 'bad');
}

/** Runs an instructor action, reporting anything that goes wrong. Returns the
 *  action's value, or null if it failed. */
export async function guarded(what, run) {
  try {
    return await run();
  } catch (err) {
    reportFailure(err, what);
    return null;
  }
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
