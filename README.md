# VVV (Veni Vidi Video)

VVV is a content aware video matching tool to find and nuke your duplicate videos to save disk space.

Containers are built and run with **podman** (not docker) — see `docs/deployment.md` and `AGENTS.md`.

# Roadmap

- Support Videos
- Support Images
- Find duplicates by FS properties/stats and hashes
- Find duplicates by image content comparison methods
- Find videos by audio similarity matches
- Find partial matches, whether your small video clip is part of a bigger video file

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
The browser currently has login and an authenticated empty Home screen;
scanning is available through the API below. The built SPA is served by the API server.

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
range returns eligible files to processing, reusing unchanged SHA-256 checkpoints;
files excluded before their first processing receive full analysis. files excluded before their first processing receive full analysis. Excluded files
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
| `POST /api/scans`                             | Starts a scan and returns 202 `{ "id": number }`, or 409 while one is running.                                                                                                                                                                       |
| `GET /api/scans/current`                      | Returns the latest durable scan counters/status (or null), with `current_file` when processing.                                                                                                                                                      |
| `POST /api/scans/:id/cancel`                  | Requests cooperative cancellation; the next scan skips unchanged completed files.                                                                                                                                                                    |
| `GET /api/scans/:id/events`                   | Streams `event: progress` with a JSON scan snapshot in `data:`.                                                                                                                                                                                      |
| `GET /api/scans/:id/errors?cursor=&limit=100` | Returns `{ "items": [{ "file_id", "path", "error" }], "next_cursor": string\|null }`. Pass `next_cursor` unchanged to fetch the next page; null ends pagination.                                                                                     |

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

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/)
(enforced by commitlint via a `commit-msg` hook). The `pre-commit` hook runs
typecheck, lint, build, tests, and a gitleaks scan of staged changes.
Releases are versioned automatically with semantic-release.
