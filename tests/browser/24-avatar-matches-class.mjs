/**
 * The portrait must wear the costume of the class on the label.
 *
 * A student may change class right up until the first question opens, and the
 * painting did not change with them. Summon as a HEALER, switch to THIEF, and
 * the thief walked into the arena in white cleric robes — visible on the wall,
 * where the tile said THIEF over a picture of a priest.
 *
 * The avatar now belongs to the class it was painted as. For any other class
 * the real photo stands in until they summon again; switching back restores it.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

// The stub paints a flat colour per class, so "which costume is this" becomes
// a pixel read rather than a judgement about robes.
const PAINT = { healer: [224,36,94], thief: [40,200,120] };
const near=(rgb,[r,g,b],tol=40)=>{
  if(!/^\d/.test(rgb)) return false;
  const [x,y,z]=rgb.split(',').map(Number);
  return Math.abs(x-r)<tol && Math.abs(y-g)<tol && Math.abs(z-b)<tol;
};
const CENTRE = (id) => `(()=>{
  const i=document.getElementById('${id}');
  if(!i||!i.naturalWidth) return 'no-image';
  const c=document.createElement('canvas'); c.width=c.height=8;
  const g=c.getContext('2d'); g.drawImage(i,0,0,8,8);
  const d=g.getImageData(4,4,1,1).data;
  return d[0]+','+d[1]+','+d[2];
})()`;

const chrome = await launch();
try {
  await post('/api/game/reset');

  const p = await openPage(`${B}/`, { fresh: true });
  await p.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='7301';
    document.getElementById('name').value='Costume Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);

  // A blue "photo" — neither class colour, so it is unmistakable when it stands in.
  await p.evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=c.height=512;
    const g=c.getContext('2d'); g.fillStyle='#2244cc'; g.fillRect(0,0,512,512);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'me.png',{type:'image/png'}));
    const i=document.getElementById('file'); i.files=dt.files;
    i.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);

  // The generator returns a flat colour keyed to the class it was asked for.
  await p.evaluate(`(()=>{
    const paint = ${JSON.stringify(PAINT)};
    const real = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const u = typeof url === 'string' ? url : url.url;
      if (u.includes('/api/avatar') && !u.includes('quota')) {
        const job = JSON.parse(opts.body).job;
        const [r,g,b] = paint[job] || [0,0,0];
        const c=document.createElement('canvas'); c.width=c.height=64;
        const x=c.getContext('2d');
        x.fillStyle='rgb('+r+','+g+','+b+')'; x.fillRect(0,0,64,64);
        return Promise.resolve(new Response(
          JSON.stringify({ image: c.toDataURL('image/png'), remaining: 2 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return real(url, opts);
    };
  })()`);

  // ---- summon as a HEALER
  await p.evaluate(`document.querySelector('.class-btn[data-job="healer"]').click()`);
  await sleep(500);
  await p.evaluate(`document.getElementById('generate').click()`);
  await sleep(1800);
  const healer = await p.evaluate(CENTRE('preview-art'));
  console.log('\n=== summoned as a HEALER');
  ok(near(healer, PAINT.healer), `the preview wears healer colours (${healer})`);

  // ---- now switch to THIEF without summoning again
  await p.evaluate(`document.querySelector('.class-btn[data-job="thief"]').click()`);
  await sleep(700);
  const swapped = JSON.parse(await p.evaluate(`JSON.stringify({
    art: (() => { const s=document.getElementById('preview-art').src||'';
                  return s.startsWith('data:') ? 'painted' : s.split('/').pop(); })(),
    avatarBtn: document.getElementById('use-avatar').disabled,
    note: document.getElementById('summon-note').textContent })`));
  console.log('\n=== switched to THIEF, still holding the healer painting');
  ok(swapped.art === 'thief.webp', `the preview drops the healer painting (${swapped.art})`);
  ok(swapped.avatarBtn, 'AI AVATAR is not offered for a class it was not painted for');
  ok(/HEALER/.test(swapped.note), `and the reason is on screen: "${swapped.note}"`);

  // ---- what actually reaches the room must be the photo, not the healer
  await p.evaluate(`document.getElementById('create-character').click()`);
  await sleep(3000);
  const arena = await p.evaluate(CENTRE('my-portrait'));
  console.log('\n=== the character that reached the arena');
  ok(!near(arena, PAINT.healer), `the thief is NOT wearing healer colours (${arena})`);
  ok(near(arena, [34,68,204]), `it is their real photo instead (${arena})`);

  const job = await fetch(B+'/api/game/roster').then(r=>r.json())
    .then(d=>d.players.find(x=>String(x.studentId)==='7301')?.job);
  ok(job === 'thief', `and the room has them as a thief (${job})`);

  // ---- switching back makes the painting theirs again
  await p.evaluate(`document.querySelector('[data-step="3"] [data-back]').click()`);
  await sleep(600);
  await p.evaluate(`document.querySelector('.class-btn[data-job="healer"]').click()`);
  await sleep(700);
  const back = await p.evaluate(CENTRE('preview-art'));
  const btn = await p.evaluate(`document.getElementById('use-avatar').disabled`);
  console.log('\n=== back to HEALER');
  ok(near(back, PAINT.healer), `the painting is theirs again, no summon spent (${back})`);
  ok(!btn, 'AI AVATAR is offered once more');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
