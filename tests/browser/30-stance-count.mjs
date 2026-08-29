/**
 * The START BATTLE warning has to describe the room as it actually is.
 *
 * stanceCount arrives over SSE and repainted one number on the HUD without
 * touching the model behind it, so the panel showed "2 / 2 stances" while the
 * confirm dialog — computed from the model — said "2 of 2 have not picked a
 * stance". An instructor is reading that sentence out to a class.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const dialogText = `(()=>{
  const d=document.querySelector('dialog.app-dialog[open]');
  return d ? d.querySelector('.speech').textContent.trim() : 'no dialog';
})()`;

const chrome = await launch();
try {
  await post('/api/game/reset');
  await post('/api/game/join',{studentId:'8401',name:'Stance One',job:'warrior',token:'t1'});
  await post('/api/game/join',{studentId:'8402',name:'Stance Two',job:'mage',token:'t2'});

  // autoDialog off so the confirm can be read before it is answered.
  const wall = await openPage(`${B}/wall`, { fresh: true, autoDialog: false });
  await sleep(2600);
  await post('/api/game/stance/open');
  await sleep(1500);

  // ---- one of the two picks
  await post('/api/game/stance',{studentId:'8401',token:'t1',stance:'attack'});
  await sleep(1500);
  const oneHud = await wall.evaluate(`document.getElementById('gm-stances').textContent.trim()`);
  console.log('\n=== one of two has picked');
  ok(oneHud === '1 / 2', `the HUD counts it (${oneHud})`);

  await wall.evaluate(`document.getElementById('gm-battle').click()`);
  await sleep(1200);
  const oneMsg = await wall.evaluate(dialogText);
  ok(/^1 of 2 have not picked/.test(oneMsg), `and the warning agrees: "${oneMsg}"`);
  await wall.evaluate(`document.querySelector('dialog.app-dialog[open] [data-cancel]').click()`);
  await sleep(600);

  // ---- now the second one picks, over the live stream
  await post('/api/game/stance',{studentId:'8402',token:'t2',stance:'defend'});
  await sleep(1500);
  const bothHud = await wall.evaluate(`document.getElementById('gm-stances').textContent.trim()`);
  console.log('\n=== both have picked');
  ok(bothHud === '2 / 2', `the HUD counts both (${bothHud})`);

  // With nobody left unpicked there is nothing to warn about, so the battle
  // should start with no dialog at all.
  await wall.evaluate(`document.getElementById('gm-battle').click()`);
  await sleep(1500);
  const afterMsg = await wall.evaluate(dialogText);
  ok(afterMsg === 'no dialog', `no false warning is raised (got: "${afterMsg}")`);

  await sleep(1500);
  const state = await fetch(B+'/api/game/state').then(r=>r.json());
  ok(state.phase === 'battle', `and the battle actually started (${state.phase})`);
  ok(state.stancePicked === 2, `with both stances recorded (${state.stancePicked})`);

  for (const e of errors(wall.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  wall.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
