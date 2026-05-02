import { html } from "hono/html"
import { Layout } from "./layout"
import { statusIcon, statusClass, timeAgo } from "./helpers"

type OverviewProps = {
  stats: {
    total_deliveries: number
    total_dispatches: number
    active_entities: number
    status_counts: Record<string, number>
    today_count: number
  }
  recent: Array<{
    entity_key: string | null
    event: string
    action: string | null
    status: string
    outcome: string | null
    started_at: number
    trigger_name: string
  }>
}

export function OverviewPage({ stats, recent }: OverviewProps) {
  const succeeded = stats.status_counts.succeeded ?? 0
  const failed = stats.status_counts.failed ?? 0
  const timedOut = stats.status_counts.timeout ?? 0
  const total = succeeded + failed + timedOut
  const successRate = total > 0 ? Math.round((succeeded / total) * 100) : 0
  const failedCount = failed + timedOut

  const content = html`
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Active Entities</div>
        <div class="stat-value blue">${stats.active_entities}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Events Today</div>
        <div class="stat-value">${stats.today_count}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Success Rate</div>
        <div class="stat-value ${successRate >= 90 ? "green" : successRate >= 50 ? "" : "red"}">
          ${successRate}%
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Failed / Timeout</div>
        <div class="stat-value ${failedCount > 0 ? "red" : "green"}">
          ${failedCount}
        </div>
      </div>
    </div>

    <h2 style="font-size:16px; font-weight:600; color:#e6edf3; margin-bottom:16px;">
      Recent Activity
    </h2>

    ${recent.length === 0
      ? html`
        <div class="empty-state">
          <p>No activity yet</p>
          <span class="text-small text-muted">Events will appear here once webhooks are received</span>
        </div>
      `
      : html`
        <ul class="feed">
          ${recent.map((r) => {
            const eventLabel = r.action ? `${r.event}.${r.action}` : r.event
            const entityDisplay = r.entity_key ?? "\u2014"
            const entityHref = r.entity_key
              ? `/dashboard/entities/${encodeURIComponent(r.entity_key)}`
              : null
            return html`
              <li class="feed-item">
                <span class="feed-icon ${statusClass(r.status)}">
                  ${statusIcon(r.status)}
                </span>
                <span class="feed-entity">
                  ${entityHref
                    ? html`<a href="${entityHref}">${entityDisplay}</a>`
                    : entityDisplay
                  }
                </span>
                <span class="feed-event mono">${eventLabel}</span>
                <span class="feed-outcome">
                  ${r.outcome ?? ""}
                </span>
                <span class="feed-time">${timeAgo(r.started_at)}</span>
              </li>
            `
          })}
        </ul>
      `
    }
  `

  return Layout({ title: "Overview", content, autoRefresh: 10, activePage: "overview" })
}
