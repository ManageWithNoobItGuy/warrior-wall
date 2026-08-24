/**
 * Avatar generation via Gemini's image model ("nano banana").
 *
 * Runs server-side only: the API key must never reach a student's phone, and
 * the shared quota is only enforceable somewhere the students cannot edit.
 */

// Workers has no `process`, so every setting is read through a shim that
// falls back to the environment only when there is one.
const ENV = globalThis.process?.env ?? {};

const MODEL = ENV.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const REQUEST_TIMEOUT = 90_000;

/**
 * A whole class hitting "generate" at once would just earn us 429s.
 * On Workers this is per-isolate rather than global — the real ceiling that
 * protects the API key is the per-session budget enforced in the route.
 */
const MAX_INFLIGHT = Number(ENV.AVATAR_CONCURRENCY) || 3;
const MAX_QUEUE = Number(ENV.AVATAR_QUEUE) || 24;

export const JOBS = [
  {
    id: 'warrior',
    card: { bg: ['#52190f', '#290c0d', '#120506'], plate: ['#6a2113', '#2a0b0a'] },
    label: 'WARRIOR',
    tagline: 'Front line',
    accent: '#ff7a5c',
    costume:
      'battle-worn leather and fur armour with iron shoulder guards, a huge greatsword resting on one shoulder, embers and a dusk battlefield behind them',
  },
  {
    id: 'knight',
    card: { bg: ['#16305c', '#0d1c3c', '#050a18'], plate: ['#1d3d72', '#0a1526'] },
    label: 'KNIGHT',
    tagline: 'Guardian',
    accent: '#9fb8ff',
    costume:
      'polished silver plate armour with a deep blue cape and ornate pauldrons, helmet held under one arm so the head is completely bare, a great hall lit by torches behind them',
  },
  {
    id: 'thief',
    card: { bg: ['#123c26', '#0a2116', '#040d09'], plate: ['#184e31', '#08160f'] },
    label: 'THIEF',
    tagline: 'Shadows',
    accent: '#7cf07c',
    costume:
      'dark green hooded cloak pushed back off the head so the face is fully visible, buckled leather jerkin, a dagger held low, moonlit rooftops behind them',
  },
  {
    id: 'mage',
    card: { bg: ['#2e1a5c', '#180e38', '#09051c'], plate: ['#3c2277', '#120a2a'] },
    label: 'MAGE',
    tagline: 'Arcane',
    accent: '#c4a2ff',
    costume:
      'flowing midnight-blue robe embroidered with gold stars, a wide-brimmed pointed wizard hat pushed back off the forehead, holding a staff topped with a glowing blue crystal, a starry night sky behind them',
  },
  {
    id: 'healer',
    card: { bg: ['#4e3a11', '#2a1e08', '#120c03'], plate: ['#664c14', '#231903'] },
    label: 'HEALER',
    tagline: 'Support',
    accent: '#ffd75e',
    costume:
      'white and gold cleric robes with a red emblem, a golden staff wreathed in warm healing light, a sunlit cathedral behind them',
  },
];

const BY_ID = new Map(JOBS.map((job) => [job.id, job]));

export function findJob(id) {
  return BY_ID.get(String(id ?? '').toLowerCase()) ?? null;
}

export function hasApiKey(apiKey = ENV.GEMINI_API_KEY) {
  return Boolean(apiKey);
}

/**
 * The likeness clause carries the whole feature — an avatar nobody recognises
 * is worthless on a wall of classmates, so it leads and the costume follows.
 *
 * Deliberately NOT pixel art: chunky pixels destroy exactly the facial detail
 * that makes a classmate identifiable. Painted semi-realistic character art
 * keeps the JRPG feel while holding onto the face.
 */
function buildPrompt(job) {
  return `Repaint the person in this photograph as a ${job.label} in a Japanese role-playing game — the painted character portrait you would see on a party member's status screen.

IDENTITY IS THE TOP PRIORITY. This is a real, specific person and the portrait must be unmistakably them:
- Copy their facial structure exactly — face shape, jawline, cheekbones, chin, nose shape and width, eye shape and spacing, eyelid and eyebrow shape, mouth and lip shape.
- Keep their exact hairstyle: length, parting, texture and colour. If the photo has no fringe over the forehead, do not add one; if it has one, keep it. Never restyle their hair.
- Keep their skin tone, apparent age, body build, glasses, facial hair, moles and any other distinguishing marks.
- Keep the same head angle and facial expression as the photograph.
- Do NOT beautify, slim down, make younger, or replace them with a generic anime character. Keep realistic human facial proportions — normal-sized eyes, no over-stylised anime face.
Someone who knows this person must recognise them instantly.

CHANGE ONLY the clothing, the props, the lighting and the background: ${job.costume}.

STYLE: high-quality digital painting, semi-realistic JRPG character art. Clean confident line work, soft cel-shaded rendering with painterly highlights, rich saturated fantasy colours, warm rim lighting from behind, subtle glow. Detailed and polished, like official game key art. Not pixel art. Not a photograph.

COMPOSITION: tight bust portrait cropped just below the collarbone — head and shoulders only. The head must fill roughly half of the frame height so the face reads clearly even when the picture is shown small. Subject facing the viewer, head centred in the upper middle of the frame, softly blurred simple fantasy background. Square 1:1. No text, no letters, no watermark, no border.

FINAL REMINDER: the hair is part of who they are. Match it to the photograph exactly — if their forehead is visible in the photo it must be visible here, and any headwear sits back far enough not to change their hairline.`;
}

// ------------------------------------------------------------------ queueing

let inflight = 0;
const waiting = [];

function acquire() {
  if (inflight < MAX_INFLIGHT) {
    inflight += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) {
    return Promise.reject(
      Object.assign(new Error('avatar queue is full'), { status: 503, code: 'busy' }),
    );
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else inflight -= 1;
}

// ------------------------------------------------------------------ the call

/**
 * @param {string} photoBase64 the student's snapshot, already base64 (no data: prefix)
 * @param {string} mimeType
 * @param {string} jobId one of JOBS[].id
 * @param {string} [apiKey] explicit key — Workers passes it from its bindings
 * @returns {Promise<{base64: string, mimeType: string}>}
 */
export async function generateAvatar(photoBase64, mimeType, jobId, apiKey = ENV.GEMINI_API_KEY) {
  const job = findJob(jobId);
  if (!job) throw Object.assign(new Error('unknown class'), { status: 400, code: 'bad_job' });
  if (!hasApiKey(apiKey)) {
    throw Object.assign(new Error('GEMINI_API_KEY is not set'), {
      status: 501,
      code: 'no_key',
    });
  }

  await acquire();
  try {
    // Classroom wifi drops large downloads often enough to be worth one retry;
    // a returned image is ~2 MB and the call runs for the better part of a minute.
    try {
      return await callModel(photoBase64, mimeType, job, apiKey);
    } catch (err) {
      if (err.code !== 'network') throw err;
      console.warn('[warrior-wall] avatar network hiccup, retrying once');
      return await callModel(photoBase64, mimeType, job, apiKey);
    }
  } finally {
    release();
  }
}

async function callModel(photoBase64, mimeType, job, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: buildPrompt(job) },
                { inline_data: { mime_type: mimeType, data: photoBase64 } },
              ],
            },
          ],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      // fetch rejects with a bare TypeError on DNS/TLS/socket failures
      throw Object.assign(new Error(`network error: ${err.cause?.code ?? err.message}`), {
        status: 503,
        code: 'network',
      });
    }

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message = body?.error?.message ?? `image API returned ${res.status}`;
      // A 429 means two very different things. Rate limiting clears on its own,
      // so "wait and retry" is right; depleted credits never clear by waiting,
      // and telling a student to retry would just spin them forever.
      const outOfCredit = res.status === 429 && /credit|billing|exhaust|quota/i.test(message);
      const retryable = !outOfCredit && (res.status === 429 || res.status >= 500);
      throw Object.assign(new Error(message), {
        status: outOfCredit ? 402 : retryable ? 503 : 502,
        code: outOfCredit ? 'exhausted' : retryable ? 'busy' : 'upstream',
      });
    }

    const candidate = body.candidates?.[0];
    const part = candidate?.content?.parts?.find((p) => p.inlineData ?? p.inline_data);
    const blob = part?.inlineData ?? part?.inline_data;

    if (!blob?.data) {
      // Almost always a safety block or an empty candidate; both are worth
      // reporting as "try another photo" rather than as a server fault.
      throw Object.assign(
        new Error(`no image returned (${candidate?.finishReason ?? 'unknown reason'})`),
        { status: 422, code: 'no_image' },
      );
    }

    // Handed back as the model's own base64 string. Decoding it to a Buffer
    // only for the caller to re-encode it was ~2 MB of pointless CPU on every
    // summon, and CPU is the scarce resource once this runs serverless.
    return {
      base64: blob.data,
      mimeType: blob.mimeType ?? blob.mime_type ?? 'image/png',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      throw Object.assign(new Error('image generation timed out'), {
        status: 504,
        code: 'timeout',
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
