Right now the facility is a passive observer. It watches Claude instances, records what happened, and reports to Supabase. Opening it is "start watching."
  Closing it is "stop watching." The telemetry flows whether or not anyone's looking at it.

  The interesting question is: what if the facility was the control plane, not just the observation deck?

  Think about what lo-open could mean:

  Opening the facility starts the research day. Not just "start the daemon" — it declares intent. Which projects are active today? What's the token budget?
  Are there agents that should auto-spawn? When you close, it doesn't just flip a flag — it drains active agents gracefully, generates a shift summary,
  archives the day's work.

  A few threads I'd pull on:

  1. The outbox is an event bus, not just a sync pipe.
  We just built a durable local event store. Right now the only consumer is the Supabase shipper. But the SQLite outbox could be the backbone for any local
  tool — the dashboard reads from it, Nexus could subscribe to it, a cost tracker could query it, a notification system could watch for anomalies. The
  architecture already supports this (WAL mode, concurrent readers). We just need to think of the outbox as infrastructure, not just a shipping mechanism.

  2. Facility states should be a lifecycle, not a toggle.
  active/dormant is binary. Research doesn't work that way. Consider:
  - Opening — preflight, spawning agents, loading context
  - Active — full operation, budget tracking, anomaly detection
  - Winding down — drain agents, finalize work, generate summaries
  - Dormant — minimal monitoring, auto-close already does this after 2h idle
  - Maintenance — agents paused, updates applying

  Each transition could trigger hooks. The outbox pipeline makes this natural — state transitions are just events that flow through the system.

  3. The facility should know about intent, not just activity.
  Right now the watcher sees "there's a Claude process running on project X." It doesn't know why. If lo-open let you declare "today I'm working on nexus and
   platform," the system could:
  - Prioritize telemetry for those projects
  - Alert when agents drift to unplanned work
  - Track focus vs. distraction
  - Generate end-of-day reports scoped to what you intended

  4. Multi-machine is the corner to avoid building into.
  Right now everything assumes one MacBook. But "facility" implies something bigger. If you ever have a second machine running agents, or a cloud VM, the
  architecture should accommodate it. The outbox pattern actually helps here — each machine has its own local outbox, and they all ship to the same Supabase.
   The facility becomes a logical grouping of machines, not a single daemon.

  5. The shift log is the killer feature no one's built yet.
  When you run lo-close, imagine it generates:

  ── Shift Summary (8h 23m) ──────────────────────
    Projects: nexus (4h active), platform (2h), telemetry-exporter (1h)
    Agents: 12 spawned, 3 concurrent peak
    Tokens: 2.4M (nexus: 1.8M, platform: 0.4M, telemetry-exporter: 0.2M)
    Events: 847 tool calls, 23 sessions, 4 commits pushed
    Cost estimate: ~$14.20

    Notable:
    - nexus had 3 agent failures (auth middleware test loop)
    - platform shipped 2 PRs
    - telemetry-exporter: outbox pipeline architecture shipped

  All of this data already exists in the outbox. It's just a query away.

  Where I'd focus next: The shift log. It's high-value, uses data we already collect, requires no architectural changes, and it forces you to think about
  what "opening" and "closing" the facility actually means as a research workflow — which informs every other evolution.