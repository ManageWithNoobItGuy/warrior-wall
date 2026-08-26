import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');

  // ---- A returning student: ID only, has a card from an earlier class
  const p1 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p1.evaluate(`
    document.getElementById('student-id').value='6600000002';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2200);
  const panel = await p1.evaluate(`JSON.stringify({
    shown: !document.getElementById('returning').hidden,
    formHidden: document.getElementById('identity-form').hidden,
    name: document.getElementById('ret-name').textContent,
    cls: document.getElementById('ret-class').textContent,
    when: document.getElementById('ret-when').textContent,
    imgW: document.getElementById('ret-photo').naturalWidth,
    nameField: document.getElementById('name').value })`);
  const P = JSON.parse(panel);
  console.log('\n=== the choice panel');
  ok(P.shown && P.formHidden, 'panel replaces the form');
  ok(P.name === 'Returning Tester', `old name shown: ${P.name}`);
  ok(P.cls === 'HEALER · AI AVATAR', `class + portrait kind: ${P.cls} (${P.when})`);
  ok(P.imgW === 400, `old portrait actually loaded (${P.imgW}px)`);
  ok(P.nameField === 'Returning Tester', 'name pre-filled into the form for the card');
  await p1.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/returning.png');

  // ---- USE THIS
  await p1.evaluate(`document.getElementById('ret-use').click()`);
  await sleep(2200);
  const used = await p1.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    selected: document.querySelector('.class-btn.selected')?.dataset.job ?? null,
    previewShown: !document.getElementById('class-preview').hidden,
    shotDrawn: document.getElementById('shot').width > 0 && !document.getElementById('shot').hidden })`);
  const U = JSON.parse(used);
  console.log('\n=== USE THIS');
  ok(U.step === 2, `jumped to the class step, skipping the camera (step ${U.step})`);
  ok(U.selected === 'healer', `old class pre-selected: ${U.selected}`);
  ok(U.shotDrawn, 'old portrait loaded into the preview canvas');
  ok(U.previewShown, 'stat preview visible');

  await p1.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2000);
  const made = await p1.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    name: document.getElementById('my-name').textContent,
    cls: document.getElementById('my-class').textContent })`);
  const M = JSON.parse(made);
  ok(M.step === 3 && M.name === 'Returning Tester' && M.cls === 'HEALER',
     `character created in one press: ${M.name} / ${M.cls}`);

  // the portrait made it to the arena
  await sleep(1200);
  const av = await p1.evaluate(`(async()=>{
    const r = await fetch('/av/6600000002.jpg'); return r.status; })()`);
  ok(av === 200, `arena portrait uploaded from the old card (HTTP ${av})`);

  // ---- NEW LOOK takes the other branch
  await post('/api/game/reset');
  const p2 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p2.evaluate(`
    document.getElementById('student-id').value='6600000002';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2000);
  await p2.evaluate(`document.getElementById('ret-fresh').click()`);
  await sleep(900);
  const fresh = await p2.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    nameField: document.getElementById('name').value,
    hasPhoto: !document.getElementById('portrait-empty').hidden === false })`);
  const F = JSON.parse(fresh);
  console.log('\n=== NEW LOOK');
  ok(F.step === 1, `goes to the camera step (step ${F.step})`);
  ok(F.nameField === 'Returning Tester', 'keeps their name anyway');

  // ---- an ID with no history is unaffected
  const p3 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p3.evaluate(`
    document.getElementById('student-id').value='9999999';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2000);
  const n = await p3.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    panel: !document.getElementById('returning').hidden,
    toast: document.querySelector('.toast')?.textContent ?? '' })`);
  const N = JSON.parse(n);
  console.log('\n=== a stranger');
  ok(!N.panel && N.step === 0, 'no panel, held on the first screen');
  ok(/name/i.test(N.toast), `asked for a name: "${N.toast}"`);

  for (const e of [...errors(p1.logs),...errors(p2.logs),...errors(p3.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  p1.close(); p2.close(); p3.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
