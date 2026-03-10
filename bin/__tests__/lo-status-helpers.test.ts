import { describe, test, expect } from "bun:test";
import { parseFrontmatter, parseBacklogFeatures, parseBacklogTasks } from "../lo-status-helpers";

// ─── parseFrontmatter ───────────────────────────────────────────────────────

describe("parseFrontmatter", () => {
  test("parses basic key-value pairs", () => {
    const content = `---
title: My Project
status: active
---
# Body`;

    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: "My Project", status: "active" });
  });

  test("strips quoted values", () => {
    const content = `---
title: "My Project"
status: 'active'
---`;

    const result = parseFrontmatter(content);
    expect(result.title).toBe("My Project");
    expect(result.status).toBe("active");
  });

  test("strips inline YAML comments from quoted values", () => {
    const content = `---
status: "explore"  # this is a comment
---`;

    const result = parseFrontmatter(content);
    expect(result.status).toBe("explore");
  });

  test("skips comment lines", () => {
    const content = `---
# This is a comment
title: Hello
---`;

    const result = parseFrontmatter(content);
    expect(result).toEqual({ title: "Hello" });
  });

  test("returns empty for content without frontmatter", () => {
    expect(parseFrontmatter("# Just a heading")).toEqual({});
  });

  test("returns empty for unclosed frontmatter", () => {
    expect(parseFrontmatter("---\ntitle: Oops")).toEqual({});
  });

  test("handles empty frontmatter block", () => {
    expect(parseFrontmatter("---\n---\nBody")).toEqual({});
  });

  test("handles values containing colons", () => {
    const content = `---
url: http://example.com:8080/path
---`;
    const result = parseFrontmatter(content);
    expect(result.url).toBe("http://example.com:8080/path");
  });
});

// ─── parseBacklogFeatures ───────────────────────────────────────────────────

describe("parseBacklogFeatures", () => {
  test("parses feature headings with em dash", () => {
    const content = `### f001 — Feature One
Some description

### f002 — Feature Two
Status: in progress`;

    const result = parseBacklogFeatures(content);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ id: "f001", name: "Feature One", status: "backlog" });
    expect(result[1]).toEqual({ id: "f002", name: "Feature Two", status: "in progress" });
  });

  test("parses feature headings with en dash", () => {
    const content = `### f010 – Dashboard`;
    const result = parseBacklogFeatures(content);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f010");
    expect(result[0].name).toBe("Dashboard");
  });

  test("parses feature headings with hyphen", () => {
    const content = `### f020 - Simple feature`;
    const result = parseBacklogFeatures(content);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Simple feature");
  });

  test("skips done features", () => {
    const content = `### f001 — Done Feature
Status: done

### f002 — Also Done
Status: done -> 2026-02-25

### f003 — Active Feature
Status: in progress`;

    const result = parseBacklogFeatures(content);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("f003");
  });

  test("defaults status to backlog when no Status: line", () => {
    const content = `### f001 — No Status
Just some description text here.`;

    const result = parseBacklogFeatures(content);
    expect(result[0].status).toBe("backlog");
  });

  test("stops looking for status at next heading", () => {
    const content = `### f001 — First
## Section Header
Status: should not be found`;

    const result = parseBacklogFeatures(content);
    expect(result[0].status).toBe("backlog");
  });

  test("returns empty for content with no features", () => {
    expect(parseBacklogFeatures("Just regular text\nNo features here")).toEqual([]);
  });

  test("status matching is case-insensitive", () => {
    const content = `### f001 — Feature
STATUS: In Progress`;

    const result = parseBacklogFeatures(content);
    expect(result[0].status).toBe("in progress");
  });
});

// ─── parseBacklogTasks ──────────────────────────────────────────────────────

describe("parseBacklogTasks", () => {
  test("parses unchecked task items", () => {
    const content = `- [ ] t001 Write tests
- [ ] t002 Fix bug`;

    const result = parseBacklogTasks(content);
    expect(result).toEqual([
      { id: "t001", text: "Write tests" },
      { id: "t002", text: "Fix bug" },
    ]);
  });

  test("ignores checked items", () => {
    const content = `- [x] t001 Done task
- [ ] t002 Open task`;

    const result = parseBacklogTasks(content);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t002");
  });

  test("ignores lines without task IDs", () => {
    const content = `- [ ] Some random checkbox
- [ ] t003 Valid task`;

    const result = parseBacklogTasks(content);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("t003");
  });

  test("returns empty for content with no tasks", () => {
    expect(parseBacklogTasks("No tasks here")).toEqual([]);
  });

  test("trims task text", () => {
    const content = `- [ ] t001 Some text with trailing spaces   `;
    const result = parseBacklogTasks(content);
    expect(result[0].text).toBe("Some text with trailing spaces");
  });

  test("ignores regular list items", () => {
    const content = `- Regular item
- [ ] t001 Task item
- Another item`;

    const result = parseBacklogTasks(content);
    expect(result).toHaveLength(1);
  });
});
