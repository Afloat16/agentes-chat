import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_ACTION_KINDS, type AgentAction, type AgentActionKind } from "@agenteschat/client";
import { receiptPieces, receiptRows } from "@agenteschat/client/lib/actions";
import {
  boldRuns,
  groupStart,
  RECEIPT_ICONS,
  receiptIcon,
  receiptLayout,
  targetHref,
} from "../../src/features/chat/actions";
import { translator } from "./fixtures";

const action = (over: Partial<AgentAction> = {}): AgentAction => ({
  id: "a1",
  kind: "issue.created",
  agentId: "ag",
  messageId: "m1",
  requestedByUserId: "u1",
  target: { type: "issue", id: "i1", number: 23, title: "Prompt" },
  params: { number: 23, title: "Prompt" },
  createdAt: "2026-10-18T11:59:00Z",
  undoableUntil: "2026-10-18T12:04:58Z",
  undoneAt: null,
  undoneByUserId: null,
  redoneAt: null,
  ...over,
});

describe("receipts under an agent's reply", () => {
  test("one change is a row (A), two or more a group (B)", () => {
    expect(receiptLayout(undefined)).toBe("none");
    expect(receiptLayout([])).toBe("none");
    expect(receiptLayout([action()])).toBe("one");
    expect(receiptLayout([action(), action({ id: "a2" })])).toBe("group");
  });

  test("the group's age is its first change", () => {
    expect(
      groupStart([action({ createdAt: "2026-10-18T11:59:30Z" }), action({ createdAt: "2026-10-18T11:58:00Z" })]),
    ).toBe("2026-10-18T11:58:00Z");
    expect(groupStart([])).toBeNull();
  });

  test("tapping the target opens what the phone has", () => {
    expect(targetHref({ type: "issue", id: "i1", number: 23 }, "c1")).toBe("/issues/23");
    expect(targetHref({ type: "issue", id: "i1" }, "c1")).toBeNull();
    expect(targetHref({ type: "channel", id: "c9", title: "tech" }, "c1")).toBe("/chat/c9");
    expect(targetHref({ type: "thread", id: "t1" }, "c1")).toBe("/chat/c1?thread=t1");
    expect(targetHref({ type: "wiki_page", id: "w1", slug: "x" }, "c1")).toBeNull();
    // A memory opens its own screen, where it is fixed or forgotten; a skill its page.
    expect(targetHref({ type: "memory", id: "m1" }, "c1")).toBe("/memory/m1");
    expect(targetHref({ type: "memory", id: "../x" }, "c1")).toBeNull();
    expect(targetHref({ type: "skill", id: "s1" }, "c1")).toBe("/settings/skills/s1");
    expect(targetHref({ type: "routine", id: "r1" }, "c1")).toBe("/routines/r1");
    expect(targetHref({ type: "routine", id: "" }, "c1")).toBeNull();
  });

  test("icons per kind and bold runs of the sentence", () => {
    expect(receiptIcon("issue.created")).toBe("issue");
    expect(receiptIcon("memory.saved")).toBe("brain");
    expect(receiptIcon("routine.updated")).toBe("clock");
    expect(boldRuns("Criei a issue <b>#23</b> · Prompt")).toEqual([
      { text: "Criei a issue ", bold: false },
      { text: "#23", bold: true },
      { text: " · Prompt", bold: false },
    ]);
    expect(boldRuns("sem marca")).toEqual([{ text: "sem marca", bold: false }]);
  });

  test("every kind the app knows has its icon; one it doesn't yet gets the plain check", () => {
    expect(Object.keys(RECEIPT_ICONS).sort()).toEqual([...AGENT_ACTION_KINDS].sort());
    expect(receiptIcon("channel.created")).toBe("hash");
    expect(receiptIcon("something.new" as AgentActionKind)).toBe("checkc");
  });
});

describe("receipts on one line, as on the web", () => {
  const task = (n: number) =>
    action({
      id: `a${n}`,
      target: { type: "issue", id: `i${n}`, number: n, title: `Página de preços: o botão Assinar não responde no tablet ${n}` },
      params: { number: n, title: `Página de preços: o botão Assinar não responde no tablet ${n}`, audience: "everyone" },
    });

  test("tasks made together are one row, each number opening its own task", async () => {
    const t = await translator("pt-BR");
    const [row, ...rest] = receiptRows([task(58), task(59), task(60)], t);
    expect(rest).toEqual([]);
    const pieces = receiptPieces(row as never, t);
    expect(pieces.map((p) => p.text).join("")).toBe("Criei as tarefas #58, #59 e #60");
    expect(pieces.flatMap((p) => (p.opens ? [[p.text, targetHref(p.opens.target, "c1")]] : []))).toEqual([
      ["#58", "/issues/58"],
      ["#59", "/issues/59"],
      ["#60", "/issues/60"],
    ]);
    const en = await translator("en");
    expect(
      receiptPieces(receiptRows([task(58), task(59)], en)[0] as never, en)
        .map((p) => p.text)
        .join(""),
    ).toBe("Created tasks #58 and #59");
  });

  test("a row is one line: its sentence never wraps, and no line under it says who sees the task", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/features/chat/Receipts.tsx"), "utf8");
    const sentence = src.slice(src.indexOf("function Sentence("), src.indexOf("function CopyHook("));
    expect(sentence).toContain("numberOfLines={1}");
    // Several: each reference opens its own; one change: the whole line opens it.
    expect(sentence).toContain("const each = row.refs ? opener(p.opens) : undefined;");
    expect(sentence).toContain("const open = row.refs ? undefined : opener(row.actions[0]);");
    expect(src).toContain("receiptRows(list, t, meId ?? undefined)");
    expect(src).not.toContain("WhoSeesLine");
  });
});
