import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Runs a tournament through to its end.
 *
 * MY PLEDGE ▶ only appears once the battle is over, so any suite that needs the
 * pledge has to get the room there first. Two things make this unavoidably
 * slow: a bracket needs at least two fighters — one produces no battle at all —
 * and the show runs on its own clock, which nothing can fast-forward.
 *
 * Every student who should fight must have joined before this is called.
 */
export async function runBattleToEnd(base, { partnerId = '9999', job = 'warrior' } = {}) {
  const post = (path, body) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then((r) => r.json());

  await post('/api/game/join', {
    studentId: partnerId,
    name: 'Sparring Partner',
    job,
    token: `partner-${partnerId}`,
  });
  await post('/api/game/battle/start');

  const total = await fetch(`${base}/api/game/battle`)
    .then((r) => r.json())
    .then((d) => d.battle.totalMs);
  // A margin over the timeline: the room's alarm fires at exactly startedAt +
  // totalMs, and the phones need a moment to hear about it.
  await sleep(total + 3000);
  return total;
}
