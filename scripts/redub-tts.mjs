#!/usr/bin/env node
/**
 * redub-tts.mjs — generate per-segment narration audio for a re-dub language.
 * Reads narration.json + redub.config.json, writes audio-<lang>/<part>__<id>.mp3.
 * Provider: MiniMax (matches the ndemo `minimax` TTS). Set MINIMAX_API_KEY.
 *
 * Usage: node scripts/redub-tts.mjs <lang> [configPath]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const lang = process.argv[2];
const configPath = path.resolve(process.argv[3] || "redub.config.json");
if (!lang) { console.error("Usage: node scripts/redub-tts.mjs <lang> [configPath]"); process.exit(1); }
const apiKey = process.env.MINIMAX_API_KEY;
if (!apiKey) { console.error("MINIMAX_API_KEY not set (put it in .env, gitignored)."); process.exit(1); }

const root = path.dirname(configPath);
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const narration = JSON.parse(fs.readFileSync(path.resolve(root, cfg.narration), "utf8"));
const tts = (narration.tts || {})[lang];
if (!tts) { console.error(`no narration.tts.${lang} entry — nothing to synthesize`); process.exit(1); }

const jobs = [];
for (const part of cfg.parts) {
  const map = narration[part.key][lang];
  for (const [id, text] of Object.entries(map)) jobs.push({ part: part.key, id, text });
}
const outDir = path.resolve(root, `${cfg.audioDir || "audio"}-${lang}`);
fs.mkdirSync(outDir, { recursive: true });

async function synth(text) {
  const r = await fetch("https://api.minimax.chat/v1/t2a_v2", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: tts.model || "speech-02-hd", text, stream: false,
      voice_setting: { voice_id: tts.voice, speed: tts.speed || 1, vol: 1.0, pitch: 0 },
      audio_setting: { format: "mp3", sample_rate: 32000, bitrate: 128000, channel: 1 },
      language_boost: tts.language,
    }),
  });
  const d = await r.json();
  const hex = d?.data?.audio;
  if (!hex) throw new Error("MiniMax TTS failed: " + JSON.stringify(d).slice(0, 400));
  return Buffer.from(hex, /^[0-9a-fA-F]+$/.test(hex) ? "hex" : "base64");
}
const ms = (f) => Math.round(parseFloat(execFileSync("ffprobe", ["-v","error","-show_entries","format=duration","-of","csv=p=0",f]).toString().trim()) * 1000);

for (const j of jobs) {
  const file = path.join(outDir, `${j.part}__${j.id}.mp3`);
  process.stdout.write(`[${lang}] ${j.part}/${j.id} ... `);
  fs.writeFileSync(file, await synth(j.text));
  console.log(`${ms(file)}ms`);
}
console.log("Done ->", outDir);
