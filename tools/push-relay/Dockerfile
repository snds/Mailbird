# Mailbird push relay. Build from the repository root:
#   docker build -f tools/push-relay/Dockerfile -t mailbird-push-relay .
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY tools/push-relay ./tools/push-relay
# The workspace lists the desktop shell and the gateway too; stubs keep Cargo happy without them.
# Stubs drop their packages from Cargo.lock, so no --locked: every remaining version still comes from it.
RUN for m in web/src-tauri:mailbird-shell gateway:mailbird-gateway; do \
      d=apps/${m%%:*}; mkdir -p $d/src \
      && printf '[package]\nname = "%s"\nversion = "0.1.0"\nedition = "2024"\n[lib]\npath = "src/lib.rs"\n' ${m#*:} > $d/Cargo.toml \
      && touch $d/src/lib.rs; \
    done \
 && cargo build --release -p mailbird-push-relay

FROM debian:bookworm-slim
RUN useradd --system --uid 10001 --home /data relay && mkdir -p /data && chown relay /data
COPY --from=build /src/target/release/mailbird-push-relay /usr/local/bin/
USER relay
ENV RELAY_DATA=/data RELAY_ADDRESS=0.0.0.0:8787
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s CMD ["/usr/local/bin/mailbird-push-relay", "--health"]
ENTRYPOINT ["/usr/local/bin/mailbird-push-relay"]
