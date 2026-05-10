# Changelog
## 0.2.0

### New Features ✨

- (opentower) Extract linked issues from email body for PR session reuse by @MathurAditya724 in [#66](https://github.com/MathurAditya724/outpost/pull/66)
- Add cron scheduling system to opentower by @MathurAditya724 in [#69](https://github.com/MathurAditya724/outpost/pull/69)
- Bundle dashboard into opentower for single-origin serving by @MathurAditya724 in [#68](https://github.com/MathurAditya724/outpost/pull/68)

### Internal Changes 🔧

- (dashboard) Replace custom toast with sonner by @MathurAditya724 in [#67](https://github.com/MathurAditya724/outpost/pull/67)
- Detect stale opencode-config-bun.lock by @MathurAditya724 in [#57](https://github.com/MathurAditya724/outpost/pull/57)

### Other

- Relax email self-loop guard to only block comment loops by @MathurAditya724 in [#65](https://github.com/MathurAditya724/outpost/pull/65)
- Improve skills architecture based on Sentry warden and junior-prod patterns by @MathurAditya724 in [#63](https://github.com/MathurAditya724/outpost/pull/63)
- Refine email self-loop guard to allow CI and security notifications by @MathurAditya724 in [#61](https://github.com/MathurAditya724/outpost/pull/61)
- Loosen entity resolver skip list so actionable emails get session affinity by @MathurAditya724 in [#60](https://github.com/MathurAditya724/outpost/pull/60)
- Fix CI: pin @loreai/opencode to 0.12.0 to avoid broken transitive deps by @MathurAditya724 in [#59](https://github.com/MathurAditya724/outpost/pull/59)
- Fix session URL routing to match OpenCode web UI structure by @MathurAditya724 in [#58](https://github.com/MathurAditya724/outpost/pull/58)
- Add auto-merge skill and fix CORS for dashboard SPA by @MathurAditya724 in [#55](https://github.com/MathurAditya724/outpost/pull/55)
- Store auto-share URLs for clickable OpenCode session links by @MathurAditya724 in [#54](https://github.com/MathurAditya724/outpost/pull/54)
- Migrate forms to zod + react-hook-form by @MathurAditya724 in [#52](https://github.com/MathurAditya724/outpost/pull/52)
- Fix sidebar dual-line artifact on rail hover by @MathurAditya724 in [#51](https://github.com/MathurAditya724/outpost/pull/51)
- Dashboard: sidebar rail toggle, session links relative to server, TanStack Query, pagination by @MathurAditya724 in [#50](https://github.com/MathurAditya724/outpost/pull/50)
- Dashboard: sidebar server management, emoji branding, and opencode session links by @MathurAditya724 in [#49](https://github.com/MathurAditya724/outpost/pull/49)
- Fix CORS: apply middleware globally so /healthz is reachable from dashboard SPA by @MathurAditya724 in [#48](https://github.com/MathurAditya724/outpost/pull/48)
- Rename my-opencode to outpost by @MathurAditya724 in [#47](https://github.com/MathurAditya724/outpost/pull/47)
- Add OpenTower dashboard SPA and JSON API endpoints by @MathurAditya724 in [#40](https://github.com/MathurAditya724/outpost/pull/40)
- Add explicit email triage rules for PR authorship checks by @MathurAditya724 in [#45](https://github.com/MathurAditya724/outpost/pull/45)
- updated the service icons by @MathurAditya724 in [0dba58ef](https://github.com/MathurAditya724/outpost/commit/0dba58efcd8f94ff8f3e87fe7c39128713d4d23f)
- Fix agent init: interpolate init_script at plan time via heredoc by @MathurAditya724 in [#44](https://github.com/MathurAditya724/outpost/pull/44)
- Remove ephemeral flag from Coder template secret parameters by @MathurAditya724 in [#43](https://github.com/MathurAditya724/outpost/pull/43)
- Fix K8s template: remove command override to preserve image ENTRYPOINT by @MathurAditya724 in [#42](https://github.com/MathurAditya724/outpost/pull/42)
- Add Coder workspace template (Kubernetes) by @MathurAditya724 in [#41](https://github.com/MathurAditya724/outpost/pull/41)
- Add Coder workspace template by @MathurAditya724 in [#31](https://github.com/MathurAditya724/outpost/pull/31)
- Remove ALLOWED_EMAILS env var — D1 allowlist is the single source of truth by @MathurAditya724 in [#39](https://github.com/MathurAditya724/outpost/pull/39)

