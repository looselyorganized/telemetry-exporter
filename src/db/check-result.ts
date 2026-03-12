/**
 * Standardized Supabase result checker with error reporting.
 */

import { reportError, type ErrorCategory } from "../errors";

export interface ResultContext {
  operation: string;
  category: ErrorCategory;
  entity?: Record<string, unknown>;
}

/**
 * Check a Supabase result and report errors with full context.
 * Returns true if the operation succeeded, false otherwise.
 *
 * 5xx errors are automatically categorized as "supabase_transient"
 * regardless of the provided category.
 */
export function checkResult(
  result: { error: any; status?: number },
  ctx: ResultContext
): boolean {
  if (!result.error) return true;

  const status = result.status ?? 0;
  const category: ErrorCategory =
    status >= 500 ? "supabase_transient" : ctx.category;
  const msg = `${ctx.operation}: ${result.error.message}`;

  console.error(`  ${msg}`);
  reportError(category, msg, ctx.entity);

  return false;
}
