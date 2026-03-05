#!/usr/bin/env bun
/**
 * LO Status — Cross-project backlog scanner
 *
 * Scans all LO projects and prints open work (features + tasks).
 *
 * Usage:
 *   bun run lo-status.ts
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { DIM, RESET, BOLD, EXPORTER_DIR } from "./cli-output";

// ─── .env Parsing (just LO_PROJECT_ROOT, no Supabase) ──────────────────────

function loadProjectRoot(): string {
  const envFile = join(EXPORTER_DIR, ".env");
  if (!existsSync(envFile)) {
    console.error(`  ${BOLD}\x1b[31mERROR${RESET} — .env not found at ${envFile}`);
    process.exit(1);
  }

  const content = readFileSync(envFile, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    const v = trimmed.slice(eqIdx + 1).trim();
    if (k === "LO_PROJECT_ROOT") return v;
  }

  console.error(`  ${BOLD}\x1b[31mERROR${RESET} — LO_PROJECT_ROOT not set in .env`);
  process.exit(1);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface Feature {
  id: string;
  name: string;
  status: string; // "in work" for work dirs, or status text from backlog
}

interface Task {
  id: string;
  text: string;
}

interface Project {
  dir: string;
  title: string;
  status: string;
  state: string;
  features: Feature[];
  tasks: Task[];
}

// ─── Parsing ────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
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

function parseProjectMd(path: string): { title: string; status: string; state: string } | null {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf-8");
  const meta = parseFrontmatter(content);
  if (!meta.title) return null;
  return {
    title: meta.title,
    status: meta.status || "unknown",
    state: meta.state || "private",
  };
}

function parseBacklogFeatures(content: string): Feature[] {
  const features: Feature[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match ### fNNN — Name
    const match = line.match(/^###\s+(f\d+)\s+[—–-]\s+(.+)/);
    if (!match) continue;

    const id = match[1];
    const name = match[2].trim();

    // Look for Status: line in the next few lines
    let status = "backlog";
    for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
      const statusMatch = lines[j].match(/^Status:\s*(.+)/i);
      if (statusMatch) {
        status = statusMatch[1].trim().toLowerCase();
        break;
      }
      // Stop at next heading
      if (lines[j].startsWith("#")) break;
    }

    // Skip done features (matches "done", "done -> 2026-02-25", etc.)
    if (status.startsWith("done")) continue;

    features.push({ id, name, status });
  }

  return features;
}

function parseBacklogTasks(content: string): Task[] {
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

function getWorkFeatures(loDir: string): Feature[] {
  const workDir = join(loDir, "work");
  if (!existsSync(workDir)) return [];

  const features: Feature[] = [];
  for (const entry of readdirSync(workDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === ".gitkeep") continue;

    // Work dir names: fNNN-slug
    const match = entry.name.match(/^(f\d+)/);
    if (!match) continue;

    // Read plan.md for feature name if available
    const planPath = join(workDir, entry.name, "plan.md");
    let name = entry.name
      .replace(/^f\d+-/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (existsSync(planPath)) {
      const planContent = readFileSync(planPath, "utf-8");
      // Try to get title from first # heading
      const headingMatch = planContent.match(/^#\s+(.+)/m);
      if (headingMatch) {
        name = headingMatch[1]
          .replace(/\s*[—–-]\s*implementation plan$/i, "")
          .replace(/\s*implementation plan$/i, "")
          .replace(/\s*plan$/i, "")
          .replace(/\s*[—–-]\s*$/, "")
          .trim();
      }
    }

    features.push({ id: match[1], name, status: "in work" });
  }

  return features;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const root = loadProjectRoot();

  // Discover projects by globbing for .lo/PROJECT.md
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    console.error(`  ${BOLD}\x1b[31mERROR${RESET} — Cannot read ${root}`);
    process.exit(1);
  }

  const projects: Project[] = [];

  for (const name of entries) {
    const loDir = join(root, name, ".lo");
    const projectMdPath = join(loDir, "PROJECT.md");
    const info = parseProjectMd(projectMdPath);
    if (!info) continue;

    // Collect features from work dirs (in-progress)
    const workFeatures = getWorkFeatures(loDir);
    const workFeatureIds = new Set(workFeatures.map((f) => f.id));

    // Collect features + tasks from BACKLOG.md
    const backlogPath = join(loDir, "BACKLOG.md");
    let backlogFeatures: Feature[] = [];
    let tasks: Task[] = [];
    if (existsSync(backlogPath)) {
      const content = readFileSync(backlogPath, "utf-8");
      backlogFeatures = parseBacklogFeatures(content).filter(
        (f) => !workFeatureIds.has(f.id)
      );
      tasks = parseBacklogTasks(content);
    }

    const features = [...workFeatures, ...backlogFeatures];

    if (features.length === 0 && tasks.length === 0) continue;

    projects.push({
      dir: name,
      title: info.title,
      status: info.status,
      state: info.state,
      features,
      tasks,
    });
  }

  // ─── Output ─────────────────────────────────────────────────────────────

  console.log();
  console.log(`  ${DIM}── LO Status ──────────────────────────${RESET}`);
  console.log();

  if (projects.length === 0) {
    console.log(`  ${DIM}No open work across projects.${RESET}`);
    console.log();
    return;
  }

  let totalFeatures = 0;
  let totalTasks = 0;

  for (const proj of projects) {
    // Project title + metadata
    console.log(`  ${BOLD}${proj.title}${RESET} ${DIM}(${proj.status}, ${proj.state})${RESET}`);

    // Features
    for (const f of proj.features) {
      totalFeatures++;
      const statusText = `${DIM}${f.status}${RESET}`;
      console.log(`    ${f.id}  ${f.name.padEnd(36)}${statusText}`);
    }

    // Tasks
    for (const t of proj.tasks) {
      totalTasks++;
      console.log(`    ${DIM}[ ]${RESET}   ${t.id}  ${t.text}`);
    }

    console.log();
  }

  // Footer
  const parts = [
    `${projects.length} project${projects.length !== 1 ? "s" : ""}`,
    totalFeatures > 0
      ? `${totalFeatures} feature${totalFeatures !== 1 ? "s" : ""}`
      : null,
    `${totalTasks} task${totalTasks !== 1 ? "s" : ""}`,
  ].filter(Boolean);

  console.log(`  ${DIM}${parts.join(" · ")}${RESET}`);
  console.log();
}

main();
