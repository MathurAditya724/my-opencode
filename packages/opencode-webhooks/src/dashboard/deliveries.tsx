/** @jsxImportSource hono/jsx */
import { Layout } from "./layout"
import { statusClass, timeAgo } from "./helpers"

type DeliveriesProps = {
  deliveries: Array<{
    delivery_id: string
    event: string
    action: string | null
    received_at: number
    dispatch_count: number
    statuses: Record<string, number>
  }>
  next_cursor: string | null
  filters: {
    event?: string
    status?: string
  }
}

export function DeliveriesPage({ deliveries, next_cursor, filters }: DeliveriesProps) {
  return (
    <Layout title="Deliveries" activePage="deliveries">
      <form method="get" action="/dashboard/deliveries" class="filter-bar">
        <label>Event</label>
        <input
          type="text"
          name="event"
          value={filters.event ?? ""}
          placeholder="e.g. issues"
        />
        <label>Status</label>
        <select name="status">
          <option value="">All</option>
          {["pending", "running", "succeeded", "failed", "timeout", "skipped"].map((s) => (
            <option value={s} selected={filters.status === s}>
              {s}
            </option>
          ))}
        </select>
        <button type="submit" class="btn">Filter</button>
      </form>

      {deliveries.length === 0 ? (
        <div class="empty-state">
          <p>No deliveries found</p>
          <span class="text-small text-muted">
            {filters.event || filters.status
              ? "Try adjusting your filters"
              : "Deliveries will appear here once webhooks are received"}
          </span>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Delivery ID</th>
              <th>Dispatches</th>
              <th>Status</th>
              <th>Received</th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((d) => {
              const eventLabel = d.action ? `${d.event}.${d.action}` : d.event
              return (
                <tr>
                  <td class="mono">{eventLabel}</td>
                  <td>
                    <a href={`/deliveries/${d.delivery_id}`} class="mono text-small">
                      {d.delivery_id.slice(0, 8)}…
                    </a>
                  </td>
                  <td class="mono">{d.dispatch_count}</td>
                  <td>
                    <div class="status-counts">
                      {Object.entries(d.statuses).map(([status, count]) => (
                        <span class={`status-count badge ${statusClass(status)}`}>
                          {count} {status}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td class="text-muted text-small">{timeAgo(d.received_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {next_cursor ? (
        <div class="pagination">
          <a
            href={`/dashboard/deliveries?cursor=${encodeURIComponent(next_cursor)}${filters.event ? `&event=${encodeURIComponent(filters.event)}` : ""}${filters.status ? `&status=${encodeURIComponent(filters.status)}` : ""}`}
            class="btn"
          >
            Next page
          </a>
        </div>
      ) : null}
    </Layout>
  )
}
