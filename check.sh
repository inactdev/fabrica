#!/bin/sh
# fabrica's own definition of green: the whole suite, never a subset.
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules ]; then
  if [ -d /deps/node_modules ]; then
    # Inside inspector's check container (see Dockerfile.inspector): no
    # network, dependencies were installed when the image was built.
    ln -s /deps/node_modules node_modules
  else
    npm ci
  fi
fi
npm test
