#!/bin/sh
# Start as root only to hand the data volume to the `node` user (volumes made
# by older images belong to root), then run the server without root rights.
set -e
if [ "$(stat -c %u /data)" != "$(id -u node)" ]; then
  chown -R node:node /data
fi
exec setpriv --reuid=node --regid=node --init-groups -- "$@"
