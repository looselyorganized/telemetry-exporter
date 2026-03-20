# LORF North Star — Agent-Native Research Facility

Status: **vision / active exploration**. Not a spec. This document captures the high-level picture of what the Loosely Organized Research Facility is, what it does, and how its parts relate. Expect this to evolve as individual explorations refine each layer.

Written: 2026-03-20, from a brainstorming session between the operator and Claude Code.

---

## The One-Paragraph Vision

LORF is an agent-native research facility. It runs on dedicated hardware (Mac Mini/Studio), operates 24/7, and treats AI agents as tier-1 participants — not tools, not assistants, but first-class members of the organization that consume data, services, and infrastructure alongside humans. The facility has three core systems: a knowledge brain that captures and indexes everything, a message spine that connects all participants, and a resource ledger that tracks costs per project. LORF agents are spawned internally to work on projects. External humans and agents interact through a mediator that gates access based on trust credentials. The operator has full visibility and control, with a progressive autonomy model that starts manual and moves toward facility-directed operation as confidence and evals justify it. The platform (Next.js) is the window into the facility from anywhere in the world.

---

## The Body Metaphor

The facility is a body. The ordering of what gets built follows biological development — brain first, then nervous system, then limbs.

| Layer | Metaphor | What It Is |
|-------|----------|------------|
| Knowledge | Brain | Captures, indexes, and retrieves everything the facility has ever learned |
| Spine | Nervous system | Event/message rails that connect all participants and systems |
| Agent Identity | Appendages | Agents that take signal from the spine and do work |
| Resources | Metabolism | Tracks and allocates energy (tokens, compute, money) across the body |
| Observability | Senses | See what's happening, intervene when needed |
| Platform | Eyes/voice | The facility's interface to the outside world |

**Build order follows the metaphor**: knowledge capture is the first use case of the spine (you build them in tandem, but the brain is *why* the spine exists). Agent identity comes after because agents without knowledge are amnesiac. Resources, observability, and platform layer on top.

---

## Core Architecture

```
┌─────────────────────────────────────────────────────┐
│                    THE FACILITY                      │
│                                                      │
│   ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│   │ Knowledge  │  │  Projects  │  │  Resources   │  │
│   │  (Brain)   │  │   (Work)   │  │  (Ledger)    │  │
│   └──────┬─────┘  └──────┬─────┘  └──────┬───────┘  │
│          │               │               │           │
│   ═══════╪═══════════════╪═══════════════╪═════════  │
│          │          THE SPINE             │           │
│   ═══════╪═══════════════╪═══════════════╪═════════  │
│          │               │               │           │
│   ┌──────┴─────┐  ┌──────┴─────┐  ┌──────┴───────┐  │
│   │ LORF Agent │  │ LORF Agent │  │  Mediator    │  │
│   │(researcher)│  │ (builder)  │  │ (front desk) │  │
│   └────────────┘  └────────────┘  └──────┬───────┘  │
│                                          │           │
└──────────────────────────────────────────┼───────────┘
                                           │
                                 ┌─────────┴─────────┐
                                 │  EXTERNAL WORLD    │
                                 │                    │
                                 │  humans · agents   │
                                 └────────────────────┘
```

- **Knowledge, Projects, Resources** are the core domains that sit on top of the spine
- **LORF agents** are internal appendages — spawned by the facility, managed by the facility
- **The Mediator** is the boundary between inside and outside — the front desk with context and judgment
- **External participants** (humans and agents) interact through the mediator, never directly with internals

---

## Participants and Trust

In an agent-native organization, the participant model applies uniformly to humans and agents. The distinction isn't *what* you are — it's *what trust level you hold*.

### Humans

| Role | Access | Description |
|------|--------|-------------|
| Operator | Full control | Directs and sees everything. Spawns agents, manages projects, sets budgets, reviews work. |
| Visitor | Scoped interaction | Talks to the mediator. Can propose projects, view their own costs, discuss work with assigned agents. |
| Credentialed visitor | Extended access | Authorized visitor who can bring their own agents, maintain ongoing project relationships, and have deeper facility access. |

### Agents

| Role | Access | Description |
|------|--------|-------------|
| LORF (internal) | Full facility access | Spawned and managed by the facility. Assigned to projects, orchestrated by operator or facility. Access to knowledge brain, spine, all internal systems. |
| External | Scoped access | Interacts through the mediator. Can discuss the facility, projects, and propose work. |
| Credentialed external | Project-scoped work access | Authorized to work on specific projects. Can read scoped project state, receive tasks, report progress. Interacts through the mediator, never directly with internals. |

Trust is a spectrum, not categories. A visitor becomes credentialed through authorization. An external agent gains project access through the same mechanism. One trust framework, applied uniformly.

---

## Agent Model

Agents are **framework-agnostic**. The facility doesn't care how an agent thinks — it cares that the agent can speak the facility protocol. Claude Code, nanoclaw/openclaw, custom Python scripts, partner agents on external infra — all are valid runtimes.

The facility provides the rails:
- **Identity** — who are you
- **Communication** — how you talk (the spine)
- **Knowledge** — what you know and learn
- **Observability** — we can see what you're doing
- **Resources** — what you're allowed to spend

The agent provides its own runtime and capabilities.

### Agent Manifest (Conceptual)

```yaml
agent:
  name: lorf-researcher-alpha
  runtime: claude-code          # or nanoclaw, custom, external
  capabilities: [web-research, code-analysis, writing]
  skills: [autoresearch-karpathy, academic-search]
  mcps: [firecrawl, supabase]
  memory: shared + personal
  trust: internal               # or credentialed-external, external
  budget: 50k-tokens/day
```

The "equip flow" is editing this manifest — adding skills, MCPs, capabilities, memory access. Like equipping a character in a game. The facility reads the manifest and stands up the agent on whatever runtime it declares.

### Agent Lifecycle

Internal agents (LORF) follow a managed lifecycle:
- **Spawn** — facility (or operator) creates agent from manifest
- **Assign** — agent gets assigned to project(s) and receives objectives
- **Operate** — agent works, communicates through spine, contributes to knowledge
- **Report** — agent posts progress, surfaces blockers, responds to queries
- **Suspend/Resume** — facility can pause and resume agents
- **Terminate** — graceful shutdown, final knowledge contribution

---

## The Learning Model

The facility gets smarter over time — not through training ML models, but through **structured memory + retrieval + LLM reasoning**.

### How Organizations Learn

1. **Record what happened** — every decision, its context, who made it
2. **Tag outcomes** — did it work? What went wrong? What went well?
3. **Recall when relevant** — retrieve past decisions when facing similar situations
4. **Codify proven patterns** — reliable patterns graduate from judgment calls to deterministic rules

### How the Facility Learns

- **The LLM is already the reasoning engine.** No need to train a separate model.
- **The knowledge brain is the learning system.** Every interaction — operator decisions, agent work, external conversations — gets captured with context.
- **Retrieval is the bridge.** When the facility faces a decision, it retrieves relevant past decisions and their outcomes. The LLM reasons over that context.
- **Patterns graduate to rules.** "When a researcher loops on the same queries for 30 minutes, it's stuck" starts as an observation, becomes a tagged pattern, eventually becomes an automated intervention.

### Knowledge Tiers

| Tier | Recall Speed | Content | Example |
|------|-------------|---------|---------|
| Hot | Instant | Active project context, recent conversations, current agent state | "Jack asked about drones yesterday" |
| Warm | Fast search | Completed project history, past decisions with outcomes, relationship history | "Last time we spawned a researcher for stalled tasks it worked" |
| Cold | Deep retrieval | Archived projects, old conversations, historical patterns | "Two years ago we tried X approach and it failed because Y" |

Nothing is ever deleted. Tiering is about retrieval speed, not retention.

### Cross-Pollination

Knowledge isn't siloed by source. An external visitor's conversation about autonomous drones might contain insights relevant to an internal robotics project weeks later. The brain captures facility-wide intelligence, not per-participant files. Retrieval surfaces relevant context regardless of where it originated.

---

## Progressive Autonomy

The facility starts with high control and low agency. Autonomy increases as operational data and evals justify it.

| Level | Who Decides | How It Works |
|-------|------------|--------------|
| **Manual** | Operator | Operator spawns agents, assigns work, manages everything. Facility records all decisions and outcomes. |
| **Suggested** | Operator (informed) | Facility retrieves similar past situations, reasons about current state, pings operator with recommendation. Operator approves or rejects. |
| **Supervised** | Facility (reviewed) | Facility acts within defined constraints, notifies operator after. Operator reviews and can override. |
| **Autonomous** | Facility (bounded) | Facility manages agent pool and resources within policy boundaries. Escalates edge cases where retrieved context is ambiguous. |

**The eval for level promotion**: does the facility's suggestion match what the operator would have done? Score that over time. When confidence is high, move up a level. Each level is a natural extension, not a rewrite.

---

## What Exists Today

| Component | State | Role in Vision |
|-----------|-------|---------------|
| `telemetry-exporter` | Pipeline daemon shipping to Supabase. SQLite outbox, process watcher, 431 tests. | Early data pipe. Feeds into the knowledge brain and resource ledger. The outbox pattern is a prototype of spine-like durable messaging. |
| `platform` | Next.js site (App Router, MDX, Supabase). Early stage. | Becomes the facility's interface to the world — the eyes and voice. |
| `nexus` | Multi-agent coordination server (Hono, Drizzle, Redis). | Potential backbone for agent coordination. Worth evaluating against the spine requirements rather than rebuilding from scratch. |
| `work-item-protocol` | Extension of A2A for structured work exchange between agents. | Potentially relevant for how agents exchange tasks. Needs evaluation once the spine is better defined. |

---

## Explorations

Each layer of the facility is a separate exploration. Each gets its own brainstorm → spec → plan → build cycle. They share this vision doc as their north star.

| # | Exploration | Layer | Depends On | Key Questions |
|---|-------------|-------|------------|---------------|
| 1 | Knowledge capture system | Brain | — | What gets captured? Storage model? How does retrieval work? How do we index without over-engineering? |
| 2 | Event/message spine | Nervous system | — | Protocol design? What rides the spine? Does Nexus serve as foundation or do we start fresh? |
| 3 | Agent identity and lifecycle | Appendages | Spine | Manifest schema? Spawn/terminate flow? Framework-agnostic runtime contract? |
| 4 | Mediator and external protocol | Boundary | Spine, Agent identity | How do external participants authenticate? What does the front desk agent look like? Trust elevation flow? |
| 5 | Resource tracking and cost attribution | Metabolism | Spine, Knowledge | Per-project cost model? What services get tracked? Budget enforcement mechanism? |
| 6 | Platform as facility interface | Eyes/voice | All above | What does the operator see? What do visitors see? Real-time vs. async? |
| 7 | Orchestration and progressive autonomy | Higher function | All above | Decision retrieval? Eval framework? Level promotion criteria? |

Explorations 1 and 2 can develop in tandem (brain and spine co-develop). Everything else builds on top.

---

## Framework Philosophy

The long-term vision is a framework others can adopt to run their own agent-native facilities. But the best frameworks are extracted from working systems, not designed in the abstract. Rails came from Basecamp. Django came from a newsroom. React came from Facebook. They started as "build the thing I need," and the framework fell out of patterns that survived contact with reality.

**The rule: build a clean facility, not a framework. The framework is what you extract later when the patterns have proven themselves.**

This means making cheap architectural choices that don't close the door:

- **Config, not constants.** Facility identity, operator identity, service URLs — always config, never hardcoded. No `bigviking` baked into the architecture.
- **Document the spine protocol, don't just implement it.** If the message format is well-defined, someone else can build a compatible spine later.
- **Agent manifests are inherently portable.** They describe capabilities and constraints, not LORF internals. Already framework-shaped.
- **Knowledge schema is facility-agnostic.** "A participant had a conversation about X" — not operator-specific.
- **Clean boundary between facility core and facility policy.** "The facility can spawn agents" is core. "We use Claude Code as the default runtime" is policy. Keep those in different places.

The cost of these choices is near zero. You're not building extra abstraction — you're being disciplined about where assumptions live. When the time comes to extract the framework, you're peeling layers apart instead of rewriting.

---

## What NOT to Build (Yet)

- **Don't train ML models.** The LLM + knowledge retrieval is the learning system.
- **Don't build a scheduler.** Agent work is directed, not cron-scheduled (for now).
- **Don't build the framework.** Build for LORF. Extract the framework when patterns prove themselves.
- **Don't over-engineer the protocol.** Start with what LORF agents need. Generalize when external agents actually show up.
- **Don't replace existing projects.** The telemetry exporter, platform, and Nexus evolve — they don't get thrown away.

---

## Open Questions

- Where exactly does the spine live? Is it a service (like Nexus), a library, or a protocol that multiple services implement?
- How does knowledge capture work for conversations happening in Claude Code sessions (like the one that produced this document)?
- What's the minimum viable mediator? A single agent with a prompt, or something more structured?
- How do agent manifests get versioned and managed? Git? Database? Both?
- What does "equipping" an agent actually look like in practice with current Claude Code / agent SDK constraints?
- How does the facility handle agent runtime diversity (Claude Code vs. nanoclaw vs. custom) without becoming a universal adapter?
