import { html } from "hono/html"
import { Layout } from "./layout"
import {
  statusIcon,
  statusClass,
  formatDate,
  formatDuration,
} from "./helpers"

type EntityDetailProps = {
  entity_key: string
  session_id: string | null
  events: Array<{
    dispatch_id: number
    delivery_id: string
    event: string
    action: string | null
    received_at: number
    trigger_name: string
    status: string
    outcome: string | null
    started_at: number
    completed_at: number | null
    duration_ms: number | null
  }>
}

export function EntityDetailPage({ entity_key, session_id, events }: EntityDetailProps) {
  const isIssue = events.some(
    (ev) => ev.event === "issues" || ev.event.startsWith("email.assign"),
  )
  const kindLabel = isIssue ? "Issue" : "Pull Request"
  const opencodeUrl = session_id
    ? `http://localhost:4096/session/${session_id}`
    : null

  const content = html`
    <div class="entity-header">
      <span class="entity-key">${entity_key}</span>
      <span class="entity-kind">${kindLabel}</span>
      ${session_id
        ? html`<span class="mono text-small text-muted" style="margin-left:8px;">
            session: ${session_id.slice(0, 8)}…
          </span>`
        : ""}
      <span style="flex:1;"></span>
      ${opencodeUrl
        ? html`<a href="${opencodeUrl}" target="_blank" rel="noopener" class="btn btn-primary">
            Open in OpenCode
          </a>`
        : ""}
      <a href="/dashboard/entities" class="btn">Back</a>
    </div>

    <h2 style="font-size:16px; font-weight:600; color:#e6edf3; margin-bottom:16px;">
      Event Timeline (${events.length})
    </h2>

    ${events.length === 0
      ? html`
        <div class="empty-state">
          <p>No events recorded</p>
        </div>
      `
      : html`
        <ul class="timeline">
          ${events.map((ev) => {
            const eventLabel = ev.action ? `${ev.event}.${ev.action}` : ev.event
            return html`
              <li class="timeline-item">
                <div class="timeline-dot ${statusClass(ev.status)}"></div>
                <div class="timeline-header">
                  <span class="timeline-event">${eventLabel}</span>
                  <span class="badge ${statusClass(ev.status)}">
                    ${statusIcon(ev.status)} ${ev.status}
                  </span>
                </div>
                <div class="timeline-meta">
                  <span>${formatDate(ev.started_at)}</span>
                  <span>trigger: ${ev.trigger_name}</span>
                  <span>duration: ${formatDuration(ev.duration_ms)}</span>
                  <span class="mono" style="font-size:11px;">
                    ${ev.delivery_id.slice(0, 8)}
                  </span>
                </div>
                ${ev.outcome
                  ? html`<div style="margin-top:6px; font-size:13px; color:#8b949e;">
                      ${ev.outcome}
                    </div>`
                  : ""}
                ${(ev.status === "failed" || ev.status === "timeout")
                  ? html`<form
                      method="post"
                      action="/dashboard/dispatches/${ev.dispatch_id}/retry"
                      style="margin-top:8px; display:inline;"
                    >
                      <button type="submit" class="btn btn-retry">
                        Retry
                      </button>
                    </form>`
                  : ""}
              </li>
            `
          })}
        </ul>
      `
    }
  `

  return Layout({ title: entity_key, content, activePage: "entity-detail" })
}
