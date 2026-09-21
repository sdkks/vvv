# Test media fixtures

Media used by integration tests and local smokes lives here, but **no media is
committed to the repository** (see `.gitignore`: `tests/fixtures/data/`).

## Structure

```
tests/fixtures/
  generate.sh          # committed — derives everything below with ffmpeg
  generate-images.mjs  # committed — builds the synthetic image corpus with sharp
  data/                # NOT committed
    video/
      original-video1.mp4   # place your own video here (any length)
      original-video2.mov   # place a second video here (optional but recommended)
      ...derived variants
    audio/                   # extracted audio variants
    images/                  # synthetic image corpus (no originals needed)
```

## Usage

```sh
make fixtures          # or: tests/fixtures/generate.sh
```

Requires `ffmpeg`/`ffprobe` on PATH and Node 22 with workspace deps installed
(the image generator uses the workspace's `sharp`).

## Supplying your own originals

Drop any video(s) at `data/video/original-video1.mp4` and
`data/video/original-video2.mov` (extension-aware: `.mkv`/`.webm`/`.mov` also work
for video2). The generator trims and scales small variants from them; your
originals are never read by the application's tests directly, never committed,
and never uploaded anywhere.

With no originals present, the generator still builds the synthetic image corpus
and prints instructions.
