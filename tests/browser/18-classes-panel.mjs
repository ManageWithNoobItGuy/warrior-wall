/** The CLASSES panel on the wall page. */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const get=(p)=>fetch(B+p).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const rows = (p) => p.evaluate(`JSON.stringify([...document.querySelectorAll('.session-row')].map(r => ({
  name: r.querySelector('.session-name b').textContent,
  active: r.dataset.active === 'true',
  meta: r.querySelector('.session-meta').textContent.replace(/\\s+/g,' ').trim(),
  actions: [...r.querySelectorAll('[data-act]')].map(b => b.dataset.act),
})))`).then(JSON.parse);

const chrome = await launch();
try {
  await post('/api/session', { title: 'MONDAY CLASS' });
  await post('/api/session', { title: 'TUESDAY CLASS' });

  const p = await openPage(`${B}/wall`, { fresh: true, autoDialog: false });
  await sleep(3000);
  await p.evaluate(`document.getElementById('session-manager').open = true`);
  await sleep(900);

  const list = await rows(p);
  console.log('\n=== the class list');
  list.forEach(r => console.log(`    ${r.active ? '▶' : ' '} ${r.name.padEnd(16)} ${r.meta}   [${r.actions.join(',')}]`));
  ok(list.length >= 2, `${list.length} classes listed`);
  const live = list.filter(r => r.active);
  ok(live.length === 1 && live[0].name === 'TUESDAY CLASS', `one is marked live: ${live[0]?.name}`);
  ok(!live[0].actions.includes('switch'), 'the live one offers no SWITCH TO');
  ok(!live[0].actions.includes('delete'), 'and cannot be deleted from here');
  const other = list.find(r => !r.active && r.name === 'MONDAY CLASS');
  ok(other?.actions.includes('switch') && other?.actions.includes('delete'),
     'the others can be switched to or deleted');

  // ---- switching, through the dialog
  console.log('\n=== SWITCH TO');
  await p.evaluate(`(() => {
    const row = [...document.querySelectorAll('.session-row')]
      .find(r => r.querySelector('.session-name b').textContent === 'MONDAY CLASS');
    row.querySelector('[data-act="switch"]').click();
  })()`);
  await sleep(700);
  const dlg = await p.evaluate(`(() => {
    const d = document.querySelector('dialog.app-dialog[open]');
    return d ? JSON.stringify({ title: d.querySelector('.window-title').textContent,
      msg: d.querySelector('.speech').textContent.replace(/\\s+/g,' ').trim() }) : 'null';
  })()`);
  const D = JSON.parse(dlg);
  ok(D && D.title === 'SWITCH CLASS', `asks first: "${D?.title}"`);
  ok(/Nothing is deleted/i.test(D.msg), 'and reassures that nothing is lost');

  await p.evaluate(`document.querySelector('dialog.app-dialog [data-ok]').click()`);
  await sleep(3200);
  const after = await get('/api/state');
  ok(after.session.title === 'MONDAY CLASS', `switched: now "${after.session.title}"`);
  ok((await p.evaluate(`document.getElementById('title').value`)) === 'MONDAY CLASS',
     'and the page reloaded onto the new class');

  // ---- rename from the list
  console.log('\n=== RENAME');
  await p.evaluate(`document.getElementById('session-manager').open = true`);
  await sleep(700);
  await p.evaluate(`(() => {
    const row = [...document.querySelectorAll('.session-row')]
      .find(r => r.querySelector('.session-name b').textContent === 'TUESDAY CLASS');
    row.querySelector('[data-act="rename"]').click();
  })()`);
  await sleep(700);
  await p.evaluate(`(() => {
    const d = document.querySelector('dialog.app-dialog[open]');
    d.querySelector('input').value = 'TUESDAY · RENAMED';
    d.querySelector('[data-ok]').click();
  })()`);
  await sleep(1800);
  ok((await rows(p)).some(r => r.name === 'TUESDAY · RENAMED'), 'the list shows the new name');

  // ---- delete from the list
  console.log('\n=== DELETE');
  await p.evaluate(`(() => {
    const row = [...document.querySelectorAll('.session-row')]
      .find(r => r.querySelector('.session-name b').textContent === 'TUESDAY · RENAMED');
    row.querySelector('[data-act="delete"]').click();
  })()`);
  await sleep(700);
  const delDlg = await p.evaluate(`document.querySelector('dialog.app-dialog .speech')?.textContent.replace(/\\s+/g,' ').trim() ?? ''`);
  ok(/cannot be undone/i.test(delDlg), `warns clearly: "${delDlg.slice(0,70)}…"`);
  await p.evaluate(`document.querySelector('dialog.app-dialog [data-ok]').click()`);
  await sleep(1800);
  ok(!(await rows(p)).some(r => r.name === 'TUESDAY · RENAMED'), 'and it is gone');
  ok((await get('/api/state')).session.title === 'MONDAY CLASS', 'the live class is untouched');

  for (const e of errors(p.logs).filter(x=>!x.text.includes('404'))) console.log('  ! console:', e.text.split('\n')[0]);
  await p.screenshot((process.env.SHOT_DIR ?? '/tmp') + '/classes.png');
  p.close();
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
