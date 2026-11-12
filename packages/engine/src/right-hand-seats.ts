import type { AgentScope } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { getAgentCached, workspaceHomeId } from "./agents";
import type { MachineCaller } from "./machine-hub";
import { getMachine } from "./machines";
import { personBehindCall } from "./requester";
import { isRightHand, readsAlone } from "./right-hand";
import { SandboxUnavailableError } from "./sandbox";
import type { ToolContext } from "./tools/types";

const { agents, organizationMembers, rightHandSeats, users } = schema;

/**
 * The right hand's computer (ADR 0174). One agents row answers everyone, so on the workspace's own computer each
 * person has a seat: a stored random id the computer takes for an agent's, which gives that person's right hand its
 * own OS user, home, browser profile and sign-ins there. The agent's own id never goes to a computer for anything but
 * its locked chat turn (the hub refuses it), so a request built without a seat fails instead of landing every member
 * in one home.
 */

/** A call of the right hand outside a person's own conversation with it: no seat, so no computer. */
export const NO_SEAT_MESSAGE =
  "Your computer is each person's own: you use it only in a person's own conversation with you, when that person asks. Here you have none. Hand this to an agent that has a computer (ask_agent, tell_agent, or create_issue assigned to it), or say it can be done in their own conversation with you, and never ask the person to try again here.";

/** The workspace has no computer of its own connected: the right hand has none either. */
export const NO_HOME_MESSAGE =
  "You have no computer here: this workspace has no computer of its own connected. Hand this to an agent that has a computer (ask_agent, tell_agent, or create_issue assigned to it), and never ask the person to try again.";

/** Another computer of the workspace (one a person brought, a phone's host): the right hand has no seat there. */
export const notHomeMessage = (computer: string) =>
  `You have no place of your own on ${computer}: your computer is the workspace's own. Do it there, or hand this to an agent that uses ${computer} (ask_agent, tell_agent, or create_issue assigned to it).`;

/** A computer where every agent works as the same OS user can't keep people's seats apart. */
export const notSystemMessage = (computer: string) =>
  `You have no computer on ${computer}: it runs every agent as one user, so it can't keep each person's files and sign-ins apart. Hand this to an agent that has a computer (ask_agent, tell_agent, or create_issue assigned to it), and never ask the person to try again.`;

/** `userId`'s live seat in the workspace, made on first use; null for someone who isn't a member. */
export async function seatOf(
  db: Executor,
  orgId: string,
  userId: string,
): Promise<{ id: string; made: boolean } | null> {
  const live = () =>
    db
      .select({ id: rightHandSeats.id })
      .from(rightHandSeats)
      .innerJoin(
        organizationMembers,
        and(eq(organizationMembers.orgId, rightHandSeats.orgId), eq(organizationMembers.userId, rightHandSeats.userId)),
      )
      .where(and(eq(rightHandSeats.orgId, orgId), eq(rightHandSeats.userId, userId), isNull(rightHandSeats.removedAt)));
  const [had] = await live();
  if (had) return { id: had.id, made: false };
  await db.execute(sql`insert into ${rightHandSeats} (org_id, user_id)
    select om.org_id, om.user_id from ${organizationMembers} om
    where om.org_id = ${orgId}::uuid and om.user_id = ${userId}
    on conflict do nothing`);
  const [made] = await live();
  return made ? { id: made.id, made: true } : null;
}

/** The person's seat is gone with their membership: the computer hears its id is deleted, and a return starts anew. */
export async function removeSeat(db: Executor, orgId: string, userId: string) {
  await db
    .update(rightHandSeats)
    .set({ removedAt: new Date() })
    .where(and(eq(rightHandSeats.orgId, orgId), eq(rightHandSeats.userId, userId), isNull(rightHandSeats.removedAt)));
}

/** The live seats of the workspace's members, with each person's name for the computer's own lists. */
export async function liveSeats(db: Executor, orgId: string) {
  return db
    .select({ id: rightHandSeats.id, userId: rightHandSeats.userId, person: users.name, locale: users.locale })
    .from(rightHandSeats)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, rightHandSeats.orgId), eq(organizationMembers.userId, rightHandSeats.userId)),
    )
    .innerJoin(users, eq(users.id, rightHandSeats.userId))
    .where(and(eq(rightHandSeats.orgId, orgId), isNull(rightHandSeats.removedAt)))
    .orderBy(rightHandSeats.createdAt);
}

/** Seats whose person left (or whose membership is gone whatever removed it), the latest first. */
export async function removedSeatIds(db: Executor, orgId: string, limit: number): Promise<string[]> {
  const rows = await db
    .select({ id: rightHandSeats.id })
    .from(rightHandSeats)
    .where(
      and(
        eq(rightHandSeats.orgId, orgId),
        sql`(${isNotNull(rightHandSeats.removedAt)} or not exists (select 1 from ${organizationMembers} om
          where om.org_id = ${rightHandSeats.orgId} and om.user_id = ${rightHandSeats.userId}))`,
      ),
    )
    .orderBy(desc(sql`coalesce(${rightHandSeats.removedAt}, ${rightHandSeats.createdAt})`))
    .limit(limit);
  return rows.map((r) => r.id);
}

/** The seat as the computer names it: the right hand's handle, and whose it is in the OS user's description. */
const seatScope = (seatId: string, agent: { handle: string; name: string }, person: string | null): AgentScope => ({
  id: seatId,
  handle: agent.handle,
  name: person ? `${agent.name} (${person})` : agent.name,
});

/** A computer as a seat's rules read it. */
type SeatMachine = { id: string; orgId: string; name: string; system: boolean };

/**
 * `userId`'s seat on `machine` as a request's agent, or why there is none. The one place a seat is given: only on
 * the workspace's own computer, and only where each agent is its own OS user. `told`: tells the workspace's computers
 * of a seat just made, which they list like an agent (its containers, its desktop kept), before its first request.
 */
async function seatOn(
  db: Executor,
  agent: { orgId: string; handle: string; name: string },
  userId: string,
  machine: SeatMachine | null,
  told?: (orgId: string) => Promise<void>,
): Promise<{ ok: true; scope: AgentScope } | { ok: false; message: string }> {
  const home = await workspaceHomeId(db, agent.orgId);
  if (!home || !machine || machine.orgId !== agent.orgId) return { ok: false, message: NO_HOME_MESSAGE };
  if (machine.id !== home) return { ok: false, message: notHomeMessage(machine.name) };
  if (!machine.system) return { ok: false, message: notSystemMessage(machine.name) };
  const seat = await seatOf(db, agent.orgId, userId);
  if (!seat) return { ok: false, message: NO_SEAT_MESSAGE };
  if (seat.made) await told?.(agent.orgId);
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return { ok: true, scope: seatScope(seat.id, agent, person?.name ?? null) };
}

/** The person whose seat a run of the right hand uses: who asked, in their own DM with it. Nobody anywhere else. */
export async function seatPerson(
  ctx: Pick<ToolContext, "orgId" | "agentId" | "channelId" | "runId" | "triggerMessageId"> & { db: Executor },
): Promise<string | null> {
  // Never a routine's creator nor an agent's owner: a run nobody asked for may carry what a routine read outside.
  const person = await personBehindCall(ctx).catch(() => null);
  return person && (await readsAlone(ctx.db, ctx.channelId, person, ctx.agentId)) ? person : null;
}

/** What a run of the right hand has of a computer: the person's `seat`, none here (`away`), or `none` at all. */
export type SeatState = "seat" | "away" | "none";

/** `SeatState` of a run, for what its prompt says. It makes no seat: the first request does. */
export async function seatState(
  db: Database,
  run: { orgId: string; agentId: string; channelId: string; id: string; triggerMessageId: string },
): Promise<SeatState> {
  const home = await workspaceHomeId(db, run.orgId);
  const machine = home ? await getMachine(db, run.orgId, home) : null;
  if (machine?.executors?.mode !== "system") return "none";
  return (await seatPerson({ db, ...run, runId: run.id })) ? "seat" : "away";
}

export type ScopeContext = Pick<ToolContext, "orgId" | "agentId"> &
  Partial<Pick<ToolContext, "channelId" | "runId" | "triggerMessageId">> & { db: Database };

/**
 * The computer an agent's tools act on: its own, or for the right hand, which is on none (ADR 0137 §1), the
 * workspace's own.
 */
export async function toolMachineId(
  db: Executor,
  agent: { orgId: string; machineId: string | null; builtin?: string | null } | null | undefined,
): Promise<string | null> {
  if (!agent) return null;
  return agent.machineId ?? (isRightHand(agent) ? workspaceHomeId(db, agent.orgId) : null);
}

/**
 * The agent a request to `machineId` is for, built from a tool call: the agent itself, or for the right hand the seat
 * of the person behind the run. Throws what the agent reads when the right hand has no seat there: a channel, a run
 * nobody asked for, a computer that isn't the workspace's own or runs every agent as one user.
 */
export async function machineScope(
  hub: Pick<MachineCaller, "status" | "agentsChanged">,
  ctx: ScopeContext,
  machineId: string,
): Promise<AgentScope> {
  const agent = await getAgentCached(ctx.db, ctx.orgId, ctx.agentId);
  if (!isRightHand(agent)) {
    return { id: ctx.agentId, handle: agent?.handle ?? "agent", ...(agent?.name ? { name: agent.name } : {}) };
  }
  const person =
    agent && ctx.channelId
      ? await seatPerson({
          ...ctx,
          channelId: ctx.channelId,
          runId: ctx.runId ?? "",
          triggerMessageId: ctx.triggerMessageId ?? "",
        })
      : null;
  if (!agent || !person) throw new SandboxUnavailableError(NO_SEAT_MESSAGE);
  const status = await hub.status(machineId);
  const seat = await seatOn(
    ctx.db,
    agent,
    person,
    status && { id: machineId, orgId: status.orgId, name: status.name, system: status.mode === "system" },
    async (orgId) => hub.agentsChanged?.(orgId),
  );
  if (!seat.ok) throw new SandboxUnavailableError(seat.message);
  return seat.scope;
}

/**
 * What the server remembers of an agent's screen is kept under this: the agent, and for the right hand the
 * conversation too, since each person's seat is another screen and one person's must never be compared with another's.
 */
export async function screenKey(ctx: Pick<ToolContext, "db" | "orgId" | "agentId" | "channelId">) {
  const key = `${ctx.orgId}:${ctx.agentId}`;
  return isRightHand(await getAgentCached(ctx.db, ctx.orgId, ctx.agentId)) ? `${key}:${ctx.channelId}` : key;
}

/** A scope's id when it is a seat, for rows that keep which seat their work runs in; null for the agent's own. */
export const seatIdOf = (ctx: { agentId: string }, scope: AgentScope) => (scope.id === ctx.agentId ? null : scope.id);

/**
 * The agent a person's own request reaches on a computer (watching, driving, a terminal, its files): the agent, or
 * for the right hand that person's own seat and nobody else's, admins included. Everything that opens something of
 * an agent on a computer for a signed-in person goes through here, so nothing can name another person's seat.
 * `message`: why the right hand has no seat for them.
 */
export async function viewerScope(
  db: Database,
  orgId: string,
  agentId: string,
  viewerId: string,
  told?: (orgId: string) => Promise<void>,
): Promise<{ machineId: string | null; scope: AgentScope; seat: boolean } | { message: string } | null> {
  const [agent] = await db
    .select({
      orgId: agents.orgId,
      handle: agents.handle,
      name: agents.name,
      machineId: agents.machineId,
      builtin: agents.builtin,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  if (!agent) return null;
  if (!isRightHand(agent)) {
    return { machineId: agent.machineId, scope: { id: agentId, handle: agent.handle, name: agent.name }, seat: false };
  }
  const machineId = await workspaceHomeId(db, orgId);
  const machine = machineId ? await getMachine(db, orgId, machineId) : null;
  const seat = await seatOn(
    db,
    agent,
    viewerId,
    machine && {
      id: machine.id,
      orgId: machine.orgId,
      name: machine.name,
      system: machine.executors?.mode === "system",
    },
    told,
  );
  return seat.ok ? { machineId, scope: seat.scope, seat: true } : { message: seat.message };
}
