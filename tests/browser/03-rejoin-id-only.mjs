import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');

  // ---- create a character the normal way
  const p1 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p1.evaluate(`
    document.getElementById('name').value='Rejoin Tester';
    document.getElementById('student-id').value='6410777';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1200);
  await p1.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(500);
  await p1.evaluate(`document.querySelector('.class-btn[data-job="thief"]').click()`);
  await sleep(300);
  await p1.evaluate(`document.getElementById('create-character').click()`);
  await sleep(1800);
  console.log('\n=== setup');
  ok((await p1.evaluate(`document.getElementById('my-name').textContent`)) === 'Rejoin Tester', 'character created');

  // ---- ID only, name left blank
  const p2 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p2.evaluate(`
    document.getElementById('student-id').value='6410777';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2200);
  const r = await p2.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    sheetName: document.getElementById('my-name').textContent,
    formName: document.getElementById('name').value,
    cls: document.getElementById('my-class').textContent })`);
  const R = JSON.parse(r);
  console.log('\n=== returning with ID only, name blank');
  ok(R.step === 3, `went straight to the arena (step ${R.step})`);
  ok(R.sheetName === 'Rejoin Tester', `found the character: ${R.sheetName} / ${R.cls}`);
  ok(R.formName === 'Rejoin Tester', `name refilled into the form ("${R.formName}") — the card needs it`);

  // ---- and the card really does carry the name
  await p2.evaluate(`document.getElementById('to-pledge').click()`); await sleep(500);
  await p2.evaluate(`
    document.querySelectorAll('#takeaways textarea')[0].value='เรียนรู้เรื่อง Durable Objects';
    document.querySelector('[data-step="4"] [data-next]').click();`); await sleep(500);
  await p2.evaluate(`
    document.querySelectorAll('#actions textarea')[0].value='จะลองสร้าง quiz ของตัวเอง';
    document.querySelector('[data-step="5"] [data-next]').click();`);
  await sleep(3500);
  const card = await p2.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    w: document.getElementById('preview').naturalWidth })`);
  const C = JSON.parse(card);
  console.log('\n=== the pledge card after a name-less resume');
  ok(C.step === 6 && C.w > 0, `card built (${C.w}px wide) — not blocked by an empty name`);
  await p2.evaluate(`document.getElementById('preview').scrollIntoView()`); await sleep(600);
  await p2.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/card-resumed.png');

  // ---- a new student still has to give a name
  const p3 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p3.evaluate(`
    document.getElementById('student-id').value='6410999';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2000);
  const n = await p3.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    toast: document.querySelector('.toast')?.textContent ?? '' })`);
  const N = JSON.parse(n);
  console.log('\n=== a brand-new ID with no name');
  ok(N.step === 0, `held on the first screen (step ${N.step})`);
  ok(/name/i.test(N.toast), `told why: "${N.toast}"`);

  await p3.evaluate(`
    document.getElementById('name').value='Newcomer';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1500);
  ok((await p3.evaluate(`[...document.querySelectorAll('.step')].findIndex(s=>!s.hidden)`)) === 1,
     'proceeds once a name is given');

  // ---- no ID at all
  const p4 = await openPage(`${B}/`, { fresh: true });
  await sleep(2200);
  await p4.evaluate(`document.querySelector('[data-step="0"] [data-next]').click()`);
  await sleep(900);
  const noId = await p4.evaluate(`document.querySelector('.toast')?.textContent ?? ''`);
  console.log('\n=== nothing entered');
  ok(/student ID/i.test(noId), `asks for the ID: "${noId}"`);

  for (const e of [...errors(p1.logs),...errors(p2.logs),...errors(p3.logs),...errors(p4.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  p1.close(); p2.close(); p3.close(); p4.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
