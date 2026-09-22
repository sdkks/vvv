# Video matching and calibration

Videos are SHA-256 hashed, then probed with ffprobe and sampled with one ffmpeg
process. ffmpeg must decode the timeline even though only nine frames are emitted.
Images and videos use the same 64-bit, 9×8 grayscale dHash construction. Four
shared work slots bound hashing, decoding, and thumbnail generation; ffmpeg may
also use its own decoder threads.

Duration comes from the container, falling back to the first video stream. Missing
or nonpositive duration is a `no_duration` per-file error. A failed decoder, partial
frame, or frame count other than nine is `incomplete_frames`; hung children become
`timeout`. Errors do not abort the scan. Cancellation terminates children and
retains successful SHA checkpoints for the next scan.

Video candidate probes require matching frame indices and band indices. Verification
uses the mean of all nine aligned Hamming distances, with a default threshold of 10. Similarity in group details is mean distance to the smallest-id reference,
not a percentage. Groups are connected components, not cliques. Candidate retrieval
is approximate, and hot buckets are skipped and reported. Partial clips, cropped
content, and different timelines are not promised matches.

The database settings `video_frame_count`, `video_timeout_ms`, and
`video_phash_threshold` default to 9, 600000 ms, and 10 respectively. They are not
exposed in the UI. Video thumbnails seek to the middle timestamp, extract one JPEG,
and use the existing source-identity cache. Unavailable content returns 404;
operational failures return logged 500 responses. Thumbnail access requires login.

## Reproducing the benchmark

Install ffmpeg/ffprobe (6.1 or newer) for local development. Container builds already
include them. The normal tests generate tiny synthetic videos; a local-corpus test
also runs when the expected files exist under `tests/fixtures/data/video` and skips
when they do not. Originals and derived fixtures remain local and gitignored.

```sh
pnpm --filter @vvv/server exec tsx scripts/calibrate-videos.ts \
  ../../tests/fixtures/data/video /tmp/vvv-video-report.json 200000
```

The harness samples each local video once, reports SHA and sampling times separately,
measures matching, and builds a separate 200,000-video hash catalog. Its four equal
classes are blank frames, repeated title frames, exact copies, and independently
random frames. Reports include pair-level outcomes, skipped buckets, candidate counts,
Node RSS, and event-loop lag. Decoder-child RSS is **not** included. The benchmark
allows 15 minutes per child rather than changing the production two-minute default.

### Local measurement (2026-09-21, ffmpeg 6.1.1)

- 17 real clips: two five-member groups, comprising the AVI, small MP4, tiny MKV,
  WebM, and with-audio MP4 variants of each source. Group-reference means ranged
  from 0 to 3.33 bits. Matching took 11.3 ms, with 37 candidate pairs and no hot buckets.
- The 4,717,643,077-byte original: 3.03 s SHA time and **67.20 s sampling time** for
  its 1,859.858 s timeline. This is a hardware-specific measurement, not a throughput
  guarantee. Its 60-second variants are partial clips, so no full-original match
  is expected.
- The second original (8.337 s) did not group with its 7.633 s derivatives: aligned
  means were 12.78–13.56. Keeping these five comparisons as labeled positives gives
  20 true positives, 5 false negatives, and 0 false positives: recall 80%, precision
  100%. Crops and explicitly short clips are excluded from these quality metrics.
- Synthetic catalog: 28.88 s construction, **175.99 s matching**, 11,623,695 candidate
  pairs, and 90 skipped buckets. Peak Node RSS across the harness was 411.8 MB;
  synthetic matching event-loop lag was 17.24 ms p99 and **400.29 ms maximum**.
  This does not demonstrate a hard 50 ms worst-case responsiveness bound.
- Total harness elapsed: 278.73 s.

These measurements validate the tested re-encode/rescale families, not a universal
threshold. Two original sources are a small corpus; threshold 10 remains unverified
for broad real libraries. The duration-sensitive misses and maximum event-loop lag
are retained in the evidence rather than hidden by changing thresholds or labels.
