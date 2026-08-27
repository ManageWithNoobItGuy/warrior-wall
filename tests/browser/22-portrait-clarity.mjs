/**
 * A student's own face, shown clearly.
 *
 * Two things were dulling it, both on the display side — the generator prompt
 * has not changed since the first version of this app:
 *
 *   - The CRT scanline overlay sits at z-index 9000 over the whole page. A
 *     list of selectors paints artwork above it, and `.sheet-portrait img` was
 *     missing from that list, so dark stripes ran across every face in the
 *     arena and on the class preview.
 *   - The portrait was uploaded at 256px but is drawn at up to 172 CSS px —
 *     344-516 real pixels on a phone — so it was upscaled everywhere.
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
    document.getElementById('name').value='Clarity Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);

  // A flat mid-grey face: any dark banding across it is the scanline overlay
  // and nothing else.
  await p.evaluate(`(async()=>{
    const c=document.createElement('canvas'); c.width=c.height=1024;
    const g=c.getContext('2d'); g.fillStyle='#9a9a9a'; g.fillRect(0,0,1024,1024);
    const blob=await new Promise(r=>c.toBlob(r,'image/png'));
    const dt=new DataTransfer();
    dt.items.add(new File([blob],'me.png',{type:'image/png'}));
    const i=document.getElementById('file'); i.files=dt.files;
    i.dispatchEvent(new Event('change'));
  })()`);
  await sleep(900);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await p.evaluate(`document.querySelector('.class-btn[data-job="mage"]').click()`);
  await sleep(500);
  await p.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2500);

  // ---- the portrait must paint above the scanline overlay
  const stack = JSON.parse(await p.evaluate(`(()=>{
    const img=document.getElementById('my-portrait');
    const z=getComputedStyle(img).zIndex;
    const r=img.getBoundingClientRect();
    // What is actually on top at the centre of the face?
    const hit=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
    return JSON.stringify({ z, top: hit?.id || hit?.className || hit?.tagName,
                            w: Math.round(r.width) });
  })()`));
  console.log('\n=== the scanline overlay');
  ok(Number(stack.z) > 9000, `the portrait paints above the overlay (z-index ${stack.z})`);
  // Not an assertion: elementFromPoint cannot see a ::after pseudo-element, so
  // this reads "my-portrait" whether or not the stripes are painted over it.
  console.log(`  · topmost hit-test element: ${stack.top}`);

  // ---- and prove it against the COMPOSITED page.
  // Reading the <img> with drawImage would only decode the JPEG again and would
  // pass whether or not the overlay is painted over it; elementFromPoint cannot
  // see a ::after pseudo-element either. A screenshot is the only thing here
  // that actually contains the stripes.
  const rect = JSON.parse(await p.evaluate(`(()=>{
    const r=document.getElementById('my-portrait').getBoundingClientRect();
    return JSON.stringify({x:r.left+10, y:r.top+10, width:30, height:30});
  })()`));
  const shot = await p.send('Page.captureScreenshot', {
    format: 'png', clip: { ...rect, scale: 1 },
  });
  const bands = JSON.parse(await p.evaluate(`(async()=>{
    const img=new Image();
    img.src='data:image/png;base64,${shot.result.data}';
    await new Promise(r=>{img.onload=r;img.onerror=r;});
    const c=document.createElement('canvas');
    c.width=img.naturalWidth; c.height=img.naturalHeight;
    const g=c.getContext('2d'); g.drawImage(img,0,0);
    const d=g.getImageData(2,0,1,img.naturalHeight).data;
    const col=[]; for(let i=0;i<img.naturalHeight;i++) col.push(d[i*4]);
    return JSON.stringify({ min:Math.min(...col), max:Math.max(...col), rows:col.length });
  })()`));
  const spread = bands.max - bands.min;
  ok(spread < 20, `a flat grey face composites flat — no CRT stripes (spread ${spread} over ${bands.rows} rows)`);

  // ---- the stored portrait must out-resolve the frame it is drawn in
  const stored = await p.evaluate(`(async()=>{
    const i=new Image();
    i.src='/av/6410777.jpg?probe=' + Date.now();
    await new Promise(r=>{i.onload=r;i.onerror=r;});
    return i.naturalWidth;
  })()`);
  // .sheet-portrait is clamp(112px, 30vw, 172px); the widest it ever gets is
  // 172 CSS px, which is 344 real pixels on the 2x screens students carry.
  const widestDevicePx = 172 * 2;
  console.log('\n=== resolution');
  ok(stored >= 512, `portrait stored at ${stored}px`);
  ok(stored >= widestDevicePx,
     `source out-resolves the widest frame (${stored}px stored vs ${widestDevicePx}px drawn)`);
  console.log(`  · drawn at ${stack.w} CSS px on this viewport`);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/portrait-clarity.png');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
