# AGENTS.md — VVV contributor/agent guide

VVV (Veni Vidi Video) is a self-hosted duplicate video/image finder: Fastify API,
React SPA, SQLite state, containerized for NAS/home-server use. Public MIT project.

## Layout

- `packages/server` — Fastify API, signed-cookie auth, SQLite (better-sqlite3, WAL), scan engine
- `packages/web` — React 19 + Vite SPA (plain CSS, no component library)
- `packages/shared` — type-only API contracts

## Gates

- `make ci` = typecheck + lint + build + test + gitleaks (full history scan)
- Conventional Commits enforced by commitlint (`commit-msg` hook); pre-commit runs the same gates on staged changes
- Never modify `.husky/`, `commitlint.config.js`, or Makefile target names without owner direction

## Containers: podman, not docker

This project uses **podman** as its container runtime. All container work — build, run,
inspect, compose — uses podman commands. Do not use `docker` commands and do not
assume a docker daemon; do not add docker-specific tooling or docker-in-docker patterns.

```sh
podman build -t vvv .
podman run -d --name vvv -p 8080:8080 \
  -v /path/to/data:/data \
  -v /path/to/media:/media:ro \
  -e VVV_PASSWORD=change-me \
  localhost/vvv:latest
podman compose -f compose.yml up -d   # or podman-compose
podman logs -f vvv
```

On macOS, podman runs inside a `podman machine` VM; start it with `podman machine start`
before container work. Mount host paths into that VM, not just the container — see
`docs/deployment.md`.

## Conventions

- No ticket IDs, spec IDs, or prior-art project names anywhere in code, comments, docs, or commit messages
- Every server route is registered behind the auth guard unless it is `/api/health` or `/api/auth/login`
- SQLite schema changes only via the ordered `user_version` migration runner
- Tests colocated as `*.test.ts` (Vitest); new behavior ships with tests
- Production LOC per story stays inside its ticket band; stop and report if it would be exceeded
