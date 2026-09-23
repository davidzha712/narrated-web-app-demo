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
  -f lavfi -i "color=c=#f6f4f3:s=3840x2160:rate=30" \
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
ffmpeg -y -loop 1 -r 30 -i title.png -f lavfi -i anullsrc=channel_layout=mono:sample_rate=44100 \
  -t 3 -r 30 -c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -shortest title.mp4
```

**The card text belongs in the playbook's `titleCard:` / `outro:` block, not in
a shell argument.** A compositing script that caches the rendered PNG
(`[ -f title.png ] || card.py "$TITLE" ...`) silently ignores the text you pass
on a re-run, so a changed title takes no effect and no error says so. Worse,
after the run the only record of what the card said is the PNG itself — the
argument is gone with the shell history. Put the strings in the playbook and
have the script read them from there.

`channel_layout=mono` matches the narration track ndemo renders. Write
`stereo` here and the concat in step 4 gets mixed channel counts — the two
failures documented in gotchas.md (silent in QuickTime, or audible artifacts)
both start on this line.

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
  -c:v copy -c:a aac -ac 1 -ar 44100 -b:a 192k -f mp4 final.mp4
```

Every input is mono by now (step 2 made the cards mono, step 1 and step 3 pass
the narration through with `-c:a copy`), so this is one channel count in, one
channel count out, one encode. Two things are forbidden here, and they are the
same rule seen from both sides — **the channel count is decided at the source,
never at the mux**:

- **Never `-c copy`.** Stream copy writes one `AudioSpecificConfig` from the
  first input; if the inputs ever disagree, the result plays silent in
  QuickTime and Safari while ffprobe reports healthy audio.
- **Never `-ac 2`.** Upmixing a concat of mixed-channel inputs through one AAC
  encoder produces audible artifacts. It looks like a fix and is not.

Full explanation of both in `gotchas.md`.

**Frame rate is the video half of the same rule.** `-c:v copy` concats whatever
frame rates it is handed, and lavfi `color=` without `rate=` is **25 fps** — the
overlay base input sets the output timing, so step 1 silently makes a 25 fps body
between 30 fps cards. Players then run the video ~1.2x fast against the audio and
the subtitles drift further every second. Every clip must be 30 fps *before*
this step: `:rate=30` in step 1, `-r 30` on the cards.

Verify frame rate first — one packet duration, one count:

```bash
ffprobe -v error -select_streams v:0 -show_entries packet=duration_time -of csv=p=0 final.mp4 \
  | sort | uniq -c | sort -rn | head
# expect: a single line, 0.033333; any second value = mixed rates
ffprobe -v error -show_entries stream=codec_type,duration -of csv=p=0 final.mp4
# expect: video and audio durations within ~0.05s
```

Verify — channel count, then the per-channel numbers:

```bash
ffprobe -v error -select_streams a:0 -show_entries stream=channels,sample_rate -of csv=p=0 final.mp4
# expect: 1,44100

ffmpeg -hide_banner -nostats -i final.mp4 -map a:0 -af astats -f null - 2>&1 \
  | grep -E "Channel:|Peak level|RMS level|Peak count"
# expect: one `Channel: 1` block, numbers matching the raw narration
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
