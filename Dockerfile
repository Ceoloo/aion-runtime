# ============================================================================
# AION reference runtime — production image (aion-infra §20–21).
# ============================================================================
# Multi-stage: a build stage vendors + builds @aion/core and @aion/data and
# compiles the host; the final stage carries only the built artifact and
# production dependencies, runs as a NON-ROOT user, and bakes NO secrets.
# Node major is PINNED. The image is immutable and tagged by commit SHA by the
# pipeline (aion-infra §21–22).

# ---- build stage -----------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /build

# git is needed to vendor the pinned @aion/core and @aion/data commits.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
COPY scripts/ ./scripts/

# Vendor the real workload (pinned commits) then install + build.
ARG AION_CORE_REF
ARG AION_DATA_REF
RUN node scripts/setup-deps.mjs
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Ship the aion-infra privilege grants alongside the compiled migrate entrypoint
# so the migration job can enforce least privilege after applying migrations.
COPY sql/ ./dist/sql/

# Prune to production dependencies only (no dev deps in the final image, §20).
RUN npm prune --omit=dev

# ---- runtime stage ---------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Drop privileges: the built-in non-root `node` user owns nothing writable.
COPY --from=build --chown=node:node /build/node_modules ./node_modules
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/package.json ./package.json

USER node
EXPOSE 8080

# Container-level health check (Cloud Run also probes /health/ready; §20, §29).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default command runs the long-running host. The migration JOB overrides this
# with `node dist/migrate.js` (set in the Cloud Run job — runtime module).
CMD ["node", "dist/index.js"]
