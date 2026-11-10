# syntax=docker/dockerfile:1

# ── Build: bundle claude-share, claude-connect and the manager ──────────────
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
# Baked into the bundle at build time (see scripts/build.ts)
ARG BORE_SERVER=bore.pub
ARG BORE_PASSWORD=
RUN BORE_SERVER="$BORE_SERVER" BORE_PASSWORD="$BORE_PASSWORD" bun run build

# ── bore: optional internet tunnel ──────────────────────────────────────────
FROM alpine:3.20 AS bore
ARG TARGETARCH
ARG BORE_VERSION=0.6.0
RUN case "$TARGETARCH" in \
      amd64) T=x86_64-unknown-linux-musl ;; \
      arm64) T=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && wget -qO- "https://github.com/ekzhang/bore/releases/download/v${BORE_VERSION}/bore-v${BORE_VERSION}-${T}.tar.gz" \
    | tar xz -C /usr/local/bin bore

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM node:22-slim
ENV NODE_ENV=production \
    MANAGER_PORT=8080 \
    SHARE_PORT_START=2586 \
    SHARE_PORT_END=2595
WORKDIR /app
# The bundles are self-contained — no node_modules needed at runtime
COPY --from=build /app/dist ./dist
COPY --from=bore /usr/local/bin/bore /usr/local/bin/bore
USER node
EXPOSE 8080 2586-2595
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.MANAGER_PORT+'/api/config').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/manager/index.js"]
