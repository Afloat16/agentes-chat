/**
 * The right hand's shared place on the workspace's computer (ADR 0175): the one it works in where others read, like a
 * channel. Without it, an agent's screen is the agent's own, and the right hand's is the viewer's own place.
 */
export const SHARED_SEAT = "shared";
export type Seat = typeof SHARED_SEAT;

/** An agent's screen as the cache names it: the agent's id, or that agent's shared place. */
export const screenId = (agentId: string, seat?: Seat | null) => (seat ? `${agentId}:${seat}` : agentId);
