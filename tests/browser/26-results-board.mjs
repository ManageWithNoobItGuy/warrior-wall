/**
 * The board the room reads when the tournament is over.
 *
 * Two orders of merit: who was left standing, and who answered best. The arena
 * deliberately does not settle the quiz — answering well buys stats, not
 * victory — so these are often different people and both get their name up.
 *
 * This also covers a trap the `done` phase introduced: GAME_VIEWS did not list
 * it, so the projector walked away from the arena the instant the battle ended
 * and showed the card wall instead.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { runBattleToEnd } from '../lib/battle.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const BOARD = `JSON.stringify({
  board: !!document.querySelector('.results-board'),
  arena: !!document.querySelector('.proj-arena'),
  heads: [...document.querySelectorAll('.results-head')].map(n=>n.textContent.trim()),
  cols: [...document.querySelectorAll('.results-col')].map(col => ({
    rows: [...col.querySelectorAll('.results-list li')].map(li => ({
      name: li.querySelector('.results-name').textContent.trim(),
      detail: li.querySelector('.results-detail').textContent.trim(),
      first: li.classList.contains('is-first') })) })),
  crowns: [...document.querySelectorAll('.results-crowns b')].map(n=>n.textContent.trim()) })`;

const chrome = await launch();
try {
  await post('/api/game/reset');
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'Which binding holds the room state?',choices:['D1','Durable Object','R2','KV'],correctIdx:1,timeLimitSec:60}]})});

  // Three fighters; only one answers the question, so the quiz order and the
  // arena order are computed from genuinely different things.
  await post('/api/game/join',{studentId:'8101',name:'Quiz Ace',job:'mage',token:'t1'});
  await post('/api/game/join',{studentId:'8102',name:'Silent Bob',job:'warrior',token:'t2'});
  await post('/api/game/join',{studentId:'8103',name:'Third Wheel',job:'thief',token:'t3'});

  await post('/api/game/open',{index:0});
  await sleep(600);
  await post('/api/game/answer',{studentId:'8101',token:'t1',choiceIdx:1});
  await sleep(400);
  await post('/api/game/close');
  await sleep(800);

  const proj = await openPage(`${B}/projector`, { fresh: true });
  await sleep(2500);

  await runBattleToEnd(B, { partnerId: '8104' });

  // The champion keeps the battlefield for a moment before the board arrives.
  const during = JSON.parse(await proj.evaluate(BOARD));
  console.log('\n=== the moment the battle ends');
  ok(!during.board, 'the board has not taken over yet');
  ok(during.arena, 'the battlefield is still on screen with the champion');

  await sleep(9000);
  const after = JSON.parse(await proj.evaluate(BOARD));
  console.log('\n=== once the champion has had their moment');
  ok(after.board, 'the results board is up');
  ok(!after.arena, 'and it has the screen to itself');
  ok(after.heads.join('/') === 'ARENA/QUIZ', `both tables are titled (${after.heads.join(', ')})`);

  const [arenaCol, quizCol] = after.cols;
  ok(arenaCol?.rows.length >= 3, `the arena table lists the field (${arenaCol?.rows.length} rows)`);
  ok(arenaCol?.rows[0]?.first, 'the winner of the tournament is marked');
  ok(/DMG/.test(arenaCol?.rows[0]?.detail ?? ''), `with their damage (${arenaCol?.rows[0]?.detail})`);

  ok(quizCol?.rows.length === 1, `only the student who answered appears in the quiz table (${quizCol?.rows.length})`);
  ok(quizCol?.rows[0]?.name === 'Quiz Ace', `and it is the right one (${quizCol?.rows[0]?.name})`);
  ok(quizCol?.rows[0]?.detail === '1/1', `scored out of what they were asked (${quizCol?.rows[0]?.detail})`);
  ok(quizCol?.rows[0]?.first, 'the sharpest answerer is marked too');

  ok(after.crowns.length === 2, `both champions are named at the foot (${after.crowns.join(' / ')})`);
  ok(after.crowns[1] === 'Quiz Ace', `SHARPEST is the best answerer (${after.crowns[1]})`);
  await proj.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/results-board.png');

  // ---- no more than eight places, however big the class
  const rows = arenaCol?.rows.length ?? 0;
  ok(rows <= 8, `the arena table is capped at eight (${rows})`);

  for (const e of errors(proj.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  proj.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
