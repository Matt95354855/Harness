# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Official llama.cpp CUDA server image. Models are mounted at runtime and never copied here.
ARG LLAMA_IMAGE=ghcr.io/ggml-org/llama.cpp:server-cuda
FROM ${LLAMA_IMAGE} AS runtime

COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /opt/harness
COPY --from=build /build/dist/src ./dist/src
COPY --from=build /build/node_modules ./node_modules
COPY web ./web

RUN groupadd --gid 10001 harness \
    && useradd --uid 10001 --gid harness --no-create-home --shell /usr/sbin/nologin harness \
    && mkdir -p /data /models /workspace /config \
    && chown -R harness:harness /data /opt/harness

ENV NODE_ENV=production \
    HARNESS_WEB_DATA=/data \
    HARNESS_WEB_BIND=0.0.0.0 \
    HARNESS_MODEL_ROOT=/models \
    HARNESS_LLAMA_SERVER=/app/llama-server \
    LOCAL_FILE_ROOTS=/workspace \
    MCP_CONFIG_PATH=/config/mcp.json

USER harness
EXPOSE 3080 3081 3082
HEALTHCHECK --interval=30s --timeout=5s --start-period=5m --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3082/api/models >/dev/null || exit 1

ENTRYPOINT []
CMD ["node", "dist/src/web/server.js"]
