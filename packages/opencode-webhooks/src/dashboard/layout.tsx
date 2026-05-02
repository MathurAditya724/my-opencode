/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx"

type LayoutProps = {
  title: string
  children: Child
  autoRefresh?: number
  activePage?: "overview" | "entities" | "deliveries"
}

export function Layout({ title, children, autoRefresh, activePage }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {autoRefresh ? <meta http-equiv="refresh" content={String(autoRefresh)} /> : null}
        <title>{title} — opencode-webhooks</title>
        <style>{CSS}</style>
      </head>
      <body>
        <nav class="sidebar">
          <div class="sidebar-header">
            <span class="logo">⚡</span>
            <span class="logo-text">webhooks</span>
          </div>
          <ul class="nav-list">
            <li>
              <a href="/dashboard" class={activePage === "overview" ? "nav-link active" : "nav-link"}>
                Overview
              </a>
            </li>
            <li>
              <a href="/dashboard/entities" class={activePage === "entities" ? "nav-link active" : "nav-link"}>
                Entities
              </a>
            </li>
            <li>
              <a href="/dashboard/deliveries" class={activePage === "deliveries" ? "nav-link active" : "nav-link"}>
                Deliveries
              </a>
            </li>
          </ul>
          <div class="sidebar-footer">
            <a href="/healthz" class="nav-link subtle">healthz</a>
            <a href="/deliveries" class="nav-link subtle">API</a>
          </div>
        </nav>
        <main class="content">
          <header class="page-header">
            <h1>{title}</h1>
          </header>
          <div class="page-body">
            {children}
          </div>
        </main>
      </body>
    </html>
  )
}

const CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    background: #0d1117;
    color: #c9d1d9;
    display: flex;
    min-height: 100vh;
    line-height: 1.5;
  }

  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  /* Sidebar */
  .sidebar {
    width: 200px;
    background: #161b22;
    border-right: 1px solid #30363d;
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    padding: 16px 0;
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    overflow-y: auto;
  }

  .sidebar-header {
    padding: 0 16px 16px;
    border-bottom: 1px solid #30363d;
    margin-bottom: 8px;
  }

  .logo { font-size: 20px; }
  .logo-text {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 14px;
    font-weight: 600;
    color: #e6edf3;
    margin-left: 8px;
  }

  .nav-list { list-style: none; flex: 1; }

  .nav-link {
    display: block;
    padding: 8px 16px;
    color: #c9d1d9;
    font-size: 14px;
    border-left: 3px solid transparent;
  }
  .nav-link:hover { background: #1c2129; text-decoration: none; }
  .nav-link.active {
    color: #e6edf3;
    background: #1c2129;
    border-left-color: #58a6ff;
    font-weight: 600;
  }
  .nav-link.subtle { color: #8b949e; font-size: 12px; }

  .sidebar-footer {
    margin-top: auto;
    padding-top: 8px;
    border-top: 1px solid #30363d;
  }

  /* Main content */
  .content {
    flex: 1;
    margin-left: 200px;
    min-width: 0;
  }

  .page-header {
    padding: 24px 32px 16px;
    border-bottom: 1px solid #30363d;
  }
  .page-header h1 {
    font-size: 20px;
    font-weight: 600;
    color: #e6edf3;
  }

  .page-body { padding: 24px 32px; }

  /* Stat cards */
  .stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
    margin-bottom: 32px;
  }

  .stat-card {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 16px 20px;
  }
  .stat-label {
    font-size: 12px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }
  .stat-value {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 28px;
    font-weight: 700;
    color: #e6edf3;
  }
  .stat-value.green { color: #3fb950; }
  .stat-value.red { color: #f85149; }
  .stat-value.blue { color: #58a6ff; }

  /* Tables */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  thead th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 2px solid #30363d;
    color: #8b949e;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }
  tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
  }
  tbody tr:hover { background: #161b22; }

  .mono {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 13px;
  }

  .text-muted { color: #8b949e; }
  .text-small { font-size: 12px; }

  /* Status badges */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 12px;
    font-weight: 500;
    line-height: 1.5;
  }
  .status-succeeded { color: #3fb950; }
  .status-failed { color: #f85149; }
  .status-timeout { color: #d29922; }
  .status-running { color: #58a6ff; }
  .status-pending { color: #d29922; }
  .status-skipped { color: #8b949e; }

  .badge.status-succeeded { background: rgba(63,185,80,0.15); color: #3fb950; }
  .badge.status-failed { background: rgba(248,81,73,0.15); color: #f85149; }
  .badge.status-timeout { background: rgba(210,153,34,0.15); color: #d29922; }
  .badge.status-running { background: rgba(88,166,255,0.15); color: #58a6ff; }
  .badge.status-pending { background: rgba(210,153,34,0.15); color: #d29922; }
  .badge.status-skipped { background: rgba(139,148,158,0.15); color: #8b949e; }

  /* Activity feed */
  .feed { list-style: none; }
  .feed-item {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid #21262d;
    font-size: 14px;
  }
  .feed-item:last-child { border-bottom: none; }
  .feed-icon {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 14px;
    flex-shrink: 0;
    width: 16px;
    text-align: center;
  }
  .feed-entity {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 13px;
    min-width: 160px;
  }
  .feed-event { color: #8b949e; min-width: 160px; }
  .feed-time { color: #8b949e; font-size: 12px; margin-left: auto; white-space: nowrap; }
  .feed-outcome {
    color: #8b949e;
    font-size: 12px;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Timeline (entity detail) */
  .timeline { list-style: none; position: relative; }
  .timeline::before {
    content: "";
    position: absolute;
    left: 7px;
    top: 0;
    bottom: 0;
    width: 2px;
    background: #30363d;
  }
  .timeline-item {
    position: relative;
    padding: 16px 0 16px 32px;
    border-bottom: 1px solid #21262d;
  }
  .timeline-item:last-child { border-bottom: none; }
  .timeline-dot {
    position: absolute;
    left: 0;
    top: 20px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #30363d;
    border: 2px solid #0d1117;
    text-align: center;
    font-size: 10px;
    line-height: 12px;
  }
  .timeline-dot.status-succeeded { background: #238636; }
  .timeline-dot.status-failed { background: #da3633; }
  .timeline-dot.status-timeout { background: #9e6a03; }
  .timeline-dot.status-running { background: #1f6feb; }
  .timeline-dot.status-pending { background: #9e6a03; }
  .timeline-dot.status-skipped { background: #484f58; }

  .timeline-header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 4px;
  }
  .timeline-event {
    font-weight: 600;
    color: #e6edf3;
  }
  .timeline-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    font-size: 12px;
    color: #8b949e;
    margin-top: 4px;
  }

  /* Entity detail header */
  .entity-header {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 20px 24px;
    margin-bottom: 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .entity-key {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 18px;
    font-weight: 700;
    color: #e6edf3;
  }
  .entity-kind {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 12px;
    background: rgba(88,166,255,0.15);
    color: #58a6ff;
  }

  .btn {
    display: inline-block;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
  }
  .btn:hover { background: #30363d; text-decoration: none; }
  .btn-primary { background: #238636; color: #fff; border-color: #2ea043; }
  .btn-primary:hover { background: #2ea043; }

  /* Filter bar */
  .filter-bar {
    display: flex;
    gap: 12px;
    margin-bottom: 20px;
    flex-wrap: wrap;
    align-items: center;
  }
  .filter-bar label {
    font-size: 12px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .filter-bar select, .filter-bar input {
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
  }

  /* Pagination */
  .pagination {
    margin-top: 20px;
    display: flex;
    gap: 12px;
    align-items: center;
  }

  /* Status counts inline */
  .status-counts {
    display: flex;
    gap: 6px;
  }
  .status-count {
    font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, Consolas, monospace;
    font-size: 12px;
    padding: 1px 6px;
    border-radius: 8px;
  }

  .empty-state {
    text-align: center;
    padding: 48px 24px;
    color: #8b949e;
  }
  .empty-state p { font-size: 16px; margin-bottom: 8px; }
`
