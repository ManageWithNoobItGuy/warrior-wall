import { api, toast, sfx, wireSounds, connectEvents, askConfirm } from './ui.js';
import {
  initPlay,
  createCharacter,
  lookupCharacter,
  refresh as refreshPlay,
  playEvents,
  previewStats,
  statRadar,
  play,
} from './play.js';
import {
  renderPoster,
  ensureFonts,
  loadImage,
  scaleCanvas,
  canvasToBlob,
  POSTER_W,
} from './poster.js';

const TAKEAWAY_COUNT = 3; // boxes offered
const TAKEAWAY_MIN = 1; // boxes that must be filled
const ACTION_COUNT = 3;
const MAX_CHARS = 140;

const steps = [...document.querySelectorAll('.step')];
const dots = document.getElementById('steps');
const sessionLabel = document.getElementById('session-label');

const state = {
  step: 0,
  session: { title: 'AI CLASS' },
  photo: null, // canvas or image element, full quality for the poster
  posterFull: null, // Blob, full resolution, for download
  posterSmall: null, // Blob, display copy for the wall
  previewUrl: null,
  avatar: null, // AI-generated portrait, once summoned
  useAvatar: false,
  job: null,
  avatarConfig: null, // { enabled, limit, jobs[] } from the server
  remaining: 0,
  generating: false,
  character: null, // stats/rank as the arena reports them, once created
  // Set when the portrait came from a previous card that AI painted as a
  // particular class. The picture and the class have to agree: a healer's
  // robes on a card that says WARRIOR reads as a bug, not a choice.
  classLocked: false,
  // The card they already sent for this class, if any. Its presence is what
  // turns the arena's forward button from an invitation into a receipt.
  pledged: null,
};

/** How many dots the progress strip shows — one per screen the student walks
 *  through, the completion screen excluded. */
const STEP_COUNT = 7;

// ------------------------------------------------------------------ bootstrap

wireSounds();
ensureFonts();
buildEntries();
renderDots();

api('/api/state')
  .then((data) => {
    state.session = data.session;
    sessionLabel.textContent = `QUEST: ${data.session.title.toUpperCase()}`;
    state.avatarConfig = data.avatar;
    state.remaining = data.avatar?.limit ?? 0;
    renderClasses();
    refreshSummon();

    const identity = initPlay({
      sessionId: data.session.id,
      jobs: data.avatar?.jobs ?? [],
      onCharacter: (player) => {
        state.character = player;
      },
    });

    // A phone that reloaded mid-class already has a character in the room.
    // Put its owner straight back in the arena rather than making them retype
    // a name and retake a photo while a question is on screen.
    if (identity) {
      document.getElementById('student-id').value = identity.studentId;
      refreshPlay().then(async () => {
        if (!play.player) return;
        document.getElementById('name').value = play.player.name;
        state.job = play.player.job;
        markClass(state.job);
        // This path skips the first screen entirely, so the pledge check that
        // normally happens there has to happen here too — otherwise a student
        // who reloads after sending their card is invited to send a second one.
        const previous = await findPrevious(identity.studentId);
        state.pledged = previous?.isCurrentSession ? previous : null;
        applyPledgeState();
        show(3);
      });
    }
  })
  .catch(() => {
    sessionLabel.textContent = 'QUEST: OFFLINE';
  });

// The room speaks to every page over one stream; the arena view reacts to it.
connectEvents({
  ...playEvents,
  renamed: ({ title }) => {
    state.session = { ...state.session, title };
    sessionLabel.textContent = `QUEST: ${String(title).toUpperCase()}`;
  },
  // A genuinely new class means this phone's character belongs to a room that
  // no longer exists, so starting over is the only correct thing to do. A
  // rename must never come through here — see the `renamed` event above.
  session: ({ id }) => {
    if (id && id !== state.session?.id) window.location.reload();
  },
});

// ------------------------------------------------------------------ stepper

function renderDots() {
  dots.innerHTML = '';
  for (let i = 0; i < STEP_COUNT; i++) {
    const dot = document.createElement('i');
    if (i < state.step) dot.className = 'done';
    if (i === state.step) dot.className = 'current';
    dots.append(dot);
  }
}

function show(index) {
  state.step = index;
  steps.forEach((section) => {
    section.hidden = Number(section.dataset.step) !== index;
  });
  renderDots();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-next]')) {
    if (await validate(state.step)) show(state.step + 1);
  }
  if (event.target.closest('[data-back]')) {
    sfx.cancel();
    show(Math.max(0, state.step - 1));
  }
});

async function validate(step) {
  if (step === 0) {
    const id = value('student-id');
    if (!id) {
      fail('Enter your student ID first.');
      return false;
    }
    refreshQuota(); // the student id keys their avatar allowance

    // Ask the room and the card bank at once. The room says whether they have
    // a character; the bank says whether they have already pledged today and
    // what they looked like last time.
    //
    // The name is deliberately not required to get here. Someone coming back
    // an hour later remembers their student ID; whether they typed "Preeda" or
    // "preeda s." at the start is exactly the sort of thing they do not.
    const [existing, previous] = await Promise.all([
      lookupCharacter({ sessionId: state.session.id, studentId: id }),
      findPrevious(id),
    ]);
    state.pledged = previous?.isCurrentSession ? previous : null;
    applyPledgeState();

    // Already have a character in this room? Go straight back to it — this is
    // the path for a phone that died, a borrowed handset, or a browser that
    // cleared its storage, and retaking a photo and picking a class again
    // would build a second character and lose the stats they earned.
    if (existing) {
      state.character = existing;
      state.job = existing.job;
      // The card built at the end of the lesson reads its name straight off
      // this field, so put the character's own name back into the form.
      // Without this, resuming without typing a name produces a nameless card.
      document.getElementById('name').value = existing.name;
      markClass(existing.job);
      toast(`Welcome back, ${existing.name}!`);
      sfx.fanfare();
      show(3);
      return false; // handled here; the stepper must not also advance
    }

    // No character in this room. Did they leave a card behind before? Their
    // portrait and class are still in R2, and offering them back saves a
    // returning student the photo step entirely.
    if (previous) {
      showReturning(previous);
      return false; // the panel's own buttons take it from here
    }

    // Nobody we know, so this is a new player and we do need a name.
    if (!value('name')) {
      fail('Enter your name to create your character.');
      return false;
    }
    return true;
  }

  if (step === 1) {
    if (!state.photo) {
      sfx.error();
      return askConfirm({
        title: 'NO PHOTO',
        message:
          'You have not taken a photo. Carry on without one? Your card and your fighter in the arena will show your initials instead.',
        confirmLabel: 'CARRY ON ▶',
      });
    }
    return true;
  }

  // Step 2 is left by its own CREATE CHARACTER button, and step 3 — the arena
  // — is a place to sit, not a gate: a student can move on to their pledge
  // whenever they like and the room keeps their character either way.

  if (step === 4) {
    if (collect('takeaways').length < TAKEAWAY_MIN) {
      fail('Write down at least 1 thing you learned.');
      return false;
    }
    return true;
  }

  if (step === 5) {
    if (!collect('actions').length) {
      fail('Pledge at least 1 action.');
      return false;
    }
    await buildPreview();
    return true;
  }

  return true;
}

function fail(message) {
  sfx.error();
  toast(message, 'bad');
}

function value(id) {
  return document.getElementById(id).value.trim();
}

function collect(containerId) {
  return [...document.querySelectorAll(`#${containerId} textarea`)]
    .map((el) => el.value.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ------------------------------------------------------------------ entries

function buildEntries() {
  const specs = [
    { id: 'takeaways', count: TAKEAWAY_COUNT, cls: '', required: TAKEAWAY_MIN },
    { id: 'actions', count: ACTION_COUNT, cls: 'entry--action', required: 1 },
  ];

  for (const spec of specs) {
    const host = document.getElementById(spec.id);
    for (let i = 0; i < spec.count; i++) {
      const wrap = document.createElement('div');
      wrap.className = `entry ${spec.cls}`;
      wrap.innerHTML = `
        <div class="entry-head">
          <span class="num">${i + 1}</span>
          ${i >= spec.required ? '<span class="optional">OPTIONAL</span>' : ''}
          <span class="spacer"></span>
          <span class="counter">0/${MAX_CHARS}</span>
        </div>
        <textarea maxlength="${MAX_CHARS}" rows="2" placeholder="${
          spec.id === 'takeaways' ? 'What you learned…' : 'An action I commit to…'
        }"></textarea>`;
      const textarea = wrap.querySelector('textarea');
      const counter = wrap.querySelector('.counter');
      textarea.addEventListener('input', () => {
        counter.textContent = `${textarea.value.length}/${MAX_CHARS}`;
        counter.classList.toggle('over', textarea.value.length >= MAX_CHARS);
      });
      host.append(wrap);
    }
  }
}

// ------------------------------------------------------------------ camera

const video = document.getElementById('video');
const shot = document.getElementById('shot');
const empty = document.getElementById('portrait-empty');
const startBtn = document.getElementById('camera-start');
const snapBtn = document.getElementById('camera-snap');
const retakeBtn = document.getElementById('camera-retake');
const fileInput = document.getElementById('file');
const hint = document.getElementById('camera-hint');
let stream;

startBtn.addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    hint.textContent =
      'This browser cannot open the camera in-page (needs https or localhost) — use “CHOOSE PHOTO” to shoot with your phone camera instead.';
    fail('Camera unavailable in-page — use “CHOOSE PHOTO”.');
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false,
    });
    video.srcObject = stream;
    video.hidden = false;
    shot.hidden = true;
    empty.hidden = true;
    startBtn.hidden = true;
    snapBtn.hidden = false;
    retakeBtn.hidden = true;
  } catch (err) {
    hint.textContent = `Could not open the camera (${err.name}) — use “CHOOSE PHOTO” to shoot with your phone camera instead.`;
    fail('Could not open the camera — use “CHOOSE PHOTO”.');
  }
});

snapBtn.addEventListener('click', () => {
  const side = Math.min(video.videoWidth, video.videoHeight);
  if (!side) return fail('Camera is not ready yet — try again.');
  const canvas = document.createElement('canvas');
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext('2d');
  // Mirror to match the preview the student was framing themselves in.
  ctx.translate(side, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(
    video,
    (video.videoWidth - side) / 2,
    (video.videoHeight - side) / 2,
    side,
    side,
    0,
    0,
    side,
    side,
  );
  usePhoto(canvas);
  stopCamera();
  sfx.confirm();
});

retakeBtn.addEventListener('click', () => {
  state.photo = null;
  state.avatar = null;
  state.useAvatar = false;
  shot.hidden = true;
  empty.hidden = false;
  sourceToggle.hidden = true;
  retakeBtn.hidden = true;
  startBtn.hidden = false;
  refreshSummon();
  refreshPreviewArt();
});

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const img = await loadImage(URL.createObjectURL(file));
    stopCamera();
    usePhoto(img);
    sfx.confirm();
  } catch {
    fail('Could not read that image file.');
  } finally {
    fileInput.value = '';
  }
});

function stopCamera() {
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.hidden = true;
  snapBtn.hidden = true;
}

function usePhoto(source) {
  state.photo = source;
  state.avatar = null;
  state.useAvatar = false;
  sourceToggle.hidden = true;
  drawToBox(activeSource());
  startBtn.hidden = true;
  retakeBtn.hidden = false;
  refreshSummon();
  refreshPreviewArt();
}

/** Centre-crops whatever is currently chosen into the framed preview box. */
function drawToBox(source) {
  const side = 512;
  shot.width = side;
  shot.height = side;
  const ctx = shot.getContext('2d');
  const w = source.naturalWidth || source.width || source.videoWidth;
  const h = source.naturalHeight || source.height || source.videoHeight;
  const crop = Math.min(w, h);
  ctx.drawImage(source, (w - crop) / 2, (h - crop) / 2, crop, crop, 0, 0, side, side);
  shot.hidden = false;
  empty.hidden = true;
}

function activeSource() {
  return state.useAvatar && state.avatar ? state.avatar : state.photo;
}

/** Square, downscaled copy of whichever picture is in play. */
function squareCanvas(source, size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  const crop = Math.min(w, h);
  canvas
    .getContext('2d')
    .drawImage(source, (w - crop) / 2, (h - crop) / 2, crop, crop, 0, 0, size, size);
  return canvas;
}

/** Data URL form — only the avatar request still needs one, and it is small. */
function encodeSource(source, size, quality = 0.9) {
  return squareCanvas(source, size).toDataURL('image/jpeg', quality);
}

// ------------------------------------------------------------- AI avatar

const summon = document.getElementById('summon');
const classGrid = document.getElementById('class-grid');
const generateBtn = document.getElementById('generate');
const quotaEl = document.getElementById('quota');
const summonNote = document.getElementById('summon-note');
const sourceToggle = document.getElementById('source-toggle');
const usePhotoBtn = document.getElementById('use-photo');
const useAvatarBtn = document.getElementById('use-avatar');

function jobById(id) {
  return state.avatarConfig?.jobs.find((job) => job.id === id) ?? null;
}

/**
 * The class list.
 *
 * Drawn whether or not AI avatars are configured. It used to live inside the
 * summon panel and disappear with it, which was fine when a class was only a
 * costume — now it decides how the character fights, so it has to be there
 * even with no API key on the server.
 */
function renderClasses() {
  const config = state.avatarConfig;
  if (!config?.jobs?.length) return;
  summon.hidden = !config.enabled || state.classLocked;
  classGrid.innerHTML = config.jobs
    .map(
      (job) => `
      <button type="button" class="class-btn" data-job="${job.id}">
        <img class="class-art" src="/portraits/${job.id}.webp" alt="" loading="lazy"
             width="320" height="320" style="--accent:${job.accent}" />
        <b>${job.label}</b>
        <small>${job.tagline}</small>
      </button>`,
    )
    .join('');
}

classGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-job]');
  if (!button) return;
  if (state.classLocked) {
    if (button.dataset.job !== state.job) {
      sfx.cancel();
      toast('Your portrait was painted for this class — take a new photo to change it.', 'bad');
    }
    return;
  }
  markClass(button.dataset.job);
  refreshSummon();
});

/**
 * Locks the class to whatever the reused portrait was painted as, and takes
 * the summon panel away with it.
 *
 * Someone who pressed USE THIS asked to keep the look they already had;
 * leaving SUMMON AVATAR on that screen invites them to spend a generation
 * replacing the very thing they just chose to keep.
 */
function applyClassLock() {
  const locked = state.classLocked;
  classGrid.classList.toggle('is-locked', locked);
  document.getElementById('class-lock').hidden = !locked;
  document.getElementById('class-speech').textContent = locked
    ? 'This is the character from your last class. Your class is set to match your portrait.'
    : 'Every class fights differently. Pick the one you want to be — you can still change it until the first question opens.';
  if (locked) {
    document.getElementById('lock-class').textContent = (state.job ?? '').toUpperCase();
    summon.hidden = true;
  } else if (state.avatarConfig?.enabled) {
    summon.hidden = false;
  }
}

/** The way out of the lock: a new photo means no painted class to honour. */
document.getElementById('lock-release').addEventListener('click', () => {
  state.classLocked = false;
  state.photo = null;
  state.avatar = null;
  state.useAvatar = false;
  shot.hidden = true;
  empty.hidden = false;
  sourceToggle.hidden = true;
  retakeBtn.hidden = true;
  startBtn.hidden = false;
  applyClassLock();
  refreshSummon();
  refreshPreviewArt();
  sfx.cancel();
  show(1);
});

function markClass(job) {
  state.job = job;
  [...classGrid.children].forEach((el) =>
    el.classList.toggle('selected', el.dataset.job === job),
  );

  const preview = document.getElementById('class-preview');
  const chosen = jobById(job);
  if (!chosen) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  document.getElementById('preview-class').textContent = chosen.label;
  document.getElementById('preview-class').dataset.job = job;
  // Once the character exists the room owns the numbers; before that this is
  // the only place a student can compare one class against another.
  document.getElementById('preview-tier').textContent = chosen.tagline.toUpperCase();

  refreshPreviewArt();

  document.getElementById('preview-stats').innerHTML = statRadar(
    play.player?.job === job ? play.player.stats : previewStats(chosen),
    { accent: chosen.accent },
  );
}

/**
 * Paints the class preview with the student's own portrait once they have one,
 * falling back to the stock artwork.
 *
 * Kept apart from markClass because the picture changes without the class
 * changing: summoning an avatar and flipping REAL PHOTO / AI AVATAR both leave
 * the chosen class alone. When this lived inside markClass those three paths
 * left a freshly painted avatar sitting behind stock artwork.
 */
function refreshPreviewArt() {
  const chosen = jobById(state.job);
  if (!chosen) return;
  const art = document.getElementById('preview-art');
  const own = state.useAvatar && state.avatar ? state.avatar.src : null;
  art.src = own || `/portraits/${state.job}.webp`;
  art.style.setProperty('--accent', chosen.accent);
}

function refreshSummon() {
  if (!state.avatarConfig?.enabled) return;
  const ready = Boolean(state.photo && state.job) && state.remaining > 0;
  generateBtn.disabled = !ready || state.generating;
  quotaEl.textContent = `${state.remaining} / ${state.avatarConfig.limit} LEFT`;
  quotaEl.classList.toggle('empty', state.remaining <= 0);

  if (state.generating) return;
  if (state.remaining <= 0) {
    summonNote.textContent = 'No summons left — your real photo works great too.';
  } else if (!state.photo) {
    summonNote.textContent = 'Take a photo first, then pick a class.';
  } else if (!state.job) {
    summonNote.textContent = 'Pick the class you want to be.';
  } else {
    summonNote.textContent = 'Takes about 15–25 seconds.';
  }
}

async function refreshQuota() {
  if (!state.avatarConfig?.enabled) return;
  const studentId = value('student-id');
  if (!studentId) return;
  try {
    const quota = await api(`/api/avatar/quota?studentId=${encodeURIComponent(studentId)}`);
    state.remaining = quota.remaining;
  } catch {
    /* quota is advisory on the client; the server is the one that enforces it */
  }
  refreshSummon();
}

generateBtn.addEventListener('click', async () => {
  if (!state.photo || !state.job) return;
  state.generating = true;
  refreshSummon();
  generateBtn.disabled = true;
  generateBtn.classList.add('casting');

  const label = jobById(state.job)?.label ?? 'AVATAR';
  generateBtn.textContent = `SUMMONING ${label}…`;
  summonNote.textContent = 'The AI is painting your character — keep this page open…';

  try {
    const result = await api('/api/avatar', {
      method: 'POST',
      body: JSON.stringify({
        studentId: value('student-id'),
        job: state.job,
        photo: encodeSource(state.photo, 768),
      }),
    });
    state.avatar = await loadImage(result.image);
    state.remaining = result.remaining;
    state.useAvatar = true;
    setSourceButtons();
    sourceToggle.hidden = false;
    drawToBox(state.avatar);
    refreshPreviewArt();
    sfx.fanfare();
    toast(`Your ${label} is ready!`);
  } catch (err) {
    if (err.data?.remaining !== undefined) state.remaining = err.data.remaining;
    fail(avatarErrorMessage(err));
  } finally {
    state.generating = false;
    generateBtn.classList.remove('casting');
    generateBtn.textContent = 'SUMMON AVATAR';
    refreshSummon();
  }
});

function avatarErrorMessage(err) {
  switch (err.code) {
    case 'quota':
      return 'You have used all your avatar summons.';
    case 'busy':
      return 'Too many summons right now — wait a moment and try again.';
    case 'exhausted':
      return 'AI image credits have run out — let your instructor know. Your real photo still works.';
    case 'network':
      return 'Connection dropped while generating — try again (this did not use a summon).';
    case 'timeout':
      return 'That took too long — try again.';
    case 'no_image':
      return 'The AI could not generate an image — retake the photo with your face clearly visible.';
    case 'no_key':
      return 'Avatar generation is not configured on the server.';
    default:
      return `Generation failed: ${err.message}`;
  }
}

function setSourceButtons() {
  usePhotoBtn.className = state.useAvatar ? 'btn--ghost btn--sm' : 'btn--sm btn--primary';
  useAvatarBtn.className = state.useAvatar ? 'btn--sm btn--primary' : 'btn--ghost btn--sm';
}

usePhotoBtn.addEventListener('click', () => {
  if (!state.photo) return;
  state.useAvatar = false;
  setSourceButtons();
  drawToBox(state.photo);
  refreshPreviewArt();
});

useAvatarBtn.addEventListener('click', () => {
  if (!state.avatar) return;
  state.useAvatar = true;
  setSourceButtons();
  drawToBox(state.avatar);
  refreshPreviewArt();
});

// ------------------------------------------------------ returning students

const returningPanel = document.getElementById('returning');
const identityForm = document.getElementById('identity-form');
let previousCard = null;

/**
 * Swaps the arena's forward button for a receipt once the pledge is in.
 *
 * A student who has already sent their card is here for the quiz and the
 * battle; putting MY PLEDGE ▶ in front of them again invites a second card
 * from the same person onto the wall.
 */
function applyPledgeState() {
  const done = Boolean(state.pledged);
  document.getElementById('to-pledge').hidden = done;
  document.getElementById('pledged-note').hidden = !done;
  document.getElementById('view-card').hidden = !done;
}

document.getElementById('view-card').addEventListener('click', () => {
  const card = state.pledged;
  if (!card?.posterId) return;
  document.getElementById('done-preview').src = `/p/${card.posterId}.png`;
  const download = document.getElementById('download');
  download.href = `/p/full/${card.posterId}.png`;
  download.setAttribute('download', `warrior-${value('student-id')}.png`);
  document.getElementById('done-message').textContent =
    `${card.name} is already on the wall. Keep the card as a memento!`;
  setupShare(`/p/full/${card.posterId}.png`);
  refreshArenaLink();
  show(7);
});

async function findPrevious(studentId) {
  try {
    const { previous } = await api(
      `/api/game/previous?studentId=${encodeURIComponent(studentId)}`,
    );
    return previous ?? null;
  } catch {
    // Never block someone from starting fresh because a lookup failed.
    return null;
  }
}

function showReturning(previous) {
  previousCard = previous;
  document.getElementById('ret-name').textContent = previous.name;
  document.getElementById('ret-photo').src = previous.photoUrl;
  document.getElementById('ret-class').textContent = previous.job
    ? `${previous.job.toUpperCase()} · AI AVATAR`
    : 'YOUR PHOTO';
  document.getElementById('ret-when').textContent = new Date(previous.createdAt)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    .toUpperCase();

  // The name is theirs either way — reusing it is the whole point of matching
  // on the student ID, and it is the field the final card reads from.
  document.getElementById('name').value = previous.name;

  identityForm.hidden = true;
  returningPanel.hidden = false;
  sfx.confirm();
}

function hideReturning() {
  returningPanel.hidden = true;
  identityForm.hidden = false;
}

document.getElementById('ret-use').addEventListener('click', async () => {
  if (!previousCard) return;
  const button = document.getElementById('ret-use');
  button.disabled = true;
  button.textContent = 'LOADING…';
  try {
    const img = await loadImage(previousCard.photoUrl);
    if (previousCard.isAvatar) {
      // It is already a painted portrait. Loading it as the avatar rather than
      // the raw photo is what stops the card renderer posterising it a second
      // time, which turns a face into mud.
      state.photo = img;
      state.avatar = img;
      state.useAvatar = true;
      setSourceButtons();
      sourceToggle.hidden = false;
    } else {
      state.photo = img;
      state.avatar = null;
      state.useAvatar = false;
    }
    drawToBox(activeSource());
    startBtn.hidden = true;
    retakeBtn.hidden = false;

    // A painted portrait carries its class with it; a plain photo does not,
    // so only the former locks anything down.
    state.classLocked = Boolean(previousCard.isAvatar && previousCard.job);
    markClass(previousCard.job ?? state.job);
    applyClassLock();
    hideReturning();
    refreshSummon();
    // Straight to the class step, everything filled in: one button left.
    show(2);
  } catch {
    fail('Could not load your old portrait — take a new photo instead.');
    hideReturning();
    show(1);
  } finally {
    button.disabled = false;
    button.textContent = 'USE THIS ▶';
  }
});

document.getElementById('ret-fresh').addEventListener('click', () => {
  state.classLocked = false;
  applyClassLock();
  hideReturning();
  sfx.cancel();
  show(1); // new photo, new class — the name stays theirs
});

// ------------------------------------------------------- character creation

const createBtn = document.getElementById('create-character');

/**
 * Enters the room.
 *
 * The portrait is uploaded here rather than with the pledge card, because the
 * tournament runs in the middle of the lesson — long before anyone has written
 * what they learned. It goes up at 256px: fifty of these on a projector should
 * cost about what one card costs.
 */
createBtn.addEventListener('click', async () => {
  if (!state.job) return fail('Pick a class first.');

  createBtn.disabled = true;
  createBtn.textContent = 'SUMMONING…';
  try {
    const player = await createCharacter({
      sessionId: state.session.id,
      studentId: value('student-id'),
      name: value('name'),
      job: state.job,
    });

    // The character exists either way; a portrait that fails to upload costs
    // the student a face in the arena, not their place in it.
    if (activeSource()) {
      uploadPortrait(value('student-id')).catch(() => {
        toast('Your picture did not upload — you will fight without a face.', 'bad');
      });
    }

    state.character = player;
    show(3);
    sfx.fanfare();
  } catch (err) {
    fail(
      err.code === 'ID_TAKEN'
        ? 'That student ID is already taken on another phone.'
        : err.message,
    );
  } finally {
    createBtn.disabled = false;
    createBtn.textContent = 'CREATE CHARACTER ▶';
  }
});

async function uploadPortrait(studentId) {
  const blob = await canvasToBlob(squareCanvas(activeSource(), 256), 'image/jpeg', 0.8);
  const res = await fetch(`/av/${encodeURIComponent(studentId)}.jpg`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  if (!res.ok) throw new Error('portrait upload failed');
}

// A student who resummons an avatar after entering the arena should be the new
// face on the projector, not the old one.
useAvatarBtn.addEventListener('click', () => {
  if (play.identity && state.avatar) uploadPortrait(play.identity.studentId).catch(() => {});
});
usePhotoBtn.addEventListener('click', () => {
  if (play.identity && state.photo) uploadPortrait(play.identity.studentId).catch(() => {});
});

// ------------------------------------------------------------------ preview

async function buildPreview() {
  await ensureFonts();
  const canvas = renderPoster({
    name: value('name'),
    studentId: value('student-id'),
    takeaways: collect('takeaways'),
    actions: collect('actions'),
    photo: activeSource(),
    // The palette follows the class the student fought as, whether or not they
    // summoned an avatar — a wall of cards should read as the party that was
    // just in the arena.
    job: jobById(state.job),
    character: state.character,
    title: state.session.title,
    // A raw photo gets posterised so it belongs inside the pixel frame; an AI
    // avatar is already stylised and posterising it twice only muddies the face.
    pixelate: !state.useAvatar,
  });
  state.posterFull = await canvasToBlob(canvas);
  state.posterSmall = await canvasToBlob(scaleCanvas(canvas, POSTER_W));

  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = URL.createObjectURL(state.posterSmall);
  document.getElementById('preview').src = state.previewUrl;
}

// ------------------------------------------------------------------ submit

const submitBtn = document.getElementById('submit');

submitBtn.addEventListener('click', async () => {
  if (!state.posterFull || !state.posterSmall) {
    return fail('The card is not built yet — go back a step and return.');
  }
  submitBtn.disabled = true;
  submitBtn.textContent = 'SENDING…';
  try {
    // 1. metadata only — a small JSON body
    const { id } = await api('/api/posters', {
      method: 'POST',
      body: JSON.stringify({
        name: value('name'),
        studentId: value('student-id'),
        takeaways: collect('takeaways'),
        actions: collect('actions'),
        job: state.job,
      }),
    });

    // 2. the images as raw bytes. The display copy goes last: the server
    //    publishes the card to the wall the moment it arrives, so everything
    //    else is already in place by then.
    await putImage(id, 'full', state.posterFull);
    if (activeSource()) {
      await putImage(id, 'photo', await canvasToBlob(squareCanvas(activeSource(), 400), 'image/jpeg', 0.82));
    }
    await putImage(id, 'display', state.posterSmall);

    document.getElementById('done-preview').src = `/p/${id}.png`;
    const download = document.getElementById('download');
    download.href = `/p/full/${id}.png`;
    download.setAttribute('download', `warrior-${value('student-id')}.png`);
    document.getElementById('done-message').textContent =
      `${value('name')} is on the wall. Keep the card as a memento!`;
    setupShare(`/p/full/${id}.png`);
    // Coming back to the arena after this should show the receipt, not another
    // invitation to pledge.
    state.pledged = { posterId: id, name: value('name'), isCurrentSession: true };
    applyPledgeState();
    refreshArenaLink();
    show(7);
    sfx.fanfare();
  } catch (err) {
    fail(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'PLEDGE IT';
  }
});

async function putImage(id, variant, blob) {
  const res = await fetch(`/api/posters/${id}/image/${variant}`, {
    method: 'PUT',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `upload failed (${variant})`);
  }
}

function setupShare(url) {
  const shareBtn = document.getElementById('share');
  if (!navigator.canShare) return;
  shareBtn.hidden = false;
  shareBtn.onclick = async () => {
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], `warrior-${value('student-id')}.png`, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Warrior Card' });
      }
    } catch {
      /* the user dismissing the share sheet is not an error worth shouting about */
    }
  };
}

/**
 * Back to the arena.
 *
 * Offered whenever this device has a character in the room, because sending a
 * card is not the end of the lesson — the instructor may have several more
 * rounds of questions and the battle still to run.
 */
const toArenaBtn = document.getElementById('to-arena');

toArenaBtn.addEventListener('click', async () => {
  show(3);
  await refreshPlay();
});

/** Keeps that button in step with whether a character actually exists. */
function refreshArenaLink() {
  toArenaBtn.hidden = !play.player;
}

document.getElementById('again').addEventListener('click', () => {
  window.location.reload();
});

// ------------------------------------------------------------------ sound toggle

const muteBtn = document.getElementById('mute');
muteBtn.textContent = sfx.isMuted() ? 'SOUND: OFF' : 'SOUND: ON';
muteBtn.addEventListener('click', () => {
  muteBtn.textContent = sfx.toggle() ? 'SOUND: OFF' : 'SOUND: ON';
});

window.addEventListener('pagehide', stopCamera);
