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

# Set git author identity to the GH_TOKEN's owner so commits agents
# push from cloned repos (~/dev/<owner>/<repo>) are attributed to the
# bot's actual GitHub user. Without this, commits inherit either the
# image's default identity or whatever git falls back to — which can
# leak unrelated identities (e.g. an upstream bot baked into a parent
# image) onto every commit the bot pushes.
#
# Uses GitHub's noreply pattern (<id>+<login>@users.noreply.github.com)
# so the commit author resolves cleanly to the bot's GitHub user
# without exposing a private email. Set globally so every clone
# inherits it; also written to the ~/dev repo-local config to override
# any pre-existing values there.
#
# Fail-soft: if `gh api user` errors, leave existing identity alone
# and let the fallback below set a sane default.
if [ -n "$GH_TOKEN" ]; then
  GH_USER_JSON=$(gh api user 2>/dev/null) || GH_USER_JSON=""
  if [ -n "$GH_USER_JSON" ]; then
    GH_LOGIN=$(printf '%s' "$GH_USER_JSON" | jq -r '.login // empty')
    GH_ID=$(printf '%s' "$GH_USER_JSON" | jq -r '.id // empty')
    GH_NAME=$(printf '%s' "$GH_USER_JSON" | jq -r '.name // .login // empty')
    if [ -n "$GH_LOGIN" ] && [ -n "$GH_ID" ]; then
      GH_EMAIL="${GH_ID}+${GH_LOGIN}@users.noreply.github.com"
      git config --global user.name  "$GH_NAME"
      git config --global user.email "$GH_EMAIL"
      git -C "$DEV_DIR" config user.name  "$GH_NAME"
      git -C "$DEV_DIR" config user.email "$GH_EMAIL"
      echo "git author identity: $GH_NAME <$GH_EMAIL>"
    else
      echo "WARN: gh api user returned empty login/id; git author identity not set" >&2
    fi
  else
    echo "WARN: gh api user failed; git author identity not set" >&2
  fi
fi

# Fallback identity for the ~/dev worktree when GH_TOKEN is unset or
# `gh api user` failed above. Only written if the repo-local config
# is currently empty so we don't stomp the gh-derived identity on
# subsequent boots.
if ! git -C "$DEV_DIR" config --get user.email >/dev/null 2>&1; then
  git -C "$DEV_DIR" config user.email "developer@my-opencode.local"
  git -C "$DEV_DIR" config user.name  "Developer"
fi

# Pin cwd to ~/dev — Railway can start the container from / regardless
# of the Dockerfile's WORKDIR.
cd "$DEV_DIR"

exec "$@"
