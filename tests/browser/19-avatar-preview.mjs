/**
 * The class preview must show the portrait the student actually has.
 *
 * `#preview-art` was written in exactly one place — inside markClass() — so it
 * only ever changed when the *class* changed. Summoning an avatar, and both
 * PICTURE ON YOUR CARD buttons, left a freshly painted portrait sitting behind
 * the stock class artwork.
 *
 * The avatar endpoint is stubbed: a real summon costs money, takes 15-25s, and
 * none of what broke here lives on the server side of that call.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');

  const p = await openPage(`${B}/`, { fresh: true });
  await p.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='6410777';
    document.getElementById('name').value='Preview Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1200);

  // ---- a real photo, through the file input the students actually use
  await p.evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=c.height=256;
    const g=c.getContext('2d');
    g.fillStyle='#2f6f4f'; g.fillRect(0,0,256,256);
    g.fillStyle='#f0d9a0'; g.beginPath(); g.arc(128,110,52,0,7); g.fill();
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'me.png',{type:'image/png'}));
    const input=document.getElementById('file');
    input.files=dt.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  const shot = await p.evaluate(`JSON.stringify({
    shown: !document.getElementById('shot').hidden,
    retake: !document.getElementById('camera-retake').hidden })`);
  const P = JSON.parse(shot);
  console.log('\n=== portrait');
  ok(P.shown && P.retake, 'photo accepted from the file input');

  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await p.evaluate(`document.querySelector('.class-btn[data-job="mage"]').click()`);
  await sleep(600);

  // The panel must genuinely be on screen. A hidden panel would let every
  // assertion below pass without the feature working at all.
  const panel = await p.evaluate(`JSON.stringify({
    summonShown: !document.getElementById('summon').hidden,
    btn: !document.getElementById('generate').disabled,
    art: (document.getElementById('preview-art').src||'').split('/').pop() })`);
  const N = JSON.parse(panel);
  console.log('\n=== before summoning');
  ok(N.summonShown, 'AI AVATAR panel is on screen (needs GEMINI_API_KEY in .dev.vars)');
  ok(N.btn, 'SUMMON AVATAR is enabled once photo + class are set');
  ok(N.art === 'mage.webp', `preview shows stock artwork: ${N.art}`);

  // ---- stub the generator with a flat magenta square: unmistakable, and
  //      nothing else in the app could produce it.
  await p.evaluate(`(()=>{
    const c=document.createElement('canvas'); c.width=c.height=64;
    const g=c.getContext('2d'); g.fillStyle='#e0245e'; g.fillRect(0,0,64,64);
    window.__fake = c.toDataURL('image/png');
    const real = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const u = typeof url === 'string' ? url : url.url;
      if (u.includes('/api/avatar') && !u.includes('quota'))
        return Promise.resolve(new Response(
          JSON.stringify({ image: window.__fake, remaining: 2 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return real(url, opts);
    };
  })()`);

  await p.evaluate(`document.getElementById('generate').click()`);
  await sleep(1500);
  const after = await p.evaluate(`JSON.stringify({
    isFake: document.getElementById('preview-art').src === window.__fake,
    art: (document.getElementById('preview-art').src||'').slice(0,30),
    toggle: !document.getElementById('source-toggle').hidden,
    w: document.getElementById('preview-art').naturalWidth })`);
  const A = JSON.parse(after);
  console.log('\n=== after summoning');
  ok(A.toggle, 'REAL PHOTO / AI AVATAR toggle appeared');
  ok(A.isFake, `preview swapped to the summoned avatar (${A.art}…)`);
  ok(A.w > 0, `preview image actually decoded (${A.w}px)`);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/avatar-preview.png');

  // ---- the two PICTURE ON YOUR CARD buttons move the preview with them
  await p.evaluate(`document.getElementById('use-photo').click()`);
  await sleep(400);
  const real = await p.evaluate(`(document.getElementById('preview-art').src||'').split('/').pop()`);
  ok(real === 'mage.webp', `REAL PHOTO returns the preview to stock art: ${real}`);

  await p.evaluate(`document.getElementById('use-avatar').click()`);
  await sleep(400);
  const back = await p.evaluate(`document.getElementById('preview-art').src === window.__fake`);
  ok(back, 'AI AVATAR puts the summoned portrait back');

  // ---- retaking the photo throws the avatar away; the preview must follow
  await p.evaluate(`document.querySelector('[data-step="2"] [data-back]').click()`);
  await sleep(500);
  await p.evaluate(`document.getElementById('camera-retake').click()`);
  await sleep(500);
  const cleared = await p.evaluate(`(document.getElementById('preview-art').src||'').split('/').pop()`);
  console.log('\n=== after retaking the photo');
  ok(cleared === 'mage.webp', `stale avatar dropped from the preview: ${cleared}`);

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
