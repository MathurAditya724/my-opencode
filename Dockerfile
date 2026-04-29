# syntax=docker/dockerfile:1.7

# ---- Stage 1: download prebuilt binaries ----
FROM debian:bookworm-slim AS downloader

ARG TARGETARCH
ARG YQ_VERSION=v4.44.3

# Build OpenCode from BYK's fork (https://github.com/BYK/opencode) at the
# byk/cumulative branch instead of using the official prebuilt binaries.
# That branch carries fixes that aren't yet upstream (question dock UX, plan
# mode guards, db perf, etc.). No prebuilt releases exist for the fork, so
# we have to build the binary from source with bun.
ARG OPENCODE_REPO=https://github.com/BYK/opencode.git
ARG OPENCODE_REF=byk/cumulative

ENV DEBIAN_FRONTEND=noninteractive

# Build deps for compiling opencode from source: git to clone, build-essential
# / python3 for any native node modules pulled in by `bun install`, unzip for
# the bun installer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      pkg-config \
      python3 \
      unzip \
 && rm -rf /var/lib/apt/lists/*

# Bun install. BUN_INSTALL has to be on the right of the pipe — that's the
# bash that actually reads it; setting it on `curl` would be useless.
# Installed before the opencode build so we can use it for compilation.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/out/opt/bun bash

ENV PATH=/out/opt/bun/bin:$PATH

# Build opencode from the BYK fork. `bun run build --single` produces a
# single native binary for the host platform under
# packages/opencode/dist/opencode-<os>-<arch>/bin/opencode. We mirror the
# upstream installer's layout by copying that into
# /out/home/developer/.opencode/bin/opencode so the runtime stage's COPY
# path stays unchanged.
RUN git clone --depth 1 --branch "$OPENCODE_REF" "$OPENCODE_REPO" /tmp/opencode-src \
 && cd /tmp/opencode-src \
 && bun install \
 && bun run --cwd packages/opencode build --single \
 && case "$TARGETARCH" in \
      amd64) oc_arch=x64 ;; \
      arm64) oc_arch=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && install -d /out/home/developer/.opencode/bin \
 && cp "packages/opencode/dist/opencode-linux-${oc_arch}/bin/opencode" \
       /out/home/developer/.opencode/bin/opencode \
 && chmod +x /out/home/developer/.opencode/bin/opencode \
 && rm -rf /tmp/opencode-src ~/.bun/install/cache

RUN mkdir -p /out/usr/local/bin \
 && case "$TARGETARCH" in \
      amd64) yq_arch=amd64 ;; \
      arm64) yq_arch=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${yq_arch}" \
      -o /out/usr/local/bin/yq \
 && chmod +x /out/usr/local/bin/yq

# Sentry CLI. Env var on the right of the pipe so bash inherits it.
RUN mkdir -p /out/usr/local/bin \
 && curl -fsSL https://cli.sentry.dev/install \
    | SENTRY_INSTALL_DIR=/out/usr/local/bin \
      bash -s -- --no-modify-path --no-completions

# Pre-fetch the gh apt keyring while curl is handy — saves bootstrapping
# curl in the runtime stage just to grab one file.
RUN install -d -m 0755 /out/etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /out/etc/apt/keyrings/githubcli-archive-keyring.gpg


# ---- Stage 2: runtime ----
FROM debian:bookworm-slim AS runtime

ARG NVM_VERSION=v0.40.3
ARG NODE_VERSION=22.20.0
ARG USER_UID=1000
ARG USER_GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    NODE_VERSION=$NODE_VERSION \
    BROWSER=true

# OS packages + GitHub CLI in a single apt transaction.
COPY --from=downloader \
     /out/etc/apt/keyrings/githubcli-archive-keyring.gpg \
     /etc/apt/keyrings/githubcli-archive-keyring.gpg

RUN chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      fd-find \
      fzf \
      gh \
      git \
      jq \
      less \
      openssh-client \
      pkg-config \
      ripgrep \
      sudo \
      tini \
      unzip \
      vim-tiny \
      wget \
      xz-utils \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# Only copy bun's bin/ — the rest is installer scratch.
COPY --from=downloader /out/usr/local/bin/yq     /usr/local/bin/yq
COPY --from=downloader /out/usr/local/bin/sentry /usr/local/bin/sentry
COPY --from=downloader /out/opt/bun/bin          /opt/bun/bin
RUN ln -s /opt/bun/bin/bun  /usr/local/bin/bun \
 && ln -s /opt/bun/bin/bunx /usr/local/bin/bunx

# Non-root developer user + every dir we'll need, in one layer.
RUN groupadd --gid ${USER_GID} developer \
 && useradd  --uid ${USER_UID} --gid ${USER_GID} \
      --create-home --shell /bin/bash developer \
 && echo 'developer ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/developer \
 && chmod 0440 /etc/sudoers.d/developer \
 && install -d -m 0755 -o developer -g developer \
      /home/developer/dev \
      /home/developer/.opencode \
      /home/developer/.opencode/bin \
      /home/developer/.local \
      /home/developer/.local/share \
      /home/developer/.config \
      /home/developer/.config/opencode \
 && ln -s /home/developer/dev/.opencode /home/developer/.local/share/opencode \
 && chown -h developer:developer /home/developer/.local/share/opencode

COPY --from=downloader --chown=developer:developer \
     /out/home/developer/.opencode/bin/opencode \
     /home/developer/.opencode/bin/opencode

# nvm + Node + corepack pnpm/yarn, installed as the developer user.
ENV NVM_DIR=/home/developer/.nvm
ENV PATH=/home/developer/.opencode/bin:$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

USER developer
RUN mkdir -p "$NVM_DIR" \
 && curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash \
 && bash -c '. "$NVM_DIR/nvm.sh" \
      && nvm install "$NODE_VERSION" \
      && nvm alias default "$NODE_VERSION" \
      && npm install -g corepack@latest \
      && corepack enable \
      && corepack prepare pnpm@latest --activate \
      && corepack prepare yarn@stable --activate \
      && nvm cache clear'

# Baseline opencode user config — kept last so editing it doesn't bust the
# nvm cache on every tweak.
COPY --chown=developer:developer \
     opencode-user-config.json \
     /home/developer/.config/opencode/opencode.json

# Tiny entrypoint that mkdir's ~/dev/.opencode at runtime so a single
# Railway Volume mounted at ~/dev persists projects + OpenCode session/auth
# data together (~/.local/share/opencode is symlinked into it).
COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# No VOLUME directive — Railway rejects them. Attach a Railway Volume at
# /home/developer/dev (~/dev) via the dashboard for persistence; both
# projects you clone there and OpenCode session/auth data live in it.
EXPOSE 4096
WORKDIR /home/developer/dev

# PORT lets PaaS platforms (Railway/Fly/Render) assign a port; falls back
# to 4096 locally.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["sh", "-c", "exec opencode web --hostname 0.0.0.0 --port ${PORT:-4096}"]
