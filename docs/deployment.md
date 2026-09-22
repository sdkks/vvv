# Deploying VVV with podman

VVV ships as a single OCI image containing the API server, the built web UI, and
ffmpeg/ffprobe. This project uses **podman**, not docker, as its container runtime.

## Prerequisites

- podman 5+ (`podman --version`)
- On macOS: a running podman machine (`podman machine start`)

## Build

```sh
podman build --format docker -t localhost/vvv:latest .   # or: make image
```

Podman's `--format docker` retains image HEALTHCHECK metadata (the default OCI
serialization omits it); this needs no daemon or different runtime. Compose also
sets the healthcheck explicitly. The image builds natively for amd64 or arm64 on
Debian trixie (glibc). It includes
BtbN ffmpeg/ffprobe 8.1 builds from the retained `autobuild-2026-08-31-13-27` tag;
both architecture checksums are baked into `Dockerfile` and verified before extraction.
No host Node or ffmpeg installation is needed. If those artifacts become unavailable,
the documented alternative is trixie's ffmpeg 7.1.x package, not bookworm's older 5.1;
the build deliberately fails rather than silently switching sources.

## Run

```sh
podman volume create vvv-data
podman run -d --name vvv -p 8080:8080 \
  -v vvv-data:/data \
  -v /path/to/media:/media:ro \
  -e VVV_PASSWORD=change-me \
  localhost/vvv:latest
```

Open http://localhost:8080 and sign in; the same server serves the API and SPA,
including deep links. Replace `change-me` with a strong password before deployment.

- `/data` — persistent SQLite state. Use a local filesystem, not a network mount
  (WAL requirement). The image runs as `node` (UID/GID 1000); a named volume inherits
  writable ownership. A bind mount instead must be writable by that mapped user.
- Media mounts are read-only (`:ro`) by default for scanning; register `/media` through
  the API. Quarantine (`.vvv-trash/` moves) needs a writable mount — set
  `MEDIA_MOUNT_MODE=rw` (compose) or drop `:ro` in your `podman run` command.
- On SELinux hosts, add `:Z` for private bind-mount labels (media: `:ro,Z`).

### macOS note

The podman machine is a lightweight VM. Host paths must be reachable from that VM:
the default machine shares the home directory. For other paths, configure a volume
when creating the machine (`podman machine init --volume /host/path:/vm/path`),
then pass the VM-side path to `podman run`. A named `/data` volume lives inside the
VM; do not remove the machine if you need to retain it. Linux needs no extra VM.

## Compose

Compose reads `VVV_PASSWORD` (defaults to the demo value `vvv-demo` — change it for
real use), `MEDIA_DIR` (media mount),
`MEDIA_MOUNT_MODE` (`ro` default, `rw` enables quarantine), and `VVV_PORT`
(host port, default 8080) from your environment.

A `compose.yml` is provided at the repo root and works with `podman compose` or
`podman-compose`:

```sh
podman compose -f compose.yml up -d
```

Set `MEDIA_DIR` in your shell before starting; the example defaults to `./media` —
create it first or choose an existing VM-visible path. A Compose provider is
required by `podman compose`. The demo password is publicly known (it is in this
repository); change `VVV_PASSWORD` for anything beyond local trials.

## Health

`GET /api/health` is unauthenticated and returns `{"status":"ok","db":"ok"}` when the
database is reachable. The image's HEALTHCHECK uses it.

## Restart safety

All durable state lives under `/data`. Recreating the container with the same `/data`
volume preserves the catalog and settings. Interrupted scans are marked interrupted;
start another scan to resume without reprocessing unchanged files. WAL protects
committed state against process crashes, not host power loss. Without a stable
`VVV_SESSION_SECRET`, sign in again after restart. Do not use `down -v` when keeping data.

## Deployment assumptions

Single shared password auth; deploy on a trusted private network or behind your own
access controls with TLS at the reverse proxy. See the README security section.
