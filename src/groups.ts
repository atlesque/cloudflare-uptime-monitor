// Monitor groups. A group is the group name on its monitors, so it exists while a monitor
// uses it: renaming rewrites those monitors and removing a group ungroups them.

import { HttpError, readJsonObject } from "./http";
import { parseGroup } from "./monitors";

export async function listGroups(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT group_name AS name, COUNT(*) AS monitors FROM monitors
      WHERE group_name IS NOT NULL GROUP BY group_name ORDER BY group_name COLLATE NOCASE`,
  ).all<{ name: string; monitors: number }>();
  return { groups: results };
}

function parseExisting(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, "name of an existing group is required");
  return v;
}

/** Body: { from, to }. Renaming onto an existing group merges the two. */
export async function renameGroup(env: Env, request: Request) {
  const body = await readJsonObject(request);
  const from = parseExisting(body.from);
  const to = parseGroup(body.to);
  if (to === null) throw new HttpError(400, "to must be a non-empty group name");
  const result = await env.DB.prepare(`UPDATE monitors SET group_name = ? WHERE group_name = ?`).bind(to, from).run();
  if (result.meta.changes === 0) throw new HttpError(404, "Group not found");
  return { ...(await listGroups(env)), changed: result.meta.changes };
}

/** Body: { name, confirm: true }. The group's monitors are kept, without a group. */
export async function removeGroup(env: Env, request: Request) {
  const body = await readJsonObject(request);
  const name = parseExisting(body.name);
  if (body.confirm !== true) throw new HttpError(400, "Removing a group must be confirmed with confirm: true");
  const result = await env.DB.prepare(`UPDATE monitors SET group_name = NULL WHERE group_name = ?`).bind(name).run();
  if (result.meta.changes === 0) throw new HttpError(404, "Group not found");
  return { ...(await listGroups(env)), changed: result.meta.changes };
}
