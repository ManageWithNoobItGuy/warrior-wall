import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const chrome = await launch();
try {
  await post('/api/game/reset');
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'Which binding holds the room state?',choices:['D1','Durable Object','R2','KV'],correctIdx:1,timeLimitSec:60}]})});

  const p = await openPage(`${B}/`, { fresh: true });
  await p.send('Emulation.setDeviceMetricsOverride',{width:414,height:896,deviceScaleFactor:2,mobile:true});
  await sleep(2400);
  await p.evaluate(`
    document.getElementById('student-id').value='6600000003';
    document.getElementById('name').value='Radar Tester';
    document.querySelector('[data-step="0"] [data-next]').click();`);
  await sleep(1300);
  await p.evaluate(`document.querySelector('[data-step="1"] [data-next]').click()`);
  await sleep(700);

  // class picker with artwork
  const grid = await p.evaluate(`(async()=>{
    const imgs=[...document.querySelectorAll('.class-btn .class-art')];
    await Promise.all(imgs.map(i=>i.complete?0:new Promise(r=>{i.onload=r;i.onerror=r;})));
    return JSON.stringify({
      count: imgs.length,
      loaded: imgs.filter(i=>i.naturalWidth>0).length,
      sizes: imgs.map(i=>i.naturalWidth) });
  })()`);
  const G = JSON.parse(grid);
  console.log('\n=== class picker artwork');
  ok(G.count === 5, `${G.count} classes shown`);
  ok(G.loaded === 5, `all ${G.loaded} portraits loaded (${G.sizes.join('/')}px)`);

  await p.evaluate(`document.querySelector('.class-btn[data-job="knight"]').click()`);
  await sleep(700);
  const prev = await p.evaluate(`JSON.stringify({
    artSrc: (document.getElementById('preview-art').src||'').split('/').pop(),
    artW: document.getElementById('preview-art').naturalWidth,
    radar: !!document.querySelector('#preview-stats .radar'),
    axes: document.querySelectorAll('#preview-stats .radar-label').length,
    values: [...document.querySelectorAll('#preview-stats .radar-value')].map(t=>t.textContent) })`);
  const P = JSON.parse(prev);
  console.log('\n=== class preview');
  ok(P.artSrc === 'knight.webp' && P.artW === 320, `artwork: ${P.artSrc} (${P.artW}px)`);
  ok(P.radar && P.axes === 5, `radar drawn with ${P.axes} axes`);
  ok(P.values.join(' ') === '120 8 16 8 5', `knight's numbers: ${P.values.join(' / ')}`);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/picker.png');

  await p.evaluate(`document.getElementById('create-character').click()`);
  await sleep(2200);
  const sheet = await p.evaluate(`(async()=>{
    const img=document.getElementById('my-portrait');
    if(!img.complete) await new Promise(r=>{img.onload=r;img.onerror=r;});
    return JSON.stringify({
      portraitShown: !img.hidden,
      portraitSrc: (img.src||'').split('/').pop(),
      portraitW: img.naturalWidth,
      radar: !!document.querySelector('#my-stats .radar'),
      values: [...document.querySelectorAll('#my-stats .radar-value')].map(t=>t.textContent) });
  })()`);
  const S = JSON.parse(sheet);
  console.log('\n=== character sheet');
  ok(S.radar, 'stats shown as a radar');
  ok(S.portraitShown && S.portraitW > 0, `portrait shown: ${S.portraitSrc} (${S.portraitW}px)`);
  ok(S.values.length === 5, `five values on the chart: ${S.values.join(' / ')}`);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/sheet-radar.png');

  // ---- the shape grows when a stat is earned
  await post('/api/game/open',{index:0});
  await sleep(1000);
  await p.evaluate(`document.querySelector('#choices .choice[data-choice="1"]').click()`);
  await sleep(800);
  await post('/api/game/close');
  await sleep(1600);
  const after = await p.evaluate(`JSON.stringify({
    values: [...document.querySelectorAll('#my-stats .radar-value')].map(t=>t.textContent.trim()),
    view: [...document.querySelectorAll('.arena-view')].find(v=>!v.hidden)?.dataset.view })`);
  const A = JSON.parse(after);
  console.log('\n=== after answering correctly');
  ok(A.values.join(' ') !== S.values.join(' '), `chart updated: ${S.values.join('/')} -> ${A.values.join('/')}`);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/sheet-after.png');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
