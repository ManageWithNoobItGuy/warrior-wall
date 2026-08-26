import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');
  const p = await openPage(`${B}/`, { fresh: true });
  await p.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:2,mobile:false});
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='6600000001';
    document.getElementById('name').value='Identity Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await p.evaluate(`document.querySelector('.class-btn[data-job="thief"]').click()`);
  await sleep(400);
  await p.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2200);

  const head = await p.evaluate(`JSON.stringify({
    name: document.getElementById('my-name').textContent,
    id: document.getElementById('my-id').textContent,
    job: document.getElementById('my-class').textContent,
    score: document.getElementById('my-score').textContent,
    // does the header stay on one row, or has the ID pushed it out of shape?
    headH: Math.round(document.querySelector('#my-sheet .sheet-head').getBoundingClientRect().height),
    headTop: Math.round(document.querySelector('#my-sheet .sheet-head').getBoundingClientRect().top),
    scoreLeft: Math.round(document.querySelector('#my-sheet .sheet-score').getBoundingClientRect().left),
    nameRight: Math.round(document.getElementById('my-name').getBoundingClientRect().right),
    idColor: getComputedStyle(document.getElementById('my-id')).color })`);
  const H = JSON.parse(head);
  console.log('\n=== character sheet header');
  ok(H.name === 'Identity Tester', `name: ${H.name}`);
  ok(H.id === 'ID 6600000001', `student ID shown: ${H.id}`);
  ok(H.job === 'THIEF', `job: ${H.job}`);
  ok(H.score === '0', `score: ${H.score} PTS`);
  ok(H.headH > 20 && H.headH < 80, `header laid out, ${H.headH}px tall`);
  ok(H.scoreLeft > H.nameRight, `score still sits right of the name (${H.nameRight} → ${H.scoreLeft})`);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/sheet-id-desktop.png');

  // a long Thai name plus a long ID must not break the row
  await post('/api/game/reset');
  const q = await openPage(`${B}/`, { fresh: true });
  await q.send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await q.evaluate(`
    document.getElementById('student-id').value='641012345678901234';
    document.getElementById('name').value='ทดสอบ ชื่อยาวภาษาไทย';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);
  await q.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await q.evaluate(`document.querySelector('.class-btn[data-job="mage"]').click()`);
  await sleep(400);
  await q.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2200);
  const long = await q.evaluate(`JSON.stringify({
    id: document.getElementById('my-id').textContent,
    name: document.getElementById('my-name').textContent,
    overflowsRight: document.querySelector('#my-sheet .sheet-head').getBoundingClientRect().right > 390,
    bodyScrollW: document.body.scrollWidth })`);
  const L = JSON.parse(long);
  console.log('\n=== long Thai name + long ID on a 390px phone');
  ok(!L.overflowsRight && L.bodyScrollW <= 390, `no horizontal overflow (page width ${L.bodyScrollW})`);
  ok(L.id.startsWith('ID 6410123456'), `ID rendered: ${L.id}`);
  await q.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/sheet-id-phone.png');

  for (const e of [...errors(p.logs),...errors(q.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  p.close(); q.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
