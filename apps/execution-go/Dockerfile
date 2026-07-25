FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /execution-worker ./cmd/execution-worker

FROM alpine:3.21
RUN apk add --no-cache git ca-certificates
COPY --from=build /execution-worker /usr/local/bin/execution-worker
ENTRYPOINT ["/usr/local/bin/execution-worker"]
