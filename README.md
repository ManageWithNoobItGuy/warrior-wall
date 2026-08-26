# ⚔ AI Warrior Wall of Pledging

An end-of-class web app with a 24-bit JRPG theme, in three acts.

**1 · Build a character.** Students take a selfie, enter their name and student ID, and
pick one of five classes — warrior, knight, thief, mage, healer. Each class starts on a
different stat line, and a seeded birth roll adds a little fate on top. They can keep
their real photo or let **AI (nano banana) paint them as a JRPG character** while staying
recognisable.

**2 · Answer the quiz.** The instructor puts questions on the projector one at a time and
the room answers on their phones. Answering **grows the character**: correct answers add
HP, being in the fastest quarter adds SPD, getting a question most of the room got wrong
adds ATK, and a streak adds DEF. Everyone who presses anything gets LUK, wrong answers
included.

**3 · Fight.** Everyone picks a stance — Strike, Guard or Cast, a three-way triangle —
and the whole class fights a single-elimination battle royale on the projector, using the
stats they earned. Then they write **1–3 key takeaways** and pledge **1–3 next actions**,
and their warrior card — now carrying the character they built and where they placed —
lands on the instructor's wall.

The quiz and the battle are both optional. With no questions written, the app behaves
exactly like it did before: photo, takeaways, pledge, card.

## Running a class

Everything is driven from the **wall page**, under GAME MASTER:

Students rejoin by typing their student ID on the first screen — no photo or class step
the second time, and no name either, since the ID is the identity and the name they typed
an hour ago is exactly what they will not remember. A phone that simply reloads restores
itself silently.

An ID that made a card in an **earlier** class gets offered that card's portrait and class
back, so a returning student can be in the arena in one more press. They can decline and
shoot a new photo; their name comes across either way. Stats always start from zero —
every class is its own tournament.

Sending a card is not the end of the lesson — more rounds of questions and the battle may
still be to come — so the completion screen carries a way back to the arena, and the arena
stops offering MY PLEDGE once a card has been sent for this class, showing a receipt and a
link to the card instead. They are back for the next
round of questions, not to put a second card on the wall — and the check is made against
the *current* session, so a card from last week does not suppress this week's pledge.

Reusing an **AI-painted** portrait locks the class to the one it was painted as, and hides
the summon panel. The picture and the class label have to agree: a healer's robes on a card
that reads WARRIOR looks like a bug rather than a choice, and offering SUMMON AVATAR to
someone who just chose to keep their old look invites them to spend a generation replacing
it. Taking a new photo releases the lock. A reused plain photo locks nothing, since it
implies no class.

| Step | What you press | What the room sees |
| --- | --- | --- |
| Before class | QUESTION BANK → write questions → SAVE BANK | nothing |
| Students arrive | — | they build characters; the counter climbs |
| Ask a question | OPEN QUESTION | the question, with a live timer |
| Reveal it | CLOSE & REVEAL | the answer, who got it, and what everyone earned |
| Between questions | CLEAR SCREEN | back to the wall |
| Before the fight | OPEN STANCE PICKING | students choose Strike / Guard / Cast |
| The fight | ⚔ START BATTLE | the tournament, about 45–70 seconds |
| Afterwards | — | students write their pledge and send their card |

RESET ROOM wipes every character and result but leaves the cards on the wall alone.
NEW SESSION opens a fresh class and is what you press between two different groups.

**CLASSES** lists every class ever run and switches between them. Switching is lossless:
each session has its own room in the Durable Object, so its characters, its question bank
and how far through it you were are all still there when you switch back — as are its
cards, which live in D1 keyed by session. A class can be renamed from the list, or deleted
outright, which does remove its cards for good. The live class cannot be deleted; switch
away from it first, which is also the guard that stops the app being left with no session
at all.

## How the numbers work

`lib/rpg/` holds the rules as pure functions with no I/O, so they can be simulated
without deploying anything:

```bash
node tools/battle-sim.js 400 24    # 400 rooms of 24 students
```

Over 300 simulated rooms the champion comes from the better-answering half of the class
**95%** of the time (chance would be 50%), and the single best answerer wins **23%** of
the time (chance would be 4%). The rank correlation between quiz performance and finishing
position sits around **0.44** — answering well is a real edge, not a guarantee, which is
the point: a room where the outcome is known in advance stops watching.

Stats are normalised to a ten-question baseline before a battle, so a class that asked
four questions and one that asked twenty produce characters of comparable power. The count
used is how many questions were **actually asked**, not how many sit in the bank — write
ten, get through four, and it scales as the four-question class it was. Scaling by the
bank size instead would squash everyone's earned stats back toward the base and quietly
hand the tournament to luck.

Questions do not have to run in one block. Ask one at the start of the lesson, two in the
middle and five at the end: CLEAR SCREEN puts the projector back on the wall between
batches, stats accumulate across the gaps, and the battle can be run whenever you like.

## Getting started

```bash
npm install
cp .env.example .env     # then add GEMINI_API_KEY (already filled in your local .env)
npm start
```

Open these three pages:

| Page | URL | When you use it |
| --- | --- | --- |
| Student | `http://<your-ip>:4173/` | Students scan the QR code shown on the wall page |
| Instructor wall | `http://localhost:4173/wall` | Your own screen — everything is controlled from here |
| Projector | `http://localhost:4173/projector` | Drag to the projector and press `F` for fullscreen |

`npm start` prints your LAN IP, and the wall page shows a QR code with an "ENLARGE QR"
button you can project for students to scan.

Change the port with `PORT=8080 npm start`.

## About the camera (important)

Browsers only allow `getUserMedia` over **HTTPS or localhost**. When students connect via
your LAN IP (`http://192.168.x.x:4173`), the "OPEN CAMERA" button will not work.

That's why there is always a second path: the **"CHOOSE PHOTO"** button uses
`<input type="file" capture="user">`, which opens the phone's own camera app **with no
HTTPS required**. The student shoots in the camera app and the photo drops straight back
into the form. Works on both iOS and Android.

If you want the in-page camera for real, put HTTPS in front of it, e.g.

```bash
npx cloudflared tunnel --url http://localhost:4173
```

then hand out the `https://...trycloudflare.com` URL instead. Open the wall page through
the tunnel URL too — the QR code is built from whichever host you arrived on.

## AI avatars (nano banana)

After taking a photo the student picks a class and hits **SUMMON AVATAR**. The photo goes
to `gemini-2.5-flash-image`, which paints it as a JRPG character in about 15–25 seconds.
They can switch back to their real photo at any time.

The style is a **semi-realistic painted JRPG character portrait**, not pixel art. The
first version used 24-bit pixel art and the chunky pixels swallowed exactly the facial
detail that makes someone identifiable. The card frame is still 24-bit, so a painted
portrait inside a pixel frame ends up looking like an in-game character portrait.

The prompt puts **likeness ahead of costume** and spells it out feature by feature (face
shape, jaw, nose, eyes, brows, mouth, hairstyle, parting, skin tone, age, glasses, beard,
moles, head angle, expression), with explicit instructions not to beautify, slim, youthen,
or turn the person into a big-eyed anime character, and not to add a fringe if the photo
has none. Tune it in `buildPrompt()` in `lib/gemini.js`.

**Quota and key handling**

- **3 generations per student ID per session**, enforced server-side in the `avatar_usage`
  table. Students cannot bypass it from the browser.
- Failures (timeout, safety block, API busy, dropped connection) **do not consume quota**.
- If the connection drops mid-call the server retries once before reporting an error.
- Concurrent calls to the image API are capped at 3 (`AVATAR_CONCURRENCY`) with a queue of
  24. If the queue is full, students are told to wait and retry.
- **NEW SESSION also resets everyone's quota**, since quota is counted per session. **CLEAR**
  does not reset it.
- The API key lives in `.env`, is read only on the server, and **is never sent to a
  student's device**.
- With no `GEMINI_API_KEY` the app still works normally — it just hides the AI avatar
  section.

## Managing data

- Everything lives in `data/wall.db` (SQLite). Delete the `data/` folder to wipe it all.
- **CLEAR** removes every card in the current session but keeps the same link.
- **NEW SESSION** closes the old session and opens a fresh one (empty wall) — handy when
  you teach the same class several times.
- **ALL .ZIP** downloads every card as a single archive.
- Students can download their own card from the final screen, or use the share button on
  mobile.

## Projector shortcuts

| Key | Action |
| --- | --- |
| `←` `→` | Move to the previous / next student |
| `Esc` | Back to the attract screen |
| `F` | Toggle fullscreen |

## Structure

```
worker/index.js        routes; instructor pages sit behind a passcode
worker/game.js         quiz + battle routes (thin — the rules live elsewhere)
worker/wall-hub.js     the Durable Object: SSE fan-out AND the room's game state
worker/store.js        D1 queries + R2 objects
lib/rpg/stats.js       stat growth, scoring, normalisation
lib/rpg/classes.js     class modifiers and the birth roll
lib/rpg/battle.js      the tournament: seeded RNG, bracket, and the timeline
lib/rpg/skills.js      15 named moves (5 classes × 3 stances)
lib/gemini.js          per-class prompts, the nano banana call, concurrency queue
lib/zip.js             store-only ZIP writer for the bulk download
public/index.html      student flow: identity → portrait → class → arena → pledge
public/js/play.js      the arena on a phone: quiz, stance, result
public/js/arena.js     the tournament renderer
public/js/quiz.js      the instructor's question bank and run controls
public/js/poster.js    draws the card on a canvas (1080×1440)
public/portraits/      class artwork, shown in the picker and as a portrait fallback
tools/battle-sim.js    balance check
public/fonts/          Press Start 2P + Noto Sans Thai, self-hosted so it works offline
```

**Stats are a shape, not a list.** The character sheet plots the five stats as a radar
(inline SVG, no library). Bars answer "how much"; the pentagon answers "what kind of
fighter am I" — the question a student actually has while picking a class and while
watching the shape swell after a right answer. Each class has recognisable
silhouette: the knight bulges toward HP and DEF, the thief toward SPD.

**One room per class.** The Durable Object is addressed by session id, not by a fixed
name. That is what makes switching classes lossless rather than destructive, and it means
two classes can hold entirely separate live state. Only one is *active* at a time, though
— the student link always resolves to whichever class is live — so running two lessons
simultaneously would need per-class join links, which this does not have.

**Where the game state lives, and why.** Fifty phones answering the same question inside
two seconds is the one hot path in this app. Routing that through D1 would put a network
round trip on every tap, so live state — characters, running stats, answers in flight, the
computed tournament — lives in the WallHub Durable Object's own SQLite storage, which is
single-homed and therefore able to answer "was this student in the fastest quarter of the
room". D1 keeps only what has to outlive the room: the questions, the cards, and a
snapshot of the final standings.

**The battle is computed before the first frame.** Pressing START BATTLE runs the whole
tournament immediately; what plays on the projector is a retelling of a timeline that
already exists, interpolated against the server's `startedAt`. That is what lets a
projector which reconnects halfway through resume at exactly the right moment instead of
replaying from the beginning — and it means the result cannot be changed by anything that
happens on a screen.

**Nothing on a phone is trusted with a score.** Elapsed time is measured against the
server's clock, never a value the client sends, and the correct answer is withheld from
the live broadcast until the question closes — so neither a fast clock nor an open
devtools window is worth anything.

**A student ID is an identity, not a password.** Typing an ID that already has a
character hands you that character, on any device, at any point in the lesson. That is
deliberate: a phone dies mid-class, someone borrows a handset, a browser clears its
storage — and being locked out of your own character for the rest of the lesson is a far
more likely harm than a classmate deciding to answer in your name. The consequence is
real and should be understood before the scores are used for anything: **anyone willing
to type a classmate's ID can play as them.** These scores are for waking a room up, not
for grading. If this app is ever used for marks, the token in `join` has to become a
credential again.

Cards are drawn with Canvas on the student's own device — no image API involved — so they
appear instantly, cost nothing, and work even when the classroom wifi is slow.

**Each class gets its own card colours** — ember red for warrior, steel blue for knight,
forest green for thief, violet for mage, warm gold for healer — so a wall of cards reads
as a party of different characters instead of fifty copies of the same blue card. A card
with no class (real photo only) keeps the default indigo. The palettes live on `JOBS` in
`lib/gemini.js` as `card: { bg, plate }`.

**The portrait sizes itself.** It grows up to 500 units when the answers are short and
shrinks back toward 340 when someone writes long ones, so the face is as big as it can be
without squeezing the text below a readable size. Scanlines are never drawn across the
portrait, and the page's CRT overlay is held off artwork and QR codes too — striping a
face is exactly what makes an avatar hard to recognise.

**Images upload as raw binary, not base64.** Creating a card is a small JSON `POST`
(`/api/posters`, metadata only) followed by binary `PUT`s of the PNGs to
`/api/posters/<id>/image/{full,display,photo}`. The display copy goes last, and its
arrival is what marks the row ready and broadcasts it to the wall — so a card never
appears with a missing image, and a half-finished upload simply stays invisible and is
swept on the next submit. This shape is a third smaller on the wire than base64-in-JSON
and costs roughly 14× less CPU to receive (measured 3.19 ms → 0.22 ms for a 2.6 MB card),
which is what makes a serverless deployment viable on a 10 ms CPU budget. The avatar route
likewise hands the model's base64 straight to the client instead of decoding and
re-encoding ~2 MB on the way through.

**Two sizes are stored per card.** The layout is authored in 1080×1440 design units and
rendered at 2× (2160×2880) so an AI avatar, which arrives at 1024², lands in the portrait
at close to its native resolution instead of being halved. That full-resolution PNG is
what `/p/full/<id>.png` serves for downloads and what goes into the ZIP; a 1080-wide copy
at `/p/<id>.png` is what the wall, projector and previews load, so the wall stays light
even with a full class on it.

The card banner carries the **session name**, so renaming the session on the wall page
renames every card built afterwards. Long names shrink to fit and truncate only as a last
resort.

There is no pixel-filter control: a real photo is posterised so it belongs inside the
pixel frame, and an AI avatar is left alone because it is already stylised and posterising
it twice only muddies the face.

The interface is in English, but Thai text still renders correctly if a student types it:
the Thai webfont ships with the app, and canvas line breaking uses `Intl.Segmenter` to
find Thai word boundaries, falling back to grapheme breaks so tone marks never separate
from their base character.

## Deploying

This runs on Cloudflare Workers, with D1 for records, R2 for images, and one Durable
Object for the room.

```bash
npx wrangler login                                  # the account that owns the worker
npx wrangler d1 migrations apply warrior-wall --remote
npm run deploy
npx wrangler secret put GEMINI_API_KEY              # optional; without it AI avatars hide
npx wrangler secret put WALL_PASSCODE               # gates /wall and /projector
```

### Setting the passcode — read this before you do

`wrangler secret put` reads the value from **stdin**, and when stdin is not a real
terminal it uploads an **empty string** and still prints `✨ Success!`. Run it from a
terminal where you actually see the `Enter a secret value:` prompt — not through an
editor's embedded shell, a CI step, or an agent. The tell is that prompt line: no prompt
means no value.

Always check afterwards, because an empty passcode used to mean *no* passcode:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<your-worker>/wall          # expect 401
curl -s -o /dev/null -w '%{http_code}\n' 'https://<your-worker>/wall?pass=X' # expect 401
```

**No native `prompt()` or `confirm()` anywhere.** Chrome offers "prevent this page from
creating additional dialogs" the second time a page opens one, and once that is ticked
every later call returns null or false *without showing anything* — which the calling code
reads as "cancelled". The symptom is a button that silently does nothing, on NEW SESSION,
on CLEAR, on START BATTLE. All of them now use in-page dialogs instead, which also look
like the rest of the app and behave the same on a phone.

Every instructor action reports its own failures. They are pressed in front of a class,
where a request that fails silently looks exactly like a button that does nothing — and a
401 from a rotated passcode or an expired cookie says so plainly and returns to the
passcode screen, rather than leaving the wall inexplicably unchanged.

The gate now **fails closed**: with no passcode set it opens only for `localhost`, so a
deployment that loses its secret locks out its owner rather than handing the room the
buttons that wipe the wall. To develop over a LAN address instead of loopback, put a
passcode in `.dev.vars`.

Migrations are additive: `0002_rpg.sql` only creates new tables and adds nullable columns,
so cards from an earlier class survive it untouched and keep rendering exactly as they did
— they simply have no character attached.

There is also a plain Node build (`npm start`, SQLite on disk) kept for local development
without a Cloudflare account. It predates the quiz and does not serve it.
