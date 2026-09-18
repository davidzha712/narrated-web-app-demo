# Re-dub into other languages + burn minimalist subtitles (no re-record)

When the original recording is already good, do **not** re-run `ndemo render` to
make another-language version — it drives the live app again (needs auth) and, for
LLM-backed apps, produces different on-screen output every run. Instead reuse the
recorded pixels and only swap the audio + add subtitles.

`scripts/redub.mjs` + `scripts/redub-tts.mjs` do this, driven by two files:

- `redub.config.json` — which video parts to process, fonts, subtitle style
  (copy `assets/templates/redub.config.template.json`).
- `i18n/narration.json` — per-part, per-language narration text + `outro` cards +
  `tts` voices (copy `assets/templates/narration.template.json`).

## Two modes (auto-selected per language)

- **dub** — language HAS a `tts.<lang>` entry → synthesize narration, place each
  segment's audio at its original video offset (cumulative `videoDuration` from
  the playbook, + `titleCardMs`), speed-fit to the segment window via `atempo`,
  mix onto silence, overlay a translated end card.
- **keep-audio** — language has NO `tts.<lang>` entry (typically the original
  language) → keep the source audio untouched, burn subtitles only, keep the
  original end card.

## Run

```bash
set -a; . ./.env; set +a            # MINIMAX_API_KEY for dub languages
node scripts/redub-tts.mjs en        # synth audio-en/  (skip for keep-audio langs)
node scripts/redub-tts.mjs zh
node scripts/redub.mjs de            # keep-audio: original audio + German subs
node scripts/redub.mjs en            # dub: English audio + English subs + card
node scripts/redub.mjs zh
# -> demo-final-de.mp4 / demo-final-en.mp4 / demo-final-zh.mp4
```

## Subtitles use drawtext, NOT libass (important)

Several `libass` builds (seen with ffmpeg 8.1 static, martin-riedl) render a
**phantom comma glyph** at the left of an event whenever a comma exists *anywhere*
in the subtitle file — with both `BorderStyle=3` (box) and `BorderStyle=1`
(outline). It is not in the text; isolated single events render clean, multi-event
files do not. Unavoidable via styling.

So subtitles are drawn with ffmpeg's `drawtext` (freetype): one `drawtext` filter
per cue, text supplied via `textfile=` (no escaping), gated with
`enable='between(t,a,b)'`. drawtext draws exactly the given text — one clean
translucent pill per cue, no phantom. Style: white text, `box=1` with a
semi-transparent dark `boxcolor` (reads well on light *and* dark UIs), single line
per cue (short cues), bottom-centered.

## ffmpeg requirement

Needs an ffmpeg built with **freetype** (`drawtext`) — and Homebrew's default
`ffmpeg` formula is **minimal** (no freetype/libass). Fetch a full static build
once and point the config at it:

```bash
mkdir -p bin && cd bin
curl -fsSL -o ffmpeg.zip  https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip
curl -fsSL -o ffprobe.zip https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip
unzip -o ffmpeg.zip && unzip -o ffprobe.zip && chmod +x ffmpeg ffprobe && rm *.zip
```

`redub.config.json` `ffmpeg`/`ffprobe` keys point here. Fonts resolve via
`fc-match` (libass-free): Latin → "Helvetica Neue", CJK → "PingFang SC".

## Timing notes

- Segment offsets come from the playbook's `videoDuration` fields (read via `yq`),
  so audio + subtitles stay locked to the recorded action. Offsets are absolute
  per segment — no drift accumulates.
- If a dubbed clip overruns its segment window it is sped up (capped ~1.4x); if it
  underruns, the segment simply finishes quiet, matching the original pacing.
- `.env`, `audio-*/`, `.redub/`, `bin/` should be gitignored.
