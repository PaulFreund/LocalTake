FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY tsconfig.client.json tsconfig.server.json ./
ARG LOCALTAKE_BUILD_REVISION
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ARG LOCALTAKE_BUILD_REVISION
LABEL org.opencontainers.image.revision=$LOCALTAKE_BUILD_REVISION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
RUN mkdir -p /var/log/localtake && chown node:node /var/log/localtake && chmod 700 /var/log/localtake
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/apps/server/src/main.js"]
