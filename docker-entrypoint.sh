#!/bin/sh
set -e

DEV_DIR="${HOME:-/home/developer}/dev"

# A fresh Railway Volume mounted at ~/dev lands owned by root, so fix it
# up to belong to the running user before we try to write to it.
# Passwordless sudo is configured for the developer user specifically
# so this single chown can succeed without further setup.
if [ ! -w "$DEV_DIR" ]; then
  sudo chown "$(id -u):$(id -g)" "$DEV_DIR" || {
    echo "ERROR: $DEV_DIR is not writable and chown failed." >&2
    echo "Check the volume's mount permissions in your platform's dashboard." >&2
    exit 1
  }
fi

# Ensure OpenCode's session/auth dir exists in the dev volume. The image
# symlinks ~/.local/share/opencode -> ~/dev/.opencode so a single Railway
# Volume mounted at ~/dev persists projects + session history together.
mkdir -p "$DEV_DIR/.opencode"

# OpenCode picks the "worktree" (project root) by walking up from cwd
# looking for a .git directory. With no .git ancestor it falls back to /
# and refuses to write there ("the default working directory (/) doesn't
# allow writing"). Init ~/dev as a git repo so opencode anchors there as
# the worktree. Skipped if a previous deploy already set this up.
if [ ! -d "$DEV_DIR/.git" ]; then
  git init -q "$DEV_DIR"
  git -C "$DEV_DIR" config user.email "developer@my-opencode.local"
  git -C "$DEV_DIR" config user.name  "Developer"
fi

# If GH_TOKEN is set, configure git's credential helper to defer to
# `gh auth git-credential`. Without this, `git push` over HTTPS prompts
# for a username and fails non-interactively, even though gh itself
# (and the agents' `gh` calls) work fine via GH_TOKEN env-var
# auto-detection. The helper resolves the token fresh on every git
# operation — no on-disk token state, matches the env-var-driven
# pattern that survives Railway redeploys.
# Idempotent: gh detects existing helpers and only writes if absent.
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git 2>/dev/null \
    || echo "WARN: gh auth setup-git failed; agents that run 'git push' over HTTPS may stall" >&2
fi

# Pin cwd to ~/dev — Railway can start the container from / regardless
# of the Dockerfile's WORKDIR.
cd "$DEV_DIR"

exec "$@"
