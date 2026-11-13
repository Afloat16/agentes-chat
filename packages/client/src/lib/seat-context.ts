import { createContext, useContext } from "react";
import type { Seat } from "./seat";

/**
 * Which of the right hand's places the screens inside show (ADR 0175): the viewer's own when absent. Set around a
 * view of the shared one, so every read and action of its screen in there goes to that place and is kept apart in
 * the cache.
 */
export const SeatContext = createContext<Seat | undefined>(undefined);

export const useSeat = (): Seat | undefined => useContext(SeatContext);
