#!/usr/bin/env bash
# setup.sh — one-shot environment prep for narrated-web-app-demo / redub.
# Fetches a full-feature static ffmpeg (with freetype+libass, which Homebrew's
# minimal formula lacks), checks node/yq/fc-match + fonts, and scaffolds the
# redub config + .env. Run once per machine, per project.
#
#   bash scripts/setup.sh            # download bins + scaffold + check
#   bash scripts/setup.sh --check    # check only, no downloads/scaffold
#   bash scripts/setup.sh --force    # re-download ffmpeg even if present
set -uo pipefail

CHECK_ONLY=0; FORCE=0
for a in "$@"; do case "$a" in --check) CHECK_ONLY=1;; --force) FORCE=1;; esac; done

ok(){ printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn(){ printf "  \033[33m!\033[0m %s\n" "$1"; }
err(){ printf "  \033[31m✗\033[0m %s\n" "$1"; }

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Darwin/arm64) PLAT="macos/arm64";;
  Darwin/x86_64) PLAT="macos/amd64";;
  Linux/x86_64|Linux/amd64) PLAT="linux/amd64";;
  Linux/aarch64|Linux/arm64) PLAT="linux/arm64";;
  *) PLAT="";;
esac

echo "== ffmpeg (needs freetype for drawtext subtitles) =="
# note: no `grep -q` — it closes the pipe early, ffmpeg gets SIGPIPE, and pipefail
# would then report a false negative. Let grep read all input.
have_ff(){ "$1" -hide_banner -filters 2>/dev/null | grep -iw drawtext >/dev/null 2>&1; }
if have_ff "bin/ffmpeg"; then
  ok "bin/ffmpeg present with drawtext"
elif [ "$CHECK_ONLY" = 0 ] && [ -n "$PLAT" ]; then
  mkdir -p bin
  base="https://ffmpeg.martin-riedl.de/redirect/latest/${PLAT}/release"
  echo "  downloading static ffmpeg for ${PLAT} ..."
  if curl -fsSL -o /tmp/ff.zip "${base}/ffmpeg.zip" && curl -fsSL -o /tmp/fp.zip "${base}/ffprobe.zip"; then
    (cd bin && unzip -oq /tmp/ff.zip && unzip -oq /tmp/fp.zip && chmod +x ffmpeg ffprobe)
    rm -f /tmp/ff.zip /tmp/fp.zip
    have_ff "bin/ffmpeg" && ok "bin/ffmpeg installed ($PLAT)" || err "downloaded ffmpeg lacks drawtext"
  else
    err "download failed — fetch a freetype-enabled ffmpeg into bin/ manually"
  fi
elif have_ff "ffmpeg"; then
  ok "system ffmpeg has drawtext (no local bin needed)"
else
  err "no usable ffmpeg (need drawtext). Re-run without --check, or install one with freetype/libass."
fi

echo "== tooling =="
for t in node yq; do command -v "$t" >/dev/null && ok "$t $("$t" --version 2>&1 | head -1)" || err "$t missing (mac: brew install $t / linux: apt install $t)"; done
command -v fc-match >/dev/null && ok "fontconfig (fc-match)" || warn "fc-match missing — fonts won't auto-resolve (mac: built-in; linux: apt install fontconfig)"

echo "== fonts =="
if command -v fc-match >/dev/null; then
  for q in "Helvetica Neue" "Arial" "PingFang SC" "Noto Sans CJK SC"; do
    f="$(fc-match -f '%{family}' "$q" 2>/dev/null)"; [ -n "$f" ] && ok "$q -> $f" || warn "$q not found"
  done
  warn "Latin needs Helvetica Neue/Arial; CJK needs PingFang SC (mac) or Noto Sans CJK (linux: apt install fonts-noto-cjk)"
fi

[ "$CHECK_ONLY" = 1 ] && { echo "(check only)"; exit 0; }

echo "== scaffold =="
SK="$(cd "$(dirname "$0")/.." && pwd)"
[ -f .env ] || { printf 'MINIMAX_API_KEY=\n' > .env; ok "created .env (fill MINIMAX_API_KEY)"; }
[ -f redub.config.json ] || { cp "$SK/assets/templates/redub.config.template.json" redub.config.json; ok "created redub.config.json (edit parts: yaml/video/key)"; }
if [ ! -f i18n/narration.json ]; then mkdir -p i18n; cp "$SK/assets/templates/narration.template.json" i18n/narration.json; ok "created i18n/narration.json (fill per-language narration)"; fi
for g in .env "audio-*/" .redub/ bin/ .ndemo/ "*.local.yaml"; do grep -qxF "$g" .gitignore 2>/dev/null || echo "$g" >> .gitignore; done
ok ".gitignore updated"

echo
echo "Next:"
echo "  1) put MINIMAX_API_KEY in .env"
echo "  2) record the demo (see SKILL.md) OR point redub.config.json at an existing recording"
echo "  3) node scripts/redub-tts.mjs <lang> && node scripts/redub.mjs <lang>   # dub language"
echo "     node scripts/redub.mjs <origLang>                                    # subtitles-only for source language"
