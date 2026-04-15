# Runbook: `project_blocked`

Triggered when the exporter emits `{"evt":"project_blocked", ...}` in `~/.claude/lo-exporter.err`. A Supabase `projects` insert (or dependent-table FK) failed in a way that will not self-heal — most commonly a slug collision between a local `lo.yml` id and a different pre-existing row in Supabase with the same slug.

The daemon has paused shipping for this project (and only this project — others keep flowing). Rows continue to accumulate as `status='pending'` in the local outbox and resume once you reconcile.

## 1. Diagnose

All commands assume you are at `~/Documents/github/projects/lo/telemetry-exporter`.

```bash
# What's currently blocked?
sqlite3 data/telemetry.db \
  "SELECT proj_id, slug, reason, error_message, first_seen_at
     FROM projects_blocked WHERE resolved_at IS NULL;"
```

Then query Supabase (via the dashboard SQL editor) for the conflicting remote row:

```sql
SELECT id, slug, name, archived_at FROM projects WHERE slug = '<slug>';
```

Compare the local `proj_id` against the remote row's `id`. If they differ, you have a slug collision.

How many rows are stuck for this project?

```bash
sqlite3 data/telemetry.db "SELECT target, COUNT(*) FROM outbox
  WHERE status='pending' AND (
    json_extract(payload, '\$.project_id') = '<id>' OR
    (target='projects' AND json_extract(payload, '\$.id') = '<id>')
  ) GROUP BY target;"
```

## 2. Resolve — pick ONE path

### Option A — Force-local (the local project is the real one, remote is stale)

Example: `augment-1` exists locally as an active Auggy runtime; Supabase has a leftover row with the same slug from a prior experiment.

**Step 1 — Archive the stale remote row** (run in the Supabase SQL editor):

```sql
UPDATE projects SET archived_at = NOW() WHERE id = '<stale_remote_proj_id>';
```

**Step 2 — Mark the block resolved locally**:

```bash
sqlite3 data/telemetry.db \
  "UPDATE projects_blocked
     SET resolved_at = datetime('now')
     WHERE proj_id = '<local_proj_id>';"
```

**Step 3 — Restart the daemon** so `ProjectBlocker` reloads its in-memory Set from the table:

```bash
launchctl kickstart -k gui/$(id -u)/com.lo.telemetry-exporter
```

Verify within ~5 seconds (see §3).

### Option B — Adopt-remote (remote is canonical, local was misregistered)

**Step 1 — Rewrite local rows to the remote `proj_id`**:

```bash
sqlite3 data/telemetry.db <<'SQL'
UPDATE outbox SET payload = json_replace(payload, '$.project_id', '<remote_proj_id>')
  WHERE status='pending'
    AND json_extract(payload, '$.project_id') = '<local_proj_id>';
UPDATE outbox SET payload = json_replace(payload, '$.id', '<remote_proj_id>')
  WHERE status='pending' AND target='projects'
    AND json_extract(payload, '$.id') = '<local_proj_id>';
UPDATE projects_blocked SET resolved_at = datetime('now')
  WHERE proj_id = '<local_proj_id>';
SQL
```

**Step 2 — Edit the project's `lo.yml`** by hand: change the `id:` line from `<local_proj_id>` to `<remote_proj_id>`. The exporter does NOT touch `lo.yml` files in other repos.

**Step 3 — Restart the daemon**:

```bash
launchctl kickstart -k gui/$(id -u)/com.lo.telemetry-exporter
```

### Option C — Discard (queued rows aren't worth replaying)

```bash
sqlite3 data/telemetry.db <<'SQL'
UPDATE projects_blocked SET resolved_at = datetime('now') WHERE proj_id = '<id>';
DELETE FROM outbox
  WHERE status='pending' AND (
    json_extract(payload, '$.project_id') = '<id>' OR
    (target='projects' AND json_extract(payload, '$.id') = '<id>')
  );
SQL
launchctl kickstart -k gui/$(id -u)/com.lo.telemetry-exporter
```

## 3. Verify

```bash
# No open blocks:
sqlite3 data/telemetry.db \
  "SELECT COUNT(*) FROM projects_blocked WHERE resolved_at IS NULL;"
# → 0

# Pending rows draining:
sqlite3 data/telemetry.db "SELECT COUNT(*) FROM outbox WHERE status='pending';"
# Decreases over successive ship cycles (each cycle ships up to 500 rows).

# No new project_blocked events since restart:
tail -n 20 ~/.claude/lo-exporter.err | grep project_blocked
# (No new entries after the restart time.)
```

Platform homepage token counter updates on next ISR revalidate (~60 seconds).

## 4. If shipping resumes but then re-blocks immediately

Means the reconciliation was incomplete — usually `lo.yml` in the project directory still has the old `id` after Option B, or the archive in Option A targeted the wrong row. Re-run §1 Diagnose and pick the correct option.
