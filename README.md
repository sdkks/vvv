# VVV (Veni Vidi Video)

VVV is a content aware video matching tool to find and nuke your duplicate videos to save disk space.

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
Only login and an authenticated empty Home screen are implemented so far.
The server does not yet serve the built SPA.

- `packages/server`: Fastify API, signed-cookie auth, SQLite bootstrap.
- `packages/web`: React SPA, Vite development server and production build.
- `packages/shared`: type-only API contracts; no runtime dependencies.

`pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` run across the
workspace. After building, `pnpm --filter @vvv/server start` starts the API.
pnpm runs development processes in parallel without a separate process-manager dependency.

## Server configuration and deployment assumptions

| Variable             | Default / behavior                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VVV_PASSWORD`       | Required, nonempty shared password; never logged or saved in the browser.                                                                                                                        |
| `VVV_SESSION_SECRET` | Optional signing secret. Use a long random secret (at least 20 bytes). If unset, generated per boot, invalidating sessions on restart.                                                           |
| `PORT`               | 8080. The Vite development proxy uses the same PORT value.                                                                                                                                       |
| `DATA_DIR`           | `./data`, relative to the server working directory (`packages/server` under `pnpm dev`). Created automatically; must be writable. Use a path outside the checkout to keep local data out of Git. |

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

Commits must follow [Conventional Commits](https://www.conventionalcommits.org/)
(enforced by commitlint via a `commit-msg` hook). The `pre-commit` hook runs
typecheck, lint, build, tests, and a gitleaks scan of staged changes.
Releases are versioned automatically with semantic-release.
