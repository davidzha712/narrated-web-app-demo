# Authoring narration (and translations) that fit the recording

The narration is written by *you* (the agent), not the user. Good narration is the
difference between a demo that feels scripted and one that feels like dead air with
captions. These are the rules that worked in practice.

## Writing the original narration

- **One feature per segment.** Each `segment` = one thing the UI does. Don't cram.
- **~10–15 s spoken per segment.** At normal TTS speed that's ~25–40 words (EN/DE)
  or ~35–55 characters (ZH). Longer drifts out of sync with the action.
- **Narrate what's on screen, as it happens.** Segments use `timing: parallel`, so
  the voice plays *over* the actions. Write "In the top left we choose the model"
  while the cursor opens that menu — not before, not after.
- **Plain spoken register.** Short clauses, active voice, no marketing fluff, no
  reading out UI labels verbatim. Say the benefit, not the button name.
- **Open and close.** First segment: what the product is + one trust line. Last
  segment: one-sentence recap + where to get help. Keep both tight.
- **Lead with the verb of the demo**, e.g. "Using the globe icon we enable web
  search" — viewer's eye follows the action.

## Fitting the segment window

Each segment has a `videoDuration` (how long the on-screen actions take). The
narration audio is placed at the segment's start and must fit inside that window:

- If the spoken line is **longer** than the window, `redub.mjs` speeds it up via
  `atempo` (capped ~1.4×). Past ~1.15× it sounds rushed — so keep lines short
  enough to *not* need much speedup. Check the `fit … tempo` log lines.
- If **shorter**, the segment finishes quiet while the action completes — fine, and
  matches how the original recording paces (some actions are long, e.g. streaming).
- The tightest segments are the static ones (intro, section transitions) where
  `audioDuration ≈ videoDuration`. Write those especially lean.

## Translating for re-dub

- **Match length, not words.** Translate to roughly the same spoken duration as the
  source so it still fits the window. EN and DE run similar length; ZH is usually
  denser (fewer characters, shorter) — that's fine, it just finishes earlier.
- **Keep the meaning and the on-screen reference.** If the source says "click the
  plus icon", the translation must still describe that same visible action.
- **Leave UI text that stays on screen in its original language.** The recorded
  pixels don't change — if the app UI is German, an English narration saying "the
  menu on the left" is correct even though the menu reads in German. Don't pretend
  the UI is translated.
- **Outro card** (`outro.<lang>` in narration.json) is re-rendered per language, so
  translate title + subtitle fully.
- Numbers, product names, and code stay verbatim across languages.

## Subtitle behavior (automatic)

`redub.mjs` splits each segment's narration into short **single-line** cues and
times them proportionally across the spoken audio. You write whole sentences; the
chunker handles line length (≤54 Latin chars / ≤26 CJK) and timing. Don't pre-wrap
with newlines. Subtitles render as a translucent dark pill via `drawtext` (see
`redub-and-subtitles.md` for why not libass).
