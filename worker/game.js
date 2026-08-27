/**
 * Quiz and battle routes.
 *
 * Thin on purpose. Every rule about scoring, stats and the tournament lives in
 * the WallHub Durable Object (state that has to see the whole room) or in
 * lib/rpg (pure functions). This file only decides who is allowed to ask, and
 * where the answer is read from.
 *
 * Returns `null` when the path is none of its business, so index.js can fall
 * through to the rest of the router.
 */

import * as store from './store.js';
import { callHub, publish } from './wall-hub.js';
import { STANCES, WAVE } from '../lib/rpg/battle.js';
import { SKILLS } from '../lib/rpg/skills.js';
import { CLASS_MODIFIERS } from '../lib/rpg/classes.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

/** Hub replies already carry `{ error, code }` on failure; pass the shape
 *  straight through so the phone can branch on the code. */
const relay = ({ status, data }) => json(data, data?.error ? (status === 200 ? 400 : status) : 200);

const MAX_PORTRAIT = 2 * 1024 * 1024;

export async function gameRoutes(request, env, ctx, url, isInstructor) {
  const path = url.pathname;
  const method = request.method;

  // ---- the arena portrait. Written before the pledge card exists, because
  //      the battle happens in the middle of the lesson, not at the end.
  const portrait = /^\/av\/(.+)\.jpg$/.exec(path);
  if (portrait) {
    const studentId = decodeURIComponent(portrait[1]).slice(0, 24);
    const session = await store.activeSession(env);

    if (method === 'GET') {
      const object = await store.getPortrait(env, session.id, studentId);
      if (!object) return new Response('Not found', { status: 404 });
      return new Response(object.body, {
        headers: {
          'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
          'Content-Length': String(object.size),
          // Short: a student can resummon an avatar and expect the arena to
          // show the new one a moment later.
          'Cache-Control': 'public, max-age=60',
          ETag: object.httpEtag,
        },
      });
    }
    if (method === 'PUT') {
      if (Number(request.headers.get('Content-Length') ?? 0) > MAX_PORTRAIT) {
        return json({ error: 'portrait too large' }, 413);
      }
      if (!request.body) return json({ error: 'empty portrait' }, 400);
      await store.putPortrait(
        env,
        session.id,
        studentId,
        request.body,
        request.headers.get('Content-Type'),
      );
      await callHub(env, session.id, '/portrait', { body: { studentId } });
      return json({ ok: true });
    }
  }

  if (!path.startsWith('/api/game') && !path.startsWith('/api/questions')) return null;

  // ------------------------------------------------------------- reference

  // Static tables the phone needs to render stances and move names. Served
  // rather than duplicated into the client bundle so the two can never drift.
  if (path === '/api/game/rules' && method === 'GET') {
    // WAVE goes out with the rest because the projector interpolates against
    // the very same numbers the server used to lay the timeline out. Shipping
    // a second copy in the page would let the two drift apart silently, and
    // the symptom — an arena that runs slightly ahead of its own health bars —
    // is a miserable thing to diagnose in front of a class.
    return json({ stances: STANCES, skills: SKILLS, modifiers: CLASS_MODIFIERS, wave: WAVE });
  }

  // ------------------------------------------------------------- questions

  if (path === '/api/questions') {
    const session = await store.activeSession(env);

    if (method === 'GET') {
      const questions = await store.listQuestions(env, session.id);
      // Students may see the questions exist, never which answer is right.
      if (!isInstructor) {
        return json({ questions: questions.map(({ correctIdx, explanation, ...q }) => q) });
      }
      return json({ questions });
    }

    if (method === 'PUT') {
      if (!isInstructor) return json({ error: 'passcode required' }, 401);
      const body = await request.json().catch(() => ({}));
      const cleaned = cleanQuestions(body.questions);
      if (cleaned.error) return json({ error: cleaned.error }, 400);
      const saved = await store.replaceQuestions(env, session.id, cleaned.questions);
      await publish(env, session.id, 'questions', { count: saved.length });
      return json({ questions: saved });
    }
  }

  // ------------------------------------------------------------ the student

  if (path === '/api/game/join' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const session = await store.activeSession(env);
    return relay(
      await callHub(env, session.id, '/join', {
        body: {
          sessionId: session.id,
          studentId: String(body.studentId ?? '').trim().slice(0, 24),
          name: String(body.name ?? '').trim().slice(0, 40),
          job: body.job ?? null,
          token: body.token ?? null,
        },
      }),
    );
  }

  if (path === '/api/game/me' && method === 'GET') {
    const session = await store.activeSession(env);
    const studentId = encodeURIComponent(url.searchParams.get('studentId') ?? '');
    const token = encodeURIComponent(url.searchParams.get('token') ?? '');
    return relay(
      await callHub(env, session.id, `/me?studentId=${studentId}&token=${token}`, { method: 'GET' }),
    );
  }

  // What this student had last time, if anything. Deliberately separate from
  // /api/game/me: that answers "do you have a character in this room", this
  // answers "have you ever been here before".
  if (path === '/api/game/previous' && method === 'GET') {
    const studentId = String(url.searchParams.get('studentId') ?? '').trim().slice(0, 24);
    if (!studentId) return json({ previous: null });
    const [previous, session] = await Promise.all([
      store.findPreviousPoster(env, studentId),
      store.activeSession(env),
    ]);
    if (!previous) return json({ previous: null });
    return json({
      previous: {
        posterId: previous.posterId,
        name: previous.name,
        job: previous.job,
        // Whether that card belongs to the class running right now. A student
        // who has already pledged today should not be nudged to do it again —
        // the pledge is the last thing that happens in a lesson, not a thing
        // you do on every visit to the page.
        isCurrentSession: previous.sessionId === session.id,
        photoUrl: `/p/photo/${previous.posterId}.jpg`,
        // A card carrying a class was one with an AI avatar on it, so the
        // portrait is already stylised and must not be posterised a second
        // time when it goes onto the new card.
        isAvatar: Boolean(previous.job),
        createdAt: previous.createdAt,
      },
    });
  }

  if (path === '/api/game/state' && method === 'GET') {
    const session = await store.activeSession(env);
    return relay(await callHub(env, session.id, '/game', { method: 'GET' }));
  }

  if (path === '/api/game/answer' && method === 'POST') {
    const session = await store.activeSession(env);
    const body = await request.json().catch(() => ({}));
    return relay(await callHub(env, session.id, '/answer', { body }));
  }

  if (path === '/api/game/stance' && method === 'POST') {
    const session = await store.activeSession(env);
    const body = await request.json().catch(() => ({}));
    return relay(await callHub(env, session.id, '/stance', { body }));
  }

  // The whole tournament, for the projector to replay. Sizeable with a full
  // class, so it is fetched once on the `battle` event rather than pushed
  // down the SSE stream to every phone in the room.
  if (path === '/api/game/battle' && method === 'GET') {
    const session = await store.activeSession(env);
    return relay(await callHub(env, session.id, '/battle', { method: 'GET' }));
  }

  if (path === '/api/game/roster' && method === 'GET') {
    const session = await store.activeSession(env);
    return relay(await callHub(env, session.id, '/roster', { method: 'GET' }));
  }

  // ---- a student removing their own character.
  //
  // Must be matched BEFORE the instructor block below, which claims every
  // POST under /api/game/ and answers 401 to anyone without the passcode —
  // that is every student. The token this device minted is what authorises
  // this one, and the room refuses once the tournament has been computed.
  if (path === '/api/game/leave' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const session = await store.activeSession(env);
    return json(
      await purgeStudent(env, session.id, body.studentId, {
        token: body.token,
        ownerOnly: true,
      }),
    );
  }

  // --------------------------------------------------------- the instructor

  if (path.startsWith('/api/game/') && method === 'POST') {
    if (!isInstructor) return json({ error: 'passcode required' }, 401);
    const body = await request.json().catch(() => ({}));
    const session = await store.activeSession(env);

    if (path === '/api/game/open') {
      // The DO is never given a D1 binding — the question is read here and
      // handed over, which keeps the hot path free of database access.
      const questions = await store.listQuestions(env, session.id);
      const index = Number(body.index ?? 0);
      const question = questions[index];
      if (!question) return json({ error: 'no such question' }, 404);
      return relay(
        await callHub(env, session.id, '/admin/open', {
          body: { question, index, total: questions.length },
        }),
      );
    }

    if (path === '/api/game/close') {
      return relay(await callHub(env, session.id, '/admin/close', { body: {} }));
    }

    if (path === '/api/game/lobby') {
      return relay(await callHub(env, session.id, '/admin/lobby', { body: {} }));
    }

    if (path === '/api/game/stance/open') {
      return relay(await callHub(env, session.id, '/admin/stance', { body: {} }));
    }

    if (path === '/api/game/battle/start') {
      // The room counts its own questions — it knows how many were actually
      // asked, which the bank size does not tell us.
      const result = await callHub(env, session.id, '/admin/battle', { body: {} });
      // Mirror the outcome into D1 in the background. The projector must not
      // wait on a write it does not read from, and if this fails the room
      // still has its result — the DO is holding it.
      if (!result.data?.error) {
        ctx.waitUntil(snapshotResults(env, session.id));
      }
      return relay(result);
    }

    if (path === '/api/game/reset') {
      return relay(await callHub(env, session.id, '/admin/reset', { body: { sessionId: session.id } }));
    }

    if (path === '/api/game/pledge/open') {
      return relay(await callHub(env, session.id, '/admin/pledge', { body: {} }));
    }

    if (path === '/api/game/player/rename') {
      return relay(
        await callHub(env, session.id, '/admin/player-rename', {
          body: { studentId: body.studentId, name: body.name },
        }),
      );
    }

    if (path === '/api/game/player/remove') {
      return json(await purgeStudent(env, session.id, body.studentId, {}));
    }
  }

  if (path === '/api/game/results' && method === 'GET') {
    const session = await store.activeSession(env);
    return json({ results: await store.listBattleResults(env, session.id) });
  }

  return null;
}

/**
 * Removes a student from a class completely: character, arena portrait, and any
 * card they had already sent, images included.
 *
 * The room is asked first. If it refuses — no such character, the wrong token,
 * a battle already running — nothing else is touched, so a rejected request
 * cannot still cost someone their card.
 */
async function purgeStudent(env, sessionId, studentId, { token, ownerOnly = false }) {
  const id = String(studentId ?? '').slice(0, 24);
  if (!id) return { error: 'studentId required', code: 'BAD_ID' };

  // Two different doors into the same room method: /leave demands the device's
  // own token, /admin/player-remove does not. Choosing here rather than passing
  // a flag means a student's request can never arrive as an instructor's.
  const { data } = await callHub(env, sessionId, ownerOnly ? '/leave' : '/admin/player-remove', {
    body: { studentId: id, token },
  });
  // An instructor may remove someone who only ever sent a card and is no longer
  // in the room; a student may not remove a character that is not theirs.
  if (data?.error && (ownerOnly || data.code !== 'NO_PLAYER')) return data;

  const posters = await store.postersByStudent(env, sessionId, id);
  for (const posterId of posters) {
    await store.deletePoster(env, posterId);
    // Per card, not a blanket 'cleared': every other wall on the projector and
    // in the room would otherwise empty itself over one student leaving.
    await publish(env, sessionId, 'removed', { id: posterId });
  }
  await store.deletePortrait(env, sessionId, id);

  return { ok: true, studentId: id, cards: posters.length };
}

/** Copies the finished roster out of the DO and into D1, so it outlives the
 *  room. */
async function snapshotResults(env, sessionId) {
  const { data } = await callHub(env, sessionId, '/roster', { method: 'GET' });
  if (data?.players?.length) await store.saveBattleResults(env, sessionId, data.players);
}

/**
 * Validates the question bank coming off the editor.
 *
 * Rejects rather than clamps, unlike the game settings — a question with the
 * wrong answer marked is not something to quietly repair, and the instructor
 * is sitting in front of the editor when this runs, not in front of a class.
 */
function cleanQuestions(input) {
  if (!Array.isArray(input)) return { error: 'questions must be a list' };
  if (input.length > 60) return { error: 'at most 60 questions' };

  const questions = [];
  for (const [i, raw] of input.entries()) {
    const text = String(raw?.text ?? '').trim().slice(0, 400);
    if (!text) return { error: `question ${i + 1} has no text` };

    const choices = (Array.isArray(raw?.choices) ? raw.choices : [])
      .map((c) => String(c ?? '').trim().slice(0, 200))
      .filter(Boolean);
    if (choices.length < 2) return { error: `question ${i + 1} needs at least 2 choices` };
    if (choices.length > 4) return { error: `question ${i + 1} has more than 4 choices` };

    const correctIdx = Number(raw?.correctIdx);
    if (!Number.isInteger(correctIdx) || correctIdx < 0 || correctIdx >= choices.length) {
      return { error: `question ${i + 1} has no correct answer marked` };
    }

    questions.push({
      id: typeof raw?.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
      text,
      choices,
      correctIdx,
      timeLimitSec: Math.min(300, Math.max(5, Number(raw?.timeLimitSec) || 25)),
      explanation: String(raw?.explanation ?? '').trim().slice(0, 400) || null,
    });
  }
  return { questions };
}
