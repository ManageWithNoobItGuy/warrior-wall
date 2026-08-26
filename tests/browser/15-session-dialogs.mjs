/** The in-page NEW SESSION dialog — the one that replaced prompt()+confirm(). */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};
const dlg = (p) => p.evaluate(`(() => {
  const d = document.querySelector('dialog.app-dialog[open]');
  if (!d) return JSON.stringify({ open: false });
  return JSON.stringify({
    open: true,
    title: d.querySelector('.window-title')?.textContent ?? '',
    message: d.querySelector('.speech')?.textContent.trim().replace(/\\s+/g,' ') ?? '',
    hasInput: !!d.querySelector('input'),
    inputValue: d.querySelector('input')?.value ?? null,
    ok: d.querySelector('[data-ok]')?.textContent ?? '',
    cancel: d.querySelector('[data-cancel]')?.textContent ?? '' });
})()`).then(JSON.parse);

const chrome = await launch();
try {
  // no auto-accept: this test drives the dialog by hand
  const p = await openPage(`${B}/wall`, { fresh: true, autoDialog: false });
  await sleep(2800);
  const startTitle = await p.evaluate(`document.getElementById('title').value`);

  console.log('\n=== NEW SESSION opens an in-page dialog');
  await p.evaluate(`document.getElementById('new-session').click()`);
  await sleep(600);
  const d1 = await dlg(p);
  ok(d1.open, 'a dialog appeared — no native prompt involved');
  ok(d1.title === 'NEW SESSION', `titled "${d1.title}"`);
  ok(d1.hasInput && d1.inputValue === startTitle, `pre-filled with the current name ("${d1.inputValue}")`);
  ok(/Nothing is deleted/i.test(d1.message), 'and says plainly that nothing is deleted');

  console.log('\n=== cancelling changes nothing');
  await p.evaluate(`document.querySelector('dialog.app-dialog [data-cancel]').click()`);
  await sleep(800);
  ok(!(await dlg(p)).open, 'the dialog closed');
  ok((await p.evaluate(`document.getElementById('title').value`)) === startTitle,
     'the class name is untouched');
  ok((await p.evaluate(`document.querySelector('.toast')?.classList.contains('show') ?? false`)) === false,
     'and nothing was reported');

  console.log('\n=== confirming starts the session');
  await p.evaluate(`document.getElementById('new-session').click()`);
  await sleep(600);
  await p.evaluate(`(() => {
    const d = document.querySelector('dialog.app-dialog[open]');
    d.querySelector('input').value = 'WEEK 2 · BATTLE DAY';
    d.querySelector('[data-ok]').click();
  })()`);
  await sleep(2500);
  const after = JSON.parse(await p.evaluate(`JSON.stringify({
    toast: document.querySelector('.toast')?.textContent ?? '',
    title: document.getElementById('title').value,
    cards: document.querySelectorAll('#roster .card').length })`));
  ok(/New session started/i.test(after.toast), `confirmed: "${after.toast}"`);
  ok(after.title === 'WEEK 2 · BATTLE DAY', `the wall shows the new name: ${after.title}`);
  ok(after.cards === 0, `and starts with an empty wall (${after.cards} cards)`);

  console.log('\n=== an empty name is treated as a cancel');
  await p.evaluate(`document.getElementById('new-session').click()`);
  await sleep(600);
  await p.evaluate(`(() => {
    const d = document.querySelector('dialog.app-dialog[open]');
    d.querySelector('input').value = '   ';
    d.querySelector('[data-ok]').click();
  })()`);
  await sleep(1500);
  ok((await p.evaluate(`document.getElementById('title').value`)) === 'WEEK 2 · BATTLE DAY',
     'no session was created from whitespace');

  console.log('\n=== the destructive CLEAR dialog');
  await p.evaluate(`document.getElementById('clear').click()`);
  await sleep(600);
  const d2 = await dlg(p);
  ok(d2.open && d2.title === 'CLEAR THE WALL', `warns first: "${d2.title}"`);
  ok(/cannot be undone/i.test(d2.message), 'and says it cannot be undone');
  ok(/NEW SESSION/.test(d2.message), 'and points at the safer option instead');
  await p.evaluate(`document.querySelector('dialog.app-dialog [data-cancel]').click()`);
  await sleep(500);
  ok(!(await dlg(p)).open, 'cancelling closes it without deleting');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
