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

variable "docker_image" {
  description = "Docker image to use for the workspace"
  type        = string
  default     = "ghcr.io/mathuraditya724/my-opencode:latest"
}

data "coder_parameter" "gh_token" {
  name         = "gh_token"
  display_name = "GitHub Token"
  description  = "PAT with repo, read:org, workflow scopes. Used for gh CLI and bot identity."
  type         = "string"
  mutable      = true
  default      = ""
}

data "coder_parameter" "anthropic_api_key" {
  name         = "anthropic_api_key"
  display_name = "Anthropic API Key"
  description  = "API key for Claude. At least one LLM provider key is required."
  type         = "string"
  mutable      = true
  default      = ""
}

data "coder_parameter" "openai_api_key" {
  name         = "openai_api_key"
  display_name = "OpenAI API Key"
  description  = "API key for OpenAI models. Optional if another provider key is set."
  type         = "string"
  mutable      = true
  default      = ""
}

data "coder_parameter" "github_webhook_secret" {
  name         = "github_webhook_secret"
  display_name = "GitHub Webhook Secret"
  description  = "HMAC secret for verifying GitHub webhook deliveries. Required to receive webhooks."
  type         = "string"
  mutable      = true
  default      = ""
}

data "coder_parameter" "webhook_port" {
  name         = "webhook_port"
  display_name = "Webhook Port"
  description  = "Port for the opentower webhook listener."
  type         = "number"
  mutable      = true
  default      = "5050"
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
    GITHUB_WEBHOOK_SECRET = data.coder_parameter.github_webhook_secret.value
    WEBHOOK_PORT          = tostring(data.coder_parameter.webhook_port.value)
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
  icon         = "/icon/code.svg"
  subdomain    = true
  share        = "owner"

  healthcheck {
    url       = "http://localhost:4096"
    interval  = 10
    threshold = 6
  }
}

# OpenCode server — started by the Coder agent after it connects.
# Runs in the background so the script exits immediately; the agent
# keeps the process supervised and its logs visible in the Coder UI.
resource "coder_script" "opencode" {
  agent_id     = coder_agent.main.id
  display_name = "OpenCode Server"
  script       = "opencode serve --hostname 0.0.0.0 --port \"$PORT\" > /tmp/opencode.log 2>&1 &"
  run_on_start = true
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
          image             = var.docker_image
          image_pull_policy = "Always"

          # The image ENTRYPOINT is [tini -- docker-entrypoint.sh] which
          # sets up git/gh identity then execs "$@". We only set args
          # (Docker CMD) so the entrypoint is preserved — tini stays as
          # PID 1 and docker-entrypoint.sh runs before our command.
          #
          # The Coder agent init script runs as the foreground process so
          # any failure is immediately visible in pod logs. OpenCode is
          # started separately by the coder_script.opencode resource
          # after the agent connects.
          args = [
            "sh", "-c",
            "exec sh -c \"$CODER_AGENT_INIT_SCRIPT\"",
          ]

          env {
            name  = "CODER_AGENT_TOKEN"
            value = coder_agent.main.token
          }
          env {
            name  = "CODER_AGENT_INIT_SCRIPT"
            value = coder_agent.main.init_script
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
            name  = "GITHUB_WEBHOOK_SECRET"
            value = data.coder_parameter.github_webhook_secret.value
          }
          env {
            name  = "WEBHOOK_PORT"
            value = tostring(data.coder_parameter.webhook_port.value)
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
