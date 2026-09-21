# Pinned to node:22-trixie-slim multi-arch manifest digest for reproducible builds.
FROM docker.io/library/node:22-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/
COPY packages/web/package.json ./packages/web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY packages ./packages
RUN pnpm build && pnpm --filter @vvv/server deploy --legacy --prod --offline /runtime

FROM docker.io/library/node:22-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6 AS media
ARG FFMPEG_TAG=autobuild-2026-08-31-13-27
ARG FFMPEG_VERSION=n8.1.2-50-g1a748fe2cd
ARG FFMPEG_SHA256_AMD64=7d6d93e9c39e0e461feb13c118e91e4eec2515e4da3a01d4ad6790996731bbee
ARG FFMPEG_SHA256_ARM64=56b37b6f2832ba37bd4979ae5c4521ae718efa41846a0d3ecfbbe492137c66f6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=linux64; checksum="$FFMPEG_SHA256_AMD64" ;; \
      arm64) arch=linuxarm64; checksum="$FFMPEG_SHA256_ARM64" ;; \
      *) exit 1 ;; \
    esac; \
    curl -fL --retry 3 "https://github.com/BtbN/FFmpeg-Builds/releases/download/${FFMPEG_TAG}/ffmpeg-${FFMPEG_VERSION}-${arch}-lgpl-8.1.tar.xz" -o /tmp/ffmpeg.tar.xz; \
    echo "$checksum  /tmp/ffmpeg.tar.xz" | sha256sum -c -; \
    mkdir /ffmpeg; tar -xJf /tmp/ffmpeg.tar.xz -C /ffmpeg --strip-components=1

FROM docker.io/library/node:22-trixie-slim@sha256:c5849ff9c9ebcd66615412f0b548ca5b8ecaef84003dc9ac2e077ebe46aaa3f6
ENV NODE_ENV=production DATA_DIR=/data SERVE_WEB_DIST=/app/web PORT=8080
WORKDIR /app
COPY --from=media /ffmpeg/bin/ffmpeg /ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=media /ffmpeg/LICENSE.txt /usr/local/share/licenses/ffmpeg/LICENSE.txt
COPY --from=build /runtime/node_modules ./node_modules
COPY --from=build /runtime/package.json ./
COPY --from=build /app/packages/server/dist ./dist
COPY --from=build /app/packages/web/dist ./web
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/index.js"]
