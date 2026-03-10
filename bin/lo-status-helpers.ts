/**
 * Pure helper functions extracted from lo-status.ts for testability.
 * lo-status.ts has top-level side effects (calls main(), reads .env)
 * that prevent direct import in tests.
 */

export interface Feature {
  id: string;
  name: string;
  status: string;
}

export interface Task {
  id: string;
  text: string;
}

/** Parse YAML frontmatter from a markdown string. Handles quoted values and inline YAML comments. */
export function parseFrontmatter(content: string): Record<string, string> {
  const meta: Record<string, string> = {};
  if (!content.startsWith("---")) return meta;
  const end = content.indexOf("---", 3);
  if (end === -1) return meta;
  const block = content.slice(3, end);
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;
    const k = trimmed.slice(0, colonIdx).trim();
    let v = trimmed.slice(colonIdx + 1).trim();
    // Strip inline YAML comments (e.g. "explore"  # comment)
    v = v.replace(/^["']([^"']*)["']\s*#.*$/, "$1");
    v = v.replace(/^["']|["']$/g, "");
    meta[k] = v;
  }
  return meta;
}

/** Parse ### fNNN headings with Status: lines from backlog content. Skips done features. */
export function parseBacklogFeatures(content: string): Feature[] {
  const features: Feature[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^###\s+(f\d+)\s+[—–-]\s+(.+)/);
    if (!match) continue;

    const id = match[1];
    const name = match[2].trim();

    let status = "backlog";
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const statusMatch = lines[j].match(/^Status:\s*(.+)/i);
      if (statusMatch) {
        status = statusMatch[1].trim().toLowerCase();
        break;
      }
      if (lines[j].startsWith("#")) break;
    }

    if (status.startsWith("done")) continue;

    features.push({ id, name, status });
  }

  return features;
}

/** Parse unchecked task items (- [ ] tNNN text) from backlog content. */
export function parseBacklogTasks(content: string): Task[] {
  const tasks: Task[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const match = line.match(/^-\s+\[\s\]\s+(t\d+)\s+(.+)/);
    if (match) {
      tasks.push({ id: match[1], text: match[2].trim() });
    }
  }

  return tasks;
}
