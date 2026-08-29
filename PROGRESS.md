# Progress

An engineering journal, newest entry last. The README is the document to trust for how
the app works today; this file records how it got there and what was learned on the way.

---

# 26 August 2026

Merged the combat and character systems from **RPG-Seminar** into **AI Warrior Wall of
Pledging**, and deployed to the `first-wongs` Cloudflare account at
<https://ai-warrior-wall-of-pledging.first-wongs.workers.dev>.

The app was a one-shot pledge wall: take a selfie, write takeaways, pledge actions, get a
card. It is now a three-act lesson — build a character, grow it by answering a live quiz,
fight a battle royale on the projector — with the pledge card at the end carrying the
character you played as.

---

## What was brought across

`RPG-Seminar` is React + TypeScript + Vite. This app is vanilla JS with no build step, and
that was kept: the rules were ported from TS to JS rather than dragging a toolchain in.

| From RPG-Seminar | Landed as | What it does |
| --- | --- | --- |
| `src/shared/battle.ts` | `lib/rpg/battle.js` | Single-elimination bracket, seeded RNG, the projector's timeline |
| `src/shared/game.ts` | `lib/rpg/stats.js` | Stat growth, scoring, normalisation |
| `src/shared/classes.ts` | `lib/rpg/classes.js` | Class modifiers, birth roll |
| `src/shared/skills.ts` | `lib/rpg/skills.js` | 15 named moves (5 classes × 3 stances) |
| `src/client/lib/Arena.tsx` | `public/js/arena.js` | The tournament renderer, React → plain DOM |
| `public/portraits/*.webp` | `public/portraits/` | Class artwork, remapped to this app's five classes |

Six classes became five: `knight` takes guardian's stat line and artwork, `healer` takes
scholar's. The quiz system had no counterpart here and was built new.

---

## How it hangs together

**One room per class.** The `WallHub` Durable Object is addressed by session id, not by a
fixed name. That is what makes switching between classes lossless instead of destructive.

**Live state is in the Durable Object, not D1.** Fifty phones answering the same question
inside two seconds is the only hot path in this app, and a D1 round trip per tap would
spend the whole CPU budget on network waits. The DO also has to see *every* answer to
judge "was this student in the fastest quarter of the room". D1 keeps what must outlive
the room: questions, cards, and a snapshot of the final standings.

**The battle is computed before the first frame is drawn.** Pressing START BATTLE runs the
whole tournament immediately; the projector replays a timeline against the server's
`startedAt`. A projector that reconnects halfway through resumes at the right moment, and
nothing on any screen can change the result.

**Nothing on a phone is trusted with a score.** Elapsed time is measured against the
server's clock; the correct answer is withheld from the live broadcast until the question
closes.

**A student ID is an identity, not a password.** Typing an ID that already has a character
hands you that character, on any device, at any point in the lesson — a deliberate choice,
made because a dead battery locking someone out of their own character for the rest of the
lesson is a likelier harm than a classmate deciding to play as them. **Anyone willing to
type a classmate's ID can play as them.** If these scores are ever used for marks, the
token in `join` has to become a credential again.

---

## Balance

`node tools/battle-sim.js 300 24` — 300 rooms of 24 students, 10 questions:

```
champion came from the better-answering half   95.3%   (chance: 50%)
champion was the single best answerer          22.7%   (chance: 4.2%)
quiz rank vs finishing rank (Spearman)         0.441
```

Answering well is a strong edge, not a guarantee — which is the point: a room that knows
the outcome in advance stops watching.

---

## Bugs found and fixed

Several were **pre-existing** in the original app and would have bitten during a class.

| # | Bug | Why it mattered |
| --- | --- | --- |
| 1 | **The instructor page was publicly open.** `wrangler secret put` reads stdin; with no terminal attached it uploads an *empty string* and still prints `✨ Success!`. An empty passcode hit `if (!env.WALL_PASSCODE) return true` and opened the gate. | Anyone with the URL — every student from last week — could wipe the wall. Gate now **fails closed**: no passcode means localhost only. |
| 2 | **Renaming a class reloaded every student's phone.** Rename published the same `session` event as "a new class started", which every page treats as "throw everything away". | Pressing SAVE mid-quiz would have destroyed 50 characters and emptied the wall. Split into a `renamed` event. |
| 3 | **`prompt()` and `confirm()` silently stopped working.** Chrome offers "prevent this page from creating additional dialogs" the second time a page opens one; after that they return null/false *without showing anything*. | NEW SESSION, CLEAR and START BATTLE became buttons that did nothing. All six replaced with in-page dialogs. |
| 4 | **13 instructor actions had no error handling.** A failed request produced no toast, no log, nothing. | A 401 or a server error mid-class looked identical to a dead button. Every action now reports, and a 401 returns to the passcode screen. |
| 5 | **The quiz countdown never ticked.** `renderQuestion()` ran before `setView('question')`, so the rAF loop's `play.view === 'question'` guard failed on its first pass and never scheduled a second frame. | The clock froze at its starting value and the bar stayed full. |
| 6 | **Stats were normalised by the size of the question bank, not by how many questions were asked.** | Write 8, get through 5, and everyone's earned stats were squashed toward the base — the tournament quietly became a coin toss. Now uses `askedCount`. |
| 7 | **The completion screen was a dead end.** No route back to the arena. | A student who pledged mid-lesson could not rejoin for the next round of questions without reloading. Added BACK TO THE ARENA. |
| 8 | Stored card portraits were never served — uploaded since v1, no route ever read them. | Blocked reusing a returning student's portrait. Added `/p/photo/<id>.jpg`. |
| 9 | Arena rendering: mirrored initials, six-pixel initials on a 280px champion token, and fallen fighters piling on top of each other (a weak hash over sequential student IDs). | Fixed by flipping only the photo, scaling type off the token, and scattering with an R2 low-discrepancy sequence. |

---

## Data safety

Backed up before touching production: `backups/d1-before-rpg-<date>.sql` (gitignored — it
carries real names and student IDs, and this repo is on GitHub).

`migrations/0002_rpg.sql` is additive only: new tables plus nullable columns. All 28 cards
from the 20 August class survived it and still render — verified by seeding a card with
`stats = NULL` and checking it through the API, the wall and the card renderer.

**One mistake to record:** while diagnosing the NEW SESSION button I clicked it through a
headless browser, which auto-accepts confirmations. That created a real session on
production and closed `Noobitguy BBA TU AI Class`. No data was lost — its 28 cards are
intact and reachable via CLASSES → SWITCH TO — but production is not a place to click
buttons that change state.

---

## Tests

`npm test` runs 18 browser suites against a local `wrangler dev` on port 8799, driving
real headless Chrome over the DevTools protocol. Not jsdom: most of what broke here broke
in layout, in timing, or in the browser's own dialog handling, and none of that is modelled
by a DOM emulator.

```bash
npm run cf:dev          # terminal 1
npm test                # terminal 2
npm test -- 12 17       # just the countdown and session-switching suites
```

Three lessons from the tests themselves, worth remembering:

- **Assert that moving things move.** The countdown bug survived because the tests checked
  the clock's *initial* value, which was always right. Sample twice.
- **Watch for assertions that pass for the wrong reason.** "SUMMON AVATAR is hidden" passed
  before the feature existed, because there was no `GEMINI_API_KEY` locally and the panel
  was never shown at all. Likewise a header measured `0px` tall and passed a `< 70` check —
  it was measuring a hidden element with the same class.
- **Suites must not borrow each other's data.** One suite used whatever questions the
  previous run left behind and failed whenever the order changed. Each now seeds its own.

---

## Where things stand

Deployed and green. Production currently holds:

| Class | Cards | State |
| --- | --- | --- |
| `Test Class` | 0 | live |
| `Noobitguy BBA TU AI Class` | 28 | archived, switchable from CLASSES |

**Before teaching:** open `/wall`, use CLASSES to pick or start the right class, write the
question bank, and hand out the QR code. Ask questions in as many batches as you like —
stats accumulate across the gaps and the battle can run whenever.

**Not done:**

- **Two live classes at once.** Each class has its own room, but the student link always
  resolves to whichever class is *active*, so both groups would land in the same one. This
  needs per-class join links (`/?class=ABC123`).
- **Characters do not carry across classes.** Every class starts from a fresh birth roll,
  by decision, not by omission.
- **Nothing is committed to git yet.** About 5,000 new lines — `lib/rpg/`,
  `worker/game.js`, four client modules, the class artwork, and `tests/` — plus 18
  modified files.


---

# 27–28 August 2026 — taught, then hardened

The app was used with a real class, and most of this came out of watching it fail in
front of one.

## The pledge moved twice

It began available from the moment a character existed, which pulled students out of the
lesson to write takeaways while questions were still being asked. It was gated behind the
battle — which fixed that and immediately created a worse problem: a class that runs no
tournament could not reach the wall at all, and a bracket needs two fighters, so a small
class could not have one even in principle.

It now waits for **OPEN PLEDGING** on the wall. The instructor picks the moment, every
phone goes at once, and the room is not obliged to have fought. `pledgeOpen` is a flag
rather than a phase, because pledging runs alongside whatever the arena is doing.

Making the middle version work needed an end-of-battle signal the phones could trust.
`done` had been in `PHASES` from the start but nothing ever set it — each screen worked
the ending out from `startedAt + totalMs`, which draws a view but gives a page nothing to
react to. The room now sets a Durable Object alarm and broadcasts `phase`.

## Bugs found by teaching with it

| Bug | Why it happened |
| --- | --- |
| A summoned avatar never appeared in the class preview | `#preview-art` was written in exactly one place, inside `markClass()`, so it only changed when the *class* changed |
| The character sheet showed a stale portrait | `/av/<id>.jpg` is one URL for every version of a face; the browser served what it had cached, and nothing was broadcast when a new one landed. Portraits are versioned `?v=<portraitAt>` now |
| A thief wearing cleric robes | A student may change class after summoning, and the painting did not change with them. The avatar now belongs to the class it was painted as |
| Scan lines across every face | A z-index list lifts artwork above the CRT overlay; `.sheet-portrait img` was never in it. Measured: 25 levels of banding, now 0 |
| Portraits soft on every screen | Uploaded at 256px, drawn at up to 344 real pixels. Now 512 |
| PARTY MEMBERS empty all lesson | It listed pledge cards only, which stopped making sense the moment the pledge moved after the battle |
| "2 of 2 have not picked a stance" while the HUD said 2/2 | The `stanceCount` event repainted one number without updating the model the warning is computed from |
| The projector abandoned the arena the instant a battle ended | `GAME_VIEWS` never listed `done`, so the champion banner was being shown to nobody |

The last two are the same shape as the `/api/game/leave` routing bug: something reads a
copy of state that nothing keeps current. Worth looking for first next time.

## Added

Party member management (rename, remove — taking character, portrait and card together),
a student's own two-step delete gated before the battle, a FINAL RESULTS board showing
arena and quiz standings side by side, a question chooser so any question can be opened
out of order, and arena sound.

## Balance, re-measured

2,000 rooms rather than the 300 recorded above:

```
champion came from the better-answering half   96.0%   (chance: 50%)
champion was the single best answerer          27.3%   (chance: 4.2%)
quiz rank vs finishing rank (Spearman)         0.441
```

The single-best-answerer figure moves with class size — 47.6% at eight students, 15.8% at
forty-eight — but the *edge over chance* rises as the room grows.

## The champion scene was too slow

From the last blow to the results board was 32.6 seconds, most of it reading out places.
Halved to 18.0s. The fighting itself, including the deliberately slow final duel, is
untouched.

## Testing lessons, all of them paid for

- **Assertions that pass for the wrong reason are the norm, not the exception.** Three
  separate ones here: `elementFromPoint` cannot see a `::after` pseudo-element, so a
  scan-line check passed with stripes fully visible; a 414px viewport made a 256px
  portrait "high enough resolution"; and counting sounds passed with the reconnect guard
  removed. Each had to be rewritten to measure the thing itself — screenshot pixels,
  the widest frame the CSS allows, oscillator frequencies.
- **Never run two test runs at once.** They share a Chrome debug port and the local
  database. Doing so produced four convincing false failures.
- **Chrome throttles `requestAnimationFrame` in a background tab.** A second projector
  opened to test reconnection silently froze the first one, which was the thing under
  test.
- **`wrangler dev` dies under long SSE connections**, with `Error inside ProxyWorker:
  Network connection lost.` Reproducible on unmodified code by polling from a page that
  holds an event stream. A suite reporting `NO RESULT` usually means the server went
  away, not that the code is wrong — check before believing it.

## Still not done

- **Two live classes at once.** Each class has its own room, but the student link
  resolves to whichever class is active, so both groups land in the same one.
- **Characters do not carry across classes.** By decision.
- **A student ID is still an identity, not a credential.** Anyone willing to type a
  classmate's ID can play as them. If these scores ever count for marks, the token in
  `join` has to become a real credential.
