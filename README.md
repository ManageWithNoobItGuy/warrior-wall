# ⚔ AI Warrior Wall of Pledging

An end-of-class web app with a 24-bit JRPG theme. Students build a character, grow it by
answering a live quiz, fight a battle royale on the projector, then write a pledge card
that lands on the instructor's wall.

Built for a university AI class and released so other teachers can run the same lesson.
Everything runs on Cloudflare's free tier; the only thing that costs money is the optional
AI avatar generation.

---

## The lesson, in three acts

**1 · Build a character.** Students scan a QR code, take a selfie, enter their name and
student ID, and pick one of five classes — warrior, knight, thief, mage, healer. Each
class starts on a different stat line and a seeded birth roll adds a little fate on top.
They can keep the real photo or let AI paint them as a JRPG character while staying
recognisable.

**2 · Answer the quiz.** You put questions on the projector one at a time and the room
answers on their phones. Answering **grows the character**: a correct answer adds HP,
being in the fastest quarter adds SPD, getting a question most of the room got wrong adds
ATK, and a streak adds DEF. Everyone who presses anything gets LUK, wrong answers
included — so nobody is punished for guessing.

**3 · Fight, then pledge.** Everyone picks a stance — Strike, Guard or Cast, a three-way
triangle — and the class fights a single-elimination tournament on the projector using
the stats they earned. Afterwards you open pledging, and each student writes 1–3
takeaways and 1–3 next actions. Their card, carrying the character they played and where
they placed, lands on your wall to download or project.

The quiz and the battle are both optional. A class that runs neither still works: build
characters, open pledging, collect cards.

### Does answering well decide who wins?

It is a real edge, not a guarantee — deliberately. From `npm run battle:sim 2000 24`
(2,000 rooms of 24 students, 10 questions):

| | Result | By chance |
| --- | --- | --- |
| Champion came from the better-answering half | 96.0% | 50% |
| Champion was the single best answerer | 27.3% | 4.2% |
| Quiz rank vs finishing rank (Spearman) | 0.441 | — |

Tuned so a room cannot predict the winner and stop watching, while the student who
studied still has roughly a 1-in-4 shot in a class of 24. Run the simulator yourself with
your own class size.

---

## What you need

- **A Cloudflare account** (free plan is enough) — Workers, D1, R2 and Durable Objects
- **Node.js 22.5+** and npm
- **A Google AI Studio API key** — optional, only for AI avatars
- A projector, and students with phones on any internet connection

> **R2 requires a payment card on file** even on the free tier. If you would rather not,
> see *Running without R2* at the end.

---

## Setup, from nothing to a working class

### 1 · Get the code

```bash
git clone https://github.com/ManageWithNoobItGuy/warrior-wall.git
cd warrior-wall
npm install
```

### 2 · Log in to Cloudflare

```bash
npx wrangler login
```

### 3 · Create the database and the bucket

```bash
npx wrangler d1 create warrior-wall
npx wrangler r2 bucket create warrior-wall-cards
```

The first command prints a `database_id`. **Open `wrangler.jsonc` and paste it in** —
the one in the repo is the original author's and will not work for you:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "warrior-wall",
    "database_id": "PASTE-YOUR-OWN-ID-HERE"
  }
],
```

While you are in there, change `"name"` at the top if you want a different URL — it
becomes `https://<name>.<your-subdomain>.workers.dev`.

### 4 · Create the tables

```bash
npx wrangler d1 migrations apply warrior-wall --remote
```

### 5 · Deploy

```bash
npm run deploy
```

Wrangler prints your URL. The app is live, but the instructor page is not protected yet.

### 6 · Set the passcode — do not skip this

```bash
npx wrangler secret put WALL_PASSCODE
```

> **Run this in a real terminal where you can see the `Enter a secret value:` prompt.**
> `wrangler secret put` reads from stdin, and when stdin is not a terminal it uploads an
> **empty string and still prints `✨ Success!`**. An editor's embedded shell, a CI step
> or an AI agent will all silently set an empty passcode. No prompt means no value.

Check it took:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://YOUR-WORKER.workers.dev/wall
```

`401` is correct — the gate is working. The gate **fails closed**: with no passcode set,
`/wall` opens only for `localhost`, so a deployment that loses its secret locks out its
owner rather than handing a room the buttons that wipe the wall.

### 7 · AI avatars (optional)

Get a key from [Google AI Studio](https://aistudio.google.com/apikey), then:

```bash
npx wrangler secret put GEMINI_API_KEY
```

Without it the app works fine — the AI AVATAR panel simply never appears and students
use their real photos.

**Cost:** each avatar is one `gemini-2.5-flash-image` call. Students get 3 summons each
(`AVATAR_LIMIT` in `wrangler.jsonc`) and a whole class is capped at 150
(`AVATAR_SESSION_LIMIT`) so a runaway loop cannot drain your quota. Check current
pricing before a large class.

### 8 · Open the three pages

| Page | URL | Who sees it |
| --- | --- | --- |
| **Student** | `https://YOUR-WORKER.workers.dev/` | Students, via the QR code |
| **Instructor** | `https://YOUR-WORKER.workers.dev/wall?pass=YOUR-PASSCODE` | You only |
| **Projector** | `https://YOUR-WORKER.workers.dev/projector` | The big screen — press `F` for fullscreen |

`?pass=` sets a cookie for 12 hours, so after the first visit the plain `/wall` link
works. Do not share the `?pass=` URL.

---

## Running a class

Everything is driven from the **wall page**, under GAME MASTER.

**Before the lesson**

1. Open `/wall`. Under **CLASSES**, press **NEW SESSION** and name it.
2. Open **QUESTION BANK** and write your questions — 2 to 4 choices each, mark the
   correct one, set a time limit, and add an optional explanation shown at the reveal.
   Press **SAVE BANK**.
3. Project the QR code (**ENLARGE QR**) and let students build characters. Watch them
   appear under **PARTY MEMBERS**.

**During the lesson**

| Control | What it does |
| --- | --- |
| **ASK** dropdown | Jump to any question — you are not stuck with the running order |
| **OPEN QUESTION** | Puts it on the projector; phones show the choices and a countdown |
| **CLOSE & REVEAL** | Locks answers, reveals the correct one, awards stats |
| **CLEAR SCREEN** | Returns the projector to the card wall |
| **OPEN STANCE PICKING** | Phones offer Strike / Guard / Cast |
| **⚔ START BATTLE** | Runs the tournament. Needs at least 2 characters |
| **OPEN PLEDGING** | Sends every phone to write their card. One way |

Ask questions in as many batches as you like — stats accumulate across the gaps, and the
battle can run whenever you want it.

**Afterwards**

- The projector shows **FINAL RESULTS**: the arena standings beside the quiz standings,
  because the champion and the best answerer are often different people.
- Cards appear under PARTY MEMBERS. Click one to project it, **⬇** to download it, or
  **↓ ALL .ZIP** at the top for the whole class.

**Managing the room**

- Each party member has **RENAME** and **✕**. Removing takes everything of theirs:
  character, portrait and card. A card already sent keeps the name painted into its
  image — renaming cannot reach back into a rendered picture.
- Students can delete their own character from their sheet, but only before the battle
  starts.
- **RESET ROOM** clears characters and stats but keeps the cards and the questions.
- **CLEAR** permanently deletes every card in the session. It does **not** touch the
  question bank. Use **NEW SESSION** if you only want a fresh wall.
- **CLASSES → DELETE** removes a class entirely — cards, questions and all.

---

## Things that will bite you if nobody tells you

**Students rejoin by student ID.** Typing an ID that already has a character hands you
that character, on any device, at any point. This is deliberate — a dead battery should
not cost someone their character — but it also means **anyone willing to type a
classmate's ID can play as them.** Do not use these scores for marks without changing
that.

**An ID that made a card in an earlier class** is offered that card's portrait and class
back. Convenient in a repeat class; surprising when you are testing with round numbers
like `1234` and a character you do not recognise appears.

**The in-page camera needs HTTPS.** On a deployed worker you have it. There is always a
second path anyway: **CHOOSE PHOTO** uses the phone's own camera app and needs no HTTPS.

**One class at a time.** Each class has its own room, but the student link always
resolves to whichever class is *active*. Two live classes would land in the same one.

**The avatar belongs to the class it was painted as.** Summon as a healer, switch to
thief, and the painting is set aside until you summon again — otherwise a thief walks
into the arena in cleric robes.

---

## Local development

```bash
npm run cf:dev      # terminal 1 — the real thing, on http://127.0.0.1:8799
npm test            # terminal 2 — 30 browser suites
```

> **`npm start` is not the app.** There is an older plain-Node build (`server.js`,
> SQLite on disk) kept for offline work on the card renderer. It predates the quiz and
> **serves no game routes at all** — no questions, no battle, no arena. Use
> `npm run cf:dev` for anything real.

First run needs local tables:

```bash
npm run db:local
```

### The tests

30 suites driving real headless Chrome over the DevTools protocol — not jsdom, because
most of what breaks here breaks in layout, in timing, or in the browser's own dialog
handling, and none of that is modelled by a DOM emulator.

```bash
npm test              # everything, about 10 minutes
npm test -- 12 21     # only suites whose names contain these
```

Requires Google Chrome at the standard macOS path (`tests/lib/cdp.mjs`, one constant).

Three of the suites run a real 23-second tournament, because the end of a battle is
decided by a timeline that nothing can fast-forward.

**Do not run two test runs at once.** They share a Chrome debug port and the local
database, and concurrent runs produce convincing false failures.

**`wrangler dev` is not perfectly stable** under long SSE connections. It dies with
`Error inside ProxyWorker: Network connection lost.`, after which every remaining suite
fails for the wrong reason. Reproducible on unmodified code, so it is the dev server
rather than the app. If a run reports a wall of failures, check the server is still up
before believing any of it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8799/
```

It survives longer if you prune miniflare's local trace store now and then. `wrangler.jsonc`
turns on `observability`, which is right in production but in local dev writes every
request to a SQLite file that is never pruned — it reached 100MB here across a few days of
test runs. Deleting it is safe; it is a cache and regenerates:

```bash
rm -rf .wrangler/state/v3/observability
```

A single suite that reports `NO RESULT` while the server is still up is the other failure
mode — a lost DevTools reply. The runner retries those once and says so.

---

## How it is built

Cloudflare Workers, with **D1** for records, **R2** for images, and one **Durable
Object** for the live room. No build step and no framework — the client is plain ES
modules, so what you read is what runs.

```
worker/         index.js router · game.js quiz+battle routes · wall-hub.js the room · store.js D1+R2
lib/rpg/        battle.js bracket+timeline · stats.js growth · classes.js modifiers · skills.js move names
public/js/      student.js the phone · wall.js the wall · quiz.js game master · projector.js the big screen
                arena.js the tournament renderer · poster.js the card · play.js shared room state
migrations/     0001 base · 0002 quiz, characters and results
tests/browser/  30 suites
tools/          battle-sim.js balance check
```

**Live state lives in the Durable Object, not D1.** Fifty phones answering the same
question inside two seconds is the only hot path, and a database round trip per tap would
spend the whole CPU budget waiting on the network. D1 keeps what must outlive the room:
questions, cards, and a snapshot of the final standings.

**The battle is computed before the first frame is drawn.** Pressing START BATTLE runs
the whole tournament immediately and stores a timeline; every screen replays it against
the server's `startedAt`. A projector that reconnects halfway through resumes at the
right moment, and nothing on any screen can change the result.

**Nothing on a phone is trusted with a score.** Elapsed time is measured against the
server's clock, and the correct answer is withheld from the live broadcast until the
question closes.

**One room per class.** The room is addressed by session id, so switching between classes
is lossless rather than destructive.

---

## Running without R2

R2 asks for a card on file even on the free tier. Without it, students cannot upload
portraits or receive cards — which is most of the app. There is no supported path around
this today; the honest answer is that R2 is required.

---

## Credits and licence

The combat and character systems were ported from an earlier React/TypeScript project
(`RPG-Seminar`) into this app's plain-JS, no-build style.

Class artwork lives in `public/portraits/`. Replace it with your own if you prefer.

No licence file is included — if you want to reuse this beyond running the lesson, open
an issue and ask.
