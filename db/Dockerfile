# syntax=docker/dockerfile:1
# Migration image: psql and the repository's migrations (db/migrate.sh). Build from the
# repository root:
#   docker build -f db/Dockerfile .
FROM postgres:16-alpine
LABEL org.opencontainers.image.source="https://github.com/HarshithaJ28/relay" \
      org.opencontainers.image.description="Relay database migrations" \
      org.opencontainers.image.licenses="NOASSERTION"
# gosu is for starting the server as root; this image never does.
RUN rm -f /usr/local/bin/gosu
COPY db/migrations /db/migrations
COPY db/migrate.sh /usr/local/bin/relay-migrate
USER postgres
ENTRYPOINT ["/usr/local/bin/relay-migrate"]
