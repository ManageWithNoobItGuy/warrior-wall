/**
 * PARTY MEMBERS lists the room, not just the cards.
 *
 * The panel only ever rendered pledge cards. That was fine when the pledge came
 * first, but it now waits for the battle — so an instructor with a full room
 * spent the whole lesson looking at WAITING FOR CHALLENGERS.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const PANEL = `JSON.stringify({
  tiles: document.querySelectorAll('#roster .card').length,
  characters: document.querySelectorAll('#roster .card--character').length,
  cards: document.querySelectorAll('#roster .card:not(.card--character)').length,
  count: document.getElementById('count').textContent.trim(),
  emptyShown: !document.getElementById('empty').hidden,
  names: [...document.querySelectorAll('#roster .card-name')].map(n=>n.childNodes[0].textContent.trim()),
  jobs: [...document.querySelectorAll('#roster .party-job')].map(n=>n.textContent.trim()) })`;

const chrome = await launch();
try {
  await post('/api/game/reset');
  await post('/api/session/clear');

  const wall = await openPage(`${B}/wall`, { fresh: true });
  await sleep(2500);
  const before = JSON.parse(await wall.evaluate(PANEL));
  console.log('\n=== an empty room');
  ok(before.tiles === 0 && before.emptyShown, 'waiting for challengers with nobody in the room');

  // ---- a student makes a character and does NOT pledge
  const stu = await openPage(`${B}/`, { fresh: true });
  await stu.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await stu.evaluate(`
    document.getElementById('student-id').value='7001';
    document.getElementById('name').value='Party Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);
  await stu.evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=c.height=512;
    const g=c.getContext('2d'); g.fillStyle='#3d7a5a'; g.fillRect(0,0,512,512);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'me.png',{type:'image/png'}));
    const i=document.getElementById('file'); i.files=dt.files;
    i.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  await stu.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await stu.evaluate(`document.querySelector('.class-btn[data-job="knight"]').click()`);
  await sleep(500);
  await stu.evaluate(`document.getElementById('create-character').click()`);
  await sleep(3000);

  const after = JSON.parse(await wall.evaluate(PANEL));
  console.log('\n=== after one character, with no pledge');
  ok(!after.emptyShown, 'the panel is no longer empty');
  ok(after.characters === 1, `one member tile (${after.characters})`);
  ok(after.cards === 0, `and no card yet (${after.cards})`);
  ok(after.count === '1', `the header counts them (${after.count})`);
  ok(after.names[0] === 'Party Tester', `named on the tile: ${after.names[0]}`);
  ok(after.jobs[0] === 'KNIGHT', `class shown: ${after.jobs[0]}`);

  // ---- the portrait must not be striped by the CRT overlay
  // The tiles carry loading="lazy" and the panel sits well below the fold on a
  // desktop wall, so the browser has deliberately not fetched the portrait yet.
  // Scrolling to it is what a instructor does; measuring before that would be
  // measuring a decision the browser made, not a bug.
  const face = JSON.parse(await wall.evaluate(`(async()=>{
    const img=document.querySelector('#roster .party-face');
    if (!img) return JSON.stringify({ missing: true });
    img.scrollIntoView({ block: 'center' });
    img.loading = 'eager';
    if (!img.complete || !img.naturalWidth) {
      await new Promise((done) => {
        const stop = setTimeout(done, 4000);
        img.onload = img.onerror = () => { clearTimeout(stop); done(); };
      });
    }
    return JSON.stringify({ z: getComputedStyle(img).zIndex, w: img.naturalWidth });
  })()`));
  ok(!face.missing && face.w > 0, `the member's own portrait is shown (${face.w}px)`);
  ok(Number(face.z) > 9000, `and paints above the scanlines (z-index ${face.z})`);

  // ---- a second student lands too
  const stu2 = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await stu2.evaluate(`
    document.getElementById('student-id').value='7002';
    document.getElementById('name').value='Party Tester Two';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);
  await stu2.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await stu2.evaluate(`document.querySelector('.class-btn[data-job="mage"]').click()`);
  await sleep(400);
  await stu2.evaluate(`document.getElementById('create-character').click()`);
  await sleep(3000);

  const two = JSON.parse(await wall.evaluate(PANEL));
  console.log('\n=== a second character');
  ok(two.characters === 2, `both are listed (${two.characters})`);
  ok(two.count === '2', `header keeps up (${two.count})`);
  ok(two.names.includes('Party Tester Two'), `second name present: ${two.names.join(', ')}`);
  await wall.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/party-members.png');

  for (const e of [...errors(wall.logs),...errors(stu.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  wall.close(); stu.close(); stu2.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
