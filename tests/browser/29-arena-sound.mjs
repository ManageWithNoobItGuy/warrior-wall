/**
 * The arena makes a noise, and not too much of one.
 *
 * Counting oscillators rather than listening: every blip builds one, so the
 * count is exactly "how many sounds were asked for" — which is the thing worth
 * asserting and the only thing headless Chrome can tell us.
 *
 * The case that matters is the second projector. Sound is driven by
 * transitions between frames, so a screen connecting halfway through a battle
 * would fire every blow it had missed in one burst unless the first frame is
 * treated as a baseline.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

// Frequencies identify the sound: sfx.wave() opens at 110Hz and sfx.duel() at
// 440Hz, neither of which any other arena sound uses. That is what makes it
// possible to assert *which* sounds a screen played, not merely how many.
const WAVE_HZ = 110;
const DUEL_HZ = 440;
const SPY = `(() => {
  window.__sounds = 0;
  window.__freqs = [];
  const Real = window.AudioContext || window.webkitAudioContext;
  if (!Real) return;
  class Spy extends Real {
    createOscillator() {
      const osc = super.createOscillator();
      const set = osc.frequency.setValueAtTime.bind(osc.frequency);
      osc.frequency.setValueAtTime = (v, t) => {
        window.__sounds++;
        window.__freqs.push(Math.round(v));
        return set(v, t);
      };
      return osc;
    }
  }
  window.AudioContext = Spy;
  window.webkitAudioContext = Spy;
})();`;

async function spyProjector(chromeless, opts = {}) {
  const p = await openPage(`${B}/projector`, { fresh: true, ...opts });
  await p.send('Page.addScriptToEvaluateOnNewDocument', { source: SPY });
  await p.send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  return p;
}
const count = (p) => p.evaluate(`window.__sounds ?? -1`);
const freqs = (p) => p.evaluate(`JSON.stringify(window.__freqs ?? [])`).then(JSON.parse);

const chrome = await launch();
try {
  await post('/api/game/reset');
  for (const [id, job] of [['8301','warrior'],['8302','mage'],['8303','thief'],['8304','knight']]) {
    await post('/api/game/join',{studentId:id,name:`Fighter ${id}`,job,token:`t${id}`});
  }

  const proj = await spyProjector();
  ok((await count(proj)) >= 0, 'the audio spy is installed');

  const before = await count(proj);
  await post('/api/game/battle/start');

  // The first wave walks on at 1.6s and trades blows until about 6.4s.
  // Sampling outside that window measures the quiet between rounds and would
  // pass with the sound switched off entirely.
  await sleep(2200);
  const a = await count(proj);
  await sleep(3600);
  const b = await count(proj);
  const perSecond = (b - a) / 3.6;
  console.log('\n=== through the first clash');
  ok(b > a, `the arena is making sounds (${a} -> ${b})`);
  ok(perSecond >= 1, `and enough of them to hear (${perSecond.toFixed(1)}/s)`);
  ok(perSecond <= 12, `but no more than a dozen a second (${perSecond.toFixed(1)}/s)`);
  ok(b > before, `sounding throughout (${before} -> ${b})`);

  // ---- a screen that reconnects mid-round
  //
  // Reloading the projector is the real reconnect: a fresh Arena over a battle
  // already in progress. Done in the same tab on purpose — a second tab is
  // backgrounded, and Chrome throttles requestAnimationFrame there, so the
  // arena it was supposed to be watching quietly stops animating.
  //
  // ~5.8s in: inside the first wave's clash, and clear of the second wave at
  // 8.1s. Landing on a wave boundary would hear a legitimate gong and prove
  // nothing.
  await proj.send('Page.reload', { ignoreCache: false });
  await sleep(1600);
  const heard = await freqs(proj);
  console.log('\n=== after reconnecting mid-round');
  ok(heard.length > 0, `the reconnected screen is alive (heard ${heard.length} sounds)`);
  ok(!heard.includes(WAVE_HZ) && !heard.includes(DUEL_HZ),
     `and announced no round that had already begun (${heard.join(', ')})`);

  // ---- and mute really does silence it
  const muted = await spyProjector();
  await muted.evaluate(`localStorage.setItem('warrior-wall:muted','1')`);
  await muted.send('Page.reload', { ignoreCache: false });
  await sleep(2500);
  const mA = await count(muted);
  await sleep(3000);
  const mB = await count(muted);
  console.log('\n=== with sound turned off');
  ok(mB === mA, `nothing is played at all (${mB - mA} sounds)`);
  await muted.evaluate(`localStorage.removeItem('warrior-wall:muted')`);

  for (const e of errors(proj.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  proj.close(); muted.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
