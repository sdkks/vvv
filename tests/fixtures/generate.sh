#!/usr/bin/env bash
# Derives small synthetic media variants from user-supplied original videos.
# Originals are NEVER committed or uploaded; everything under data/ is gitignored.
# Usage: tests/fixtures/generate.sh   (or: make fixtures)
set -euo pipefail

cd "$(dirname "$0")"
VIDEO_DIR=data/video
AUDIO_DIR=data/audio
IMAGES_DIR=data/images
mkdir -p "$VIDEO_DIR" "$AUDIO_DIR" "$IMAGES_DIR"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found on PATH" >&2; exit 1; }

find_original() {
  local base="$1"
  for ext in mp4 mkv webm mov avi; do
    if [ -f "$VIDEO_DIR/$base.$ext" ]; then
      echo "$VIDEO_DIR/$base.$ext"
      return 0
    fi
  done
  return 1
}

# derive <original> <out-suffix> <ffmpeg args...>
derive() {
  local src="$1" suffix="$2"
  shift 2
  local out="$VIDEO_DIR/$(basename "${src%.*}")-$suffix"
  case "$suffix" in
    *.mp4|*.mov) out="$out" ;;
  esac
  if [ -f "$out" ]; then
    echo "skip (exists): $out"
    return 0
  fi
  echo "creating: $out"
  ffmpeg -hide_banner -loglevel error -y -i "$src" "$@" "$out"
}

variant_count=0
for base in original-video1 original-video2; do
  src="$(find_original "$base" || true)"
  if [ -z "${src:-}" ]; then
    continue
  fi
  echo "== deriving variants from $base =="
  duration="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$src")"
  short="${duration%.*}"
  [ "${short:-0}" -gt 60 ] && short=60

  # Re-encode + rescale variants (near-duplicate material: same content, different codec/size)
  derive "$src" "small-360p.mp4" -t "$short" -vf "scale=-2:360" -an -c:v libx264 -preset veryfast -crf 28
  derive "$src" "tiny-240p.mkv"  -t "$short" -vf "scale=-2:240" -an -c:v libx264 -preset veryfast -crf 32
  derive "$src" "square-320.mp4" -t "$short" -vf "scale=320:320:force_original_aspect_ratio=increase,crop=320:320" -an -c:v libx264 -preset veryfast -crf 30

  # Trim variants (partial-content material)
  derive "$src" "first10s.mp4" -t 10 -an -c:v libx264 -preset veryfast -crf 28
  if [ "${duration%.*}" -gt 120 ] 2>/dev/null; then
    derive "$src" "middle10s.mp4" -ss 60 -t 10 -an -c:v libx264 -preset veryfast -crf 28
  fi

  # Container/format variety
  derive "$src" "webm.webm" -t "$short" -vf "scale=-2:360" -an -c:v libvpx -b:v 500k
  derive "$src" "avi.avi"   -t "$short" -vf "scale=-2:360" -an -c:v mpeg4 -qscale:v 8

  # With-audio variants (audio kept at low bitrate)
  derive "$src" "with-audio-360p.mp4" -t "$short" -vf "scale=-2:360" -c:v libx264 -preset veryfast -crf 30 -c:a aac -b:a 64k

  # Audio-only variants (only when the source has an audio stream)
  if ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$src" | grep -q .; then
    derive "$src" "audio.m4a" -t "$short" -vn -c:a aac -b:a 64k
    derive "$src" "audio.mp3" -t "$short" -vn -c:a libmp3lame -q:a 6
    variant_count=$((variant_count + 2))
  else
    echo "skip (no audio stream): $base"
  fi
  variant_count=$((variant_count + 10))
done

if [ "$variant_count" -eq 0 ]; then
  echo "No originals found."
  echo "Place your own videos at:"
  echo "  $VIDEO_DIR/original-video1.mp4   (any video you have rights to)"
  echo "  $VIDEO_DIR/original-video2.mov   (a second one, optional)"
  echo "Then re-run this script. Originals stay local and are never committed."
fi

echo "== synthetic image corpus =="
cd ../.. && node tests/fixtures/generate-images.mjs "tests/fixtures/$IMAGES_DIR"
echo "done: $VIDEO_DIR $AUDIO_DIR $IMAGES_DIR"
