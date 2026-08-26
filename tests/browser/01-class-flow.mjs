import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B = 'http://127.0.0.1:8799';
const post = (p, b) => fetch(B + p, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(b ?? {}) }).then(r => r.json());

const chrome = await launch();
const fail = [];
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fail.push(m); };

try {
  await post('/api/game/reset');
  // Seed our own questions: relying on whatever a previous test left behind
  // made this file fail whenever another one changed the bank.
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({questions:[
      {text:'Which model paints the avatars?',choices:['nano banana','GPT-4o','Stable Diffusion','Midjourney'],correctIdx:0,timeLimitSec:20,explanation:'gemini-2.5-flash-image'},
      {text:'Where do the card images live?',choices:['D1','R2','KV','Durable Object'],correctIdx:1,timeLimitSec:20}]})});

  // ---- a student builds a character on their phone
  const stu = await openPage(`${B}/`);
  await sleep(2000);
  await stu.evaluate(`
    document.getElementById('name').value = 'Nimmiw';
    document.getElementById('student-id').value = '6499001';
    document.querySelector('[data-step="0"] [data-next]').click();
  `);
  await sleep(600);
  await stu.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(400);
  // no photo -> a confirm() dialog appears in the real browser; headless auto-dismisses.
  const step = await stu.evaluate(`[...document.querySelectorAll('.step')].findIndex(s=>!s.hidden)`);
  console.log('\n=== student flow');
  ok(step === 2, `reached the class step (at step ${step})`);

  await stu.evaluate(`document.querySelector('.class-btn[data-job="mage"]').click()`);
  await sleep(300);
  const preview = await stu.evaluate(`document.getElementById('class-preview').hidden === false && document.querySelectorAll('#preview-stats .radar-label').length`);
  ok(preview === 5, `class preview shows a 5-axis radar (got ${preview})`);

  await stu.evaluate(`document.getElementById('create-character').click()`);
  await sleep(1800);
  const sheet = await stu.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    name: document.getElementById('my-name').textContent,
    cls: document.getElementById('my-class').textContent,
    bars: document.querySelectorAll('#my-stats .radar-label').length,
    tier: document.getElementById('my-tier').textContent,
    view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view,
  })`);
  const s = JSON.parse(sheet);
  ok(s.step === 3, `landed in the arena (step ${s.step})`);
  ok(s.cls === 'MAGE' && s.bars === 5, `character sheet: ${s.name} / ${s.cls} / ${s.bars} axes / "${s.tier}"`);
  ok(s.view === 'idle', `waiting view shown (${s.view})`);

  // ---- six more classmates, so the bracket has some depth
  for (let i = 2; i <= 7; i++) {
    await post('/api/game/join', { studentId: `649900${i}`, name: `Classmate ${i}`,
      job: ['warrior','knight','thief','mage','healer'][i % 5], token: `t${i}` });
  }

  // ---- the instructor puts a question up
  const wall = await openPage(`${B}/wall`);
  await sleep(2200);
  console.log('\n=== instructor');
  const players = await wall.evaluate(`document.getElementById('gm-players').textContent`);
  ok(players === '7', `game master sees 7 in the room (got ${players})`);

  await wall.evaluate(`document.getElementById('gm-open').click()`);
  await sleep(1500);
  const gmPhase = await wall.evaluate(`document.getElementById('gm-phase').textContent`);
  ok(gmPhase === 'QUESTION', `question opened (phase ${gmPhase})`);

  // ---- it appears on the student's phone
  await sleep(800);
  const q = await stu.evaluate(`JSON.stringify({
    view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view,
    text: document.getElementById('q-text').textContent,
    choices: document.querySelectorAll('#choices .choice').length,
    clock: document.getElementById('q-clock').textContent,
  })`);
  const qq = JSON.parse(q);
  console.log('\n=== student answers');
  ok(qq.view === 'question', `question view is live (${qq.view})`);
  ok(qq.choices === 4, `4 choices rendered (${qq.choices}), clock "${qq.clock}"`);
  ok(qq.text.length > 0, `question text: "${qq.text.slice(0,50)}"`);

  await stu.evaluate(`document.querySelector('#choices .choice[data-choice="0"]').click()`);
  await sleep(1200);
  const locked = await stu.evaluate(`JSON.stringify({
    disabled: document.querySelector('#choices .choice').disabled,
    picked: !!document.querySelector('#choices .choice.picked'),
    status: document.getElementById('q-status').textContent })`);
  const L = JSON.parse(locked);
  ok(L.disabled && L.picked, `answer locked in ("${L.status}")`);

  // the rest of the class answers too
  for (let i = 2; i <= 7; i++)
    await post('/api/game/answer', { studentId: `649900${i}`, token: `t${i}`, choiceIdx: i <= 4 ? 0 : 2 });

  await wall.evaluate(`document.getElementById('gm-close').click()`);
  await sleep(1600);
  const rev = await stu.evaluate(`JSON.stringify({
    view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view,
    verdict: document.getElementById('verdict').textContent,
    tone: document.getElementById('verdict').dataset.tone,
    gains: [...document.querySelectorAll('#gains .gain')].map(g=>g.textContent),
    hp: document.querySelectorAll('#my-stats .radar-value')[0]?.textContent ?? '' })`);
  const R = JSON.parse(rev);
  console.log('\n=== reveal');
  ok(R.view === 'reveal', `reveal view (${R.view})`);
  ok(R.verdict === 'CORRECT!' && R.tone === 'good', `verdict "${R.verdict}"`);
  ok(R.gains.length > 0, `stats gained: ${R.gains.join(', ')}`);
  ok(/\d/.test(R.hp), `HP on the sheet updated to ${R.hp}`);

  // ---- stances
  await wall.evaluate(`document.getElementById('gm-stance').click()`);
  await sleep(1400);
  const st = await stu.evaluate(`JSON.stringify({
    view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view,
    buttons: document.querySelectorAll('#stance-grid .stance-btn').length })`);
  const S = JSON.parse(st);
  console.log('\n=== stance');
  ok(S.view === 'stance' && S.buttons === 3, `3 stances offered (view ${S.view})`);
  await stu.evaluate(`document.querySelector('.stance-btn[data-stance="defend"]').click()`);
  await sleep(900);
  const picked = await stu.evaluate(`!!document.querySelector('.stance-btn.selected') && document.getElementById('stance-note').textContent`);
  ok(!!picked, `stance locked: "${picked}"`);

  // ---- the battle, on the projector
  const proj = await openPage(`${B}/projector`);
  await sleep(2000);
  await post('/api/game/battle/start');
  await sleep(4000);
  console.log('\n=== the arena');
  const arena = await proj.evaluate(`JSON.stringify({
    tokens: document.querySelectorAll('.token').length,
    faces: document.querySelectorAll('.token-face').length,
    hud: document.querySelector('.arena-count')?.textContent,
    cells: [...document.querySelectorAll('.duel-cell')].filter(c=>!c.hidden).length })`);
  const A = JSON.parse(arena);
  ok(A.tokens === 7, `7 fighters on the field (${A.tokens})`);
  ok(A.cells >= 1, `${A.cells} duel boxes drawn, HUD says "${A.hud}"`);
  await proj.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/arena.png');

  const sb = await stu.evaluate(`[...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view`);
  ok(sb === 'battle', `student phone says "look at the screen" (${sb})`);

  // fast-forward past the whole show
  const total = await proj.evaluate(`(async()=>(await (await fetch('/api/game/battle')).json()).battle.totalMs)()`);
  console.log(`  · show runs ${Math.round(total/1000)}s; sampling mid-battle then skipping to the end`);
  await sleep(6000);
  await proj.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/arena-mid.png');

  for (const e of [...errors(stu.logs), ...errors(wall.logs), ...errors(proj.logs)])
    console.log('  ! console:', e.text.split('\n')[0]);

  stu.close(); wall.close(); proj.close();
} finally {
  chrome.kill();
}
console.log(fail.length ? `\nFAILED: ${fail.length}` : '\nALL CHECKS PASSED');
process.exit(fail.length ? 1 : 0);
