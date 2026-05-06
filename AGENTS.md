<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Gotcha

<!-- lore:019dfed8-3063-715f-886b-2721a0e319b9 -->
* **Coder agent must be foreground process — backgrounding it hides failures**: Passing \`coder\_agent.main.init\_script\` as an env var and running it via \`sh -c "$CODER\_AGENT\_INIT\_SCRIPT"\` breaks silently — shell quoting mangles newlines, embedded quotes, and variable references in the multi-line script. Fix: interpolate the script directly into \`args\` at Terraform plan time using a heredoc, so the content is a literal string in the pod spec with no runtime shell expansion. Drop the \`CODER\_AGENT\_INIT\_SCRIPT\` env var entirely. See \[\[019dfed8-3068-77f5-ba73-4c0ad108baea]] for the coder\_script pattern.

### Pattern

<!-- lore:019dfed8-3068-77f5-ba73-4c0ad108baea -->
* **Use coder\_script for OpenCode server, not container CMD/ENTRYPOINT**: In Kubernetes pod \`args\`, interpolate \`coder\_agent.main.init\_script\` directly at Terraform plan time using \`join("\n", \["cat > /tmp/coder-init.sh << 'CODER\_INIT\_EOF'", coder\_agent.main.init\_script, "CODER\_INIT\_EOF", "chmod +x /tmp/coder-init.sh", "exec /tmp/coder-init.sh"])\`. This mirrors Sentry's GCE \`startup-script\` pattern — the script is a literal string in the pod spec, never subject to runtime shell expansion. Start OpenCode separately via \`coder\_script\` with \`run\_on\_start = true\`. See \[\[019dfed8-3063-715f-886b-2721a0e319b9]] for the env-var anti-pattern this replaces.
<!-- End lore-managed section -->
