# overcli serve — the org's workers, their Slack bridge and the control plane,
# in one container. Build from the repo root:
#
#   docker build -f deploy/Dockerfile -t overcli-org .
#
# See deploy/README.md for running it, the volume, and the VPC notes.

# ---- build: compile the CLI (tsc) with dev dependencies, then drop them ----
FROM node:22-bookworm-slim AS build
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
ARG CLAUDE_CODE_VERSION=latest
ARG INSTALL_CODEX=0
ARG CODEX_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && if [ "$INSTALL_CODEX" = "1" ]; then npm install -g "@openai/codex@${CODEX_VERSION}"; fi \
 && npm cache clean --force

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
# The console's display face, from the app's bundled fonts.
COPY --from=build /src/src/renderer/fonts ./src/renderer/fonts
# The docs, served at /docs: the same pages GitHub shows, for this version.
COPY deploy/docs ./deploy/docs
COPY deploy/README.md deploy/aws.md deploy/gcp.md ./deploy/
RUN ln -s /app/dist/cli/index.js /usr/local/bin/overcli && chmod +x /app/dist/cli/index.js

# All state — workers, journals, runs, tokens, the org policy, cloned repos —
# lives on this volume. Lose it and the org loses its workers.
ENV OVERCLI_HOME=/data \
    HOME=/data/home \
    OVERCLI_CONTROL=0.0.0.0:7420
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
