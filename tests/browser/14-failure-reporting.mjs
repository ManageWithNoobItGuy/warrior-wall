/** A stale passcode cookie must produce a visible, actionable failure. */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const toast = (p) => p.evaluate(`document.querySelector('.toast')?.textContent ?? ''`);

const stubFetch = (p, status, body) => p.evaluate(`
  window.__origFetch = window.__origFetch || window.fetch;
  window.fetch = (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (method === 'POST' && String(url).startsWith('/api/session')) {
      return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(body))},
        { status: ${status}, headers: { 'Content-Type': 'application/json' } }));
    }
    return window.__origFetch(url, opts);
  };
  true;`);

const chrome = await launch();
try {
  const p = await openPage(`${B}/wall`, { fresh: true });
  await sleep(2600);

  // ---- 1. a plain server error is reported and nothing else happens
  await stubFetch(p, 500, { error: 'database is unavailable' });
  await p.evaluate(`document.getElementById('new-session').click()`);
  await sleep(1400);
  const g = await toast(p);
  console.log('\n=== a server error');
  ok(/database is unavailable/.test(g), `reported verbatim: "${g}"`);
  ok(await p.evaluate(`location.pathname === '/wall'`), 'stays on the page');

  // ---- 2. the happy path still works
  await p.evaluate(`window.fetch = window.__origFetch; true;`);
  await p.evaluate(`document.getElementById('new-session').click()`);
  await sleep(2200);
  const okToast = await toast(p);
  console.log('\n=== the happy path');
  ok(/New session started/i.test(okToast), `confirms success: "${okToast}"`);
  // Naming is t23's job — NEW SESSION no longer reads window.prompt, so the
  // stub above cannot steer it. This file is about whether failures are seen.
  ok(await p.evaluate(`document.querySelectorAll('#roster .card').length === 0`),
     'and the wall really did start over');

  // ---- 3. a 401 reports AND navigates back to the door (last: it reloads)
  await stubFetch(p, 401, { error: 'passcode required' });
  await p.evaluate(`document.getElementById('new-session').click()`);
  await sleep(1200);
  const authToast = await toast(p);
  console.log('\n=== the passcode expired');
  ok(/passcode/i.test(authToast), `says what is wrong: "${authToast}"`);

  const before = p.navigations.length;
  await sleep(3000);
  const went = p.navigations.slice(before);
  ok(went.some((u) => u.endsWith('/wall')),
     `and reloaded /wall, where the passcode form is served (${went.join(', ') || 'no navigation'})`);

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
