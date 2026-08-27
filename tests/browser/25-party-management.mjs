/**
 * Renaming and removing party members, and a student giving up their own.
 *
 * Removing takes everything: character, stats, arena portrait and any card
 * already sent. A student may only do it to themselves, and only before the
 * bracket exists — a fighter vanishing from a tournament already being
 * replayed would leave the projector showing a ghost.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const roster=()=>fetch(B+'/api/game/roster').then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const TILES = `JSON.stringify({
  ids: [...document.querySelectorAll('#roster .card')].map(c=>c.dataset.student),
  names: [...document.querySelectorAll('#roster .card-name')].map(n=>n.childNodes[0].textContent.trim()),
  count: document.getElementById('count').textContent.trim() })`;

async function makeCharacter(page, id, name, job) {
  await page.evaluate(`
    document.getElementById('student-id').value='${id}';
    document.getElementById('name').value='${name}';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1400);
  // A real photo, so removing them has an arena portrait to delete.
  await page.evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=c.height=512;
    const g=c.getContext('2d'); g.fillStyle='#557799'; g.fillRect(0,0,512,512);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'me.png',{type:'image/png'}));
    const i=document.getElementById('file'); i.files=dt.files;
    i.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  await page.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await page.evaluate(`document.querySelector('.class-btn[data-job="${job}"]').click()`);
  await sleep(400);
  await page.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2500);
}

const chrome = await launch();
try {
  await post('/api/game/reset');
  await post('/api/session/clear');

  const a = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await makeCharacter(a, '7501', 'Anucha Wong', 'warrior');
  const b = await openPage(`${B}/`, { fresh: true });
  await sleep(2400);
  await makeCharacter(b, '7502', 'Bua Chan', 'mage');

  // autoDialog off: the helper's auto-accept clicks [data-ok] every 120ms,
  // which would close the RENAME dialog before anything could be typed into it.
  const wall = await openPage(`${B}/wall`, { fresh: true, autoDialog: false });
  await sleep(2500);
  const start = JSON.parse(await wall.evaluate(TILES));
  console.log('\n=== two members');
  ok(start.ids.length === 2, `both listed (${start.ids.join(', ')})`);

  // ---- rename
  await wall.evaluate(`document.querySelector('#roster .card[data-student="7501"] [data-action="rename"]').click()`);
  await sleep(600);
  await wall.evaluate(`
    document.getElementById('dlg-input').value = 'Anucha RENAMED';
    document.querySelector('dialog.app-dialog[open] [data-ok]').click();`);
  await sleep(1500);
  const renamed = JSON.parse(await wall.evaluate(TILES));
  const inRoom = (await roster()).players.find(p=>String(p.studentId)==='7501');
  console.log('\n=== after renaming');
  ok(renamed.names.includes('Anucha RENAMED'), `the tile shows the new name (${renamed.names.join(', ')})`);
  ok(inRoom?.name === 'Anucha RENAMED', `and the room agrees (${inRoom?.name})`);

  // the student's own sheet picks it up on its next refresh
  await a.evaluate(`document.querySelector('.class-btn[data-job="warrior"]')`);
  await sleep(500);

  // ---- remove, from the wall
  const portraitBefore = await fetch(B+'/av/7502.jpg').then(r=>r.status);
  await wall.evaluate(`document.querySelector('#roster .card[data-student="7502"] [data-action="remove"]').click()`);
  await sleep(600);
  await wall.evaluate(`document.querySelector('dialog.app-dialog[open] [data-ok]').click()`);
  await sleep(2000);
  const afterRemove = JSON.parse(await wall.evaluate(TILES));
  const roomAfter = await roster();
  const portraitAfter = await fetch(B+'/av/7502.jpg').then(r=>r.status);
  console.log('\n=== after removing a member');
  ok(!afterRemove.ids.includes('7502'), `the tile is gone (${afterRemove.ids.join(', ')})`);
  ok(afterRemove.count === '1', `the header counts one (${afterRemove.count})`);
  ok(!roomAfter.players.some(p=>String(p.studentId)==='7502'), `the room dropped them (${roomAfter.count} left)`);
  ok(portraitBefore === 200 && portraitAfter === 404,
     `their portrait was deleted too (${portraitBefore} -> ${portraitAfter})`);

  // ---- a student gives up their own character
  const canLeave = await a.evaluate(`!document.getElementById('leave-character').hidden`);
  console.log("\n=== the student's own button");
  ok(canLeave, 'DELETE MY CHARACTER is offered before the battle');

  // This page keeps the helper's auto-accept — it needs it for the no-photo
  // confirm during setup — so the DELETE confirm is answered for us.
  await a.evaluate(`document.getElementById('leave-character').click()`);
  await sleep(3500);
  const roomEmpty = await roster();
  ok(roomEmpty.count === 0, `the room is empty again (${roomEmpty.count})`);
  const backToStart = await a.evaluate(`[...document.querySelectorAll('.step')].findIndex(s=>!s.hidden)`);
  ok(backToStart === 0, `and that phone is back at the first screen (step ${backToStart})`);

  // ---- a student cannot remove somebody else
  await post('/api/game/join',{studentId:'7601',name:'Victim',job:'thief',token:'real-token'});
  const stolen = await post('/api/game/leave',{studentId:'7601',token:'wrong-token'});
  console.log("\n=== somebody else's character");
  ok(stolen.code === 'BAD_TOKEN', `refused without the right token (${stolen.code ?? 'allowed!'})`);
  ok((await roster()).count === 1, 'and they are still in the room');

  // ---- and not once the bracket exists
  await post('/api/game/join',{studentId:'7602',name:'Sparring',job:'knight',token:'t2'});
  await post('/api/game/battle/start');
  await sleep(800);
  const late = await post('/api/game/leave',{studentId:'7601',token:'real-token'});
  console.log('\n=== once the battle has started');
  ok(late.code === 'LOCKED', `their own request is refused too (${late.code ?? 'allowed!'})`);
  ok((await roster()).count === 2, 'the bracket keeps its fighters');

  for (const e of [...errors(wall.logs),...errors(a.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  wall.close(); a.close(); b.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
