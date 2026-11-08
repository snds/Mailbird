# Vale web gateway. Build from the repository root:
#   docker build -f apps/gateway/Dockerfile -t vale-gateway .
# CI publishes it on every push to main as ghcr.io/snds/vale-gateway, with
# VALE_GATEWAY_VERSION stamped (ADR-0077, .github/workflows/gateway-image.yml).
# Without it the build is "from source" and doesn't check for updates.
FROM node:22-slim AS web
WORKDIR /src
# git: pnpm clones the dsa dev tool (a git dependency) while installing.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY tools/notes-relay/package.json ./tools/notes-relay/
RUN pnpm install --frozen-lockfile --filter "web..."
COPY apps/web ./apps/web
RUN pnpm --filter web build

FROM rust:1-slim-bookworm AS build
# The version the binary reports and checks with: `x.y.z-main.<commit time>`.
ARG VALE_GATEWAY_VERSION=
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/gateway ./apps/gateway
COPY tools/push-relay ./tools/push-relay
# The workspace lists the desktop shell too; a stub keeps Cargo happy without its WebView libraries.
# The stub drops its packages from Cargo.lock, so no --locked: every remaining version still comes from it.
RUN mkdir -p apps/web/src-tauri/src \
 && printf '[package]\nname = "vale-shell"\nversion = "0.1.0"\nedition = "2024"\n[lib]\npath = "src/lib.rs"\n' > apps/web/src-tauri/Cargo.toml \
 && touch apps/web/src-tauri/src/lib.rs \
 && VALE_GATEWAY_VERSION="$VALE_GATEWAY_VERSION" cargo build --release -p vale-gateway

FROM debian:bookworm-slim
ARG VALE_GATEWAY_VERSION=
# The published package is linked to this repository by its source label.
LABEL org.opencontainers.image.source="https://github.com/snds/Vale" \
      org.opencontainers.image.description="The Vale web gateway: the web app with your real accounts, on your own server" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VALE_GATEWAY_VERSION}"
# No CA bundle needed: every client trusts the roots built into the binary (webpki-roots).
RUN useradd --system --uid 10001 --home /data gateway && mkdir -p /data && chown gateway /data
COPY --from=build /src/target/release/vale-gateway /usr/local/bin/
COPY --from=web /src/apps/web/dist /web
USER gateway
ENV GATEWAY_DATA=/data GATEWAY_WEB=/web GATEWAY_ADDRESS=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD ["/usr/local/bin/vale-gateway", "--health"]
ENTRYPOINT ["/usr/local/bin/vale-gateway"]
