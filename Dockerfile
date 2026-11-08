# syntax=docker/dockerfile:1.7
#
# One multi-stage Dockerfile that builds both runtime targets:
#   - target `web`    -> Next.js standalone server
#   - target `worker` -> bundled Node worker (tsup output, fully self-contained)
#
# docker-compose selects the target per service. Shared `deps`/`build` stages
# are reused so the workspace installs and compiles once per build.

# ---- Base image -------------------------------------------------------------
# Digest-pinned like the compose images: a rebuild must not silently change the
# runtime. Refresh with `docker pull node:24-slim && docker image inspect
# node:24-slim --format '{{index .RepoDigests 0}}'`.
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
WORKDIR /app
# Keep the image lean; npm progress noise off for cleaner build logs.
ENV NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# ---- Dependencies (full workspace install, incl. dev tooling) ---------------
FROM base AS deps
# Copy only manifests first for better layer caching.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/media/package.json packages/media/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/storage/package.json packages/storage/package.json
RUN --mount=type=cache,target=/root/.npm npm ci --include=dev

# ---- Build (web standalone + worker bundle) ---------------------------------
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# The Next build cache persists across image builds via the mount, cutting
# incremental rebuilds 2–4×; it never ships in the image.
RUN --mount=type=cache,target=/app/apps/web/.next/cache npm run build -w @liedmotif/web \
    && npm run build -w @liedmotif/worker
RUN node scripts/third-party-notices.mjs THIRD_PARTY_NOTICES.txt

# ---- Runtime base -----------------------------------------------------------
# The runtime targets only ever exec `node`; npm/npx/corepack/yarn are build
# tooling. A package manager kept in the shipped image is a liability with no
# consumer: nothing in the container ever patches the npm CLI's bundled
# dependencies, so their advisories fail the weekly image scan without any app
# dependency being affected. Ship no package manager at all.
FROM base AS runtime
RUN rm -rf /usr/local/lib/node_modules \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

# ---- Web runtime ------------------------------------------------------------
FROM runtime AS web
# NEXT_MANUAL_SIG_HANDLE: stop Next's standalone server from exiting immediately
# on SIGTERM; instrumentation.ts drains in-flight responses and closes the pool
# first (bounded by the web service's compose stop_grace_period).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# curl (~2 MB) serves the compose healthcheck without cold-starting Node every
# interval.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
# Next.js standalone output (traced from the monorepo root).
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/LICENSE.md /app/NOTICE.md /app/THIRD_PARTY_NOTICES.txt ./
# /data is the only path the runtime user may write. The app tree stays
# root-owned and world-readable, so a compromised process cannot rewrite its own
# code. Docker seeds a FRESH named volume from the image's directory, which is
# what lets local-fs storage write without a privileged entrypoint; a volume that
# already exists keeps its old root ownership and needs the one-time chown
# documented in docker/README.md.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

# ---- Worker runtime ---------------------------------------------------------
FROM runtime AS worker
ENV NODE_ENV=production
# ffmpeg for track analysis: consumed via
# bounded child-process invocation only — aggregation, never linking (a
# licensing decision). The distro package keeps Debian's security-update
# pipeline; the CI `worker-image` job smokes the exact package version + build
# configuration against `docker/ci/ffmpeg-pin.txt`, and NOTICE.md records the
# pin with its corresponding-source URLs. The slim base's dpkg config retains
# `/usr/share/doc/*/copyright` by default — the smoke asserts it survived.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
# The worker bundle is self-contained (tsup noExternal) EXCEPT `sharp`, a native
# module that cannot be bundled (album-art rendition for ID3 embedding). Copy its
# installed tree (sharp + its @img platform binaries and JS deps) from the build
# stage so the bundle's createRequire can resolve it at runtime.
COPY --from=build /app/node_modules/sharp ./node_modules/sharp
COPY --from=build /app/node_modules/@img ./node_modules/@img
COPY --from=build /app/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build /app/node_modules/semver ./node_modules/semver
COPY --from=build /app/apps/worker/dist ./dist
COPY --from=build /app/LICENSE.md /app/NOTICE.md /app/THIRD_PARTY_NOTICES.txt ./
# Poster Art lettering uses this committed font asset after provider output has
# been normalized; keeping it in the image makes glyph coverage deterministic.
COPY --from=build /app/apps/worker/assets ./apps/worker/assets
# The brand overlay is read from disk at composite time and resolves relative to
# the process cwd (`/app`) once the bundle has inlined the package source.
COPY --from=build /app/packages/media/assets ./packages/media/assets
# Committed Drizzle SQL migrations for the one-shot compose `migrate` service
# (`node dist/migrate-stack.js`): the bundled MIGRATIONS_DIR resolves to
# `../drizzle` relative to `dist/`, i.e. exactly this path.
COPY --from=build /app/packages/db/drizzle ./drizzle
# Same writable-path rule as the web stage; see the comment there. Analysis temp
# files and the heartbeat go to /tmp, so nothing else needs write access.
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "dist/index.js"]
