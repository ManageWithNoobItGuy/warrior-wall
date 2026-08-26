# Progress — 26 August 2026

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
