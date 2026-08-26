/**
 * The instructor's real plan: a few questions early, a few mid-class, the rest
 * at the end — with long gaps in between and the projector back on the wall.
 */
import { launch, openPage } from '../lib/cdp.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
const B='http://127.0.0.1:8799';
const post=(p,b)=>fetch(B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b??{})}).then(r=>r.json());
const get=(p)=>fetch(B+p).then(r=>r.json());
const fail=[]; const ok=(c,m)=>{console.log((c?'  ✓ ':'  ✗ ')+m); if(!c)fail.push(m);};

const chrome = await launch();
try {
  await post('/api/game/reset');
  // Eight questions in the bank — the instructor plans 1 + 2 + 5.
  await fetch(B+'/api/questions',{method:'PUT',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({questions:[...Array(8)].map((_,i)=>({
      text:`Question ${i+1}`, choices:['a','b','c','d'], correctIdx:i%4, timeLimitSec:60 }))})});

  for (const [id,job] of [['C1','warrior'],['C2','mage'],['C3','thief'],['C4','knight']])
    await post('/api/game/join',{studentId:id,name:`Student ${id}`,job,token:'k'+id});

  const askBatch = async (from, count, label) => {
    for (let i = from; i < from + count; i++) {
      await post('/api/game/open',{index:i});
      // C1 always right, C2 right half the time, C3/C4 wrong
      await post('/api/game/answer',{studentId:'C1',token:'kC1',choiceIdx:i%4});
      if (i % 2 === 0) await post('/api/game/answer',{studentId:'C2',token:'kC2',choiceIdx:i%4});
      else await post('/api/game/answer',{studentId:'C2',token:'kC2',choiceIdx:(i+1)%4});
      await post('/api/game/answer',{studentId:'C3',token:'kC3',choiceIdx:(i+2)%4});
      await post('/api/game/close');
    }
    // back to the wall between batches, as the instructor would
    await post('/api/game/lobby');
    const st = await get('/api/game/state');
    console.log(`  ${label}: asked ${st.askedCount} so far, phase now "${st.phase}"`);
    return st;
  };

  console.log('\n=== teaching in three batches');
  const s1 = await askBatch(0,1,'start of class  (1 question) ');
  ok(s1.askedCount === 1 && s1.phase === 'lobby', 'one asked, screen returned to the wall');

  const s2 = await askBatch(1,2,'middle of class (2 questions)');
  ok(s2.askedCount === 3, 'the count carries across the gap');

  const s3 = await askBatch(3,5,'end of class    (5 questions)');
  ok(s3.askedCount === 8, 'all eight asked in total');

  // stats accumulated across every batch
  const c1 = await get('/api/game/me?studentId=C1');
  const c3 = await get('/api/game/me?studentId=C3');
  console.log('\n=== stats accumulated over the whole lesson');
  console.log(`    C1 (always right): ${JSON.stringify(c1.player.stats)}  ${c1.player.score} pts`);
  console.log(`    C3 (always wrong): ${JSON.stringify(c3.player.stats)}  ${c3.player.score} pts`);
  ok(c1.player.answered === 8, `C1 answered all ${c1.player.answered}`);
  ok(c1.player.stats.hp > c3.player.stats.hp, 'answering well grew the better student more');

  // ---- normalisation must follow what was asked, not what was written
  const before = (await get('/api/game/me?studentId=C1')).player.stats;
  await post('/api/game/battle/start');
  const { battle } = await get('/api/game/battle');
  const fighter = battle.fighters.find(f=>f.playerId==='C1');
  console.log('\n=== normalisation at battle time');
  console.log(`    raw        ${JSON.stringify(before)}`);
  console.log(`    normalised ${JSON.stringify(fighter.stats)}`);
  // 8 asked, baseline 10 -> k = 1.25, so deltas grow slightly
  const expectedHp = Math.round(100 + (before.hp - 100) * (10/8));
  ok(fighter.stats.hp === expectedHp, `scaled by the 8 asked (HP ${before.hp} -> ${fighter.stats.hp}, expected ${expectedHp})`);

  // ---- and the case that used to be wrong: bank of 8, only 2 asked
  await post('/api/game/reset');
  for (const [id,job] of [['D1','warrior'],['D2','mage']])
    await post('/api/game/join',{studentId:id,name:`Student ${id}`,job,token:'k'+id});
  for (let i=0;i<2;i++){
    await post('/api/game/open',{index:i});
    await post('/api/game/answer',{studentId:'D1',token:'kD1',choiceIdx:i%4});
    await post('/api/game/close');
  }
  const rawD1 = (await get('/api/game/me?studentId=D1')).player.stats;
  await post('/api/game/battle/start');
  const b2 = (await get('/api/game/battle')).battle;
  const f2 = b2.fighters.find(f=>f.playerId==='D1');
  const expect2 = Math.round(100 + (rawD1.hp - 100) * (10/2));
  const wouldHaveBeen = Math.round(100 + (rawD1.hp - 100) * (10/8));
  console.log('\n=== bank of 8, but only 2 asked');
  console.log(`    raw HP ${rawD1.hp} -> normalised ${f2.stats.hp}`);
  ok(f2.stats.hp === expect2, `scaled by 2 asked, not 8 in the bank (${f2.stats.hp}, expected ${expect2})`);
  ok(f2.stats.hp !== wouldHaveBeen, `the old behaviour would have given ${wouldHaveBeen} — flatter, and more of a coin toss`);
} finally { chrome.kill(); }
console.log(fail.length?`\nFAILED ${fail.length}`:'\nALL CHECKS PASSED');
