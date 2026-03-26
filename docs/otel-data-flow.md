# OTel Telemetry Data Flow

Reference diagram for the telemetry exporter pipeline. Read this when modifying any stage of the data flow to understand upstream/downstream dependencies.

## End-to-End Pipeline

```mermaid
flowchart TD
    subgraph Claude["Claude Code Process"]
        CC[Claude Code Agent]
        CC -->|"CLAUDE_CODE_ENABLE_TELEMETRY=1"| SDK[OTel SDK]
        SDK -->|"POST /v1/logs (HTTP/JSON)"| OTLP
        CC -->|writes during streaming| JSONL["~/.claude/projects/<br/>*.jsonl files"]
        CC -->|appends events| EVLOG["~/.claude/events.log"]
    end

    subgraph Daemon["Telemetry Exporter Daemon (bin/daemon.ts)"]
        subgraph Ingestion["OTLP Receiver (src/otel/server.ts)"]
            OTLP["POST /v1/logs<br/>POST /v1/metrics<br/>POST /v1/traces"]
            OTLP -->|parse| Parser["parser.ts<br/>flattenAttributes()<br/>classifyEvent()"]
            Parser -->|"insertOtelEvent()"| OE
            OTLP -->|"rate limit<br/>200/min/session"| RL{Rate OK?}
            RL -->|yes| Parser
            RL -->|no| R429[HTTP 429]
        end

        subgraph Storage["SQLite (data/telemetry.db, WAL mode)"]
            OE[("otel_events<br/>id, event_type,<br/>session_id, payload,<br/>processed, received_at")]
            SESS[("sessions<br/>session_id → proj_id<br/>immutable (INSERT OR IGNORE)")]
            CT[("cost_tracking<br/>(proj_id, date, model)<br/>upsert accumulation")]
            OB[("outbox<br/>target, payload,<br/>status, retry_count")]
            AQ[("archive_queue<br/>fact_type, content_hash<br/>deduped")]
        end

        subgraph Registry["Session Registry (src/otel/session-registry.ts)"]
            SR["buildSessionRegistry()"]
            SR -->|"readdir ~/.claude/projects/"| FS["Filesystem:<br/>encoded-dir/uuid.jsonl"]
            SR -->|"resolveProjIdForDir()"| RES["ProjectResolver<br/>(lo.yml + name cache)"]
            SR -->|"upsertSession()"| SESS
            SR -->|"archiveSessionMapping()"| AQ
        end

        subgraph Pipeline["Pipeline Loop (5s cycle)"]
            direction TB
            OR["OtelReceiver.poll()"]
            OR -->|"getUnprocessedOtelEvents(500)"| OE
            OR -->|"lookupSession()"| SESS
            OR -->|"ApiRequestEvent[]<br/>ToolResultEvent[]"| PROC

            LR["LogReceiver.poll()"] -->|"events.log tail"| PROC
            TR["TokenReceiver.poll()"] -->|"JSONL fallback<br/>(only if no OTel in 5min)"| PROC
            MR["MetricsReceiver.poll()"] -->|"stats-cache.json<br/>model-stats"| PROC

            PROC["Processor"]
            PROC -->|"processOtelBatch()"| CT
            PROC -->|"processOtelBatch()"| OB
            PROC -->|"processEvents()"| OB
            PROC -->|"processTokens()<br/>(skips OTel-covered pairs)"| OB
            PROC -->|"processMetrics()"| OB
            PROC -->|"budget check<br/>$5/$10/$25"| OB

            SHIP["Shipper.ship()"]
            OB -->|"dequeueUnshipped()<br/>priority order"| SHIP
        end

        subgraph Watcher["Process Watcher (250ms)"]
            PW["ProcessWatcher.tick()"]
            PW -->|"ps + lsof"| AS["pushAgentState()"]
        end

        subgraph CostAPI["Cost API (same HTTP server)"]
            GA["GET /cost/today"]
            GB["GET /cost/:projId"]
            GC["GET /budget/:projId"]
            GA & GB & GC -->|read| CT
        end

    end

    subgraph Supabase["Supabase (warm/cold tier)"]
        SHIP -->|"alerts (priority 0)"| ALT[("alerts")]
        SHIP -->|"projects (priority 1)"| PRJ[("projects")]
        SHIP -->|"events (priority 2)"| EVT[("events")]
        SHIP -->|"daily_metrics (priority 3)"| DM[("daily_metrics<br/>.tokens = new JSONB format")]
        SHIP -->|"project_telemetry (priority 4)"| PT[("project_telemetry")]
        SHIP -->|"facility_metrics (priority 5)"| FS2[("facility_status")]
        AS -->|"direct push<br/>(bypasses outbox)"| FS2
        AQ -->|"shipArchive()"| OA[("outbox_archive")]
    end

    subgraph Platform["Platform (Next.js)"]
        DM -->|"sumTokensJsonb()<br/>handles both formats"| HIST["Histogram"]
        PT -->|"parseModels()"| DASH["Dashboard"]
    end
```

## Data Format at Each Stage

```mermaid
flowchart LR
    subgraph OTel["OTel logRecord"]
        A["eventName: claude_code.api_request<br/>attributes: [{key: model, value: {stringValue: opus}},<br/>{key: input_tokens, value: {intValue: '1000'}},<br/>{key: cost_usd, value: {doubleValue: 0.05}}]"]
    end

    subgraph SQLite1["otel_events.payload"]
        B["JSON.stringify(logRecord)<br/>event_type: 'api_request'<br/>session_id: 'uuid-from-attrs'"]
    end

    subgraph Receiver["OtelReceiver output"]
        C["ApiRequestEvent {<br/>  projId, sessionId, model,<br/>  inputTokens, outputTokens,<br/>  cacheReadTokens, cacheWriteTokens,<br/>  costUsd, durationMs, timestamp<br/>}"]
    end

    subgraph CostTrk["cost_tracking row"]
        D["(proj_id, date, model) PK<br/>input_tokens += N<br/>output_tokens += N<br/>cost_usd += N<br/>request_count += 1"]
    end

    subgraph DailyM["daily_metrics.tokens (new JSONB)"]
        E["{<br/>  'claude-opus-4-6': {<br/>    input: 1000,<br/>    cache_read: 5000,<br/>    cache_write: 200,<br/>    output: 500<br/>  }<br/>}"]
    end

    subgraph DailyOld["daily_metrics.tokens (old JSONB)"]
        F["{<br/>  'claude-opus-4-6': 6700<br/>}"]
    end

    OTel --> SQLite1 --> Receiver --> CostTrk --> DailyM
    DailyOld -.->|"coexists in DB<br/>platform handles both"| DailyM
```

## Key Field Mappings

```mermaid
flowchart LR
    subgraph OTelAttrs["OTel Attribute Names"]
        A1["cache_creation_tokens"]
        A2["session.id"]
        A3["cost_usd"]
        A4["input_tokens"]
    end

    subgraph Receiver["OtelReceiver Fields"]
        B1["cacheWriteTokens"]
        B2["sessionId"]
        B3["costUsd"]
        B4["inputTokens"]
    end

    subgraph CostDB["cost_tracking Columns"]
        C1["cache_write_tokens"]
        C2["—"]
        C3["cost_usd"]
        C4["input_tokens"]
    end

    subgraph DailyJSON["daily_metrics JSONB"]
        D1["cache_write"]
        D2["—"]
        D3["—"]
        D4["input"]
    end

    A1 --> B1 --> C1 --> D1
    A2 --> B2
    A3 --> B3 --> C3
    A4 --> B4 --> C4 --> D4
```

## Facility Status (UI Signal Only)

The daemon is always on. `facility_status.status` in Supabase is a UI signal for Next.js:
- `lo-open` sets it to `active` (green dot on platform)
- `lo-close` sets it to `dormant` (grey dot on platform)
- Auto-dormant after 2h with no active Claude agents

The daemon does not read or care about this field. It always processes and ships.
