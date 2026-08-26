/** The dialog must sit in the middle of the screen at any size. */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const geometry = (p) => p.evaluate(`(() => {
  const d = document.querySelector('dialog.app-dialog[open]');
  const r = d.getBoundingClientRect();
  const cs = getComputedStyle(d);
  return JSON.stringify({
    left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    w: Math.round(r.width), h: Math.round(r.height),
    // clientWidth, not innerWidth: a fixed element centres inside the content
    // area, while innerWidth also counts the scrollbar. Comparing against the
    // wrong one makes a correctly centred dialog look 7px off.
    vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight,
    hasBorder: cs.borderTopWidth !== '0px',
    titleTop: Math.round(d.querySelector('.window-title').getBoundingClientRect().top),
  });
})()`).then(JSON.parse);

const chrome = await launch();
try {
  for (const [w,h,label] of [[1440,900,'desktop 1440×900'],[1024,700,'laptop 1024×700'],[390,844,'phone 390×844']]) {
    const p = await openPage(`${B}/wall`, { fresh: true, autoDialog: false });
    await p.send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:2,mobile:w<500});
    await sleep(2600);
    await p.evaluate(`document.getElementById('new-session').click()`);
    await sleep(700);
    const g = await geometry(p);
    const cx = (g.left + g.right) / 2, cy = (g.top + g.bottom) / 2;
    console.log(`\n=== ${label}`);
    console.log(`    box ${g.w}×${g.h} at (${g.left},${g.top})  centre (${Math.round(cx)},${Math.round(cy)})  viewport centre (${g.vw/2},${g.vh/2})`);
    ok(Math.abs(cx - g.vw/2) <= 2, `horizontally centred (off by ${Math.abs(Math.round(cx - g.vw/2))}px)`);
    ok(Math.abs(cy - g.vh/2) <= 2, `vertically centred (off by ${Math.abs(Math.round(cy - g.vh/2))}px)`);
    ok(g.left >= 0 && g.right <= g.vw, 'fits the viewport horizontally');
    ok(g.titleTop >= 0, `the title tab is not clipped off the top (${g.titleTop}px)`);
    ok(g.hasBorder, 'keeps the JRPG frame');
    if (w === 1440) await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/dialog-centred.png');
    for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
    p.close();
  }
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
