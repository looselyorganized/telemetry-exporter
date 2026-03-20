# Facility Evolution — What's Next

Status: brainstorming. No commitments. Written 2026-03-20 after shipping the outbox pipeline (v0.2.0).

## Where We Are

The telemetry exporter is now a pipeline: Receivers → Processor → SQLite Outbox → Shipper → Supabase. Local durability is solved. The daemon is 269 lines. 431 tests. The architecture is clean and extensible.

`lo-open` starts the daemon, runs preflight checks, flips facility to active. `lo-close` stops everything, flips to dormant. The process watcher detects Claude instances and reports their state. The dashboard shows pipeline health.

**The facility is currently a passive observer.** It watches and records. It does not manage, orchestrate, or enforce anything.

## The Core Question

What should "opening the facility" mean beyond "start watching"?

## Threads to Pull

### 1. The Outbox as Local Event Bus

The SQLite outbox is infrastructure, not just a shipping mechanism. Any local tool can read from it (WAL mode, concurrent readers). Potential consumers beyond the Supabase shipper:
- Dashboard (already does this)
- Nexus (multi-agent coordinator) — could subscribe to local events
- Cost tracker — real-time token spend monitoring
- Notification system — anomaly detection, budget alerts
- Shift log generator — end-of-day summaries

The outbox is the one place where all facility activity is captured durably. Treating it as a general-purpose event bus changes what's possible locally.

### 2. Facility Lifecycle (Beyond Binary)

Current: active | dormant

Possible: opening → active → winding_down → dormant | maintenance

Each state transition could trigger hooks:
- **Opening**: preflight checks, spawn standing agents, load project context, start budget tracking
- **Active**: full monitoring, anomaly detection, cost tracking
- **Winding down**: drain agents gracefully, finalize PRs, generate shift summary
- **Dormant**: minimal monitoring, auto-close already does this after 2h idle
- **Maintenance**: agents paused, system updates, skill reloads

### 3. Intent Declaration

Right now the watcher sees activity but not intent. If `lo-open` accepted a focus declaration:

```bash
bun run open --focus nexus platform
```

The system could:
- Prioritize telemetry for declared projects
- Alert when agents drift to unplanned work
- Track focus vs. distraction metrics
- Scope end-of-day reports to intended work
- Allocate token budgets per focus area

### 4. Shift Log (Highest-Value Next Feature)

When the facility closes, auto-generate a research day summary from outbox data:

```
── Shift Summary (8h 23m) ──────────────────────
  Projects: nexus (4h active), platform (2h), telemetry-exporter (1h)
  Agents: 12 spawned, 3 concurrent peak
  Tokens: 2.4M (nexus: 1.8M, platform: 0.4M, telemetry-exporter: 0.2M)
  Events: 847 tool calls, 23 sessions, 4 commits pushed
  Cost estimate: ~$14.20

  Notable:
  - nexus had 3 agent failures (auth middleware test loop)
  - platform shipped 2 PRs
  - telemetry-exporter: outbox pipeline shipped
```

All data already exists in the outbox. This is a query + formatter, not new infrastructure.

### 5. Token Budgets and Cost Control

The facility could enforce spending limits:
- Daily/weekly budgets per project
- Alert when burn rate exceeds threshold
- Auto-pause non-critical projects when budget is tight
- The processor can gate outbox writes based on budget state

This turns the facility from "what happened" to "what's allowed to happen."

### 6. Agent Lifecycle Management

Instead of just watching processes, the facility could manage them:
- Define agent "roles" per project (reviewer, builder, monitor)
- Auto-spawn agents when the facility opens
- Auto-restart crashed agents
- Graceful drain on facility close
- Resource limits (max concurrent agents)

This is the biggest leap — from observer to orchestrator. Depends on how Claude Code's process model evolves.

### 7. Multi-Machine Readiness

The outbox pattern helps here: each machine has its own local outbox, all shipping to the same Supabase. The facility becomes a logical grouping of machines:
- Machine A (MacBook) and Machine B (cloud VM) both run daemons
- Both ship to the same Supabase project
- Facility state is the union of all machines
- `lo-open` could be machine-scoped or facility-wide

Don't build for this yet, but don't build walls against it either.

## What NOT to Build

- Don't build a scheduler. Claude Code instances are user-initiated (for now).
- Don't build a permission system. Single user, single facility.
- Don't abstract prematurely. The outbox serves Supabase. If we need a second consumer, add it then.
- Don't replace Nexus. The facility manages the local machine. Nexus coordinates agents across contexts.

## Suggested Next Step

The shift log. It's:
- High-value (daily visibility into research output)
- Low-risk (read-only queries against existing data)
- Architecturally informative (forces thinking about what "open" and "close" really mean)
- Foundation for intent tracking, budgets, and lifecycle hooks
