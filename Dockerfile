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

# Make the VENDORED packages production-safe BEFORE the runtime-stage COPY.
# setup-deps.mjs cloned full git repos and ran full installs inside
# vendor/aion-core, vendor/aion-data and vendor/aion-data/vendor/aion-core
# (the nested copy) — .git, TS sources, tests, config, and whole
# vitest/eslint/tsc dev trees, some of which npm HOISTS into /build/node_modules.
# The running host imports ONLY each package's dist/** (its "exports"/"main")
# plus PRODUCTION deps; aion-data additionally needs its migrations/ (declared
# in its package "files"). So: (1) drop source/build/test material and every
# lockfile from the vendored trees, then (2) recompute the production dependency
# closure with `npm prune --omit=dev` — per vendored package and once at the
# /build root, which is what actually evicts the hoisted dev tooling.
# `--ignore-scripts` stops aion-data's `preinstall` (setup-core.mjs) from
# re-vendoring a full dev install.
RUN set -eux; \
    DEVPKGS='typescript @types tsx ts-node \
             eslint @eslint @eslint-community @typescript-eslint \
             vitest @vitest vite esbuild @esbuild rollup @rollup \
             @humanfs @humanwhocodes @napi-rs @jridgewell dotenv \
             tinypool tinybench tinyrainbow tinyspy tinyexec \
             chai assertion-error deep-eql loupe pathe magic-string \
             acorn acorn-walk estree-walker source-map-js \
             std-env strip-literal mlly pkg-types confbox ufo local-pkg \
             nanoid picocolors siginfo stackback why-is-node-running \
             expect-type fdir tinyglobby p-limit yocto-queue'; \
    for d in vendor/aion-core vendor/aion-data/vendor/aion-core vendor/aion-data; do \
      [ -d "$d" ] || continue; \
      rm -rf "$d/.git" "$d/src" "$d/tests" "$d/test" "$d/__tests__" "$d/examples" \
             "$d/coverage" "$d/.github" "$d/.vscode" "$d/scripts" "$d/docs" "$d/schema" \
             "$d/benchmarks" "$d/docker-compose.yml" "$d/.env" "$d/.env.example"; \
      find "$d" -maxdepth 1 -type f \( \
             -name 'tsconfig*.json' -o -name '*.tsbuildinfo' -o -name 'vitest.config.*' \
          -o -name 'vite.config.*' -o -name 'eslint.config.*' -o -name '.eslintrc*' \
          -o -name '.prettierrc*' -o -name '.editorconfig' -o -name '.npmignore' \
          -o -name '.gitignore' -o -name '.gitattributes' -o -name '.nvmrc' \
          -o -name 'package-lock.json' -o -name 'npm-shrinkwrap.json' -o -name 'yarn.lock' \
        \) -delete; \
      if [ -d "$d/node_modules" ]; then \
        ( cd "$d" && npm prune --omit=dev --ignore-scripts --no-audit --no-fund ) || true; \
      fi; \
    done; \
    rm -f package-lock.json; \
    npm prune --omit=dev --ignore-scripts --no-audit --no-fund || true; \
    for nm in node_modules vendor/aion-core/node_modules vendor/aion-data/node_modules \
              vendor/aion-data/vendor/aion-core/node_modules; do \
      [ -d "$nm" ] || continue; \
      rm -rf "$nm/.bin" "$nm/.cache" "$nm/.package-lock.json"; \
      for p in $DEVPKGS; do rm -rf "$nm/$p"; done; \
    done; \
    if find node_modules vendor -path '*/node_modules/*' -type d \( \
         -name typescript -o -name vitest -o -name '@vitest' -o -name vite -o -name eslint \
      -o -name '@eslint' -o -name '@typescript-eslint' -o -name tsx -o -name ts-node \
      -o -name esbuild -o -name '@esbuild' -o -name rollup -o -name '@rollup' \
    \) -print | grep . >&2; then \
      echo "FAIL: development tooling survived the vendor sanitize" >&2; exit 1; \
    fi; \
    if find . -maxdepth 6 -name .git -print -quit | grep -q .; then echo "FAIL: .git in build tree" >&2; exit 1; fi; \
    node --input-type=module -e "await import('@aion/core'); await import('@aion/data'); console.log('vendored @aion/* production-safe and resolve')"

# ---- runtime stage ---------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Drop privileges: the built-in non-root `node` user owns nothing writable.
COPY --from=build --chown=node:node /build/node_modules ./node_modules
# @aion/core and @aion/data are file: deps: npm links them as RELATIVE symlinks
# (node_modules/@aion/* -> ../../vendor/*). The vendor tree MUST travel with
# node_modules or those symlinks dangle and `import '@aion/core'` throws at boot
# (the v0.2.0 image shipped node_modules without vendor/ — the boot bug this
# release fixes). The symlinks are relative, so ./vendor here keeps them valid.
COPY --from=build --chown=node:node /build/vendor ./vendor
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/package.json ./package.json

# Regression guard for the v0.2.0 boot bug + packaging hygiene: fail the BUILD
# (never the deploy) if the vendored packages did not travel with node_modules
# (the @aion/* entries are symlinks into ./vendor, so `test -s <link>/dist/...`
# dangles if vendor/ is missing), if development residue survived the sanitize,
# or if either package entrypoint no longer resolves from the FINAL layout.
RUN set -eux; \
    test -s node_modules/@aion/core/dist/index.js; \
    test -s node_modules/@aion/data/dist/index.js; \
    find node_modules/@aion/data/migrations -name '*.sql' | grep -q .; \
    test -s dist/index.js; \
    test ! -d vendor/aion-core/.git; \
    test ! -d vendor/aion-data/.git; \
    test ! -d vendor/aion-data/vendor/aion-core/.git; \
    test ! -d vendor/aion-core/src; \
    test ! -d vendor/aion-data/src; \
    test -z "$(find . -name .git -print -quit)"; \
    ! find node_modules vendor -type d -path '*/node_modules/*' \( -name typescript \
        -o -name vitest -o -name eslint -o -name tsx -o -name '@typescript-eslint' \
        -o -name esbuild -o -name '@esbuild' -o -name rollup -o -name '@rollup' \) \
      -print | grep -q .; \
    node --input-type=module -e "await import('@aion/core'); await import('@aion/data'); console.log('runtime image self-check OK')"

USER node
EXPOSE 8080

# Container-level health check (Cloud Run also probes /health/ready; §20, §29).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default command runs the long-running host. The migration JOB overrides this
# with `node dist/migrate.js` (set in the Cloud Run job — runtime module).
CMD ["node", "dist/index.js"]
