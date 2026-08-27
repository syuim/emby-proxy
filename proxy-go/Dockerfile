# Build stage
FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o emby-proxy .

# Runtime stage
FROM alpine:3.19
RUN apk --no-cache add ca-certificates wget tzdata \
    && addgroup -S app \
    && adduser -S -G app -u 10001 app \
    && mkdir -p /app/data \
    && chown app:app /app/data
COPY --from=builder /build/emby-proxy /usr/local/bin/emby-proxy

USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8080/__health || exit 1

ENTRYPOINT ["emby-proxy"]
