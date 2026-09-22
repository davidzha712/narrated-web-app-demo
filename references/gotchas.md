# Gotchas & hard-won lessons

Every item here cost real debugging time. Read before authoring.

## Voice-over sync: use `timing: parallel`

`ndemo` segment timing:

- `after` (upstream default) — plays the **entire** narration first, with the
  screen frozen on the *previous* segment's last frame, **then** runs the
  actions. Result: the voice describes an action that hasn't happened yet, over
  the wrong shot. Also adds the full narration length as dead time.
- `parallel` — actions run **while** narration plays. The voice matches what's
  on screen. Use this for essentially every segment.

If actions finish before narration, the last frame holds until audio ends. If
narration finishes first, the remaining actions play out (e.g. a streaming
answer appearing) silently — usually fine.

## Render crash on long/streaming waits: avoid `done: {text: ...}`

A `done: { text: { selector: "button", has: "View source" }, timeout: 120000 }`
polls a text locator repeatedly. On a page that streams content for 60–90s
(web search, long generations) this reliably **closes/crashes the headless
browser** ("Target page, context or browser has been closed").

Fix: use a **fixed `wait`** sized to the observed response time, or a smart
`done: { stable: 1500, timeout: 30000 }` / `done: { networkIdle: true }` which
ends as soon as the page settles. A 45–55s fixed wait records fine; the crash
was the polling locator, not the duration. Frames are captured on-change, so a
static post-response screen adds few frames.

`done` is **non-fatal** in this patch: if a condition times out or errors, the
action logs `(done not met, continuing: …)` and the render proceeds, instead of
aborting. So smart waits are safe to use — worst case they fall through to the
segment's own fixed-wait bound. (`stable`/`networkIdle` are still preferred over
`text` on long-streaming pages.)

## Keep single-column layout centered

If the app supports multi-model / split views, an accidental "Add model" leaves
a 2-column comparison that looks off-center. Keep one model selected (a `setup`
step that selects the base model gives every run a clean, centered start).

## Interactive window must be Retina-correct

Upstream daemon forced `--window-size=1920,1080` + `--force-device-scale-factor=1`,
which on a Retina Mac renders an oversized, non-crisp window. The patch uses
`--start-maximized` + `viewport: null` so the window fits the screen at the
display's native DPR. (The render keeps its own high-res 4K viewport — these are
independent.)

## Suppress browser popups in recordings

Chrome's translate bar / save-password bubble / notifications can appear in the
recording. Both daemon and renderer launch with:
`--disable-translate --disable-notifications --disable-save-password-bubble`
and `--disable-features=Translate,TranslateUI,PasswordManagerOnboarding,...`.

## Setup steps fail on the login page → daemon self-kills

The daemon runs `app.setup` after navigation. If `setup` clicks an app element
(e.g. the model selector) but you're not logged in yet, it times out and the
daemon process exits. **Open with a setup-less playbook for the login phase**,
or only add `setup` once auth is captured.

## Element targeting

- Role-name matching is **substring + case-insensitive**. `name: "high"` also
  matches `xhigh`; `name: "Default"` also matches `Set as default`. Add
  `exact: true` (patched in) to pin it.
- Composite/duplicated buttons (a button wrapping a button) cause strict-mode
  violations — the error message lists every match **with a usable selector**;
  copy the stable one (often an `#id` or a class combo).
- Native `<select>` shows as `combobox` in the a11y tree; options aren't
  clickable as elements. Use the `select` action (`selectOption`), not a click.

## File upload

There is no OS file-chooser in headless. The patched `upload` action sets files
directly on the hidden input:
`{ type: upload, target: { selector: "input[type=file][multiple]" }, files: ["/abs/path"] }`.
Target `[multiple]` to avoid matching a separate camera/image input.

## Iterate fast with a scratch playbook

`play` always rewinds (re-runs prior segments). To probe one interaction
without re-running an expensive prefix, make a tiny single-segment
`scratch.yaml` and `play --segment` it — the daemon is shared, so it acts on the
same live browser.

---

# Lessons from a 4-video, 52-segment production run (2026-09)

These come from recording a real multi-role product tour of an authenticated
Next.js app. Every one cost an hour or more.

## Silent video: concat with `-c copy` across mismatched channel counts

The single worst failure of that run, because **every automated check passed.**

A post-production chain that prepends a title card and appends an outro:

```bash
ffmpeg -f concat -safe 0 -i concat.txt -c copy out.mp4     # BROKEN
```

The cards' silent tracks were generated with
`anullsrc=channel_layout=stereo` (2 channels). The body came from ndemo's
render, whose narration track is **mono** (1 channel). In an MP4 the
`AudioSpecificConfig` is written once, from the *first* input — so the
container declares stereo while the body's packets are mono.

FFmpeg's own AAC decoder reconfigures per frame, so `ffprobe`, `volumedetect`
and `ffplay` all report healthy audio. **QuickTime and Safari play it
silent.** The verification tool and the target player disagree, which is
exactly why self-checking missed it.

Fix — make every input the *same* channel count, and re-encode on the concat
step (never `-c copy`). The narration is mono, so generate the cards' silence
mono too and mux mono out:

```bash
# cards
ffmpeg ... -f lavfi -i anullsrc=channel_layout=mono:sample_rate=44100 ... title.mp4
# final mux
ffmpeg -f concat -safe 0 -i concat.txt \
  -c:v copy -c:a aac -ac 1 -ar 44100 -b:a 192k -f mp4 out.mp4
```

Then verify the *channel count*, not the loudness:

```bash
ffprobe -v error -select_streams a:0 -show_entries stream=channels,sample_rate -of csv=p=0 out.mp4
```

Corollary: if an intermediate step uses `-c:a copy` (a subtitle burner, a
frame compositor), mono propagates through it invisibly. Only the final mux
has to be right, but only the final mux can fix it.

## `-ac 2` is not the fix — it is the next bug

The obvious repair for the mismatch above is to upmix everything to stereo on
the final encoder: `-c:a aac -ac 2`. It produces a file that passes every
check *and sounds wrong* — audible artifacts through the narration.

Feeding one AAC encoder a concat of mixed-channel inputs while asking it to
resample to 2 channels is where the damage happens. The evidence is in
`astats`: a genuine 1→2 upmix writes two **identical** channels, so any
difference between them proves the samples were mangled, not copied. The
broken run read:

```
Channel: 1   Peak level dB: -3.581856   Peak count: 2
Channel: 2   Peak level dB: -8.191109   Peak count: 16
```

The fix is the one above — keep the whole chain at one channel count and mux
`-ac 1`. After that, `astats` prints a single `Channel: 1` block whose numbers
match the source narration.

Two rules that cannot both be relaxed:

- **Never `-c copy`** on the concat (silent in QuickTime).
- **Never `-ac 2`** over mixed-channel inputs (artifacts).

Read them as one rule: the channel count must be decided at the *source*, not
at the mux.

## `astats` prints at `info` level too

Same trap as `volumedetect` below, and it bites harder because `astats` is the
only tool that shows the per-channel numbers the artifact check needs:

```bash
ffmpeg -hide_banner -nostats -i out.mp4 -map a:0 -af astats -f null - 2>&1 \
  | grep -E "Channel:|Peak level|RMS level|Peak count"
```

`-v error` silences it completely, which reads as "clean".

## `ffmpeg` picks the muxer from the extension

Writing to `out.mp4.new` (a common "write then `mv`" pattern) fails with
`Unable to choose an output format for 'out.mp4.new'` and exit 234. Either
write to a standard extension, or pass `-f mp4` explicitly. Always pass `-f`
when the name is generated.

## `volumedetect` prints at `info` level

`ffmpeg -v error -af volumedetect ...` prints nothing at all, which reads as
"no audio". Use `-hide_banner` and leave the log level alone.

## A captured session's refresh token can be single-use

Supabase (and any auth with rotating refresh tokens) invalidates the old token
the moment it is redeemed. If you "verify" `.ndemo/auth.json` by loading it in
a throwaway browser context, that context redeems the token and **the copy on
disk is now dead** — the render then lands on the login page. Capture it, do
not test it; the render is the test.

## `open` exits silently when the app redirects to login

`browser-daemon.ts` prints its `wsEndpoint`, then reopens stdout/stderr onto
`.ndemo/daemon.log`, then navigates, then calls `setBrowserZoom`. If the app
bounces to a login route during that window, the zoom extension call races the
navigation and the daemon dies **after** the parent has already been told it
started. The parent sees success; nothing works afterwards.

Symptom: `open` returns cleanly, every later command times out. Read
`.ndemo/daemon.log` — it is the only place the error went.

## There is no `navigate` action

Segments act on whatever page the previous segment left behind. A segment that
follows a link out of the app shell (an external doc, a logout, a 404) strands
**every subsequent segment**, and the render keeps going, producing 20 shots
of the same wrong screen. Move between app routes by clicking real nav links,
and re-check the final frame of any segment that navigates.

## An opened dialog leaves an `aria-hidden` backdrop that eats clicks

Product tours, onboarding modals and command palettes typically mark the rest
of the page `aria-hidden` and overlay a backdrop. If a segment opens one and
does not close it, every later click resolves to the backdrop. Nothing errors
— the actions "succeed" and the UI never changes.

Close what you open, in the same segment, and prefer normalising the app's own
first-visit state before recording (clear or set the localStorage flags that
gate the tour) over scripting your way through it.

## The daemon's profile lock kills the render *after* TTS is paid for

`browser-daemon.ts` uses `.ndemo/browser-profile` as a persistent
`userDataDir`. A still-running daemon holds Chromium's `ProcessSingleton` lock,
and the render fails to launch — but only after synthesising every segment's
narration, so a paid TTS provider has already been billed for the whole run.
Run `$NDEMO close` before `render`, every time, and treat a leftover
`browser-profile` directory as a launch hazard.

## `if:` on a segment action (patch `ndemo-action-if.patch`)

`app.setup` steps support `if:`; segment actions did **not** — the schema
accepted the key and the executor ignored it, so a playbook that guards
"click Next if the tour appeared" silently ran the click unconditionally and
crashed on the run where the tour did not appear. `patches/ndemo-action-if.patch`
adds `visible` / `hidden` / `url` guards to segment actions, mirroring setup.

## Selector notes from this run

- `a[href='/some/route'] >> nth=0` is the reliable way to reach a nav
  destination that has no unique accessible name (a sidebar link duplicated in
  a breadcrumb, an icon link).
- A native `<select>` is targeted by its label:
  `target: { label: "Filter by discipline" }`, with `option:` matching the
  option text. Clearing it is `option: ""`.
- A role-switcher ("view as") is a `select` in, and a named button
  (`Back to admin`) out. Switching roles mid-playbook changes the whole nav
  tree — put each role in its own playbook instead.
