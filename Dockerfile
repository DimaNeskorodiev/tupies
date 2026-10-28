FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY scripts ./scripts
COPY public ./public
COPY docs ./docs
COPY assets ./assets
COPY README.md ./README.md
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 bash ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=4310 \
    STUDIO_DATA_DIR=/data

COPY --chown=node:node package.json package-lock.json server.mjs ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node lib ./lib
COPY --chown=node:node scripts/pair.mjs ./scripts/pair.mjs
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node assets ./assets
COPY --from=build --chown=node:node /app/assets/licenses ./assets/licenses
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 4310
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require(process.env.STUDIO_TLS==='engine'?'https':'http').get({host:'127.0.0.1',port:process.env.STUDIO_PORT,path:'/api/auth',rejectUnauthorized:false},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "server.mjs"]
