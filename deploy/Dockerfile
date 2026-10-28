# overcli serve — the org's workers, their Slack bridge and the control plane,
# in one container. Build from the repo root:
#
#   docker build -f deploy/Dockerfile -t overcli-org .
#
# See deploy/README.md for running it, the volume, and the VPC notes.

# uv runs Python tools packaged for uvx, such as AWS's CloudWatch MCP server
# (deploy/aws.md). Pin it with --build-arg UV_VERSION=<x.y.z>.
ARG UV_VERSION=0.8.0
# overdb's read-only MCP server, for Setup → Databases, built from GitHub at
# this ref. To build against a checkout instead (CI, or the two changing
# together): --build-context overdb-src=../overdb
ARG OVERDB_REF=master
# A Debian mirror to use instead of deb.debian.org, for networks that cannot
# reach it: --build-arg DEBIAN_MIRROR=mirrors.edge.kernel.org. Security
# updates then come straight from security.debian.org, which few mirrors carry.
ARG DEBIAN_MIRROR=
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# ---- overdb: just its main-process code, compiled; no Electron, no UI -----
FROM node:22-bookworm-slim AS overdb-clone
ARG OVERDB_REF
ARG DEBIAN_MIRROR
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i -e "s#deb.debian.org/debian-security#security.debian.org/debian-security#" -e "s#deb.debian.org/debian\$#${DEBIAN_MIRROR}/debian#" /etc/apt/sources.list.d/debian.sources; fi
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && git clone --depth 1 --branch "${OVERDB_REF}" https://github.com/overcodelions/overdb.git /overdb
# The repo at the root of a stage of its own, so a --build-context checkout
# can stand in for it.
FROM scratch AS overdb-src
COPY --from=overdb-clone /overdb/ /

FROM node:22-bookworm-slim AS overdb
WORKDIR /overdb
# Electron is a dev dependency for its types; its 100 MB binary is never run.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY --from=overdb-src package.json package-lock.json ./
# electron-builder packages the desktop app; nothing here needs it, and its
# platform-specific peers (dmg-builder, the Windows installer) leave a lock
# file made on a Mac unusable by `npm ci` on Linux. Without it, `npm install`
# still takes every other version from the lock.
RUN npm pkg delete devDependencies.electron-builder \
 && npm install --ignore-scripts --no-audit --no-fund
COPY --from=overdb-src tsconfig.json tsconfig.main.json ./
COPY --from=overdb-src src ./src
RUN npx tsc -p tsconfig.main.json && npm prune --omit=dev && rm -rf src

# ---- build: compile the CLI (tsc) with dev dependencies, then drop them ----
FROM node:22-bookworm-slim AS build
ARG DEBIAN_MIRROR
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i -e "s#deb.debian.org/debian-security#security.debian.org/debian-security#" -e "s#deb.debian.org/debian\$#${DEBIAN_MIRROR}/debian#" /etc/apt/sources.list.d/debian.sources; fi
# node-pty is a dependency of the desktop app and compiles on install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# The Electron binary is a 100 MB download the CLI never runs.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY tsconfig.json tsconfig.main.json ./
COPY src ./src
RUN npm run build:main && npm prune --omit=dev

# ---- runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim
# git for worktrees; ssh for git remotes; the model CLIs are what every
# worker turn runs. Claude Code always; Codex when INSTALL_CODEX=1. Pin the
# versions for reproducible images: --build-arg CLAUDE_CODE_VERSION=<x.y.z>.
ARG DEBIAN_MIRROR
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i -e "s#deb.debian.org/debian-security#security.debian.org/debian-security#" -e "s#deb.debian.org/debian\$#${DEBIAN_MIRROR}/debian#" /etc/apt/sources.list.d/debian.sources; fi
ARG CLAUDE_CODE_VERSION=latest
ARG INSTALL_CODEX=0
ARG CODEX_VERSION=latest
# JDKs for repos that build on the JVM, so a worker (and the repo's test
# command) can run their tests: Amazon Corretto, any of 8 11 17 21, e.g.
# --build-arg JDKS="8 17". Each lands at /opt/jdk/<version>; the first is
# JAVA_HOME and `java` on PATH. Empty: no JDK.
ARG JDKS=
# Anything else the repos' builds need from Debian: --build-arg
# EXTRA_APT_PACKAGES="maven python3-venv".
ARG EXTRA_APT_PACKAGES=
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini curl gnupg ${EXTRA_APT_PACKAGES} \
 && if [ -n "$JDKS" ]; then \
      curl -fsSL https://apt.corretto.aws/corretto.key | gpg --dearmor -o /usr/share/keyrings/corretto.gpg \
      && echo "deb [signed-by=/usr/share/keyrings/corretto.gpg] https://apt.corretto.aws stable main" > /etc/apt/sources.list.d/corretto.list \
      && apt-get update \
      && mkdir -p /opt/jdk \
      && for v in $JDKS; do \
           if [ "$v" = 8 ]; then pkg=java-1.8.0-amazon-corretto-jdk; dir=java-1.8.0-amazon-corretto; else pkg=java-$v-amazon-corretto-jdk; dir=java-$v-amazon-corretto; fi; \
           apt-get install -y --no-install-recommends "$pkg" \
           && ln -s "$(ls -d /usr/lib/jvm/$dir* | head -1)" "/opt/jdk/$v" || exit 1; \
         done \
      && ln -s "/opt/jdk/$(echo $JDKS | cut -d' ' -f1)" /opt/jdk/default \
      && ln -sf /opt/jdk/default/bin/java /usr/local/bin/java; \
    fi \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && if [ "$INSTALL_CODEX" = "1" ]; then npm install -g "@openai/codex@${CODEX_VERSION}"; fi \
 && npm cache clean --force
# uvx fetches a tool and the Python it needs on first use, into the cache
# under HOME on the volume, so later starts reuse them.
COPY --from=uv /uv /uvx /usr/local/bin/

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# The console's display face, from the app's bundled fonts.
COPY --from=build /src/src/renderer/fonts ./src/renderer/fonts
# The docs, served at /docs: the same pages GitHub shows, for this version.
COPY deploy/docs ./deploy/docs
COPY deploy/README.md deploy/aws.md deploy/gcp.md ./deploy/
# overdb's headless MCP server; Setup → Databases installs the overdb tool on it.
COPY --from=overdb /overdb /opt/overdb
RUN ln -s /app/dist/cli/index.js /usr/local/bin/overcli && chmod +x /app/dist/cli/index.js

# All state — workers, journals, runs, tokens, the org policy, cloned repos —
# lives on this volume. Lose it and the org loses its workers.
# Remote tools' credentials stay sealed in the server; workers reach the
# tools through a loopback gateway (src/main/org/toolGateway.ts).
ENV OVERCLI_HOME=/data \
    HOME=/data/home \
    OVERCLI_CONTROL=0.0.0.0:7420 \
    OVERCLI_TOOL_GATEWAY=1 \
    JAVA_HOME=${JDKS:+/opt/jdk/default} \
    OVERDB_HEADLESS=/opt/overdb/dist/mcp/headless.js
RUN mkdir -p /data/home \
 && chown -R node:node /data \
 && git config --system user.name "overcli workers" \
 && git config --system user.email "workers@overcli.invalid" 
USER node
VOLUME ["/data"]
EXPOSE 7420

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "const p=(process.env.OVERCLI_CONTROL||'7420').split(':').pop();fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/dist/cli/index.js"]
# Permissions: deny is the safe default, and a worker that can use no tools
# can do little. Override CMD (see docker-compose.yml) with an allow-list.
CMD ["serve", "--permissions", "deny"]
