/**
 * Pure helper functions extracted from lo-status.ts for testability.
 * lo-status.ts has top-level side effects (calls main(), reads .env)
 * that prevent direct import in tests.
 */

/** Parse lines of key: value YAML pairs. Handles quoted values and inline comments. */
function parseYamlLines(lines: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of lines.split("\n")) {
    const kv = line.match(/^(\w[\w-]*)\s*:\s*(.+)/);
    if (!kv) continue;
    let v = kv[2].trim();
    v = v.replace(/^["']([^"']*)["']\s*#.*$/, "$1");
    v = v.replace(/\s+#.*$/, "");
    v = v.replace(/^["']|["']$/g, "");
    result[kv[1]] = v;
  }
  return result;
}

/** Extract key-value pairs from YAML frontmatter between --- fences. */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  return parseYamlLines(match[1]);
}

export interface Feature {
  id: string;
  name: string;
  status: string;
}

export interface Task {
  id: string;
  text: string;
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
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
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
