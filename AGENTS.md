<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Gotcha

<!-- lore:019dfed8-3063-715f-886b-2721a0e319b9 -->
* **Coder agent must be foreground process — backgrounding it hides failures**: If the Coder agent init script is backgrounded (\`&\`) while another process (e.g. OpenCode) runs in the foreground, agent startup failures are silent — the workspace appears healthy but the agent never connects. The correct pattern (per Sentry's devbox template) is to run the agent init script as the primary foreground process, and start OpenCode via a \`coder\_script\` resource with \`run\_on\_start = true\`. This gives lifecycle visibility in the Coder UI and ensures agent failures surface immediately.

### Pattern

<!-- lore:019dfed8-3068-77f5-ba73-4c0ad108baea -->
* **Use coder\_script for OpenCode server, not container CMD/ENTRYPOINT**: Start OpenCode as a \`coder\_script\` resource (with \`run\_on\_start = true\`) rather than baking it into the container's CMD or ENTRYPOINT. This lets the Coder agent manage and surface its lifecycle, exposes logs in the Coder UI, and keeps the agent init script as the foreground process. Example: \`script = "ANTHROPIC\_API\_KEY=\\"$KEY\\" opencode serve --hostname 127.0.0.1 --port 4096 > /tmp/opencode.log 2>&1 &"\`.
<!-- End lore-managed section -->
