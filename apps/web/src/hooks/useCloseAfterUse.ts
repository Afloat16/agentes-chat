import { type RefObject, useEffect, useRef } from "react";

/** What counts as the person using the page: a press, a key, a scroll by wheel or finger. */
const USES = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

/**
 * Closes something the person has seen once they move on: `ms` after their first press, key or scroll outside `box`.
 * Never while the pointer rests on it or the focus is inside it: then as soon as both have left. Off while `on` is
 * false, and nothing before the person does anything.
 */
export function useCloseAfterUse(box: RefObject<HTMLElement | null>, close: () => void, ms: number, on = true) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => {
    const el = box.current;
    if (!on || !el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let over = false;
    let due = false;
    const end = () => {
      due = over || el.contains(document.activeElement);
      if (!due) latest.current();
    };
    const used = (e: Event) => {
      if (e.target instanceof Node && el.contains(e.target)) return;
      for (const type of USES) window.removeEventListener(type, used, true);
      timer = setTimeout(end, ms);
    };
    const enter = () => {
      over = true;
    };
    const pointerLeave = () => {
      over = false;
      if (due && !el.contains(document.activeElement)) latest.current();
    };
    const focusOut = (e: FocusEvent) => {
      // The focus going to something else inside is still inside.
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
      if (due && !over) latest.current();
    };
    for (const type of USES) window.addEventListener(type, used, { capture: true, passive: true });
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", pointerLeave);
    el.addEventListener("focusout", focusOut);
    return () => {
      clearTimeout(timer);
      for (const type of USES) window.removeEventListener(type, used, true);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", pointerLeave);
      el.removeEventListener("focusout", focusOut);
    };
  }, [box, ms, on]);
}
