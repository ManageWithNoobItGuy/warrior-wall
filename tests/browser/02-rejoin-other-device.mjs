import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'Q1?',choices:['a','b','c','d'],correctIdx:0,timeLimitSec:60},
    {text:'Q2?',choices:['a','b','c','d'],correctIdx:1,timeLimitSec:60}]})});

  // ---- phone 1 builds the character and earns some stats
  const p1 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p1.evaluate(`
    document.getElementById('name').value='Rejoin';
    document.getElementById('student-id').value='6410777';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(900);
  await p1.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(500);
  await p1.evaluate(`document.querySelector('.class-btn[data-job="thief"]').click()`);
  await sleep(300);
  await p1.evaluate(`document.getElementById('create-character').click()`);
  await sleep(1800);

  await post('/api/game/open',{index:0});
  await sleep(1000);
  await p1.evaluate(`document.querySelector('#choices .choice[data-choice="0"]').click()`);
  await sleep(900);
  await post('/api/game/close');
  await sleep(1400);
  const earned = await p1.evaluate(`JSON.stringify({
    hp: document.querySelectorAll('#my-stats .radar-value')[0]?.textContent ?? '',
    score: document.getElementById('my-score').textContent })`);
  const E = JSON.parse(earned);
  console.log('\n=== phone 1 earned some stats');
  ok(Number(E.score) > 0, `score ${E.score}, HP ${E.hp}`);

  // ---- phone 2: a different device, no stored identity at all
  const p2 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  const storage = await p2.evaluate(`localStorage.getItem('warrior-wall:player')`);
  console.log('\n=== phone 2 (fresh device, nothing stored)');
  ok(!storage, 'starts with no saved identity');

  await p2.evaluate(`
    document.getElementById('name').value='Rejoin';
    document.getElementById('student-id').value='6410777';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2200);
  const back = await p2.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    name: document.getElementById('my-name').textContent,
    cls: document.getElementById('my-class').textContent,
    hp: document.querySelectorAll('#my-stats .radar-value')[0]?.textContent ?? '',
    score: document.getElementById('my-score').textContent })`);
  const K = JSON.parse(back);
  ok(K.step === 3, `jumped straight to the arena, skipping photo and class (step ${K.step})`);
  ok(K.name === 'Rejoin' && K.cls === 'THIEF', `same character: ${K.name} / ${K.cls}`);
  ok(K.hp === E.hp && K.score === E.score, `stats carried over: HP ${K.hp}, score ${K.score}`);

  // ---- and it can answer the next question from the new device
  await post('/api/game/open',{index:1});
  await sleep(1400);
  const canAnswer = await p2.evaluate(`JSON.stringify({
    view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view,
    choices: document.querySelectorAll('#choices .choice:not([disabled])').length })`);
  const C = JSON.parse(canAnswer);
  console.log('\n=== answering from the new device');
  ok(C.view === 'question' && C.choices === 4, `question is live and tappable (${C.choices} choices)`);
  await p2.evaluate(`document.querySelector('#choices .choice[data-choice="1"]').click()`);
  await sleep(1200);
  const accepted = await p2.evaluate(`document.getElementById('q-status').textContent`);
  ok(accepted.includes('Locked in'), `answer accepted: "${accepted}"`);

  await post('/api/game/close');
  await sleep(1400);
  const after = await p2.evaluate(`document.getElementById('my-score').textContent`);
  ok(Number(after) > Number(E.score), `score grew ${E.score} → ${after} on the same character`);

  // ---- a brand-new id still builds a fresh character
  const p3 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p3.evaluate(`
    document.getElementById('name').value='Newcomer';
    document.getElementById('student-id').value='6410888';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2000);
  const fresh = await p3.evaluate(`[...document.querySelectorAll('.step')].findIndex(s=>!s.hidden)`);
  console.log('\n=== an unknown id is unaffected');
  ok(fresh === 1, `newcomer still goes to the photo step (step ${fresh})`);

  for (const e of [...errors(p1.logs),...errors(p2.logs),...errors(p3.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  p1.close(); p2.close(); p3.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
