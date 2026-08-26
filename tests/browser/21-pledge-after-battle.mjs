/**
 * The pledge belongs after the tournament.
 *
 * MY PLEDGE ▶ used to sit in the arena from the moment a character existed,
 * which invited students to go and write their takeaways while questions were
 * still being asked. It now appears only once the battle has finished.
 *
 * The end of a battle is not broadcast — each screen works it out from
 * startedAt + totalMs — so this suite runs a real battle and waits it out
 * rather than asserting against a faked clock.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const NAV = `JSON.stringify({
  pledge: !document.getElementById('to-pledge').hidden,
  wait: !document.getElementById('pledge-wait').hidden,
  view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view,
  step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden) })`;

const chrome = await launch();
try {
  await post('/api/game/reset');
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'Which binding holds the room state?',choices:['D1','Durable Object','R2','KV'],correctIdx:1,timeLimitSec:60}]})});

  const p = await openPage(`${B}/`, { fresh: true });
  await p.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='6410999';
    document.getElementById('name').value='Pledge Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await p.evaluate(`document.querySelector('.class-btn[data-job="mage"]').click()`);
  await sleep(500);
  await p.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2000);

  // A tournament needs an opponent; one fighter produces no bracket at all.
  await post('/api/game/join',{studentId:'6410998',name:'Sparring Partner',job:'warrior',token:'partner'});

  const idle = JSON.parse(await p.evaluate(NAV));
  console.log('\n=== in the arena, before any battle');
  ok(idle.step === 3, `student is on the arena step (${idle.step})`);
  ok(!idle.pledge, 'MY PLEDGE is not offered yet');
  ok(idle.wait, 'the nav explains why: PLEDGE OPENS AFTER THE BATTLE');

  // ---- a question is asked; still no pledge
  await post('/api/game/open',{index:0});
  await sleep(1000);
  await p.evaluate(`document.querySelector('#choices .choice[data-choice="1"]').click()`);
  await sleep(600);
  await post('/api/game/close');
  await sleep(1500);
  const q = JSON.parse(await p.evaluate(NAV));
  console.log('\n=== after answering a question');
  ok(!q.pledge, `still no pledge mid-quiz (view: ${q.view})`);

  // ---- the battle
  await post('/api/game/stance/open');
  await sleep(1200);
  await post('/api/game/battle/start');
  await sleep(2500);
  const mid = JSON.parse(await p.evaluate(NAV));
  console.log('\n=== while the battle is running');
  ok(mid.view === 'battle', `phone says look at the screen (${mid.view})`);
  ok(!mid.pledge, 'MY PLEDGE stays hidden during the battle');

  const total = await fetch(B+'/api/game/battle').then(r=>r.json()).then(d=>d.battle.totalMs);
  const waitMs = total + 8000; // the phone polls every 5s once the clock runs out
  console.log(`  · show runs ${Math.round(total/1000)}s; waiting ${Math.round(waitMs/1000)}s for it to finish`);
  await sleep(waitMs);

  // The room's own alarm must have fired: without it a phone that missed the
  // moment, or joined afterwards, would have nothing authoritative to read.
  // The phone's local timer alone would make every check below pass.
  const serverPhase = await fetch(B+'/api/game/state').then(r=>r.json()).then(d=>d.phase);
  const done = JSON.parse(await p.evaluate(NAV));
  console.log('\n=== once the battle is over');
  ok(serverPhase === 'done', `the room itself moved to done (server phase: ${serverPhase})`);
  ok(done.view === 'done', `the arena shows the result (${done.view})`);
  ok(done.pledge, 'MY PLEDGE ▶ is now offered');
  ok(!done.wait, 'the waiting note is gone');
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/pledge-after-battle.png');

  // ---- and it still leads where it always did
  const clicked = await p.evaluate(`(()=>{
    const b=document.getElementById('to-pledge');
    if (b.hidden || !b.offsetParent) return 'not visible';
    b.click(); return 'clicked';
  })()`);
  await sleep(800);
  const next = JSON.parse(await p.evaluate(NAV));
  ok(clicked === 'clicked', `the button is genuinely on screen, not just present (${clicked})`);
  ok(next.step === 4, `MY PLEDGE still opens KEY TAKEAWAYS (step ${next.step})`);

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
