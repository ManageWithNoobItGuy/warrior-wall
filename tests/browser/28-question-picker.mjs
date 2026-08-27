/**
 * Choosing which question to ask, out of order.
 *
 * The arrows step one at a time, which is fine for a bank read front to back
 * and useless the moment a class goes somewhere the running order did not
 * expect. The chooser opens any question directly.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const q = (text, correctIdx) => ({ text, choices: ['A','B','C','D'], correctIdx, timeLimitSec: 60 });

const chrome = await launch();
try {
  await post('/api/game/reset');
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    q('First question about bindings', 0),
    q('Second question about storage', 1),
    q('Third question about the arena', 2),
    q('Fourth question about pledging', 3)]})});
  await post('/api/game/join',{studentId:'8201',name:'Picker Tester',job:'mage',token:'t1'});

  const wall = await openPage(`${B}/wall`, { fresh: true });
  await sleep(2600);

  const initial = JSON.parse(await wall.evaluate(`JSON.stringify({
    options: [...document.querySelectorAll('#gm-pick option')].map(o=>o.textContent.trim()),
    value: document.getElementById('gm-pick').value,
    current: document.getElementById('gm-current').textContent.trim() })`));
  console.log('\n=== the chooser');
  ok(initial.options.length === 4, `every question is listed (${initial.options.length})`);
  ok(/^Q1 · First question/.test(initial.options[0]), `numbered and labelled: "${initial.options[0]}"`);
  ok(initial.value === '0', `it starts on the first (${initial.value})`);

  // ---- jump to the third, skipping the second entirely
  await wall.evaluate(`(()=>{
    const s=document.getElementById('gm-pick');
    s.value='2'; s.dispatchEvent(new Event('change'));
  })()`);
  await sleep(700);
  const picked = await wall.evaluate(`document.getElementById('gm-current').textContent.trim()`);
  console.log('\n=== after choosing the third');
  ok(/Q3 of 4/.test(picked), `NEXT UP follows the choice: "${picked}"`);
  ok(/Third question/.test(picked), 'and names the right question');

  // ---- and that is genuinely the one the room opens
  await wall.evaluate(`document.getElementById('gm-open').click()`);
  await sleep(1800);
  const live = await fetch(B+'/api/game/state').then(r=>r.json());
  console.log('\n=== what the room opened');
  ok(live.phase === 'question', `a question is live (${live.phase})`);
  ok(live.questionIndex === 2, `the third one, not the next in line (index ${live.questionIndex})`);
  ok(/Third question/.test(live.text ?? ''), `students see it: "${live.text}"`);

  // ---- locked while a question is on screen
  const lockedPick = await wall.evaluate(`document.getElementById('gm-pick').disabled`);
  ok(lockedPick, 'the chooser is locked while a question is live');

  await post('/api/game/close');
  await sleep(1600);
  const afterClose = await wall.evaluate(`document.getElementById('gm-pick').disabled`);
  ok(!afterClose, 'and usable again once it is closed');
  await wall.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/question-picker.png');

  for (const e of errors(wall.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  wall.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
