# syntax=docker/dockerfile:1
# Data-plane image. Build from the repository root:
#   docker build -f services/data-plane/Dockerfile .

FROM python:3.15-slim AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY services/data-plane/requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --require-virtualenv -r requirements.txt

FROM python:3.15-slim
LABEL org.opencontainers.image.source="https://github.com/HarshithaJ28/relay" \
      org.opencontainers.image.description="Relay data plane" \
      org.opencontainers.image.licenses="NOASSERTION"
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin relay
COPY --from=build /opt/venv /opt/venv
COPY services/data-plane/relay_dataplane /app/relay_dataplane
WORKDIR /app
USER 10001
# The outbox publisher is the only runnable entry point so far: it drains the
# outbox once and exits. Configured by RELAY_DSN, RELAY_AMQP and RELAY_QUEUE.
CMD ["python", "-m", "relay_dataplane.publisher"]
