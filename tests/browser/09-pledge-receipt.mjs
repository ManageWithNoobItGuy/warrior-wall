import { launch, openPage, errors } from '../lib/cdp.mjs';
import { runBattleToEnd } from '../lib/battle.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const footer = (page) => page.evaluate(`JSON.stringify({
  pledgeBtn: !document.getElementById('to-pledge').hidden,
  note: !document.getElementById('pledged-note').hidden,
  viewCard: !document.getElementById('view-card').hidden,
  step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden) })`).then(JSON.parse);

async function makeCharacter(page, id, name, job) {
  await page.evaluate(`
    document.getElementById('student-id').value='${id}';
    document.getElementById('name').value='${name}';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1600);
  const onReturning = await page.evaluate(`!document.getElementById('returning').hidden`);
  if (onReturning) { await page.evaluate(`document.getElementById('ret-use').click()`); await sleep(2200); }
  else {
    await page.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`); await sleep(700);
    await page.evaluate(`document.querySelector('.class-btn[data-job="${job}"]').click()`); await sleep(400);
    await page.evaluate(`document.getElementById('create-character').click()`); await sleep(2200);
  }
}

async function sendPledge(page) {
  await page.evaluate(`document.getElementById('to-pledge').click()`); await sleep(600);
  await page.evaluate(`
    document.querySelectorAll('#takeaways textarea')[0].value='Durable Objects hold the room';
    document.querySelector('[data-step="4"] [data-next]').click();`); await sleep(600);
  await page.evaluate(`
    document.querySelectorAll('#actions textarea')[0].value='Build a quiz for my team';
    document.querySelector('[data-step="5"] [data-next]').click();`); await sleep(3500);
  await page.evaluate(`document.getElementById('submit').click()`); await sleep(6000);
}

const chrome = await launch();
try {
  await post('/api/game/reset');
  await post('/api/session/clear');   // start from an empty wall

  // ---- a student who has NOT pledged
  const a = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await makeCharacter(a,'8001','Anan','warrior');

  const early = await footer(a);
  console.log('\n=== before the battle');
  ok(early.step === 3 && !early.pledgeBtn, 'no pledge until the tournament is over');

  // Everyone who fights has to be in the room before this.
  await runBattleToEnd(B, { partnerId: '8003' });

  const A = await footer(a);
  console.log('\n=== after the battle');
  ok(A.step === 3 && A.pledgeBtn && !A.note, 'MY PLEDGE is offered');

  // ---- send it
  await sendPledge(a);
  const done = await a.evaluate(`[...document.querySelectorAll('.step')].findIndex(s=>!s.hidden)`);
  ok(done === 7, `card sent, on the completion screen (step ${done})`);

  // ---- come back on a clean device with just the ID
  const b = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await b.evaluate(`
    document.getElementById('student-id').value='8001';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(2400);
  const Bf = await footer(b);
  console.log('\n=== returning after pledging');
  ok(Bf.step === 3, `dropped straight into the arena (step ${Bf.step})`);
  ok(!Bf.pledgeBtn, 'MY PLEDGE is gone');
  ok(Bf.note && Bf.viewCard, 'shows the receipt and a way to see the card');

  // ---- and the card is reachable
  await b.evaluate(`document.getElementById('view-card').click()`); await sleep(2200);
  const card = await b.evaluate(`JSON.stringify({
    step: [...document.querySelectorAll('.step')].findIndex(s=>!s.hidden),
    w: document.getElementById('done-preview').naturalWidth,
    msg: document.getElementById('done-message').textContent })`);
  const C = JSON.parse(card);
  ok(C.step === 7 && C.w > 0, `VIEW MY CARD shows it (${C.w}px) — "${C.msg}"`);

  // ---- a reload must not re-offer the pledge either
  await b.evaluate('location.reload()');
  await sleep(3200);
  const R = await footer(b);
  console.log('\n=== after a reload');
  ok(R.step === 3, `restored into the arena (step ${R.step})`);
  ok(!R.pledgeBtn && R.note, 'still shows the receipt, not the button');

  // ---- someone else who has not pledged is unaffected
  const c = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await makeCharacter(c,'8002','Benja','mage');
  const Cf = await footer(c);
  console.log('\n=== a different student');
  ok(Cf.pledgeBtn && !Cf.note, 'still invited to pledge');

  // ---- the wall lists the room, and a member who pledged shows as their card
  //      rather than appearing twice.
  const wall = await openPage(`${B}/wall`, { fresh: true });
  await sleep(2500);
  const panel = JSON.parse(await wall.evaluate(`JSON.stringify({
    cards: [...document.querySelectorAll('#roster .card:not(.card--character)')]
      .map(el => el.querySelector('.card-name small')?.textContent.trim()),
    characters: [...document.querySelectorAll('#roster .card--character')]
      .map(el => el.querySelector('.card-name small')?.textContent.trim()) })`));
  const all = [...panel.cards, ...panel.characters];
  console.log('\n=== PARTY MEMBERS');
  ok(panel.cards.includes('8001'), `the student who pledged shows as a card (${panel.cards.join(', ')})`);
  ok(!panel.characters.includes('8001'), 'and not also as a member tile');
  ok(all.filter(id => id === '8001').length === 1, 'listed exactly once');
  ok(panel.characters.includes('8002'), `the student who has not pledged is still listed (${panel.characters.join(', ')})`);

  for (const e of [...errors(a.logs),...errors(b.logs),...errors(c.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  a.close(); b.close(); c.close(); wall.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
