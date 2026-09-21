# Deploying VVV with podman

VVV ships as a single OCI image containing the API server, the built web UI, and
ffmpeg/ffprobe. This project uses **podman**, not docker, as its container runtime.

## Prerequisites

- podman 5+ (`podman --version`)
- On macOS: a running podman machine (`podman machine start`)

## Build

```sh
podman build -t localhost/vvv:latest .
```

## Run

```sh
podman run -d --name vvv -p 8080:8080 \
  -v /path/to/data:/data \
  -v /path/to/media:/media:ro \
  -e VVV_PASSWORD=change-me \
  localhost/vvv:latest
```

- `/data` — persistent state (SQLite DB + thumbnail cache). Keep it on a local
  filesystem inside the container; network mounts break WAL. Must be writable.
- media mounts — your libraries, read-only (`:ro`) is recommended; register their
  container paths as scan directories in the UI.

### macOS note

The podman machine is a lightweight VM. Host paths must be reachable from that VM:
mount them into the machine first (e.g. `podman machine stop && podman machine start` does
not preserve arbitrary mounts — use `podman machine init --volume` or bind via the
`virtiofs` config), then pass the *machine-side* path to `podman run`. When running on
Linux this extra step does not exist.

## Compose

A `compose.yml` is provided at the repo root and works with `podman compose` or
`podman-compose`:

```sh
podman compose -f compose.yml up -d
```

Set `VVV_PASSWORD` (required — the server refuses to boot without it) and the volume
paths in the file before starting.

## Health

`GET /api/health` is unauthenticated and returns `{"status":"ok","db":"ok"}` when the
database is reachable. The image's HEALTHCHECK uses it.

## Restart safety

All durable state lives under `/data`. Recreating the container with the same `/data`
volume preserves the catalog, settings, and quarantine metadata; an interrupted scan
resumes after restart. Killing the container at any point does not corrupt committed
state (WAL).

## Deployment assumptions

Single shared password auth; deploy on a trusted private network or behind your own
access controls with TLS at the reverse proxy. See the README security section.
