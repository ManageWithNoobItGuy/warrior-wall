/**
 * A class that never fights still reaches the wall.
 *
 * Gating the pledge on the end of the battle left an instructor who skipped
 * the tournament — or whose class was too small for one, a bracket needs two —
 * with no way to collect a single card. OPEN PLEDGING is the room's own
 * signal, and owes nothing to the arena.
 *
 * Runs the whole way through to a downloadable card, which is the thing the
 * lesson is actually for.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const chrome = await launch();
try {
  await post('/api/game/reset');
  await post('/api/session/clear');

  // One student. A tournament is impossible here — runBattle needs two.
  const stu = await openPage(`${B}/`, { fresh: true, autoDialog: false });
  await stu.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await stu.evaluate(`
    document.getElementById('student-id').value='7801';
    document.getElementById('name').value='Solo Student';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1400);
  await stu.evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=c.height=512;
    const g=c.getContext('2d'); g.fillStyle='#6a4b8a'; g.fillRect(0,0,512,512);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'me.png',{type:'image/png'}));
    const i=document.getElementById('file'); i.files=dt.files;
    i.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  await stu.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await stu.evaluate(`document.querySelector('.class-btn[data-job="healer"]').click()`);
  await sleep(400);
  await stu.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2500);

  const waiting = JSON.parse(await stu.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    pledge: !document.getElementById('to-pledge').hidden })`));
  console.log('\n=== in the arena, no battle possible');
  ok(waiting.step === 3, `the student is waiting in the arena (step ${waiting.step})`);
  ok(!waiting.pledge, 'and cannot pledge on their own initiative');

  // ---- the instructor opens pledging
  const wall = await openPage(`${B}/wall`, { fresh: true, autoDialog: false });
  await sleep(2500);
  const before = JSON.parse(await wall.evaluate(`JSON.stringify({
    label: document.getElementById('gm-pledge').textContent.trim(),
    disabled: document.getElementById('gm-pledge').disabled,
    battle: document.getElementById('gm-battle').disabled })`));
  console.log('\n=== the wall');
  ok(before.battle, 'START BATTLE is unavailable with one character');
  ok(!before.disabled, `but OPEN PLEDGING is ready (${before.label})`);

  await wall.evaluate(`document.getElementById('gm-pledge').click()`);
  await sleep(600);
  await wall.evaluate(`document.querySelector('dialog.app-dialog[open] [data-ok]').click()`);
  await sleep(2500);

  const after = JSON.parse(await wall.evaluate(`JSON.stringify({
    label: document.getElementById('gm-pledge').textContent.trim(),
    disabled: document.getElementById('gm-pledge').disabled })`));
  ok(after.disabled && /OPEN/.test(after.label), `and says so afterwards (${after.label})`);

  const moved = await stu.evaluate(`[...document.querySelectorAll('.step')].findIndex(s=>!s.hidden)`);
  console.log('\n=== the student, with no tap of their own');
  ok(moved === 4, `the phone went to KEY TAKEAWAYS by itself (step ${moved})`);

  // ---- the same questions as ever, through to a card
  const prompts = JSON.parse(await stu.evaluate(`JSON.stringify({
    takeaways: document.querySelectorAll('#takeaways textarea').length,
    ask: document.querySelector('[data-step="4"] .speech').textContent.trim() })`));
  ok(prompts.takeaways === 3, `three takeaway boxes (${prompts.takeaways})`);
  ok(/what did you learn/i.test(prompts.ask), `asked as before: "${prompts.ask}"`);

  await stu.evaluate(`
    document.querySelectorAll('#takeaways textarea')[0].value='Durable Objects hold the room';
    document.querySelector('[data-step="4"] [data-next]').click();`);
  await sleep(700);
  await stu.evaluate(`
    document.querySelectorAll('#actions textarea')[0].value='Run this with my own class';
    document.querySelector('[data-step="5"] [data-next]').click();`);
  await sleep(3500);
  await stu.evaluate(`document.getElementById('submit').click()`);
  await sleep(7000);

  const card = JSON.parse(await stu.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    w: document.getElementById('done-preview').naturalWidth,
    href: document.getElementById('download').getAttribute('href'),
    name: document.getElementById('download').getAttribute('download') })`));
  console.log('\n=== the card');
  ok(card.step === 7, `the student reached QUEST COMPLETE (step ${card.step})`);
  ok(card.w > 0, `their card rendered (${card.w}px)`);
  ok(/^\/p\/full\//.test(card.href ?? ''), `and can be downloaded (${card.href})`);
  const full = await fetch(B + card.href).then(r=>({ status: r.status, type: r.headers.get('content-type') }));
  ok(full.status === 200 && full.type === 'image/png',
     `the download really serves a PNG (${full.status}, ${full.type})`);

  const wallCards = await fetch(B+'/api/posters').then(r=>r.json());
  ok(wallCards.posters.some(p=>String(p.studentId)==='7801'),
     `and it is on the wall (${wallCards.posters.length} card(s))`);
  await stu.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/pledge-no-battle.png');

  for (const e of [...errors(stu.logs),...errors(wall.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  stu.close(); wall.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
