# Post-production: title card, subtitles, 4K browser frame

`$NDEMO render` gives you a raw MP4 at the viewport resolution plus a matching
`.srt`. Everything below is optional polish applied afterwards with `ffmpeg`
and two small Python scripts. Nothing here is part of ndemo.

Shot at `viewport: 1920x1080` with `scale: 2`, the raw file is 3840x2160 — but
it is *all page*, no browser. Framing it inside a browser chrome image means
the page no longer fills 4K, so the raw is composited onto a 3840x2160 canvas
at an offset.

## Step 1 — frame the raw inside browser chrome

```bash
ffmpeg -y \
  -f lavfi -i "color=c=#f6f4f3:s=3840x2160" \
  -i raw.mp4 -i chrome4k.png \
  -filter_complex "[0][1]overlay=48:160:shortest=1[a];[a][2]overlay=0:0" \
  -c:a copy -shortest framed.mp4
```

`chrome4k.png` is a 3840x2160 PNG with a transparent window cut-out; `48:160`
is where that cut-out starts. Make the two agree once and reuse them — a
mismatch shows as a hairline of background along one edge.

## Step 2 — title and outro cards

Generate a still with Pillow, then a clip with a **silent** audio track:

```bash
ffmpeg -y -loop 1 -i title.png -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 \
  -t 3 -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -shortest title.mp4
```

Note `channel_layout=stereo`. This is exactly where the mono/stereo mismatch in
gotchas.md is born — see step 4.

## Step 3 — burn the subtitles

Pillow renders one transparent PNG per cue and ffmpeg overlays each with
`enable='between(t,start,end)'`. Scale every size by `k = W/1920` so the same
script works at 1080p and 4K:

- font 40*k, line height 52*k, box padding 14*k, corner radius 14*k
- wrap at 1500*k px, bottom margin 40*k
- box `fill=(20,24,18,200)`, text white

Reasons not to use `-vf subtitles=file.srt`: libass styling is awkward to get
consistent across resolutions, and the overlay approach gives exact control of
the box.

The burner encodes video and should pass audio through with `-c:a copy` — fast,
and any channel-count problem gets fixed in the final mux, not here.

## Step 4 — concat, and the one rule that matters

```bash
printf "file 'title.mp4'\nfile 'body-sub.mp4'\nfile 'outro.mp4'\n" > concat.txt
ffmpeg -y -f concat -safe 0 -i concat.txt \
  -c:v copy -c:a aac -ac 2 -ar 44100 -b:a 192k -f mp4 final.mp4
```

**Never `-c copy` here.** The cards are stereo, the body is mono, and stream
copy writes one `AudioSpecificConfig` from the first input — the result plays
silent in QuickTime and Safari while ffprobe reports healthy audio. Full
explanation in `gotchas.md`.

Verify:

```bash
ffprobe -v error -select_streams a:0 -show_entries stream=channels,sample_rate -of csv=p=0 final.mp4
# expect: 2,44100
```

## Estimating `audioDuration` before you have audio

`timing: parallel` needs `audioDuration` and `videoDuration` in the playbook,
but you only learn the real narration length after synthesis. For Dutch TTS at
speed 1, **~82 ms per character** of narration text estimates the audio length
well enough to author with; set `videoDuration` to that or higher, never lower,
or the segment cuts the voice off. After the first render, read the real
durations out of the `.srt` and correct the playbook.

## One video per role, not one video with role switches

A role switcher mid-playbook changes the whole nav tree, so selectors written
for one role silently miss under another, and the narration has to explain the
switch. Author one playbook per role against the same app, render them
separately, and frame them all with the same chrome image so the set looks like
one production.
