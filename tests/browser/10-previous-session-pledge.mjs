import { launch, openPage } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');
  const p = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='6600000002';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2400);
  await p.evaluate(`document.getElementById('ret-use').click()`);
  await sleep(2400);
  await p.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2200);
  const f = JSON.parse(await p.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    pledgeBtn: !document.getElementById('to-pledge').hidden,
    note: !document.getElementById('pledged-note').hidden })`));
  console.log('\n=== a card from a PREVIOUS class');
  ok(f.step === 3, `in the arena (step ${f.step})`);
  ok(f.pledgeBtn && !f.note, 'MY PLEDGE is still offered — last week does not count as today');
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
