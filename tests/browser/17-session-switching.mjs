/**
 * Switching between classes must be lossless: cards, question bank and the
 * characters in the room all belong to their own session.
 */
import { launch, openPage, errors } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const get=(p)=>fetch(B+p).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const chrome = await launch();
try {
  // ---- CLASS A: two questions asked, one character with earned stats
  await post('/api/session', { title: 'CLASS A' });
  const a = (await get('/api/state')).session.id;
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'A1',choices:['a','b','c','d'],correctIdx:0,timeLimitSec:60},
    {text:'A2',choices:['a','b','c','d'],correctIdx:1,timeLimitSec:60}]})});
  await post('/api/game/join',{studentId:'AA1',name:'Anan',job:'warrior',token:'ta'});
  await post('/api/game/open',{index:0});
  await post('/api/game/answer',{studentId:'AA1',token:'ta',choiceIdx:0});
  await post('/api/game/close');
  const aStats = (await get('/api/game/me?studentId=AA1')).player;
  console.log('\n=== CLASS A set up');
  console.log(`    ${aStats.name}: ${aStats.score} pts, HP ${aStats.stats.hp}, asked ${(await get('/api/game/state')).askedCount}`);
  ok(aStats.score > 0, 'a character with earned stats exists');

  // ---- CLASS B: different everything
  await post('/api/session', { title: 'CLASS B' });
  const b = (await get('/api/state')).session.id;
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({questions:[
    {text:'B1',choices:['a','b','c','d'],correctIdx:2,timeLimitSec:60}]})});
  await post('/api/game/join',{studentId:'BB1',name:'Benja',job:'mage',token:'tb'});
  const bState = await get('/api/game/state');
  console.log('\n=== CLASS B is a clean room');
  ok(bState.players === 1, `only B's own player is here (${bState.players})`);
  ok((await get('/api/game/me?studentId=AA1')).player === null, "A's character is not visible from B");
  ok((await get('/api/questions')).questions.length === 1, `and B has its own single question`);

  // ---- the class list
  const list = (await get('/api/sessions')).sessions;
  console.log('\n=== the class list');
  console.log('   ', list.map(s=>`${s.title}${s.active?' (LIVE)':''}`).join(' · '));
  ok(list.filter(s=>s.active).length === 1, 'exactly one class is live');
  ok(list.find(s=>s.id===b).active, 'and it is CLASS B');

  // ---- switch back to A
  await post('/api/sessions/activate', { id: a });
  const back = await get('/api/state');
  console.log('\n=== switched back to CLASS A');
  ok(back.session.title === 'CLASS A', `now teaching "${back.session.title}"`);

  const restored = (await get('/api/game/me?studentId=AA1')).player;
  ok(restored !== null, "A's character came back");
  ok(restored.score === aStats.score && restored.stats.hp === aStats.stats.hp,
     `with its stats intact (${restored.score} pts, HP ${restored.stats.hp})`);
  ok((await get('/api/game/state')).askedCount === 1, 'and the room remembers a question was asked');
  ok((await get('/api/questions')).questions.length === 2, "A's own question bank is back");
  ok((await get('/api/game/me?studentId=BB1')).player === null, "B's character is not here");

  // ---- and switching to B again still finds B intact
  await post('/api/sessions/activate', { id: b });
  ok((await get('/api/game/me?studentId=BB1')).player !== null, "switching to B restores B's character too");

  // ---- guards
  console.log('\n=== guards');
  const selfDelete = await post('/api/sessions/delete', { id: b });
  ok(!!selfDelete.error, `deleting the live class is refused: "${selfDelete.error}"`);

  await post('/api/sessions/rename', { id: a, title: 'CLASS A · RENAMED' });
  ok((await get('/api/sessions')).sessions.find(s=>s.id===a).title === 'CLASS A · RENAMED',
     'renaming a class that is not live works');

  const del = await post('/api/sessions/delete', { id: a });
  ok(del.ok, `deleting a non-live class works (removed ${del.cards} cards)`);
  ok(!(await get('/api/sessions')).sessions.some(s=>s.id===a), 'and it is gone from the list');
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
