---
name: narrated-web-app-demo
description: Create narrated, voice-over screen-recording demo videos of web applications — including authenticated apps behind SSO/login. Drives a real browser through scripted UI actions with an animated cursor and button highlights, generates per-segment TTS narration, and renders a 4K MP4. Use when asked to "make a demo video", "record a product walkthrough", "screen recording with voiceover", "演示视频", "录制产品演示", or to showcase the features of a web app. Built on top of the `ndemo` toolkit (github.com/splitbrain/ndemo) plus enhancements for authenticated apps, file upload, multi-provider TTS, and reliable headless rendering. 中文触发 — 产品演示视频, 给投资人看的演示, 功能录制, 教程视频, 制作演示视频.
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
- **Re-dub + subtitles (no re-record)** — turn a finished recording into other
  languages and burn minimalist subtitles, without driving the live app again.

## What the agent does from one sentence

When the user says e.g. *"make a demo of <app> in German, English and Chinese with
subtitles"*, you run the whole thing — the user only logs in once (SSO can't be
automated for them) and approves. Your loop:

1. **Prereqs** — `bash scripts/setup.sh` in the project (downloads a freetype
   ffmpeg into `bin/`, checks node/yq/fonts, scaffolds `.env`,
   `redub.config.json`, `i18n/narration.json`, updates `.gitignore`). Then
   `bash scripts/install.sh` for the ndemo engine (only needed to *record*).
2. **You author the playbook + narration** — write segments (one feature each) and
   the spoken narration yourself. Do NOT ask the user to write narration. Follow
   `references/authoring-narration.md` for length/timing/tone.
3. **Record once** — `$NDEMO open`, user logs in, `$NDEMO capture-auth`, iterate
   segments (`page-state` → actions → `play --segment`), then `$NDEMO render`.
4. **Other languages** — translate narration into `i18n/narration.json`, then
   `redub-tts` + `redub` per language (no re-record). Languages without a `tts`
   entry get subtitles-only over the original audio.
5. **Verify** — extract one frame per segment per language; eyeball sync + subs.

So "one sentence" still implies: the user provides the app URL, performs the login
when prompted, and approves the result. Everything else is yours.

## Setup (once per machine/project)

```bash
bash scripts/setup.sh              # ffmpeg(+freetype) into bin/, deps + font check, scaffolds config/.env
bash scripts/install.sh            # ndemo engine -> ~/.claude/skills/ndemo (only to RECORD new demos)
```

`setup.sh` is the important new step: Homebrew's default `ffmpeg` is **minimal**
(no freetype/libass → no `drawtext`/`subtitles`), so subtitle burning fails. It
fetches a full static ffmpeg into `bin/` and the redub scripts use it. Put the TTS
key in `.env` (git-ignored), not the shell:

```bash
echo 'MINIMAX_API_KEY=...' > .env        # for MiniMax voices (provider: minimax)
# OPENAI_API_KEY=... also works for upstream OpenAI voices during recording
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

## Re-dub into other languages + burn subtitles (no re-record)

Already have a finished recording and want English / Chinese / … versions with
subtitles? Do **not** re-render (it re-drives the live app and, for LLM apps,
changes the on-screen output). Reuse the recorded pixels: swap the narration audio
and burn minimalist subtitles.

```bash
cp ~/.claude/skills/narrated-web-app-demo/assets/templates/redub.config.template.json   redub.config.json
cp ~/.claude/skills/narrated-web-app-demo/assets/templates/narration.template.json      i18n/narration.json
# fill narration.json (per-part text per language + outro cards + tts voices)
set -a; . ./.env; set +a                       # MINIMAX_API_KEY
node ~/.claude/skills/narrated-web-app-demo/scripts/redub-tts.mjs en   # synth audio-en/
node ~/.claude/skills/narrated-web-app-demo/scripts/redub.mjs    en    # -> demo-final-en.mp4
node ~/.claude/skills/narrated-web-app-demo/scripts/redub.mjs    de    # original lang: subtitles only
```

- A language **with** a `tts.<lang>` entry → full re-dub (TTS audio at the original
  segment offsets, fit-to-window, translated end card).
- A language **without** one → keep-audio mode (original audio untouched, subtitles
  only, original end card kept) — perfect for subtitling the original language.
- Subtitles are rendered with `drawtext`, **not libass** (libass injects a phantom
  comma glyph on multi-event files). Needs an ffmpeg with freetype — Homebrew's
  default ffmpeg is minimal; fetch a full static build (see the reference).

See `references/redub-and-subtitles.md` for the full how-to, the libass gotcha, and
the ffmpeg/font setup.

## References

- `references/authenticated-apps.md` — capture/restore auth, scripted SSO login,
  recording the login screen, the profile-lock and `close` pitfalls.
- `references/gotchas.md` — every hard-won lesson: timing/sync, render crashes,
  Retina window, popup suppression, native `<select>` handling, exact matching,
  file upload.
- `references/redub-and-subtitles.md` — re-dub a finished recording into other
  languages + burn minimalist subtitles without re-recording (drawtext, not
  libass; ffmpeg-with-freetype setup; keep-audio vs dub modes).
- `references/authoring-narration.md` — how to write narration + translations that
  fit the segment windows (you author these, not the user): length, timing, tone.
- `scripts/setup.sh` — per-machine prep: static ffmpeg, dependency + font checks,
  config/.env scaffolding.
- `assets/templates/` — ready-to-edit playbook + re-dub templates.

## Credit

The underlying recording/replay/TTS engine is **ndemo** by splitbrain:
https://github.com/splitbrain/ndemo. This repository adds a workflow guide,
templates, and an enhancement patch on top of it.
