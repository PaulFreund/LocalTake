FROM node:24-alpine AS client-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN npm ci
COPY apps/client apps/client
COPY packages packages
COPY scripts scripts
COPY tsconfig.client.json ./
ARG LOCALTAKE_BUILD_REVISION
RUN npm run build:client

FROM rust:1.90-alpine AS server-build
RUN apk add --no-cache musl-dev
WORKDIR /app
ARG CARGO_BUILD_JOBS=1
ENV CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS
COPY Cargo.toml Cargo.lock ./
COPY apps/server apps/server
RUN cargo build --release --locked --bin localtake-server

FROM alpine:3.22
ARG LOCALTAKE_BUILD_REVISION
LABEL org.opencontainers.image.revision=$LOCALTAKE_BUILD_REVISION
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
# Keep uid/gid 1000 so existing telemetry volumes remain writable after upgrade.
RUN addgroup -g 1000 localtake && adduser -D -u 1000 -G localtake localtake \
    && mkdir -p /var/log/localtake \
    && chown localtake:localtake /var/log/localtake \
    && chmod 700 /var/log/localtake
COPY --from=server-build /app/target/release/localtake-server /usr/local/bin/localtake-server
COPY --from=client-build --chown=localtake:localtake /app/dist/client ./dist/client
USER localtake
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["localtake-server", "healthcheck"]
CMD ["localtake-server"]
