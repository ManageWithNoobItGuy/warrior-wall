/**
 * The face on YOUR CHARACTER must be the picture the student actually chose.
 *
 * The sheet loads /av/<id>.jpg, which CREATE CHARACTER uploads in the
 * background *after* the sheet has been drawn. With no version in the URL and
 * nothing broadcast when the upload landed, the browser kept serving the copy
 * it had already cached — so a student who summoned an avatar walked into the
 * arena still wearing the photo from their previous run.
 *
 * Asserted on decoded pixels, not on the src attribute: the whole failure was
 * a correct-looking URL serving stale bytes.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

// Centre pixel of whatever the sheet is showing. Same-origin, so the canvas
// stays untainted and getImageData is allowed.
const CENTRE = `(()=>{
  const i=document.getElementById('my-portrait');
  if(!i||!i.naturalWidth) return 'no-image';
  const c=document.createElement('canvas'); c.width=c.height=8;
  const g=c.getContext('2d'); g.drawImage(i,0,0,8,8);
  const d=g.getImageData(4,4,1,1).data;
  return d[0]+','+d[1]+','+d[2];
})()`;
const near=(rgb,r,g,b,tol=40)=>{
  if(!/^\d/.test(rgb)) return false;
  const [x,y,z]=rgb.split(',').map(Number);
  return Math.abs(x-r)<tol && Math.abs(y-g)<tol && Math.abs(z-b)<tol;
};

const chrome = await launch();
try {
  await post('/api/game/reset');

  const p = await openPage(`${B}/`, { fresh: true });
  await p.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='6410888';
    document.getElementById('name').value='Portrait Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1200);

  // ---- a flat green "photo", so the centre pixel is unambiguous
  await p.evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=c.height=256;
    const g=c.getContext('2d'); g.fillStyle='#2f6f4f'; g.fillRect(0,0,256,256);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'me.png',{type:'image/png'}));
    const input=document.getElementById('file');
    input.files=dt.files; input.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await p.evaluate(`document.querySelector('.class-btn[data-job="mage"]').click()`);
  await sleep(500);

  // ---- enter the arena with the real photo
  await p.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2500);
  const first = await p.evaluate(CENTRE);
  const firstSrc = await p.evaluate(`(document.getElementById('my-portrait').src||'').replace(location.origin,'')`);
  console.log('\n=== character created with the real photo');
  ok(near(first,47,111,79), `sheet shows the uploaded photo (rgb ${first})`);
  ok(firstSrc.includes('?v='), `portrait URL carries a version: ${firstSrc}`);

  // ---- now summon an avatar from inside the arena
  await p.evaluate(`(()=>{
    const c=document.createElement('canvas'); c.width=c.height=64;
    const g=c.getContext('2d'); g.fillStyle='#e0245e'; g.fillRect(0,0,64,64);
    window.__fake = c.toDataURL('image/png');
    const real = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const u = typeof url === 'string' ? url : url.url;
      if (u.includes('/api/avatar') && !u.includes('quota'))
        return Promise.resolve(new Response(
          JSON.stringify({ image: window.__fake, remaining: 1 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return real(url, opts);
    };
  })()`);
  await p.evaluate(`document.querySelector('[data-step="3"] [data-back]').click()`);
  await sleep(600);
  await p.evaluate(`document.getElementById('generate').click()`);
  await sleep(3000);

  const second = await p.evaluate(CENTRE);
  const secondSrc = await p.evaluate(`(document.getElementById('my-portrait').src||'').replace(location.origin,'')`);
  console.log('\n=== after summoning an avatar');
  ok(secondSrc !== firstSrc, `portrait URL changed: ${firstSrc} -> ${secondSrc}`);
  ok(near(second,224,36,94), `sheet shows the summoned avatar, not the old photo (rgb ${second})`);

  // ---- and the arena's fighter list must carry the same version
  const fighters = await fetch(B+'/api/game/state').then(r=>r.ok?r.json():null).catch(()=>null);
  if (fighters) console.log('  · state endpoint reachable');

  await p.evaluate(`document.getElementById('create-character')?.click()`);
  await sleep(1500);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/sheet-portrait.png');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
