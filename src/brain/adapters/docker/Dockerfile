# Builds the image claude-code.ts's DEFAULT_IMAGE ("fabrica-claude-code:latest")
# runs the CLI inside via src/containment/ (issue #44). Verified on the
# real machine: the host's installed CLI is a native macOS binary and
# cannot run in any Linux container - this installs the same tool's own
# Linux build instead, which does run (confirmed: it starts, parses
# args, and reports a version). What it can't do yet is authenticate -
# see claude-code.md's "Process containment" section for why, and for
# the separate, deliberate decision that closes that gap.
#
# Build once, before contained calls can find this image:
#   docker build -t fabrica-claude-code:latest -f src/brain/adapters/docker/Dockerfile .
#
# Pinned to an exact digest, not the floating "20-alpine" tag: pulled
# once and cached, so container spin-up stays fast and reproducible
# rather than silently fetching a new base image on some future run.
# Resolves to Node v20.20.2 on Alpine 3.23.4, verified on the real
# machine at the time this was pinned. The CLI below is pinned to an
# exact version for the same reason: claude-code.md's behavior notes
# (flag semantics, stream-json shape) were verified against 2.1.222, so
# a rebuild must not silently install a different one.
#
# Worker toolchains (issue #86): a Worker that cannot run the project's
# own check command inside its container writes blind and burns fix
# rounds, so the toolchains those commands need live in this image.
# Today that means Go, for projects whose checks are `go test ./...`.
# Alpine 3.23's own `apk add go` is 1.25.10, older than the 1.26.5 such
# a project pins, so the toolchain is copied from the official Go image
# instead - digest-pinned for the same reason the base is, and taken by
# manifest-list digest so it stays correct on both arm64 and amd64.
# Resolves to go1.26.8 on Alpine 3.24.1, verified on the real machine at
# the time this was pinned. This is the short-term answer: one image
# carrying every toolchain. Per-project worker images are a separate,
# later issue.
FROM golang@sha256:ce864e7223ac17b1775e6fd0b4c0db580c2eb50e7953a427916379e4b92a1628 AS go

FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
# git so the Worker can actually use the read-only .git mount
# worktree-git.ts provides (status/log/diff against the real history).
RUN apk add --no-cache git
RUN npm install -g @anthropic-ai/claude-code@2.1.222
COPY --from=go /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:$PATH"
