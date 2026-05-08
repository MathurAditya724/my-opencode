# self-update — Specification

## Intent

Keep the agent's dependencies current to benefit from bug fixes,
security patches, and new features without manual intervention.

## Scope

### In scope

- Checking for outdated dependencies
- Updating to latest compatible versions
- Running type checks, lint, build, and tests after updating
- Reverting updates that cause failures
- Opening a draft PR with the changes

### Out of scope

- Updating application code or configuration
- Major version bumps without changelog review
- Updating dependencies that are pinned for specific reasons

## Invocation

Triggered manually by a maintainer, or on a periodic schedule.
Not triggered by webhook events.

## Runtime contract

### Input

- A clean working tree on the default branch

### Output

- A draft PR with dependency updates, or a report of what couldn't be updated

### Side effects

- Updates package.json and lockfiles
- Creates a branch and opens a draft PR

## Evaluation criteria

- All verification steps pass after updates
- Updates that cause failures are reverted
- Pinned dependencies are not blindly updated
- The PR description lists what was updated

## Maintenance

- Package manager commands may need updating as tooling evolves
- The verification step list should match the project's actual CI checks
