/**
 * Project registration and activity tracking.
 */

import { getSupabase } from "./client";
import { checkResult } from "./check-result";

/**
 * Ensure a project exists in the projects table.
 * Upserts on id (canonical PK). Tracks local directory names
 * in the local_names array.
 */
export async function upsertProject(
  projId: string,
  contentSlug: string,
  localName: string,
  visibility: "public" | "private",
  timestamp?: Date
): Promise<boolean> {
  const now = timestamp ?? new Date();
  const { data, error } = await getSupabase()
    .from("projects")
    .upsert(
      {
        id: projId,
        content_slug: contentSlug,
        visibility: visibility === "public" ? "public" : "private",
        state: visibility === "public" ? "public" : "private",
        status: "explore",
        first_seen: now.toISOString(),
        last_active: now.toISOString(),
        local_names: [],
      },
      { onConflict: "id", ignoreDuplicates: false }
    )
    .select("local_names")
    .single();

  let localNames: string[] | null = (data?.local_names as string[] | undefined) ?? null;

  if (error) {
    // Upsert failed (e.g. first_seen immutable) — fall back to updating convergent fields
    console.warn(`  upsertProject: primary upsert failed (${error.message}), trying fallback update`);
    const { data: fallback, error: updateError } = await getSupabase()
      .from("projects")
      .update({
        content_slug: contentSlug,
        visibility: visibility === "public" ? "public" : "private",
        state: visibility === "public" ? "public" : "private",
        last_active: now.toISOString(),
      })
      .eq("id", projId)
      .select("local_names")
      .single();
    if (updateError) {
      console.error(`  Failed to register project ${projId}:`, updateError.message);
      checkResult(
        { error: updateError },
        { operation: "upsertProject.fallback", category: "project_registration", entity: { projId, slug: contentSlug } }
      );
      return false;
    }
    localNames = (fallback?.local_names as string[] | undefined) ?? null;
  }

  // Merge localName into local_names if it's not already present
  if (localName && localName !== contentSlug) {
    const names = localNames ?? [];
    if (!names.includes(localName)) {
      const { error: mergeError } = await getSupabase()
        .from("projects")
        .update({ local_names: [...names, localName] })
        .eq("id", projId);
      if (mergeError) {
        console.warn(`  upsertProject: failed to merge localName (${mergeError.message})`);
      }
    }
  }

  return true;
}

/**
 * Update a project's event count and last_active time.
 */
export async function updateProjectActivity(
  projId: string,
  eventCount: number,
  lastActive: Date
): Promise<boolean> {
  const { data: current, error: selectError } = await getSupabase()
    .from("projects")
    .select("total_events")
    .eq("id", projId)
    .single();

  if (selectError || !current) {
    checkResult(
      { error: selectError ?? { message: "no project row" } },
      { operation: "updateProjectActivity.select", category: "project_registration", entity: { projId } }
    );
    return false;
  }

  const result = await getSupabase()
    .from("projects")
    .update({
      total_events: current.total_events + eventCount,
      last_active: lastActive.toISOString(),
    })
    .eq("id", projId);

  return checkResult(result, {
    operation: "updateProjectActivity.update",
    category: "project_registration",
    entity: { projId },
  });
}
