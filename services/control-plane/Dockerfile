# syntax=docker/dockerfile:1
# Control-plane image. Build from the repository root:
#   docker build -f services/control-plane/Dockerfile .

FROM node:22-slim AS build
WORKDIR /build
COPY services/control-plane/package.json services/control-plane/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY services/control-plane/tsconfig.json ./
COPY services/control-plane/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/HarshithaJ28/relay" \
      org.opencontainers.image.description="Relay control plane" \
      org.opencontainers.image.licenses="NOASSERTION"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY services/control-plane/package.json ./
USER node
EXPOSE 8081
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.RELAY_CONTROL_PORT||8081)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/server.js"]
