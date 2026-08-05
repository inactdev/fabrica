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

FROM node:20-alpine
RUN npm install -g @anthropic-ai/claude-code
