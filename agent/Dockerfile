# DeployNow agent: a small static binary in a scratch-like image.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X github.com/encorp-io/deploynow/agent/internal/agent.Version=${VERSION}" -o /out/deploynow-agent ./cmd/deploynow-agent

FROM alpine:3.24
RUN apk add --no-cache ca-certificates
COPY --from=build /out/deploynow-agent /usr/local/bin/deploynow-agent
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/deploynow-agent"]
CMD ["run"]
