# argus has no dependencies and no build step, so the image is just a
# Node runtime plus the sources — nothing to install, nothing to compile.
FROM node:22-alpine

WORKDIR /app
COPY . .

# Create the persistence directory in the image so a named volume mounted here
# inherits the `node` ownership instead of coming up root-owned and unwritable.
RUN mkdir -p /data && chown -R node:node /data

USER node

ENV ATHENA_OBS_HOST=0.0.0.0 \
    ATHENA_OBS_PORT=4318 \
    ATHENA_OBS_PERSIST=/data

EXPOSE 4318
VOLUME /data

# /api/health is deliberately reachable without the token so this probe works
# even when the collector is token-gated.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:4318/api/health >/dev/null || exit 1

CMD ["node", "bin/argus.mjs"]
