#!/bin/sh
# fabrica's own definition of green: the whole suite, never a subset.
set -e
cd "$(dirname "$0")"
[ -d node_modules ] || npm ci
npm test
