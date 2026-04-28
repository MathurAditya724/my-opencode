#!/bin/sh
set -e

# A fresh Railway Volume mounted at /workspace lands owned by root, so
# fix it up to belong to the running user before we try to write to it.
# Passwordless sudo is configured for the developer user specifically
# so this single chown can succeed without further setup.
if [ ! -w /workspace ]; then
  sudo chown "$(id -u):$(id -g)" /workspace || {
    echo "ERROR: /workspace is not writable and chown failed." >&2
    echo "Check the volume's mount permissions in your platform's dashboard." >&2
    exit 1
  }
fi

# Ensure OpenCode's session/auth dir exists in the workspace. The image
# symlinks ~/.local/share/opencode -> /workspace/.opencode so a single
# Railway Volume on /workspace persists projects + session history.
mkdir -p /workspace/.opencode

exec "$@"
