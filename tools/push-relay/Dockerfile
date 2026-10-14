# Mailbird push relay. Build from the repository root:
#   docker build -f tools/push-relay/Dockerfile -t mailbird-push-relay .
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY tools/push-relay ./tools/push-relay
# The workspace lists the desktop shell too; a stub keeps Cargo happy without its WebView libraries.
RUN mkdir -p apps/web/src-tauri/src \
 && printf '[package]\nname = "mailbird-shell"\nversion = "0.1.0"\nedition = "2024"\n[lib]\npath = "src/lib.rs"\n' > apps/web/src-tauri/Cargo.toml \
 && touch apps/web/src-tauri/src/lib.rs \
 && cargo build --release --locked -p mailbird-push-relay

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home /data relay && mkdir -p /data && chown relay /data
COPY --from=build /src/target/release/mailbird-push-relay /usr/local/bin/
USER relay
ENV RELAY_DATA=/data RELAY_ADDRESS=0.0.0.0:8787
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD ["/usr/local/bin/mailbird-push-relay", "--health"]
ENTRYPOINT ["/usr/local/bin/mailbird-push-relay"]
