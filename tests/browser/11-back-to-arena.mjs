import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const step = (p) => p.evaluate(`[...document.querySelectorAll('.step')].findIndex(s=>!s.hidden)`);
const chrome = await launch();
try {
  await post('/api/game/reset');
  await post('/api/session/clear');
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'Round one?',choices:['a','b','c','d'],correctIdx:0,timeLimitSec:90},
    {text:'Round two, after some students pledged?',choices:['a','b','c','d'],correctIdx:2,timeLimitSec:90}]})});

  const p = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='9101';
    document.getElementById('name').value='Arena Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1500);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`); await sleep(700);
  await p.evaluate(`document.querySelector('.class-btn[data-job="knight"]').click()`); await sleep(400);
  await p.evaluate(`document.getElementById('create-character').click()`); await sleep(2200);

  // round one
  await post('/api/game/open',{index:0}); await sleep(1200);
  await p.evaluate(`document.querySelector('#choices .choice[data-choice="0"]').click()`); await sleep(900);
  await post('/api/game/close'); await sleep(1400);
  const score1 = await p.evaluate(`document.getElementById('my-score').textContent`);
  console.log('\n=== round one done');
  ok(Number(score1) > 0, `scored ${score1}`);

  // pledge mid-class
  await p.evaluate(`document.getElementById('to-pledge').click()`); await sleep(600);
  await p.evaluate(`
    document.querySelectorAll('#takeaways textarea')[0].value='Fail closed, not open';
    document.querySelector('[data-step="4"] [data-next]').click();`); await sleep(600);
  await p.evaluate(`
    document.querySelectorAll('#actions textarea')[0].value='Audit my own gates';
    document.querySelector('[data-step="5"] [data-next]').click();`); await sleep(3500);
  await p.evaluate(`document.getElementById('submit').click()`); await sleep(6000);

  const done = JSON.parse(await p.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    arenaBtn: !document.getElementById('to-arena').hidden })`));
  console.log('\n=== the completion screen');
  ok(done.step === 7, `on the card screen (step ${done.step})`);
  ok(done.arenaBtn, 'BACK TO THE ARENA is offered — not a dead end any more');

  // back to the arena
  await p.evaluate(`document.getElementById('to-arena').click()`); await sleep(1800);
  const back = JSON.parse(await p.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    pledgeBtn: !document.getElementById('to-pledge').hidden,
    note: !document.getElementById('pledged-note').hidden,
    score: document.getElementById('my-score').textContent })`));
  console.log('\n=== back in the arena');
  ok(back.step === 3, `returned to the arena (step ${back.step})`);
  ok(!back.pledgeBtn && back.note, 'shows the receipt, not another pledge invitation');
  ok(back.score === score1, `character intact, still ${back.score} pts`);

  // ---- and can still play round two
  await post('/api/game/open',{index:1}); await sleep(1400);
  const q2 = JSON.parse(await p.evaluate(`JSON.stringify({
    view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view,
    tappable: document.querySelectorAll('#choices .choice:not([disabled])').length })`));
  console.log('\n=== round two');
  ok(q2.view === 'question' && q2.tappable === 4, `question is live and tappable (${q2.tappable} choices)`);
  await p.evaluate(`document.querySelector('#choices .choice[data-choice="2"]').click()`); await sleep(900);
  await post('/api/game/close'); await sleep(1500);
  const score2 = await p.evaluate(`document.getElementById('my-score').textContent`);
  ok(Number(score2) > Number(score1), `kept scoring after pledging: ${score1} -> ${score2}`);

  // ---- the VIEW MY CARD round trip
  await p.evaluate(`document.getElementById('view-card').click()`); await sleep(2400);
  ok((await step(p)) === 7, 'VIEW MY CARD opens the card');
  ok(await p.evaluate(`!document.getElementById('to-arena').hidden`), 'and offers the way back');
  await p.evaluate(`document.getElementById('to-arena').click()`); await sleep(1600);
  ok((await step(p)) === 3, 'round trip returns to the arena');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
