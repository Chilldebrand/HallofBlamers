# syntax=docker/dockerfile:1
#
# Hall of Blamers self-host image (Task 15). ONE image, TWO roles — docker-compose.yml's `web` and
# `worker` services both run this image, differing only in `command`. `web` runs the built Next
# standalone server; `worker` runs the sync/backup entry point straight off TypeScript source via
# `tsx` (see worker/index.ts's docstring for why: there's no existing build step for worker/*.ts
# outside Next's own app-router bundler, and standing up a second, parallel `tsc` pipeline for one
# small entry point adds real complexity for a single-operator box with no benefit worth that
# cost — `tsx` here is a deliberate choice, not an oversight).

# ---------------------------------------------------------------------------
# Stage 1: deps — installs node_modules INSIDE the Linux container.
# ---------------------------------------------------------------------------
FROM node:22-slim AS deps
WORKDIR /app

# better-sqlite3 ships prebuilt native binaries (via `prebuild-install`) for common platforms,
# including linux-x64-glibc — exactly what `node:22-slim` (Debian) is, so `npm ci` below fetches
# a matching prebuild automatically; no compilation happens in the common case. python3/make/g++
# are installed anyway as a fallback so the install still succeeds (compiling from source) on the
# rare chance npm's prebuild mirror is unreachable — this layer never reaches the runtime image
# (see the `runtime` stage below, which starts fresh from `node:22-slim` and copies in only
# specific files), so it costs nothing at deploy time.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# MUST run here, inside the container — never copy a host-built node_modules into this image.
# That's what makes better-sqlite3's compiled binding match the container's actual platform
# (linux x64) instead of whatever OS built it (this repo is authored on Windows).
RUN npm ci

# ---------------------------------------------------------------------------
# Stage 2: build — `next build` with `output: "standalone"` (see next.config.ts).
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
# `.env` is excluded from the build context by .dockerignore. This matters here specifically:
# `next build` with standalone output copies any `.env*` file present in the project root
# VERBATIM into `.next/standalone/.env` (confirmed empirically while building this feature) — if
# a real `.env` reached this COPY, its secrets (ESPN cookies, SESSION_SECRET, ANTHROPIC_API_KEY)
# would be baked into an image layer forever. With no `.env` in the build context, there's nothing
# for Next to copy — real secrets only ever reach a container at RUNTIME, via docker-compose's
# `env_file: .env` (a live mount of the host file, never part of the image).
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3: runtime — the shipped image. Starts fresh from node:22-slim (none of the `deps`/`build`
# stages' apt packages or source tree carry over except what's explicitly COPY'd below).
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Deliberately root (no `USER` switch). The `web`/`worker` services bind-mount `./data:/data` from
# the host — a non-root container user would need to match the host directory's ownership exactly
# or writes to /data (the live DB, nightly backups) would fail with permission errors that a
# non-developer operator has no easy way to diagnose or fix. This box is single-purpose (nothing
# else runs on it) and only reachable through the Cloudflare Tunnel / the operator's own SSH
# access, so the usual "don't run containers as root" hardening trades a real day-one usability
# problem for a marginal security gain here. Revisit if that trade-off ever stops holding.

# Full node_modules, built for linux x64 in the `deps` stage. The standalone server (copied below)
# only needs its own trimmed subset, but `worker` runs off raw TypeScript via `tsx`, which needs
# packages Next's file-tracing never sees — nothing in the Next app itself imports `tsx` or
# `croner`, only worker/index.ts does.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# The standalone Next server: a minimal server.js plus its compiled .next/ server output. Per
# Next's docs, `.next/static` and `public/` are NOT included automatically — copied in separately
# below.
COPY --from=build /app/.next/standalone/server.js ./server.js
COPY --from=build /app/.next/standalone/.next ./.next
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Worker source, and everything under src/server it imports (db client/migrations, espn client,
# sync pipeline, stats build) — raw .ts, run directly via `tsx` (see docker-compose.yml's
# `worker` service command). Not needed by `web` (already compiled into the standalone bundle
# above), but harmless to have present in both containers since it's the same image.
COPY --from=build /app/worker ./worker
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./tsconfig.json

# Franchise/manager/correction seed data. normalizeSeason() and loadSeedCorrections() read these
# from `./seed` relative to the process's cwd at runtime (see src/server/sync/franchise-map.ts and
# corrections.ts) — needed by the worker's sync tiers, and by any manual
# `docker compose exec web npm run seed:managers`-style invocation.
COPY --from=build /app/seed ./seed

EXPOSE 3000

# No CMD/ENTRYPOINT here on purpose — docker-compose.yml's `web` and `worker` services each set
# their own `command`, since this one image serves both roles.
