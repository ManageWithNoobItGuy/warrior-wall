import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();

async function build(page, id, job) {
  await page.evaluate(`
    document.getElementById('student-id').value='${id}';
    document.getElementById('name').value='Testcase Longname';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);
  await page.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);
  await page.evaluate(`document.querySelector('.class-btn[data-job="${job}"]').click()`);
  await sleep(400);
  await page.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2200);
}

/** Do the portrait and the chart overlap, and does the chart clear its box? */
async function geometry(page) {
  return JSON.parse(await page.evaluate(`(async()=>{
    const img=document.getElementById('my-portrait');
    if(!img.complete) await new Promise(r=>{img.onload=r;img.onerror=r;});
    const p=img.getBoundingClientRect();
    const svg=document.querySelector('#my-stats .radar');
    const s=svg.getBoundingClientRect();
    const labels=[...document.querySelectorAll('#my-stats .radar-label, #my-stats .radar-value')]
      .map(t=>{const r=t.getBoundingClientRect();return {t:t.textContent.trim(),l:r.left,r:r.right,tp:r.top,b:r.bottom};});
    return JSON.stringify({
      portrait:{w:Math.round(p.width),h:Math.round(p.height),l:Math.round(p.left),r:Math.round(p.right)},
      svg:{w:Math.round(s.width),l:Math.round(s.left),r:Math.round(s.right)},
      leftmostLabel: Math.round(Math.min(...labels.map(x=>x.l))),
      rightmostLabel: Math.round(Math.max(...labels.map(x=>x.r))),
      overlaps: labels.filter(x=>x.l < p.right && x.r > p.left && x.tp < p.bottom && x.b > p.top).map(x=>x.t),
    });
  })()`));
}

try {
  await post('/api/game/reset');

  // ---- desktop
  const d = await openPage(`${B}/`, { fresh: true });
  await d.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:2,mobile:false});
  await sleep(2400);
  await build(d,'7001','warrior');
  const D = await geometry(d);
  console.log('\n=== desktop 1280px');
  ok(D.portrait.w >= 150, `portrait ${D.portrait.w}×${D.portrait.h}px (was 92)`);
  ok(D.overlaps.length === 0, `no label overlaps the portrait${D.overlaps.length?': '+D.overlaps.join(','):''}`);
  ok(D.leftmostLabel >= D.svg.l - 2, `labels stay inside the chart box (left edge ${D.leftmostLabel} vs box ${D.svg.l})`);
  ok(D.rightmostLabel <= D.svg.r + 2, `and inside on the right (${D.rightmostLabel} vs ${D.svg.r})`);
  ok(D.svg.l > D.portrait.r, `chart sits clear to the right of the portrait (${D.portrait.r} → ${D.svg.l})`);
  await d.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/sheet-desktop.png');

  // ---- phone
  const m = await openPage(`${B}/`, { fresh: true });
  await m.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await build(m,'7002','mage');
  const M = await geometry(m);
  console.log('\n=== phone 414px');
  ok(M.portrait.w >= 90, `portrait ${M.portrait.w}px`);
  ok(M.overlaps.length === 0, `no label overlaps the portrait${M.overlaps.length?': '+M.overlaps.join(','):''}`);
  ok(M.rightmostLabel <= 414, `nothing spills off the screen (right edge ${M.rightmostLabel} of 414)`);
  ok(M.leftmostLabel >= 0, `nor off the left (${M.leftmostLabel})`);
  await m.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/sheet-phone.png');

  // ---- narrow phone: the two should stack
  const n = await openPage(`${B}/`, { fresh: true });
  await n.send('Emulation.setDeviceMetricsOverride',{width:360,height:780,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await build(n,'7003','thief');
  const N = await geometry(n);
  console.log('\n=== narrow phone 360px');
  ok(N.svg.l < N.portrait.r, 'stacked instead of side by side');
  ok(N.rightmostLabel <= 360 && N.leftmostLabel >= 0, `chart fits (${N.leftmostLabel}–${N.rightmostLabel} of 360)`);

  for (const e of [...errors(d.logs),...errors(m.logs),...errors(n.logs)].filter(x=>!x.text.includes('404')))
    console.log('  ! console:', e.text.split('\n')[0]);
  d.close(); m.close(); n.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
