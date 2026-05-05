terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

provider "docker" {}
provider "coder" {}

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
  ephemeral    = true
}

data "coder_parameter" "anthropic_api_key" {
  name         = "anthropic_api_key"
  display_name = "Anthropic API Key"
  description  = "API key for Claude. At least one LLM provider key is required."
  type         = "string"
  mutable      = true
  ephemeral    = true
  default      = ""
}

data "coder_parameter" "openai_api_key" {
  name         = "openai_api_key"
  display_name = "OpenAI API Key"
  description  = "API key for OpenAI models. Optional if another provider key is set."
  type         = "string"
  mutable      = true
  ephemeral    = true
  default      = ""
}

data "coder_parameter" "github_webhook_secret" {
  name         = "github_webhook_secret"
  display_name = "GitHub Webhook Secret"
  description  = "HMAC secret for verifying GitHub webhook deliveries. Required to receive webhooks."
  type         = "string"
  mutable      = true
  ephemeral    = true
  default      = ""
}

data "coder_parameter" "webhook_port" {
  name         = "webhook_port"
  display_name = "Webhook Port"
  description  = "Port for the openhealer webhook listener."
  type         = "number"
  mutable      = true
  default      = "5050"
}

# --- Persistent volume for ~/dev ---

resource "docker_volume" "dev" {
  name = "opencode-${data.coder_workspace.me.id}-dev"
  lifecycle {
    ignore_changes = all
  }
}

# --- Agent ---

resource "coder_agent" "main" {
  arch           = data.coder_provisioner.me.arch
  os             = "linux"
  dir            = "/home/developer/dev"
  startup_script = <<-EOT
    echo "Workspace ready."
  EOT

  env = {
    GH_TOKEN               = data.coder_parameter.gh_token.value
    ANTHROPIC_API_KEY       = data.coder_parameter.anthropic_api_key.value
    OPENAI_API_KEY          = data.coder_parameter.openai_api_key.value
    GITHUB_WEBHOOK_SECRET   = data.coder_parameter.github_webhook_secret.value
    WEBHOOK_PORT            = tostring(data.coder_parameter.webhook_port.value)
    GIT_AUTHOR_NAME         = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_AUTHOR_EMAIL        = data.coder_workspace_owner.me.email
    GIT_COMMITTER_NAME      = coalesce(data.coder_workspace_owner.me.full_name, data.coder_workspace_owner.me.name)
    GIT_COMMITTER_EMAIL     = data.coder_workspace_owner.me.email
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

# OpenCode web UI
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

# --- Docker container ---

resource "docker_image" "opencode" {
  name = var.docker_image
}

resource "docker_container" "workspace" {
  count    = data.coder_workspace.me.start_count
  image    = docker_image.opencode.image_id
  name     = "opencode-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name
  dns      = ["1.1.1.1", "8.8.8.8"]

  entrypoint = [
    "/usr/bin/tini", "--",
    "/usr/local/bin/docker-entrypoint.sh",
    "sh", "-c",
    "${coder_agent.main.init_script} & exec opencode web --hostname 0.0.0.0 --port 4096",
  ]

  env = [
    "CODER_AGENT_TOKEN=${coder_agent.main.token}",
    "GH_TOKEN=${data.coder_parameter.gh_token.value}",
    "ANTHROPIC_API_KEY=${data.coder_parameter.anthropic_api_key.value}",
    "OPENAI_API_KEY=${data.coder_parameter.openai_api_key.value}",
    "GITHUB_WEBHOOK_SECRET=${data.coder_parameter.github_webhook_secret.value}",
    "WEBHOOK_PORT=${data.coder_parameter.webhook_port.value}",
    "PORT=4096",
  ]

  # Persistent dev volume — survives workspace stop/start.
  volumes {
    container_path = "/home/developer/dev"
    volume_name    = docker_volume.dev.name
    read_only      = false
  }

  # Docker socket — enables docker-compose inside the workspace.
  volumes {
    host_path      = "/var/run/docker.sock"
    container_path = "/var/run/docker.sock"
  }

  user   = "1000:1000"
  memory = 4096
}
