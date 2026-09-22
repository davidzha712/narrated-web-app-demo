---
name: narrated-web-app-demo
description: Create narrated, voice-over screen-recording demo videos of web applications — including authenticated apps behind SSO/login. Drives a real browser through scripted UI actions with an animated cursor and button highlights, generates per-segment TTS narration, and renders a 4K MP4. Use when asked to "make a demo video", "record a product walkthrough", "screen recording with voiceover", "演示视频", "录制产品演示", or to showcase the features of a web app. Built on top of the `ndemo` toolkit (github.com/splitbrain/ndemo) plus enhancements for authenticated apps, file upload, multi-provider TTS, and reliable headless rendering.
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep]
---

# narrated-web-app-demo

Produce a polished, narrated demo video of a web application. You script the
tour as a YAML *playbook* (segments = narration + browser actions), the toolkit
drives a headless Chromium through it with a visible animated cursor + button
highlights, synthesizes voice-over per segment, and merges everything into a 4K
MP4 with subtitles.

This skill wraps the upstream **`ndemo`** tool (by splitbrain) and adds the
pieces needed for real-world product demos:

- **Authenticated apps** — capture a logged-in session once and replay it into
  the headless render (so SSO/login is not re-required on every render).
- **`upload` action** — attach real files via the hidden `<input type=file>`
  (no OS file-chooser), to demo document upload / RAG.
- **MiniMax TTS provider** — high-quality non-English (e.g. German) voices, in
  addition to upstream OpenAI/ElevenLabs.
- **Reliability fixes** — Retina-correct interactive window, popup suppression
  (translate / save-password / notifications), `exact` role-name matching,
  and a `close` that preserves the profile instead of wiping it.

## Setup (once)

```bash
bash scripts/install.sh            # installs to ~/.claude/skills/ndemo
# or: bash scripts/install.sh /path/to/ndemo
```

This clones `splitbrain/ndemo`, applies `patches/ndemo-enhancements.patch`,
runs `npm install && npm run build`, and installs the Playwright browser.

`patches/ndemo-action-if.patch` is a separate, optional patch applied **after**
the main one. It makes `if: { visible | hidden | url }` work on segment actions
(it already worked on `app.setup` steps), so a playbook can step through a
first-visit tour without failing the render on the run where the tour does not
appear.
Set a TTS key in your shell (never commit it):

```bash
export OPENAI_API_KEY=...        # for the default OpenAI voices
export MINIMAX_API_KEY=...        # for MiniMax voices (provider: minimax)
```

Throughout, `NDEMO=~/.claude/skills/ndemo/ndemo`.

## Workflow

### 1. Write the playbook

Copy `assets/templates/webapp-demo.template.yaml` into the project under
`demo/<name>/<name>.yaml`. Fill `app.url`, the `tts` block, and write each
segment's `narration` (the spoken voice-over) + `intent` (what the actions
should accomplish). Leave `actions: []` empty for now.

Key rules baked into the template (see `references/gotchas.md` for *why*):

- **`timing: parallel`** on every content segment — narration plays *while* the
  actions run, so the voice matches what's on screen. (`after` plays the whole
  narration over the previous frame first — voice ends up on the wrong shot.)
- **Fixed `wait`s, not `done: {text: ...}`** for slow / streaming responses —
  polling a text locator across a long streaming update can crash the headless
  browser. Pick a wait that matches the observed response time.
- One segment per feature; keep narration ~10–15s.

### 2. Open the browser & log in (authenticated apps)

```bash
$NDEMO open demo/<name>/<name>.yaml      # opens a REAL, visible window
```

Log in by hand in that window (or script the login — see
`references/authenticated-apps.md`). Then capture the session **while the
daemon is still running**:

```bash
$NDEMO capture-auth                       # writes .ndemo/auth.json (cookies + localStorage)
```

`auth.json` is git-ignored and lets the headless render reuse the login.

### 3. Author each segment

For each segment, discover the UI then write actions:

```bash
$NDEMO page-state                         # accessibility tree of the current screen
$NDEMO page-state --screenshot            # + .ndemo/screenshot.png
$NDEMO play demo/<name>/<name>.yaml --segment <id>   # test one segment (rewinds first)
```

Target elements by `role`+`name` (add `exact: true` to avoid substring
collisions like `high` vs `xhigh`), or by `selector` / `testId`. Use a stable
CSS `selector` when the accessible name is dynamic or duplicated. Discover
hidden menus by clicking their trigger and re-running `page-state`.

Iterate: `page-state` → write actions → `play --segment` → adjust.

### 4. Review

```bash
$NDEMO play demo/<name>/<name>.yaml --audio     # full run with voice-over (visible)
```

### 5. Render

```bash
$NDEMO close                              # free the profile (preserves auth.json)
$NDEMO render demo/<name>/<name>.yaml --output demo/<name>/<name>.mp4
```

The render is **headless** (no visible window) — it records via CDP screencast
and produces a 4K MP4 + `.srt`. It restores `auth.json` so the app is logged in.

### 6. (Optional) Login-intro + concat

To open the video with the login screen, render a logged-out intro and
concatenate. See `references/authenticated-apps.md` (the "Recording the login"
section) and `assets/templates/login-intro.template.yaml`.

## Best practices

**Calibrate waits — don't guess.** For each segment that waits on an async
response, run it once (`play --segment <id>`) and note how long the response
actually takes. Then either:
- set a fixed `wait` a little longer than observed (proven-safe, deterministic), or
- use a **smart wait** `done: { stable: 1500, timeout: 30000 }` after the
  send — the segment proceeds as soon as the DOM stops changing for 1.5s, so
  there is no dead time *and* no under-cutting. `done` is **non-fatal**: a
  timeout logs and continues instead of crashing the render.
- Do **not** use `done: { text: ... }` on a page that streams for a long time —
  the locator polling can crash the headless browser. Prefer `stable` /
  `networkIdle`, or a fixed wait.

**Trim dead time.** Use `timing: parallel` everywhere; keep narration ~10–15s;
size waits to the *response*, not a round number. A 90s "searching" shot is
boring — show enough to prove it works and move on.

**Verify before delivering.** The render is headless, so confirm the result:
```bash
ffprobe -v error -show_entries format=duration eva.mp4
for t in 30 60 100 150; do ffmpeg -y -ss $t -i eva.mp4 -frames:v 1 /tmp/f$t.png; done
```
Eyeball one frame per segment — confirm it's logged in, centered, and showing
the intended content (not a spinner or the wrong screen).

**Render reliably.** `close` the daemon before `render` (they fight over the
profile). Keep credentials out of the repo (`*.local.yaml`, env vars). If a
render fails, an `error-<segment>.png` is written to the output dir.

**Polish in post (optional, via ffmpeg).** Background music bed and an outro are
a post-step, not part of ndemo:
```bash
# duck a music bed under the narration
ffmpeg -i demo.mp4 -i music.mp3 -filter_complex \
  "[1:a]volume=0.12[m];[0:a][m]amix=inputs=2:duration=first" -c:v copy demo-music.mp4
```

**Polish (built — opt-in via a `polish` block + `outro`):**
```yaml
outro: { title: "Thanks", subtitle: "...", duration: 3500 }   # end card
polish:
  zoom:    { enabled: true, scale: 1.3 }        # cinematic zoom toward the first
                                                #   focus action of each segment,
                                                #   held, reset on scene change
  framing: { enabled: true, background: "#e6e6ec", padding: 0.045, shadow: true }
  music:   { file: "/abs/path/bed.mp3", volume: 0.12 }   # ducked music bed
```
- **zoom** — CSS-transform zoom toward the element being acted on; composes with
  the base browser zoom. Reset (zoom-out) at each segment start.
- **framing** — scales the capture onto a padded background with a soft shadow.
- **music** — loops + ducks a track under the narration (you supply the file).
- **idle speed-up** — not a flag: use smart `done: { stable: ... }` waits so a
  segment ends the moment the page settles (no dead time). `done` is non-fatal.

## References

- `references/authenticated-apps.md` — capture/restore auth, scripted SSO login,
  recording the login screen, the profile-lock and `close` pitfalls.
- `references/gotchas.md` — every hard-won lesson: timing/sync, render crashes,
  Retina window, popup suppression, native `<select>` handling, exact matching,
  file upload, and the production-run section at the end (the two opposite
  concat audio failures — silent in QuickTime, and upmix artifacts — single-use
  auth tokens, the daemon's silent exit and profile lock).
- `references/post-production.md` — framing the raw render inside a 4K browser
  chrome image, title/outro cards, burned-in subtitles, and the concat rule that
  keeps the audio audible.
- `assets/templates/` — ready-to-edit playbook templates.

## Credit

The underlying recording/replay/TTS engine is **ndemo** by splitbrain:
https://github.com/splitbrain/ndemo. This repository adds a workflow guide,
templates, and an enhancement patch on top of it.
