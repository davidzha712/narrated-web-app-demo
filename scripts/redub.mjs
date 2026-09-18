#!/usr/bin/env node
/**
 * redub.mjs — re-dub an EXISTING ndemo recording into another language and burn
 * minimalist subtitles onto it, WITHOUT re-recording the browser.
 *
 * Why: re-running `ndemo render` drives the live app again (needs auth) and, for
 * LLM-backed apps, produces different on-screen responses each run. When the
 * original recording is already good, reuse its pixels: swap the narration audio,
 * burn clean subtitles, and overlay a translated end card.
 *
 * Two modes per language:
 *   - dub mode    (tts entry exists for the lang): generate TTS, place each
 *                 segment's audio at its original video offset, fit-to-window,
 *                 mix onto silence, overlay a translated outro card.
 *   - keep mode   (no tts entry, e.g. the original language): keep the source
 *                 audio untouched, only burn subtitles, keep the original card.
 *
 * Subtitles are rendered with ffmpeg `drawtext` (freetype), NOT libass: several
 * libass builds inject a phantom comma glyph whenever any comma exists in the
 * events. drawtext draws exactly the given text — one clean translucent pill per
 * cue. Requires an ffmpeg with freetype (see references/redub-and-subtitles.md).
 *
 * Usage: node scripts/redub.mjs <lang> [configPath]
 *        config default: ./redub.config.json
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const lang = process.argv[2];
const configPath = path.resolve(process.argv[3] || "redub.config.json");
if (!lang) { console.error("Usage: node scripts/redub.mjs <lang> [configPath]"); process.exit(1); }
if (!fs.existsSync(configPath)) { console.error("config not found: " + configPath); process.exit(1); }

const root = path.dirname(configPath);
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const rel = (p) => path.resolve(root, p);
const FFMPEG = cfg.ffmpeg ? rel(cfg.ffmpeg) : "ffmpeg";
const FFPROBE = cfg.ffprobe ? rel(cfg.ffprobe) : "ffprobe";
const narration = JSON.parse(fs.readFileSync(rel(cfg.narration), "utf8"));
const keepAudio = !narration.tts || !narration.tts[lang]; // no TTS config -> keep original audio
const tmp = rel(path.join(".redub", lang));
fs.mkdirSync(tmp, { recursive: true });

const S = cfg.subtitle || {};
const MAXLAT = S.maxLatin || 54, MAXCJK = S.maxCjk || 26;
const FSIZE = S.fontSize || 64, BOXCOLOR = S.boxColor || "0x141414@0.74", BOXBORDER = S.boxBorder || 26, MB = S.marginBottom || 300;
const isCjk = lang === "zh" || lang === "ja" || lang === "ko" || lang === "zh-TW";

const sh = (cmd, args) => {
  try { return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).toString(); }
  catch (e) { console.error(`\n[FAIL] ${cmd} ${args.join(" ")}\n${(e.stderr || "").toString().split("\n").slice(-12).join("\n")}`); throw e; }
};
const ffprobeMs = (f) => Math.round(parseFloat(sh(FFPROBE, ["-v","error","-show_entries","format=duration","-of","csv=p=0",f]).trim()) * 1000);
const fontFile = (q) => sh("fc-match", ["-f", "%{file}", q]).trim();
const sec = (ms) => (ms / 1000).toFixed(3);

const SUB_FONT_FILE = fontFile(isCjk ? (S.fontCjk || "PingFang SC") : (S.fontLatin || "Helvetica Neue"));

function segMeta(yamlFile) {
  return JSON.parse(sh("yq", ["-o=json", "-I=0", '[.segments[] | {"id": .id, "vd": .videoDuration, "ad": .audioDuration}]', yamlFile]));
}

// split narration into timed single-line cues (one line == one clean drawtext box)
function chunk(text) {
  const max = isCjk ? MAXCJK : MAXLAT;
  const sentences = isCjk ? text.trim().split(/(?<=[。！？])/) : text.trim().split(/(?<=[.!?])\s+/);
  const cues = [];
  for (let s of sentences) {
    s = s.trim(); if (!s) continue;
    if (isCjk) {
      const parts = s.split(/(?<=[，、；：])/).map(x => x.trim()).filter(Boolean);
      let cur = "";
      for (const p of parts) {
        if ((cur + p).length <= max) { cur += p; continue; }
        if (cur) { cues.push(cur); cur = ""; }
        if (p.length <= max) cur = p; else for (let i = 0; i < p.length; i += max) cues.push(p.slice(i, i + max));
      }
      if (cur) cues.push(cur);
    } else {
      let cur = "";
      for (const w of s.split(/\s+/)) {
        if ((cur + " " + w).trim().length <= max) cur = (cur + " " + w).trim();
        else { if (cur) cues.push(cur); cur = w; }
      }
      if (cur) cues.push(cur);
    }
  }
  return cues;
}
function cuesFor(segs) {
  const cues = [];
  for (const s of segs) {
    const parts = chunk(s.text);
    const total = parts.reduce((a, c) => a + c.length, 0) || 1;
    let t = s.offsetMs;
    parts.forEach((cue, i) => {
      const dur = i === parts.length - 1 ? (s.offsetMs + s.placedMs - t) : Math.round(s.placedMs * (cue.length / total));
      cues.push({ start: t, end: t + dur, text: cue }); t += dur;
    });
  }
  return cues;
}
const drawtext = (txtFile, font, opts) => `drawtext=fontfile='${font}':textfile='${txtFile}':x=(w-tw)/2:${opts}`;

function buildPart(part) {
  const yamlFile = rel(part.yaml), videoFile = rel(part.video);
  const meta = segMeta(yamlFile);
  const audioDir = rel(`${cfg.audioDir || "audio"}-${lang}`);
  const videoMs = ffprobeMs(videoFile);
  const segText = narration[part.key][lang];
  let cursor = part.titleCardMs || 0;
  const segs = [];

  meta.forEach((m) => {
    if (keepAudio) {
      segs.push({ id: m.id, offsetMs: cursor, placedMs: Math.min(m.ad, m.vd), text: segText[m.id] });
      cursor += m.vd; return;
    }
    const af = path.join(audioDir, `${part.key}__${m.id}.mp3`);
    if (!fs.existsSync(af)) throw new Error("missing audio (run redub-tts first): " + af);
    let aMs = ffprobeMs(af), src = af, placedMs = aMs;
    const window = m.vd - 120;
    if (aMs > window) {
      const tempo = Math.min(1.4, aMs / window);
      const fit = path.join(tmp, `${part.key}__${m.id}.fit.mp3`);
      sh(FFMPEG, ["-y","-i",af,"-filter:a",`atempo=${tempo.toFixed(4)}`,fit]);
      src = fit; placedMs = ffprobeMs(fit);
      console.log(`  fit ${m.id}: ${aMs}->${placedMs}ms (win ${m.vd}, tempo ${tempo.toFixed(2)})`);
    }
    segs.push({ id: m.id, offsetMs: cursor, placedMs, src, text: segText[m.id] });
    cursor += m.vd;
  });

  // audio (skip in keep mode)
  let audioOut = null;
  if (!keepAudio) {
    const inputs = ["-f","lavfi","-t",sec(videoMs),"-i","anullsrc=channel_layout=stereo:sample_rate=48000"];
    segs.forEach(s => inputs.push("-i", s.src));
    let fc = "";
    segs.forEach((s, i) => { fc += `[${i+1}:a]adelay=${s.offsetMs}|${s.offsetMs},aresample=48000[a${i}];`; });
    fc += "[0:a]" + segs.map((_, i) => `[a${i}]`).join("") + `amix=inputs=${segs.length+1}:normalize=0:duration=first[mix]`;
    audioOut = path.join(tmp, `${part.key}.m4a`);
    sh(FFMPEG, ["-y", ...inputs, "-filter_complex", fc, "-map", "[mix]", "-c:a", "aac", "-b:a", "192k", audioOut]);
  }

  // subtitles + optional translated outro
  const txtDir = path.join(tmp, "txt", part.key); fs.mkdirSync(txtDir, { recursive: true });
  const filters = [];
  const SUB_OPTS = `fontcolor=white:fontsize=${FSIZE}:box=1:boxcolor=${BOXCOLOR}:boxborderw=${BOXBORDER}:y=h-${MB}`;
  cuesFor(segs).forEach((c, i) => {
    const f = path.join(txtDir, `c${i}.txt`); fs.writeFileSync(f, c.text);
    filters.push(drawtext(f, SUB_FONT_FILE, `${SUB_OPTS}:enable='between(t,${sec(c.start)},${sec(c.end)})'`));
  });
  const wantOutro = part.outro && !keepAudio && narration.outro && narration.outro[lang];
  if (wantOutro) {
    const o0 = sec(cursor), o1 = sec(videoMs), bg = (cfg.outro && cfg.outro.bg) || "0xF5F5F6";
    const o = narration.outro[lang];
    const tf = path.join(txtDir, "outro-title.txt"); fs.writeFileSync(tf, o.title);
    const sf = path.join(txtDir, "outro-sub.txt"); fs.writeFileSync(sf, o.subtitle);
    filters.unshift(`drawbox=x=0:y=0:w=iw:h=ih:color=${bg}:t=fill:enable='between(t,${o0},${o1})'`);
    filters.push(drawtext(tf, SUB_FONT_FILE, `fontcolor=0x202024:fontsize=140:y=h/2-150:enable='between(t,${o0},${o1})'`));
    filters.push(drawtext(sf, SUB_FONT_FILE, `fontcolor=0x6E6E73:fontsize=50:y=h/2+30:enable='between(t,${o0},${o1})'`));
  }

  const vf = filters.join(",");
  const partOut = path.join(tmp, `${part.key}.${lang}.mp4`);
  const audioIn = keepAudio ? [] : ["-i", audioOut];
  const audioMap = keepAudio ? ["-map","0:a","-c:a","copy"] : ["-map","1:a","-c:a","aac","-b:a","192k"];
  sh(FFMPEG, ["-y","-i",videoFile, ...audioIn, "-filter_complex",`[0:v]${vf}[v]`,"-map","[v]", ...audioMap,
    "-c:v","libx264","-preset","medium","-crf",String(cfg.crf || 18),"-pix_fmt","yuv420p","-movflags","+faststart", partOut]);
  return partOut;
}

console.log(`redub [${lang}] mode=${keepAudio ? "keep-audio" : "dub"}`);
const parts = cfg.parts.map(buildPart);
const list = path.join(tmp, "concat.txt");
fs.writeFileSync(list, parts.map(p => `file '${p}'`).join("\n") + "\n");
const out = rel(`${cfg.outputPrefix || "demo-final"}-${lang}.mp4`);
sh(FFMPEG, ["-y","-f","concat","-safe","0","-i",list,"-c","copy", out]);
console.log("FINAL ->", out, ffprobeMs(out) + "ms");
