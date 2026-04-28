# syntax=docker/dockerfile:1.7

# ---- Stage 1: download prebuilt binaries ----
FROM debian:bookworm-slim AS downloader

ARG TARGETARCH
ARG YQ_VERSION=v4.44.3

ENV DEBIAN_FRONTEND=noninteractive

# tar/gzip are in the slim base; we just need curl + unzip (for Bun).
# `rm docker-clean` so the apt cache mount can actually persist.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      unzip

# OpenCode goes under .local/bin so `opencode upgrade` can rewrite it later.
RUN mkdir -p /out/home/developer/.local/bin \
 && OPENCODE_INSTALL_DIR=/out/home/developer/.local/bin \
    curl -fsSL https://opencode.ai/install | bash

RUN BUN_INSTALL=/out/opt/bun \
    curl -fsSL https://bun.sh/install | bash

RUN case "$TARGETARCH" in \
      amd64) yq_arch=amd64 ;; \
      arm64) yq_arch=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${yq_arch}" \
      -o /out/usr/local/bin/yq \
 && chmod +x /out/usr/local/bin/yq

# Sentry CLI. Env var on the right of the pipe so bash inherits it.
RUN curl -fsSL https://cli.sentry.dev/install \
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
ARG NODE_VERSION=22.11.0
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

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
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
 && ln -s /usr/bin/fdfind /usr/local/bin/fd

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
      /workspace \
      /home/developer/.local \
      /home/developer/.local/bin \
      /home/developer/.local/share \
      /home/developer/.local/share/opencode \
      /home/developer/.config \
      /home/developer/.config/opencode

COPY --from=downloader --chown=developer:developer \
     /out/home/developer/.local/bin/opencode \
     /home/developer/.local/bin/opencode

# nvm + Node + corepack pnpm/yarn, installed as the developer user.
ENV NVM_DIR=/home/developer/.nvm
ENV PATH=/home/developer/.local/bin:$NVM_DIR/versions/node/v$NODE_VERSION/bin:$PATH

USER developer
RUN mkdir -p "$NVM_DIR" \
 && curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${NVM_VERSION}/install.sh" | bash \
 && bash -c '. "$NVM_DIR/nvm.sh" \
      && nvm install "$NODE_VERSION" \
      && nvm alias default "$NODE_VERSION" \
      && corepack enable \
      && corepack prepare pnpm@latest --activate \
      && corepack prepare yarn@stable --activate \
      && nvm cache clear'

# Baseline opencode user config — kept last so editing it doesn't bust the
# nvm cache on every tweak.
COPY --chown=developer:developer \
     opencode-user-config.json \
     /home/developer/.config/opencode/opencode.json

EXPOSE 4096
VOLUME ["/workspace", "/home/developer/.local/share/opencode"]
WORKDIR /workspace

# PORT lets PaaS platforms (Railway/Fly/Render) assign a port; falls back
# to 4096 locally.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "exec opencode web --hostname 0.0.0.0 --port ${PORT:-4096}"]
