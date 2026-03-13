/**
 * Project registration and activity tracking.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Ensure a project exists in the initiatives table.
 * Upserts on id (canonical PK).
 */
export async function upsertProject(
  projId: string,
  contentSlug: string,
  localName: string,
  visibility: "public" | "private",
  timestamp?: Date
): Promise<boolean> {
  const now = timestamp ?? new Date();
  const { error } = await getSupabase()
    .from("initiatives")
    .upsert(
      {
        id: projId,
        slug: contentSlug,
        state: visibility,
        status: "explore",
        last_active: now.toISOString(),
      },
      { onConflict: "id", ignoreDuplicates: false }
    );

  if (error) {
    // Upsert failed — fall back to updating convergent fields
    console.warn(`  upsertProject: primary upsert failed (${error.message}), trying fallback update`);
    const { error: updateError } = await getSupabase()
      .from("initiatives")
      .update({
        slug: contentSlug,
        state: visibility,
        last_active: now.toISOString(),
      })
      .eq("id", projId);
    if (updateError) {
      console.error(`  Failed to register project ${projId}:`, updateError.message);
      checkResult(
        { error: updateError },
        { operation: "upsertProject.fallback", category: "project_registration", entity: { projId, slug: contentSlug } }
      );
      return false;
    }
  }

  return true;
}

/**
 * Update a project's last_active time.
 */
export async function updateProjectActivity(
  projId: string,
  _eventCount: number,
  lastActive: Date
): Promise<boolean> {
  const result = await getSupabase()
    .from("initiatives")
    .update({
      last_active: lastActive.toISOString(),
    })
    .eq("id", projId);

  return checkResult(result, {
    operation: "updateProjectActivity.update",
    category: "project_registration",
    entity: { projId },
  });
}
