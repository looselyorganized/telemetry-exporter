/**
 * Hand-rolled fake of the @supabase/supabase-js client surface used by the exporter.
 *
 * Enforces UNIQUE(slug) on 'projects' and FK on 'project_id' for 'events',
 * 'daily_rollups', and 'sessions'. Returns Supabase-shaped { data, error, status }
 * responses. Just enough fidelity to drive the slug-collision regression test.
 */

type Row = Record<string, unknown>;

interface SupabaseError {
  message: string;
  code?: string;
  details?: string;
}

interface SupabaseResponse {
  data: Row[] | null;
  error: SupabaseError | null;
  status: number;
}

export class SupabaseFake {
  private tables: Map<string, Row[]> = new Map();
  /** All insert/upsert attempts for assertions (including rejected ones). */
  public insertLog: Array<{ table: string; rows: Row[]; accepted: boolean }> = [];

  seed(table: string, rows: Row[]): void {
    this.tables.set(table, [...rows]);
  }

  dump(table: string): Row[] {
    return [...(this.tables.get(table) ?? [])];
  }

  from(table: string) {
    return {
      insert: (payload: Row | Row[]) => this.handleInsert(table, payload),
      upsert: (payload: Row | Row[]) => this.handleInsert(table, payload),
      update: (_payload: Row) => ({
        match: (_m: Row) => Promise.resolve(this.ok()),
      }),
      delete: () => ({
        eq: (_k: string, _v: unknown) => Promise.resolve(this.ok()),
      }),
      select: (_cols?: string) => ({
        single: () =>
          Promise.resolve({
            data: (this.tables.get(table) ?? [])[0] ?? null,
            error: null,
            status: 200,
          }),
      }),
    };
  }

  private handleInsert(table: string, payload: Row | Row[]): Promise<SupabaseResponse> {
    const rows = Array.isArray(payload) ? payload : [payload];

    if (table === "projects") {
      const existing = this.tables.get("projects") ?? [];
      for (const r of rows) {
        const slugClash = existing.find((e) => e.slug === r.slug && e.id !== r.id);
        if (slugClash) {
          this.insertLog.push({ table, rows, accepted: false });
          return Promise.resolve({
            data: null,
            error: {
              message: `duplicate key value violates unique constraint "projects_slug_key"`,
              code: "23505",
              details: `Key (slug)=(${String(r.slug)}) already exists.`,
            },
            status: 409,
          });
        }
      }
    }

    if (table === "events" || table === "daily_rollups" || table === "sessions") {
      const projects = this.tables.get("projects") ?? [];
      for (const r of rows) {
        const projectId = r.project_id as string;
        if (!projects.some((p) => p.id === projectId)) {
          this.insertLog.push({ table, rows, accepted: false });
          return Promise.resolve({
            data: null,
            error: {
              message: `insert or update on table "${table}" violates foreign key constraint "${table}_project_id_fkey"`,
              code: "23503",
            },
            status: 409,
          });
        }
      }
    }

    const current = this.tables.get(table) ?? [];
    this.tables.set(table, [...current, ...rows]);
    this.insertLog.push({ table, rows, accepted: true });
    return Promise.resolve({ data: rows, error: null, status: 201 });
  }

  private ok(): SupabaseResponse {
    return { data: null, error: null, status: 200 };
  }
}
