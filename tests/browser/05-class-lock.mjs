import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');
  const p = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p.evaluate(`
    document.getElementById('student-id').value='6600000002';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2200);
  await p.evaluate(`document.getElementById('ret-use').click()`);
  await sleep(2400);

  const st = await p.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    selected: document.querySelector('.class-btn.selected')?.dataset.job,
    gridLocked: document.getElementById('class-grid').classList.contains('is-locked'),
    noteShown: !document.getElementById('class-lock').hidden,
    lockClass: document.getElementById('lock-class').textContent,
    summonHidden: document.getElementById('summon').hidden,
    speech: document.getElementById("class-speech").textContent.trim() })`);
  const S = JSON.parse(st);
  console.log('\n=== after USE THIS on an AI-painted portrait');
  ok(S.step === 2, `on the class step (${S.step})`);
  ok(S.selected === 'healer', `class set to the portrait's class: ${S.selected}`);
  ok(S.gridLocked && S.noteShown, `grid locked, notice shown for ${S.lockClass}`);
  ok(S.summonHidden === true, 'SUMMON AVATAR is gone');
  ok(/set to match your portrait/i.test(S.speech), `copy updated: "${S.speech}…"`);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/locked.png');

  // ---- try to switch class anyway
  await p.evaluate(`document.querySelector('.class-btn[data-job="warrior"]').click()`);
  await sleep(900);
  const after = await p.evaluate(`JSON.stringify({
    selected: document.querySelector('.class-btn.selected')?.dataset.job,
    toast: document.querySelector('.toast')?.textContent ?? '' })`);
  const A = JSON.parse(after);
  console.log('\n=== trying to switch to warrior');
  ok(A.selected === 'healer', `still healer (${A.selected}) — the switch was refused`);
  ok(/portrait/i.test(A.toast), `told why: "${A.toast}"`);

  // ---- the escape hatch
  await p.evaluate(`document.getElementById('lock-release').click()`);
  await sleep(1200);
  const rel = await p.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    locked: document.getElementById('class-grid').classList.contains('is-locked'),
    noteShown: !document.getElementById('class-lock').hidden,
    emptyShown: !document.getElementById('portrait-empty').hidden })`);
  const R = JSON.parse(rel);
  console.log('\n=== TAKE A NEW PHOTO INSTEAD');
  ok(R.step === 1, `back to the camera (step ${R.step})`);
  ok(!R.locked && !R.noteShown, 'lock released');
  ok(R.emptyShown, 'old portrait cleared, ready for a new one');

  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(900);
  const free = await p.evaluate(`JSON.stringify({
    summonHidden: document.getElementById('summon').hidden,
    locked: document.getElementById('class-grid').classList.contains('is-locked') })`);
  const Fr = JSON.parse(free);
  ok(!Fr.locked, 'class grid free again');
  ok(Fr.summonHidden === false, 'SUMMON AVATAR available again');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
