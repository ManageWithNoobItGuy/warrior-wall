/**
 * Runs the browser suites against a local `wrangler dev`.
 *
 *   npm run cf:dev            # in one terminal, on port 8799
 *   npm test                  # in another
 *   npm test -- 05 12         # only the suites whose names contain these
 *
 * They drive a real headless Chrome over the DevTools protocol rather than a
 * DOM emulator, because most of what broke in this app broke in layout,
 * timing, or the browser's own dialog handling — none of which jsdom models.
 */
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv.slice(2);

/**
 * Some suites need a card from an *earlier* class to exist. Seeding it here
 * keeps each suite independent — an earlier version of these tests borrowed
 * whatever the previous run happened to leave behind, and failed in confusing
 * ways whenever the order changed.
 */
async function seedFixtures() {
  const run = (args) =>
    new Promise((ok) => {
      const p = spawn('npx', args, { cwd: join(here, '..'), stdio: 'ignore' });
      p.on('close', ok);
    });
  await run([
    'wrangler', 'd1', 'execute', 'warrior-wall', '--local', '--command',
    `INSERT OR REPLACE INTO posters
       (id, session_id, name, student_id, takeaways, actions, job, ready, created_at)
     VALUES ('oldcard-0001','prev-session','Returning Tester','6600000002','["x"]','["x"]','healer',1,1755000000000)`,
  ]);
  await run([
    'wrangler', 'r2', 'object', 'put', 'warrior-wall-cards/posters/oldcard-0001/photo.jpg',
    '--file', join(here, 'fixtures', 'portrait.jpg'), '--content-type', 'image/jpeg', '--local',
  ]);
}

const files = (await readdir(join(here, 'browser')))
  .filter((f) => f.endsWith('.mjs'))
  .filter((f) => !filter.length || filter.some((needle) => f.includes(needle)))
  .sort();

await seedFixtures();

/** Runs one suite to completion and reports what it said. */
function runSuite(file) {
  return new Promise((ok) => {
    const p = spawn('node', [join(here, 'browser', file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', () => {
      ok({ verdict: out.match(/ALL CHECKS PASSED|FAILED[: ]+\d+/)?.[0] ?? 'NO RESULT', out });
    });
  });
}

let failed = 0;
for (const file of files) {
  const name = file.replace(/\.mjs$/, '');
  let result = await runSuite(file);

  /**
   * A suite that dies without printing a verdict has usually lost its DevTools
   * connection, not found a bug: cdp.mjs puts a 15s deadline on every call, and
   * across a full run one of them occasionally never gets its reply. It moves
   * between suites from run to run, which is the tell.
   *
   * So NO RESULT is retried once. A real failure says the same thing twice; a
   * stall does not, and a phantom failure in a thirty-suite run costs whoever
   * is reading it more than the minute this spends.
   */
  const stalled = result.verdict === 'NO RESULT';
  if (stalled) result = await runSuite(file);

  const pass = result.verdict === 'ALL CHECKS PASSED';
  const note = stalled ? (pass ? '  (passed on retry after a stall)' : '  (twice)') : '';
  console.log(`${pass ? '  ok  ' : '  FAIL'}  ${name.padEnd(30)} ${result.verdict}${note}`);
  if (!pass) {
    // The whole output when there is no verdict — the stack trace is the only
    // thing that says why, and filtering for ✗ throws it away.
    console.log(
      result.verdict === 'NO RESULT'
        ? result.out
        : result.out.split('\n').filter((l) => l.includes('✗')).join('\n'),
    );
  }
  failed += pass ? 0 : 1;
}

console.log(failed ? `\n${failed} of ${files.length} suites failed` : `\nall ${files.length} suites passed`);
process.exit(failed ? 1 : 0);
