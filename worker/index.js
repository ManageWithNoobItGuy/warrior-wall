/**
 * AI Warrior Wall of Pledging — Cloudflare Workers entry point.
 *
 * Same routes as the Node build in server.js, rewritten against the fetch
 * handler. Two things shape this file:
 *
 *  - CPU is the scarce resource, so image bodies are never parsed or decoded.
 *    They stream from the request straight into R2 and back out again.
 *  - Instructor routes sit behind a passcode, because a public URL means
 *    anyone who finds it could otherwise wipe the wall mid-class.
 */

import { JOBS, findJob, generateAvatar } from '../lib/gemini.js';
import { makeZip } from '../lib/zip.js';
import * as store from './store.js';
import { hub, publish } from './wall-hub.js';

export { WallHub } from './wall-hub.js';

const MAX_IMAGE = 12 * 1024 * 1024;
const COOKIE = 'ww_pass';

// --------------------------------------------------------------------- utils

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const cleanLines = (value, max) =>
  Array.isArray(value)
    ? value
        .map((line) => String(line ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, max)
    : [];

const limit = (env, key, fallback) => Number(env[key]) || fallback;

/** Constant-time-ish compare so the passcode cannot be probed byte by byte. */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Instructor access. With no WALL_PASSCODE set the gate is open, which keeps
 * `wrangler dev` frictionless; production sets the secret.
 */
function isInstructor(request, env) {
  if (!env.WALL_PASSCODE) return true;
  const url = new URL(request.url);
  return (
    sameSecret(readCookie(request, COOKIE), env.WALL_PASSCODE) ||
    sameSecret(url.searchParams.get('pass'), env.WALL_PASSCODE) ||
    sameSecret(request.headers.get('X-Wall-Pass'), env.WALL_PASSCODE)
  );
}

function passcodeForm(message = '') {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Instructor access</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/css/jrpg.css"></head>
<body><main class="stage" style="max-width:460px">
<header class="quest-head" style="text-align:center">
  <h1><img class="title-icon" src="/sword.svg" alt=""> AI WARRIOR WALL <img class="title-icon" src="/sword.svg" alt=""><small>OF PLEDGING</small></h1>
</header>
<section class="window"><span class="window-title">INSTRUCTOR</span>
<form method="GET" class="stack">
  <p class="speech">This screen is for the instructor. Enter the passcode.</p>
  <div><label for="pass">PASSCODE</label>
  <input id="pass" name="pass" type="password" autocomplete="current-password" autofocus></div>
  ${message ? `<p class="hint" style="color:var(--danger)">${message}</p>` : ''}
  <div class="row" style="margin-top:18px"><span class="spacer"></span>
  <button class="btn--primary" type="submit">ENTER ▶</button></div>
</form></section></main></body></html>`,
    { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/** Serves an instructor page, planting the cookie when ?pass= checked out. */
async function instructorPage(request, env, file) {
  if (!isInstructor(request, env)) {
    const tried = new URL(request.url).searchParams.has('pass');
    return passcodeForm(tried ? 'Wrong passcode.' : '');
  }
  const url = new URL(request.url);
  const res = await env.ASSETS.fetch(new Request(new URL(file, url.origin), request));
  const out = new Response(res.body, res);
  if (env.WALL_PASSCODE && url.searchParams.has('pass')) {
    out.headers.append(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(env.WALL_PASSCODE)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`,
    );
  }
  return out;
}

// -------------------------------------------------------------------- routes

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (err) {
      console.error('[warrior-wall]', err.stack || err.message);
      return json({ error: err.message ?? 'server error' }, err.status ?? 500);
    }
  },
};

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ---- instructor pages (worker runs first for these, see wrangler.jsonc)
  // Asked for without the extension: the asset server rewrites `/wall.html`
  // back to `/wall`, which would bounce this route into a redirect loop.
  if (path === '/wall' || path === '/wall.html') {
    return instructorPage(request, env, '/wall');
  }
  if (path === '/projector' || path === '/projector.html') {
    return instructorPage(request, env, '/projector');
  }

  // ---- card images. /p/<id>.png is the display copy; /p/full/<id>.png the
  // full-resolution download. R2 streams both; the Worker never touches bytes.
  const image = /^\/p\/(?:(full)\/)?([\w-]+)\.png$/.exec(path);
  if (image && method === 'GET') {
    const object = await store.getPosterImage(env, image[2], image[1] ? 'full' : 'display');
    if (!object) return new Response('Not found', { status: 404 });
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'image/png',
        'Content-Length': String(object.size),
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: object.httpEtag,
      },
    });
  }

  // ---- live updates
  if (path === '/api/events' && method === 'GET') {
    return hub(env).fetch('https://hub/subscribe');
  }

  // ---- state
  if (path === '/api/state' && method === 'GET') {
    const session = await store.activeSession(env);
    return json({
      session: { id: session.id, title: session.title, createdAt: session.created_at },
      featuredId: session.featured_id ?? null,
      count: await store.countPosters(env, session.id),
      joinUrl: `${url.origin}/`,
      avatar: {
        enabled: Boolean(env.GEMINI_API_KEY),
        limit: limit(env, 'AVATAR_LIMIT', 3),
        jobs: JOBS.map(({ id, label, tagline, accent, card }) => ({
          id,
          label,
          tagline,
          accent,
          card,
        })),
      },
    });
  }

  // ---- session controls (instructor only)
  if (path.startsWith('/api/session') && method === 'POST') {
    if (!isInstructor(request, env)) return json({ error: 'passcode required' }, 401);
    const body = await request.json().catch(() => ({}));

    if (path === '/api/session') {
      const session = await store.newSession(env, body.title);
      await publish(env, 'session', { id: session.id, title: session.title });
      return json({ id: session.id, title: session.title });
    }
    if (path === '/api/session/title') {
      const session = await store.activeSession(env);
      await store.renameSession(env, session.id, body.title);
      await publish(env, 'session', { id: session.id, title: body.title });
      return json({ ok: true });
    }
    if (path === '/api/session/clear') {
      const session = await store.activeSession(env);
      await store.clearSession(env, session.id);
      await publish(env, 'cleared', {});
      return json({ ok: true });
    }
  }

  // ---- posters
  if (path === '/api/posters' && method === 'GET') {
    const session = await store.activeSession(env);
    return json({ posters: await store.listPosters(env, session.id) });
  }

  if (path === '/api/posters' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name ?? '').trim().slice(0, 40);
    const studentId = String(body.studentId ?? '').trim().slice(0, 24);
    const takeaways = cleanLines(body.takeaways, 3);
    const actions = cleanLines(body.actions, 3);

    if (!name || !studentId) return json({ error: 'name and studentId are required' }, 400);
    if (!takeaways.length) return json({ error: 'at least 1 takeaway is required' }, 400);
    if (!actions.length) return json({ error: 'at least 1 action is required' }, 400);

    const session = await store.activeSession(env);
    ctx.waitUntil(store.deleteIncomplete(env, session.id));
    const id = await store.addPoster(env, {
      sessionId: session.id,
      name,
      studentId,
      takeaways,
      actions,
      job: findJob(body.job)?.id ?? null,
    });
    // No broadcast yet — the card appears once its display image is uploaded.
    return json({ id }, 201);
  }

  // ---- image upload: the body is piped into R2 untouched
  const upload = /^\/api\/posters\/([\w-]+)\/image\/(full|display|photo)$/.exec(path);
  if (upload && method === 'PUT') {
    const [, id, variant] = upload;
    const declared = Number(request.headers.get('Content-Length') ?? 0);
    if (declared > MAX_IMAGE) return json({ error: 'image too large' }, 413);
    if (!request.body) return json({ error: 'empty image' }, 400);

    const stored = await store.putPosterImage(
      env,
      id,
      variant,
      request.body,
      request.headers.get('Content-Type'),
    );
    if (!stored) return json({ error: 'poster not found' }, 404);

    // The display copy is uploaded last, so its arrival means the card is whole.
    if (variant === 'display') {
      const poster = await store.markPosterReady(env, id);
      if (poster) await publish(env, 'poster', poster);
    }
    return json({ ok: true });
  }

  const posterMatch = /^\/api\/posters\/([\w-]+)$/.exec(path);
  if (posterMatch) {
    if (method === 'GET') {
      const poster = await store.getPoster(env, posterMatch[1]);
      return poster ? json(poster) : json({ error: 'not found' }, 404);
    }
    if (method === 'DELETE') {
      if (!isInstructor(request, env)) return json({ error: 'passcode required' }, 401);
      await store.deletePoster(env, posterMatch[1]);
      await publish(env, 'removed', { id: posterMatch[1] });
      return json({ ok: true });
    }
  }

  // ---- projector selection (instructor only)
  if (path === '/api/featured' && method === 'POST') {
    if (!isInstructor(request, env)) return json({ error: 'passcode required' }, 401);
    const body = await request.json().catch(() => ({}));
    const session = await store.activeSession(env);
    const id = body.id ? String(body.id) : null;
    if (id && !(await store.getPoster(env, id))) return json({ error: 'not found' }, 404);
    await store.setFeatured(env, session.id, id);
    await publish(env, 'featured', { id });
    return json({ id });
  }

  // ---- AI avatars
  if (path === '/api/avatar/quota' && method === 'GET') {
    const session = await store.activeSession(env);
    const studentId = (url.searchParams.get('studentId') ?? '').trim().slice(0, 24);
    const cap = limit(env, 'AVATAR_LIMIT', 3);
    const used = studentId ? await store.avatarUsage(env, session.id, studentId) : 0;
    return json({ used, limit: cap, remaining: Math.max(0, cap - used) });
  }

  if (path === '/api/avatar' && method === 'POST') {
    return handleAvatar(request, env, url);
  }

  // ---- QR code for the join link
  if (path === '/api/qr.svg' && method === 'GET') {
    const target = url.searchParams.get('url') || `${url.origin}/`;
    const { default: QRCode } = await import('qrcode');
    const svg = await QRCode.toString(target, {
      type: 'svg',
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#12123aff', light: '#f6e7c1ff' },
    });
    return new Response(svg, {
      headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=300' },
    });
  }

  // ---- bulk download (instructor only)
  if (path === '/api/download/all.zip' && method === 'GET') {
    if (!isInstructor(request, env)) return json({ error: 'passcode required' }, 401);
    const session = await store.activeSession(env);
    const posters = await store.listPosters(env, session.id);
    if (!posters.length) return json({ error: 'no posters yet' }, 404);

    const files = [];
    for (const [i, poster] of posters.entries()) {
      const object = await store.getPosterImage(env, poster.id, 'full');
      if (!object) continue;
      files.push({
        name: safeFileName(poster.name, poster.studentId, i + 1),
        data: new Uint8Array(await object.arrayBuffer()),
        date: new Date(poster.createdAt),
      });
    }

    const zip = makeZip(files);
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(zip, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="warrior-wall-${stamp}.zip"`,
      },
    });
  }

  // everything else is a static asset
  return env.ASSETS.fetch(request);
}

// -------------------------------------------------------------------- avatar

async function handleAvatar(request, env, url) {
  const body = await request.json().catch(() => ({}));
  const studentId = String(body.studentId ?? '').trim().slice(0, 24);
  const job = findJob(body.job);
  const photoParts = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(body.photo ?? ''));
  const cap = limit(env, 'AVATAR_LIMIT', 3);

  if (!studentId) return json({ error: 'studentId is required', code: 'bad_request' }, 400);
  if (!job) return json({ error: 'unknown class', code: 'bad_job' }, 400);
  if (!photoParts) return json({ error: 'photo missing or malformed', code: 'bad_photo' }, 400);
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'avatar generation is not configured', code: 'no_key' }, 501);
  }

  const session = await store.activeSession(env);
  const used = await store.avatarUsage(env, session.id, studentId);
  const quota = (extra) => ({ used, limit: cap, remaining: Math.max(0, cap - used), ...extra });

  if (used >= cap) {
    return json(quota({ error: `generation limit reached (${cap} per student)`, code: 'quota' }), 429);
  }

  // A whole-session ceiling is the backstop that actually protects the API key.
  // Per-IP limiting would be useless here and worse than useless in a
  // classroom, where all 40 students leave through one NAT address.
  const sessionCap = limit(env, 'AVATAR_SESSION_LIMIT', 150);
  if ((await store.sessionAvatarUsage(env, session.id)) >= sessionCap) {
    return json(quota({ error: 'this session has used its generation budget', code: 'busy' }), 429);
  }

  try {
    const image = await generateAvatar(photoParts[2], photoParts[1], job.id, env.GEMINI_API_KEY);
    const nowUsed = await store.bumpAvatarUsage(env, session.id, studentId);
    return json({
      // The model's own base64, handed straight on — decoding and re-encoding
      // ~2 MB would be the most expensive thing this Worker ever did.
      image: `data:${image.mimeType};base64,${image.base64}`,
      job: job.id,
      used: nowUsed,
      limit: cap,
      remaining: Math.max(0, cap - nowUsed),
    });
  } catch (err) {
    console.error('[warrior-wall] avatar generation failed:', err.message);
    return json(quota({ error: err.message, code: err.code ?? 'upstream' }), err.status ?? 502);
  }
}

/**
 * Names stay in UTF-8 (the zip flags the encoding); only bytes a filesystem
 * would reject are dropped, and a trailing dot never eats the extension.
 */
function safeFileName(name, studentId, index) {
  const clean = (value) =>
    String(value ?? '')
      .normalize('NFC')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^[._]+|[._]+$/g, '');

  const base = [String(index).padStart(2, '0'), clean(studentId), clean(name)]
    .filter(Boolean)
    .join('-')
    .slice(0, 80);
  return `${base}.png`;
}
