// Monitor groups. Groups are rows in `groups`, so one can exist before any monitor is in it.
// A monitor names its group in monitors.group_name; renaming rewrites those monitors and
// removing a group ungroups them. Database triggers add a group when a monitor uses a new name.

import { HttpError, readJsonObject } from "./http";
import { parseGroup } from "./monitors";

const MAX_MEMBERS = 500;

export async function listGroups(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT g.name, COUNT(m.id) AS monitors FROM groups g LEFT JOIN monitors m ON m.group_name = g.name
      GROUP BY g.name ORDER BY g.name COLLATE NOCASE`,
  ).all<{ name: string; monitors: number }>();
  return { groups: results };
}

function parseExisting(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, "name of an existing group is required");
  return v;
}

function parseNewName(v: unknown, field: string): string {
  const name = parseGroup(v);
  if (name === null) throw new HttpError(400, `${field} must be a non-empty group name`);
  return name;
}

/** The monitors a group should hold, exactly. Monitors in another group move to this one. */
async function parseMembers(env: Env, v: unknown): Promise<number[] | null> {
  if (v === undefined) return null;
  if (!Array.isArray(v)) throw new HttpError(400, "monitorIds must be an array");
  if (v.length > MAX_MEMBERS) throw new HttpError(400, `At most ${MAX_MEMBERS} monitors per group`);
  if (!v.every((id) => Number.isInteger(id) && id > 0)) throw new HttpError(400, "monitorIds must be positive integers");
  const ids = [...new Set(v as number[])];
  if (ids.length === 0) return ids;
  const { results } = await env.DB.prepare(`SELECT id FROM monitors WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(JSON.stringify(ids))
    .all<{ id: number }>();
  if (results.length !== ids.length) {
    const found = new Set(results.map((r) => r.id));
    throw new HttpError(404, "Some monitors no longer exist; refresh and try again", {
      missing: ids.filter((id) => !found.has(id)),
    });
  }
  return ids;
}

async function groupExists(env: Env, name: string) {
  return (await env.DB.prepare(`SELECT 1 FROM groups WHERE name = ?`).bind(name).first()) !== null;
}

function membershipStatements(env: Env, name: string, ids: number[]) {
  const json = JSON.stringify(ids);
  return [
    env.DB.prepare(
      `UPDATE monitors SET group_name = NULL WHERE group_name = ?1 AND id NOT IN (SELECT value FROM json_each(?2))`,
    ).bind(name, json),
    env.DB.prepare(`UPDATE monitors SET group_name = ?1 WHERE id IN (SELECT value FROM json_each(?2))`).bind(name, json),
  ];
}

/** Moves a group's monitors to `to`. When `to` already exists the two groups merge. */
function renameStatements(env: Env, from: string, to: string) {
  return [
    env.DB.prepare(`INSERT OR IGNORE INTO groups (name, created_at) SELECT ?2, created_at FROM groups WHERE name = ?1`).bind(
      from,
      to,
    ),
    env.DB.prepare(`UPDATE monitors SET group_name = ?2 WHERE group_name = ?1`).bind(from, to),
    env.DB.prepare(`DELETE FROM groups WHERE name = ?1`).bind(from),
  ];
}

/** Body: { name, monitorIds? }. */
export async function createGroup(env: Env, request: Request, now = Date.now()) {
  const body = await readJsonObject(request);
  const name = parseNewName(body.name, "name");
  const ids = await parseMembers(env, body.monitorIds);
  if (await groupExists(env, name)) throw new HttpError(409, "A group with this name already exists");
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO groups (name, created_at) VALUES (?, ?)`).bind(name, now),
    ...(ids ? membershipStatements(env, name, ids) : []),
  ]);
  return listGroups(env);
}

/**
 * Body: { name, to?, monitorIds? }. `monitorIds` sets the group's monitors exactly: monitors
 * left out lose the group, and monitors from another group move here. `to` renames the group,
 * merging it into `to` when that group exists.
 */
export async function editGroup(env: Env, request: Request) {
  const body = await readJsonObject(request);
  const name = parseExisting(body.name);
  const to = body.to === undefined ? name : parseNewName(body.to, "to");
  const ids = await parseMembers(env, body.monitorIds);
  if (!(await groupExists(env, name))) throw new HttpError(404, "Group not found");
  const statements = [
    ...(ids ? membershipStatements(env, name, ids) : []),
    ...(to !== name ? renameStatements(env, name, to) : []),
  ];
  if (statements.length > 0) await env.DB.batch(statements);
  return listGroups(env);
}

/** Body: { from, to }. Renaming onto an existing group merges the two. */
export async function renameGroup(env: Env, request: Request) {
  const body = await readJsonObject(request);
  const from = parseExisting(body.from);
  const to = parseNewName(body.to, "to");
  if (!(await groupExists(env, from))) throw new HttpError(404, "Group not found");
  const [, moved] = await env.DB.batch(renameStatements(env, from, to));
  return { ...(await listGroups(env)), changed: moved!.meta.changes };
}

/** Body: { name, confirm: true }. The group's monitors are kept, without a group. */
export async function removeGroup(env: Env, request: Request) {
  const body = await readJsonObject(request);
  const name = parseExisting(body.name);
  if (body.confirm !== true) throw new HttpError(400, "Removing a group must be confirmed with confirm: true");
  const [ungrouped, removed] = await env.DB.batch([
    env.DB.prepare(`UPDATE monitors SET group_name = NULL WHERE group_name = ?`).bind(name),
    env.DB.prepare(`DELETE FROM groups WHERE name = ?`).bind(name),
  ]);
  if (removed!.meta.changes === 0) throw new HttpError(404, "Group not found");
  return { ...(await listGroups(env)), changed: ungrouped!.meta.changes };
}
