# Mailbird web gateway. Build from the repository root:
#   docker build -f apps/gateway/Dockerfile -t mailbird-gateway .
FROM node:22-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY tools/notes-relay/package.json ./tools/notes-relay/
RUN pnpm install --frozen-lockfile --filter web
COPY apps/web ./apps/web
RUN pnpm --filter web build

FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY apps/gateway ./apps/gateway
COPY tools/push-relay ./tools/push-relay
# The workspace lists the desktop shell too; a stub keeps Cargo happy without its WebView libraries.
# The stub drops its packages from Cargo.lock, so no --locked: every remaining version still comes from it.
RUN mkdir -p apps/web/src-tauri/src \
 && printf '[package]\nname = "mailbird-shell"\nversion = "0.1.0"\nedition = "2024"\n[lib]\npath = "src/lib.rs"\n' > apps/web/src-tauri/Cargo.toml \
 && touch apps/web/src-tauri/src/lib.rs \
 && cargo build --release -p mailbird-gateway

FROM debian:bookworm-slim
# No CA bundle needed: every client trusts the roots built into the binary (webpki-roots).
RUN useradd --system --uid 10001 --home /data gateway && mkdir -p /data && chown gateway /data
COPY --from=build /src/target/release/mailbird-gateway /usr/local/bin/
COPY --from=web /src/apps/web/dist /web
USER gateway
ENV GATEWAY_DATA=/data GATEWAY_WEB=/web GATEWAY_ADDRESS=0.0.0.0:8080
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD ["/usr/local/bin/mailbird-gateway", "--health"]
ENTRYPOINT ["/usr/local/bin/mailbird-gateway"]
