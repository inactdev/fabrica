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
# machine at the time this was pinned.
FROM node@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
RUN npm install -g @anthropic-ai/claude-code
