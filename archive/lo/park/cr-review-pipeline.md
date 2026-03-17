# CR Review Pipeline — New Project

parked: 2026-03-12

## The Vision

End-to-end PR review pipeline where CodeRabbit CLI and Claude Code have an adversarial conversation — CR reviews, Claude fixes, CR re-reviews — running locally on Mac with Claude Max (not API credits). The user can watch the whole thing in Warp, jump in when Claude gets stuck, and approve the merge when it's clean.

## Architecture (settled)

Four pieces, each doing one thing:

1. **GitHub Action** — triggers on PR events (trigger mechanism TBD: opt-in label `cr-review`, auto with filter, or manual dispatch). POSTs to Railway.
2. **Railway relay** — thin Hono server. Receives webhook, writes job to Supabase, pushes to Mac via persistent websocket. That's it — no CR CLI, no Claude, no git. Just a mailbox.
3. **Supabase** — job queue + event log. Every stage transition logged with timestamp and metadata. Tables: jobs (one per PR review) and events (one per stage transition).
4. **Mac launchd agent** — holds websocket open to Railway. When a job arrives, opens a Warp tab and runs Claude Code with the CR plugin (`/coderabbit:review`). Similar pattern to telemetry-exporter's launchd integration.

## Why Local Mac, Not Railway

This was a key decision point. We explored three approaches:
- **Approach 1 (chosen): Thin relay** — Railway is just a webhook receiver + websocket forwarder. All work runs local.
- **Approach 2: Railway does more** — Railway runs CR CLI and Claude. Rejected because CR CLI must run in a git repo, takes 7-30 min per review, and has no REST API. Plus you lose the ability to watch/intervene.
- **Approach 3: Fully local** — No Railway, just poll GitHub. Simpler but adds latency and no webhook-driven trigger.

The killer argument for local: **Warp IS the dashboard.** You can watch Claude Code working in real time, hit Ctrl+C to take over, or walk away. On Railway you'd need to build a whole observation UI.

## Why Claude Max, Not Agent SDK

Cost. Claude Max is flat-rate (already paying for it). Agent SDK on Railway costs API credits per review, per round, per turn. For a personal workflow that doesn't need horizontal scale, Max is the obvious choice.

## The CR ↔ Claude Loop

CR CLI has a `--prompt-only` flag purpose-built for agent consumption. The designed workflow:

```
1. git fetch + checkout PR branch
2. cr --prompt-only --base main       → CR reviews (7-30 min per run)
3. Claude Code fixes issues
4. git commit + push
5. cr --prompt-only --base main       → CR re-reviews
6. If clean → pause for approval
7. If issues → back to step 3 (max N rounds)
8. If stuck → leave Warp tab open for user
```

There's already a CodeRabbit plugin for Claude Code (`/coderabbit:review`) that handles steps 2-5. The custom work is really just the trigger + orchestration glue.

## Semi-Auto Approval (start with B)

Three options were discussed:
- A) Full auto — approve + merge without asking
- B) Semi-auto (chosen for v1) — loop runs autonomously, pauses for human approval before merge
- C) Notification-gated — auto-merge after N minutes unless vetoed

Start with B to build trust. Flip to A later.

## Event Logging & UI

Every stage transition gets logged to Supabase for UI observability:

| Stage | Logged By | UI Signal |
|---|---|---|
| `queued` | Railway | Job received |
| `dispatched` | Railway | Sent to Mac |
| `received` | Mac agent | Mac picked it up |
| `checkout` | Mac agent | Git fetch/checkout |
| `reviewing` | Mac agent | CR CLI running (long wait) |
| `findings` | Mac agent | CR done — severity summary |
| `fixing` | Mac agent | Claude working |
| `pushed` | Mac agent | Fixes pushed |
| `re-reviewing` | Mac agent | CR running again (round N) |
| `clean` | Mac agent | No issues found |
| `awaiting_approval` | Mac agent | Waiting for human |
| `approved` | Mac agent | Human approved |
| `merged` | Mac agent | Done |
| `needs_input` | Mac agent | Claude stuck, needs human |
| `failed` | Mac agent | Error |

Two attention states that demand action: `awaiting_approval` and `needs_input`.

UI starts as a new tab in the telemetry dashboard (localhost:7777) for local testing. Eventually moves to its own project UI or the platform site.

## Open Questions (needs more thinking)

- **Trigger mechanism**: opt-in label, auto with filter, or manual dispatch? Recommendation was start opt-in, flip to auto later.
- **UI interaction model**: How does the user interject or respond when Claude needs input? The Warp tab is there, but what does the handoff look like? Does Claude pause and wait? Does it send a notification? How does the user signal "I'm done, continue"?
- **Project name**: TBD. Working title "CR Review Pipeline."
- **Repo structure**: New standalone repo under LO. Needs `/lo:setup`.
- **CR CLI rate limits**: 8/hour on Pro, unlimited with usage-based add-on ($0.25/file). Need to decide which plan.
- **Which PRs to review**: repo allowlist? All LO projects? Only specific repos?

## Tech Stack

- Railway service: Bun + Hono (same as cr-agent)
- Supabase: shared LO instance
- Mac agent: Bun + launchd (same pattern as telemetry-exporter)
- GitHub Action: in `ci/` repo as reusable workflow
- CR CLI: `cr --prompt-only` with agentic API key
- Claude Code: `claude -p` or interactive with CR plugin

## Next Steps

1. `/lo:setup` in a new repo
2. Design the UI interaction model (the main open question)
3. `/lo:plan` the implementation
