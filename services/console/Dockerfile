# syntax=docker/dockerfile:1
# Console image (Next.js standalone server). Build from the repository root:
#   docker build -f services/console/Dockerfile .

FROM node:22-slim AS build
WORKDIR /build
ENV NEXT_TELEMETRY_DISABLED=1
COPY services/console/package.json services/console/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/console/tsconfig.json services/console/next.config.ts services/console/postcss.config.mjs ./
COPY services/console/src ./src
COPY services/console/public ./public
RUN npm run build

FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/HarshithaJ28/relay" \
      org.opencontainers.image.description="Relay console" \
      org.opencontainers.image.licenses="NOASSERTION"
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# The runtime needs only node: drop the package managers (and their dependencies' CVEs).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn-* \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app
COPY --from=build /build/.next/standalone ./
COPY --from=build /build/.next/static ./.next/static
COPY --from=build /build/public ./public
# Numeric (node in this image): Kubernetes can only enforce runAsNonRoot on a numeric user.
USER 1000:1000
EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server.js"]
