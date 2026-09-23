# VVV (Veni Vidi Video)

VVV is a content aware video matching tool to find and nuke your duplicate videos to save disk space.

Containers are built and run with **podman** (not docker) — see `docs/deployment.md` and `AGENTS.md`.

# Screenshots

### See matching groups:
<img width="1152" height="729" alt="image" src="https://github.com/user-attachments/assets/8c9773dd-3b6f-46a1-8006-3d7e57e88e35" />

### Individual selection or automatic marking of what to trash:
<img width="901" height="789" alt="image" src="https://github.com/user-attachments/assets/9fa6239b-8029-426b-8cce-19ae076265f5" />

# Development

Requires Node ≥22.22.0, pnpm 10.33.2, and [gitleaks](https://github.com/gitleaks/gitleaks)
on your PATH for the secret-scanning gate.

```sh
make install   # install dependencies (also installs git hooks)
make hooks     # install git hooks explicitly
make ci        # typecheck + lint + build + test + secret scan
```

Set `VVV_PASSWORD` in your shell, then run `pnpm dev`. Open the Vite URL
(normally http://localhost:5173); its `/api` proxy connects to port 8080.
The authenticated browser UI supports scanning and duplicate matching. The built SPA
is served by the API server.

- `packages/server`: Fastify API, signed-cookie auth, SQLite bootstrap.
- `packages/web`: React SPA, Vite development server and production build.
- `packages/shared`: type-only API contracts; no runtime dependencies.

`pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` run across the
workspace. After building, `pnpm --filter @vvv/server start` serves the API and SPA.
pnpm runs development processes in parallel without a separate process-manager dependency.

## Container deployment

Run `make image`, then follow [the podman deployment guide](docs/deployment.md)
for a persistent `/data` volume and read-only media mount, or use `podman compose
-f compose.yml up -d`. Set a strong `VVV_PASSWORD` and your media path first.
The image includes the built UI, API, and checksum-verified ffmpeg/ffprobe.

## Server configuration and deployment assumptions

| Variable             | Default / behavior                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VVV_PASSWORD`       | Required, nonempty shared password; never logged or saved in the browser.                                                                                                                        |
| `VVV_SESSION_SECRET` | Optional signing secret. Use a long random secret (at least 20 bytes). If unset, generated per boot, invalidating sessions on restart.                                                           |
| `PORT`               | 8080. The Vite development proxy uses the same PORT value.                                                                                                                                       |
| `DATA_DIR`           | `./data`, relative to the server working directory (`packages/server` under `pnpm dev`). Created automatically; must be writable. Use a path outside the checkout to keep local data out of Git. |

“Remember me for 30 days” sets a persistent login cookie; surviving server restarts
requires a stable `VVV_SESSION_SECRET`, since a per-boot secret still invalidates it.

`SERVE_WEB_DIST` overrides the SPA directory (default: `packages/web/dist`, resolved
relative to the server module; `/app/web` in the image). Serving is enabled only
when `index.html` exists; development without a build still works through Vite.
The public shell renders login; API data remains session-protected. HTML deep links
return `index.html`; API misses stay JSON (401 without a session, otherwise 404).

Deploy only on a **trusted private network or behind your own access controls**;
this single-password application is not intended for direct public exposure.
Use HTTPS at your reverse proxy on untrusted networks. Cookies are HttpOnly,
SameSite=Lax, and Secure on direct TLS connections. The server does not trust
forwarded headers; a reverse proxy should enforce Secure cookies if terminating TLS.
Failed passwords incur per-IP delays from 500 ms up to 30 s. This is minimal
backoff, not a comprehensive rate limiter; requests behind a proxy share its IP.

SQLite state is stored in `DATA_DIR/vvv.db`. Use a **local filesystem**, not a
network mount, for WAL support. WAL with `synchronous=NORMAL` protects committed
state against process crashes, not host power loss. Settings persist across
restarts. Session cookies contain only an authentication marker and timestamp,
not the password. Without a stable session secret, users sign in again after a
restart and return to their previous browser location. No telemetry or external
runtime services are used. `GET /api/health` is public and checks the database.

## Content hash algorithm

Settings → Advanced matching controls lets you choose **SHA-256** (default; strongest,
hardware-accelerated on many CPUs) or **BLAKE2B-512** (fast software hash). Both run
locally using Node's built-in crypto. Large-media hashing is I/O-bound, so the potential
speed benefit is greatest with many small files and depends on your hardware.
Exact matching stays always on; the Matching behavior row shows the saved algorithm.

`PATCH /api/settings` accepts the top-level `file_hash_algorithm` key with exactly
`"sha256"` or `"blake2b512"`; other values return 400. `GET /api/settings` reports it as
`matching.file_hash_algorithm` and as `algorithm` on the exact method row. An actual
change returns `{ "type": "rehash_required", "message": "All files will be re-hashed
with the new algorithm on the next scan." }`. Saving the same value does not invalidate
anything. Algorithm changes are refused with 409 during a scan or matching run.

Changing the algorithm clears every stored content hash in the same transaction as
the setting update. Done/hashed files become pending. Missing, quarantined, excluded,
and error files retain their statuses but lose obsolete content-hash checkpoints;
they re-hash when restored, rediscovered, included, or retried. Existing perceptual
hashes are preserved: unchanged files do not need re-sampling. Actual size/mtime
changes still invalidate stale perceptual work and cause fresh analysis.

Start a scan after saving; scans automatically run matching afterwards. The settings
form withholds its Re-match action while the re-hash consequence is outstanding, just
as it does for frame-count changes. Previously published results are not a new match
run. Each scan snapshots the algorithm; all surviving content-hash checkpoints use
that algorithm. The SQLite column remains named `sha256` for compatibility, but stores
the selected algorithm's hex digest (64 characters for SHA-256, 128 for BLAKE2B-512).

## File-size inclusion filters

Settings → Advanced matching controls offers inclusive minimum/maximum sizes in **MiB**
(1 MiB = 1,048,576 bytes). Empty inputs display **Disabled** and save `0`; each bound is
independent. Limits must be non-negative safe integers, with maximum ≥ minimum when
both are enabled. `GET /api/settings` reports `matching.min_file_size_mb` and
`matching.max_file_size_mb`; `PATCH /api/settings` accepts these keys at the top level.
Both default to `0` (disabled). A changed bound returns the consequence
`{ "type": "next_scan_required", "reason": "size_filter_change" }`.

Size policy applies to the next scan; files outside the range are excluded from
processing and results. Each scan captures the limits at start. Saving settings does
not change an in-flight scan or existing results immediately. Directory preview uses
the saved limits and shows **Excluded by size**, the reason, and the configured range.

Excluded files remain in the catalog as `status='excluded'`. Their `error` column stores
an `excluded_by_size:` reason, not a processing failure. They count as discovered and
processed (eligibility evaluated), never as scan errors, and do not enter groups,
exports, or Trash. No source files are moved or deleted. On a later scan, widening the
range returns eligible files to processing, reusing unchanged content-hash checkpoints
unless the algorithm changed; files excluded before their first processing receive full
analysis. Excluded files
follow the same missing sweep as processed files: a deleted excluded file is
marked missing, and rediscovery re-evaluates the size policy (staying excluded or
returning to processing as appropriate). Existing quarantine and pending
filesystem-operation protections still take priority over size eligibility.

## Scan API

All scan routes require the session cookie obtained from `POST /api/auth/login`.
Paths refer to directories visible to the server (container paths when containerized).

| Method and path                               | Behavior                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/scan-dirs`                          | Lists registered directories, traversal options, and indexed `file_count`.                                                                                                                                                                           |
| `POST /api/scan-dirs`                         | Registers `{ "path": string, "follow_symlinks"?: boolean, "cross_filesystems"?: boolean }`. Options default to false; paths are normalized to absolute paths. Returns 201, 400 for invalid directories/input, or 409 for an already-registered path. |
| `PATCH /api/scan-dirs/:id`                    | Updates either or both boolean traversal options.                                                                                                                                                                                                    |
| `DELETE /api/scan-dirs/:id`                   | Unregisters the directory and cascades its indexed file rows. Returns 204, or 404 if absent. **Never deletes or moves files on disk**, including `.vvv-trash/` contents.                                                                             |
| `POST /api/scans`                             | Starts a scan and returns 202 `{ "id": number }` or 409 while one is running. Optional JSON booleans `images`, `videos`, and `audio` select standalone media kinds; each defaults to `true`.                                                         |
| `GET /api/scans/current`                      | Returns the latest durable scan counters/status (or null), with `current_file` when processing.                                                                                                                                                      |
| `POST /api/scans/:id/cancel`                  | Requests cooperative cancellation; the next scan skips unchanged completed files.                                                                                                                                                                    |
| `GET /api/scans/:id/events`                   | Streams `event: progress` with a JSON scan snapshot in `data:`.                                                                                                                                                                                      |
| `GET /api/scans/:id/errors?cursor=&limit=100` | Returns `{ "items": [{ "file_id", "path", "error" }], "next_cursor": string\|null }`. Pass `next_cursor` unchanged to fetch the next page; null ends pagination.                                                                                     |

For `POST /api/scans`, unknown keys or non-boolean options return 400
`{ "error": "invalid_scan_options" }`; a running scan returns 409
`{ "error": "scan_running" }`.

Scan kind selection applies to that scan only; it is not saved as a setting. Unchecked
kinds remain in the catalog and are not marked missing. Audio selection controls
standalone audio files; audio tracks in selected videos can still be matched when Audio
matching is enabled in Settings. Newly generated match groups use the selected kinds.

Error pages are ordered by file ID (default 100 rows, capped at 500) and include only
files last seen in that scan that currently have error status. This is not an immutable
error archive: a later scan or directory removal may change the results.

SSE progress is coalesced to at most one event per 250 ms per scan. The server retains
at most 500 events in memory and sends `: ping` heartbeat comments every 15 seconds.
There is **no replay guarantee**: reconnecting clients should fetch `/api/scans/current`
again; `Last-Event-ID` does not replay history. Slow streams are disconnected rather
than buffered indefinitely. Reverse proxies may need streaming/buffering configuration;
the server sends `X-Accel-Buffering: no`, but cannot guarantee proxy behavior.

Unregistering a directory discards its catalog metadata; restore or purge any trash you
want managed before unregistering it when trash management is available. Unregistering
is not a filesystem cleanup operation.

## Matching API

All matching routes require the authenticated session cookie. `POST /api/matches/run`
starts matching and returns 202 `{ "match_run": number }`, or 409
`{ "error": "match_running" }` if a run is active. When a scan completes successfully,
its automatic match run uses that scan's selected kinds; a manually started run uses
the latest successfully completed scan's selection, or all kinds if no scan has
completed.

`POST /api/matches/clear` returns 204 when matching is idle. It removes generated
duplicate groups and their memberships only, preserving directories, files, hashes,
fingerprints, and match-run metadata. If matching is active or queued, it returns
409 `{ "error": "match_running" }` without clearing results; retry after matching
finishes.

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/)
(enforced by commitlint via a `commit-msg` hook). The `pre-commit` hook runs
typecheck, lint, build, tests, and a gitleaks scan of staged changes.
Releases are versioned automatically with semantic-release.
