terraform {
  required_version = ">= 1.0"
  required_providers {
    coder = {
      source  = "coder/coder"
      version = "~> 2.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
  }
}

provider "coder" {}

variable "use_kubeconfig" {
  type        = bool
  description = <<-EOF
  Use host kubeconfig? (true/false)

  Set to false when the Coder host itself runs as a Pod on the same cluster.
  Set to true when the Coder host is external and ~/.kube/config is available.
  EOF
  default     = false
}

variable "namespace" {
  type        = string
  description = "Kubernetes namespace to create workspaces in (must already exist)."
  default     = "coder"
}

provider "kubernetes" {
  config_path = var.use_kubeconfig ? "~/.kube/config" : null
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

# --- Parameters (prompted when creating a workspace) ---

data "coder_parameter" "gh_token" {
  name         = "gh_token"
  display_name = "GitHub Token"
  description  = "PAT with repo, read:org, workflow scopes. Used for gh CLI and bot identity."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 1
}

data "coder_parameter" "anthropic_api_key" {
  name         = "anthropic_api_key"
  display_name = "Anthropic API Key"
  description  = "API key for Claude. At least one LLM provider key is required."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 10
}

data "coder_parameter" "openai_api_key" {
  name         = "openai_api_key"
  display_name = "OpenAI API Key"
  description  = "API key for OpenAI models. Optional if another provider key is set."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 11
}

data "coder_parameter" "github_webhook_secret" {
  name         = "github_webhook_secret"
  display_name = "GitHub Webhook Secret"
  description  = "HMAC secret for verifying GitHub webhook deliveries. Required to receive webhooks."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 2
}

data "coder_parameter" "webhook_port" {
  name         = "webhook_port"
  display_name = "Webhook Port"
  description  = "Port for the opentower webhook listener."
  type         = "number"
  mutable      = true
  default      = "5050"
  order        = 40
}

data "coder_parameter" "opentower_api_token" {
  name         = "opentower_api_token"
  display_name = "OpenTower API Token"
  description  = "Bearer token for the /api/* dashboard endpoints. Without this, API requests are rejected with 503."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 3
}

data "coder_parameter" "gemini_api_key" {
  name         = "gemini_api_key"
  display_name = "Gemini API Key"
  description  = "API key for Google Gemini models. Optional if another provider key is set."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 12
}

data "coder_parameter" "groq_api_key" {
  name         = "groq_api_key"
  display_name = "Groq API Key"
  description  = "API key for Groq models. Optional if another provider key is set."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 13
}

data "coder_parameter" "openrouter_api_key" {
  name         = "openrouter_api_key"
  display_name = "OpenRouter API Key"
  description  = "API key for OpenRouter. Optional if another provider key is set."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 14
}

data "coder_parameter" "email_webhook_secret" {
  name         = "email_webhook_secret"
  display_name = "Email Webhook Secret"
  description  = "HMAC secret for verifying email webhook deliveries from Cloudflare Email Worker. Required only if using email triggers."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 41
}

data "coder_parameter" "sentry_dsn" {
  name         = "sentry_dsn"
  display_name = "Sentry DSN"
  description  = "Sentry DSN for the opentower plugin. If set, Sentry.init() is called at plugin startup."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 50
}

data "coder_parameter" "sentry_auth_token" {
  name         = "sentry_auth_token"
  display_name = "Sentry Auth Token"
  description  = "Auth token for Sentry CLI. Used for non-interactive auth."
  type         = "string"
  mutable      = true
  default      = ""
  order        = 51
}

# --- Persistent volume for ~/dev ---

resource "kubernetes_persistent_volume_claim_v1" "dev" {
  metadata {
    name      = "opencode-${data.coder_workspace.me.id}-dev"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"     = "opencode-pvc"
      "app.kubernetes.io/instance" = "opencode-pvc-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      "com.coder.resource"         = "true"
      "com.coder.workspace.id"     = data.coder_workspace.me.id
      "com.coder.workspace.name"   = data.coder_workspace.me.name
      "com.coder.user.id"          = data.coder_workspace_owner.me.id
      "com.coder.user.username"    = data.coder_workspace_owner.me.name
    }
  }
  wait_until_bound = false
  spec {
    access_modes = ["ReadWriteOnce"]
    resources {
      requests = {
        storage = "10Gi"
      }
    }
  }
  lifecycle {
    ignore_changes = all
  }
}

# --- Agent ---

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"
  dir  = "/home/developer/dev"

  env = {
    GH_TOKEN              = data.coder_parameter.gh_token.value
    ANTHROPIC_API_KEY     = data.coder_parameter.anthropic_api_key.value
    OPENAI_API_KEY        = data.coder_parameter.openai_api_key.value
    GEMINI_API_KEY        = data.coder_parameter.gemini_api_key.value
    GROQ_API_KEY          = data.coder_parameter.groq_api_key.value
    OPENROUTER_API_KEY    = data.coder_parameter.openrouter_api_key.value
    GITHUB_WEBHOOK_SECRET = data.coder_parameter.github_webhook_secret.value
    EMAIL_WEBHOOK_SECRET  = data.coder_parameter.email_webhook_secret.value
    WEBHOOK_PORT          = tostring(data.coder_parameter.webhook_port.value)
    OPENTOWER_API_TOKEN   = data.coder_parameter.opentower_api_token.value
    SENTRY_DSN            = data.coder_parameter.sentry_dsn.value
    SENTRY_AUTH_TOKEN     = data.coder_parameter.sentry_auth_token.value
    # git identity is set by docker-entrypoint.sh from GH_TOKEN/gh api user;
    # do not set GIT_AUTHOR_* here — it would attribute bot commits to the
    # Coder workspace owner instead of the GitHub bot account.
  }

  metadata {
    display_name = "CPU Usage"
    key          = "0_cpu_usage"
    script       = "coder stat cpu"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "RAM Usage"
    key          = "1_ram_usage"
    script       = "coder stat mem"
    interval     = 10
    timeout      = 1
  }

  metadata {
    display_name = "Disk Usage"
    key          = "2_disk_usage"
    script       = "coder stat disk --path /home/developer/dev"
    interval     = 60
    timeout      = 1
  }
}

# OpenCode web UI — exposed via Coder's reverse proxy
resource "coder_app" "opencode" {
  agent_id     = coder_agent.main.id
  slug         = "opencode"
  display_name = "OpenCode"
  url          = "http://localhost:4096"
  icon         = "/icon/jetbrains-toolbox.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:4096"
    interval  = 10
    threshold = 6
  }
}

# Opentower webhook listener — exposed via Coder's reverse proxy
resource "coder_app" "opentower" {
  agent_id     = coder_agent.main.id
  slug         = "opentower"
  display_name = "OpenTower"
  url          = "http://localhost:5050"
  icon         = "/icon/kiro.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:5050/healthz"
    interval  = 10
    threshold = 6
  }
}

# OpenCode server — started by the Coder agent after it connects.
# The container command (sh -c init_script) bypasses docker-entrypoint.sh,
# so this script must replicate the critical setup: volume ownership,
# .opencode session dir, git init, and gh/git identity.
resource "coder_script" "opencode" {
  agent_id     = coder_agent.main.id
  display_name = "OpenCode Server"
  run_on_start = true
  script       = <<-EOT
    #!/bin/sh
    set -e

    DEV_DIR="$${HOME:-/home/developer}/dev"

    # Fix PVC ownership (fresh volumes land root-owned)
    if [ ! -w "$DEV_DIR" ]; then
      sudo chown "$(id -u):$(id -g)" "$DEV_DIR" || {
        echo "ERROR: $DEV_DIR is not writable and chown failed." >&2
        exit 1
      }
    fi

    # Session/auth dir (symlinked from ~/.local/share/opencode)
    mkdir -p "$DEV_DIR/.opencode"

    # OpenCode needs a .git ancestor to anchor the worktree
    if [ ! -d "$DEV_DIR/.git" ]; then
      git init -q "$DEV_DIR"
    fi

    # --- Identity setup (fail-soft) ---
    set +e
    if [ -n "$GH_TOKEN" ]; then
      gh auth setup-git 2>/dev/null || true
      GH_USER_JSON=$(gh api user 2>/dev/null) || GH_USER_JSON=""
      if [ -n "$GH_USER_JSON" ]; then
        GH_LOGIN=$(printf '%s' "$GH_USER_JSON" | jq -r '.login // empty')
        GH_ID=$(printf '%s' "$GH_USER_JSON" | jq -r '.id // empty')
        GH_NAME=$(printf '%s' "$GH_USER_JSON" | jq -r '.name // .login // empty')
        if [ -n "$GH_LOGIN" ] && [ -n "$GH_ID" ]; then
          GH_EMAIL="$${GH_ID}+$${GH_LOGIN}@users.noreply.github.com"
          git config --global user.name  "$GH_NAME"
          git config --global user.email "$GH_EMAIL"
          git -C "$DEV_DIR" config user.name  "$GH_NAME"
          git -C "$DEV_DIR" config user.email "$GH_EMAIL"
        fi
      fi
    fi
    if ! git -C "$DEV_DIR" config --get user.email >/dev/null 2>&1; then
      git -C "$DEV_DIR" config user.email "developer@outpost.local"
      git -C "$DEV_DIR" config user.name  "Developer"
    fi
    set -e

    cd "$DEV_DIR"

    # Start OpenCode in the background so the script exits and Coder
    # marks it as complete. The healthcheck on coder_app monitors it.
    opencode serve --hostname 0.0.0.0 --port "$${PORT:-4096}" > /tmp/opencode.log 2>&1 &
  EOT
}

# --- Kubernetes deployment ---

resource "kubernetes_deployment_v1" "workspace" {
  count = data.coder_workspace.me.start_count
  depends_on = [
    kubernetes_persistent_volume_claim_v1.dev
  ]
  wait_for_rollout = false

  metadata {
    name      = "opencode-${data.coder_workspace.me.id}"
    namespace = var.namespace
    labels = {
      "app.kubernetes.io/name"     = "opencode-workspace"
      "app.kubernetes.io/instance" = "opencode-workspace-${data.coder_workspace.me.id}"
      "app.kubernetes.io/part-of"  = "coder"
      "com.coder.resource"         = "true"
      "com.coder.workspace.id"     = data.coder_workspace.me.id
      "com.coder.workspace.name"   = data.coder_workspace.me.name
      "com.coder.user.id"          = data.coder_workspace_owner.me.id
      "com.coder.user.username"    = data.coder_workspace_owner.me.name
    }
  }

  spec {
    replicas = 1
    selector {
      match_labels = {
        "app.kubernetes.io/name"     = "opencode-workspace"
        "app.kubernetes.io/instance" = "opencode-workspace-${data.coder_workspace.me.id}"
      }
    }
    strategy {
      type = "Recreate"
    }

    template {
      metadata {
        labels = {
          "app.kubernetes.io/name"     = "opencode-workspace"
          "app.kubernetes.io/instance" = "opencode-workspace-${data.coder_workspace.me.id}"
          "app.kubernetes.io/part-of"  = "coder"
          "com.coder.resource"         = "true"
          "com.coder.workspace.id"     = data.coder_workspace.me.id
          "com.coder.workspace.name"   = data.coder_workspace.me.name
          "com.coder.user.id"          = data.coder_workspace_owner.me.id
          "com.coder.user.username"    = data.coder_workspace_owner.me.name
        }
      }

      spec {
        # The image runs as uid/gid 1000 (developer).
        security_context {
          run_as_user  = 1000
          run_as_group = 1000
          fs_group     = 1000
        }

        container {
          name              = "opencode"
          image             = "ghcr.io/mathuraditya724/outpost:0.3.1"
          image_pull_policy = "Always"

          # Official Coder Kubernetes template pattern:
          # command overrides Docker ENTRYPOINT, running init_script directly
          # via "sh -c". The init_script downloads the correct coder agent
          # binary from the server and execs it. CODER_AGENT_TOKEN is the
          # only required env var — CODER_AGENT_URL is baked into init_script
          # by the Coder provider at apply time.
          command = ["sh", "-c", coder_agent.main.init_script]
          env {
            name  = "CODER_AGENT_TOKEN"
            value = coder_agent.main.token
          }
          env {
            name  = "GH_TOKEN"
            value = data.coder_parameter.gh_token.value
          }
          env {
            name  = "ANTHROPIC_API_KEY"
            value = data.coder_parameter.anthropic_api_key.value
          }
          env {
            name  = "OPENAI_API_KEY"
            value = data.coder_parameter.openai_api_key.value
          }
          env {
            name  = "GEMINI_API_KEY"
            value = data.coder_parameter.gemini_api_key.value
          }
          env {
            name  = "GROQ_API_KEY"
            value = data.coder_parameter.groq_api_key.value
          }
          env {
            name  = "OPENROUTER_API_KEY"
            value = data.coder_parameter.openrouter_api_key.value
          }
          env {
            name  = "GITHUB_WEBHOOK_SECRET"
            value = data.coder_parameter.github_webhook_secret.value
          }
          env {
            name  = "EMAIL_WEBHOOK_SECRET"
            value = data.coder_parameter.email_webhook_secret.value
          }
          env {
            name  = "WEBHOOK_PORT"
            value = tostring(data.coder_parameter.webhook_port.value)
          }
          env {
            name  = "OPENTOWER_API_TOKEN"
            value = data.coder_parameter.opentower_api_token.value
          }
          env {
            name  = "SENTRY_DSN"
            value = data.coder_parameter.sentry_dsn.value
          }
          env {
            name  = "SENTRY_AUTH_TOKEN"
            value = data.coder_parameter.sentry_auth_token.value
          }
          env {
            name  = "PORT"
            value = "4096"
          }

          resources {
            requests = {
              "cpu"    = "500m"
              "memory" = "1Gi"
            }
            limits = {
              "cpu"    = "4"
              "memory" = "4Gi"
            }
          }

          volume_mount {
            name       = "dev"
            mount_path = "/home/developer/dev"
            read_only  = false
          }
        }

        volume {
          name = "dev"
          persistent_volume_claim {
            claim_name = kubernetes_persistent_volume_claim_v1.dev.metadata.0.name
            read_only  = false
          }
        }

        # Spread workspace pods across nodes.
        affinity {
          pod_anti_affinity {
            preferred_during_scheduling_ignored_during_execution {
              weight = 1
              pod_affinity_term {
                topology_key = "kubernetes.io/hostname"
                label_selector {
                  match_expressions {
                    key      = "app.kubernetes.io/name"
                    operator = "In"
                    values   = ["opencode-workspace"]
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
