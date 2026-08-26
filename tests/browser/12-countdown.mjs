import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const clock = (p) => p.evaluate(`JSON.stringify({
  text: document.getElementById('q-clock').textContent,
  width: document.getElementById('q-bar').style.width,
  low: document.getElementById('q-bar').dataset.low })`).then(JSON.parse);

const chrome = await launch();
try {
  await post('/api/game/reset');
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'A ten second question',choices:['a','b','c','d'],correctIdx:0,timeLimitSec:10}]})});

  const p = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='9501';
    document.getElementById('name').value='Timer Test';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1500);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`); await sleep(700);
  await p.evaluate(`document.querySelector('.class-btn[data-job="thief"]').click()`); await sleep(400);
  await p.evaluate(`document.getElementById('create-character').click()`); await sleep(2200);

  await post('/api/game/open',{index:0});
  await sleep(900);
  const t1 = await clock(p);
  await sleep(2600);
  const t2 = await clock(p);
  await sleep(2600);
  const t3 = await clock(p);

  console.log('\n=== the countdown, sampled three times');
  console.log(`    ${t1.text} (${t1.width})  ->  ${t2.text} (${t2.width})  ->  ${t3.text} (${t3.width})`);
  ok(Number(t1.text.replace('s','')) > Number(t2.text.replace('s','')), 'the seconds actually go down');
  ok(Number(t2.text.replace('s','')) > Number(t3.text.replace('s','')), 'and keep going down');
  ok(parseFloat(t1.width) > parseFloat(t3.width) + 20, `the bar drains too (${t1.width} -> ${t3.width})`);

  // ---- it must turn red near the end and then read TIME.
  // The three samples above already burned ~6.1s of the 10s limit; wait past
  // the rest of it with room to spare rather than landing on the last second.
  await sleep(5200);
  const t4 = await clock(p);
  console.log('\n=== past the deadline');
  ok(t4.text === 'TIME', `reads "${t4.text}" when the clock runs out`);
  ok(t4.low === 'true', 'the bar had gone red before it emptied');
  ok(parseFloat(t4.width) === 0, `bar empty (${t4.width})`);

  // ---- answering still works right up to the buzzer, and the loop stops after
  const before = await p.evaluate(`document.querySelectorAll('#choices .choice:not([disabled])').length`);
  ok(before === 4, 'choices stay tappable past the deadline (the server holds a grace window)');
  await post('/api/game/close');
  await sleep(1500);
  const view = await p.evaluate(`[...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view`);
  ok(view === 'reveal', `moved to the reveal (${view})`);

  // ---- and a second question restarts the clock cleanly
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'A ten second question',choices:['a','b','c','d'],correctIdx:0,timeLimitSec:10},
    {text:'Another one',choices:['a','b','c','d'],correctIdx:1,timeLimitSec:30}]})});
  await post('/api/game/open',{index:1});
  await sleep(900);
  const u1 = await clock(p);
  await sleep(2600);
  const u2 = await clock(p);
  console.log('\n=== a second question');
  console.log(`    ${u1.text} -> ${u2.text}`);
  ok(Number(u1.text.replace('s','')) > 25, `restarted from the new limit (${u1.text})`);
  ok(Number(u1.text.replace('s','')) > Number(u2.text.replace('s','')), 'and it ticks too');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
