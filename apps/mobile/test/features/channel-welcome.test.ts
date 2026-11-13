import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WELCOME_CLOSE_MS } from "@agenteschat/client/lib/welcome";

const source = (path: string) => readFileSync(join(import.meta.dir, "../../src/features/chat", path), "utf8");

test("the day's greeting goes by itself 8 s after the first touch elsewhere, never under a finger, unfelt", () => {
  // No renderer for the phone's components in these tests: what only the source can say is read from it.
  expect(WELCOME_CLOSE_MS).toBe(8_000);
  const chat = source("ChatScreen.tsx");
  // Any touch on the conversation's screen: a scroll, the box, a message, the bar.
  expect(chat).toContain("onTouchStart={touched ? undefined : () => setTouched(true)}");
  expect(chat).toContain("touched={touched}");
  const welcome = source("ChannelWelcome.tsx");
  // Only the day's greeting: a newcomer's welcome stays until they close it.
  expect(welcome).toContain("const autoCloses = Boolean(me) && greets && messages !== undefined && touched;");
  expect(welcome).toContain("}, WELCOME_CLOSE_MS);");
  // Its own touches are reading it; a finger on it keeps it, and it goes as the finger lifts.
  expect(welcome).toContain("e.stopPropagation();");
  expect(welcome).toContain("due.current = held.current;");
  expect(welcome).toContain("onTouchEnd={lift}");
  expect(welcome).toContain("onTouchCancel={lift}");
  // It leaves the way it came, with no haptic of its own.
  expect(welcome.match(/away\.current\(false\)/g)).toHaveLength(2);
  expect(welcome).toContain("if (felt) haptics.light();");
});
