<!-- This section is maintained by the coding agent via lore (https://github.com/BYK/loreai) -->
## Long-term Knowledge

### Gotcha

<!-- lore:019dfed8-3063-715f-886b-2721a0e319b9 -->
* **Coder agent must be foreground process — backgrounding it hides failures**: \*\*Kubernetes args newlines become literal \n — heredoc breaks silently\*\*: Terraform \`join("\n", \[...])\` produces actual newlines, but Kubernetes serializes pod \`args\` as JSON, converting them to \`\n\` escape sequences. The shell receives one giant line, so heredoc syntax (\`<< 'EOF'\`) never works. Fix: pass \`coder\_agent.main.init\_script\` as env var \`CODER\_AGENT\_INIT\_SCRIPT\` and use \`printenv CODER\_AGENT\_INIT\_SCRIPT > /tmp/coder-init.sh && chmod +x /tmp/coder-init.sh && exec /tmp/coder-init.sh\`. Kubernetes preserves newlines in env var values correctly. See \[\[019dfed8-3068-77f5-ba73-4c0ad108baea]].

<!-- lore:019dff65-568a-7669-a6f5-861ad24c024d -->
* **docker-entrypoint.sh set -e crashes container on gh/git identity errors**: With \`set -e\`, any failure in the \`gh auth setup-git\` or \`gh api user\` block (e.g. git running in a non-repo cwd, network errors) exits the entrypoint before \`exec "$@"\`, causing a crash-loop. Symptoms: only \`fatal: not in a git directory\` on stderr, no init script output, no coder agent startup. Fix: wrap the entire identity-setup block with \`set +e\` / \`set -e\` so these failures are logged as warnings instead of killing the container. The critical sections (volume chown, git init, final exec) keep \`set -e\`.

### Pattern

<!-- lore:019dfed8-3068-77f5-ba73-4c0ad108baea -->
* **Use coder\_script for OpenCode server, not container CMD/ENTRYPOINT**: \*\*Use env var + printenv to deliver init\_script in Kubernetes args\*\*: Pass \`coder\_agent.main.init\_script\` as env var \`CODER\_AGENT\_INIT\_SCRIPT\`, then in container \`args\`: \`"printenv CODER\_AGENT\_INIT\_SCRIPT > /tmp/coder-init.sh && chmod +x /tmp/coder-init.sh && exec /tmp/coder-init.sh"\`. Kubernetes preserves newlines in env var values; \`printenv\` writes them correctly. Do NOT use heredoc in \`args\` — Kubernetes JSON-serializes the string, turning \`\n\` into literal backslash-n which breaks heredoc. Start OpenCode via \`coder\_script\` with \`run\_on\_start = true\`. The Coder provider bakes correct \`ACCESS\_URL\` into \`init\_script\` at apply time. See \[\[019dfed8-3063-715f-886b-2721a0e319b9]] for ongoing agent connection issue (agent reports empty URL despite correct script).
<!-- End lore-managed section -->
