# ⚔ AI Warrior Wall of Pledging

An end-of-class web app with a 24-bit JRPG theme. Students take a selfie, enter their
name and student ID, note **1–3 key takeaways**, and **pledge 1–3 next actions**. The app
instantly builds a **warrior card** for them, it lands on the instructor's wall in real
time, and the instructor can put any student's pledge up on the projector.

Students can keep their real photo or let **AI (nano banana) paint them as a JRPG
character** while still being recognisable. Five classes to pick from — warrior, knight,
thief, mage, healer — capped at 3 generations per student so the API key can't blow
through its quota.

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
server.js              HTTP + SSE, no framework
lib/db.js              schema + queries (Node's built-in node:sqlite)
lib/gemini.js          per-class prompts, the nano banana call, concurrency queue
lib/zip.js             store-only ZIP writer for the bulk download
public/index.html      5-step student form
public/wall.html       instructor page
public/projector.html  projection screen
public/js/poster.js    draws the card on a canvas (1080×1440)
public/fonts/          Press Start 2P + Noto Sans Thai, self-hosted so it works offline
```

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

This is a plain Node server with SQLite on disk. For production:

- **Easiest**: Railway / Render / Fly.io — deploy as-is, just mount a volume at `data/`.
- **Vercel**: you'd need to swap storage for Postgres + Blob first, since serverless
  functions can't write to disk.
- If you expose it publicly, add a passcode in front of `/wall` and `/projector`.
