# syntax=docker/dockerfile:1
# Data-plane image. Build from the repository root:
#   docker build -f services/data-plane/Dockerfile .

FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY services/data-plane/requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --require-virtualenv -r requirements.txt

FROM python:3.12-slim
LABEL org.opencontainers.image.source="https://github.com/HarshithaJ28/relay" \
      org.opencontainers.image.description="Relay data plane" \
      org.opencontainers.image.licenses="NOASSERTION"
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
# Security fixes published after the base image was built.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin relay
COPY --from=build /opt/venv /opt/venv
COPY services/data-plane/relay_dataplane /app/relay_dataplane
WORKDIR /app
USER 10001
# One image, six processes: worker (default), scheduler, reaper, publisher, retention,
# and ingest (the HTTP API on RELAY_INGEST_PORT, default 8080). Every other process serves
# /metrics, /healthz and /readyz on RELAY_METRICS_PORT (default 9100).
# Choose with the argument, e.g. `docker run IMAGE python -m relay_dataplane scheduler`.
# SIGTERM shuts each one down gracefully. Settings: see relay_dataplane/settings.py.
EXPOSE 8080 9100
STOPSIGNAL SIGTERM
CMD ["python", "-m", "relay_dataplane", "worker"]
