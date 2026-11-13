import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Approval, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, LODI_ID, ORG_ID, seedDm, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The right hand's digest of what waits on a person (ADR 0177 §4): the routine ones together, the rest one by one. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const CARD = "m-digest";

/** A connected app's request, as the server lists it: the app words its title, `detail` tells one from another. */
const ask = (state: FakeState, id: string, detail: string, routine: boolean): Approval => {
  const [first] = state.approvals;
  if (!first) throw new Error("no seeded approval");
  const a: Approval = {
    ...first,
    id,
    agentId: ADA_ID,
    messageId: null,
    tool: "notes_create_page",
    scope: "custom:notes:write",
    title: "Notes: create page",
    detail,
    routine,
  };
  state.approvals.push(a);
  return a;
};

/** Lodi's digest card in its DM listing `ids`. */
const withDigest = (state: FakeState, ids: string[]) => {
  withRightHand(state);
  seedDm(state, { type: "agent", id: LODI_ID });
  const message: Message = {
    id: CARD,
    channelId: `dm-${LODI_ID}`,
    threadId: null,
    author: { type: "agent", id: LODI_ID },
    body: "",
    mentionedAgentIds: [],
    agentRunId: null,
    meta: {
      bodyCode: "action_approvals",
      actionCard: { kind: "approvals", forUserId: "u-walter", params: { approvalIds: ids, why: "", digest: true } },
    },
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  };
  state.messages.push(message);
  return state;
};

const go = async (state: FakeState) => {
  await renderApp(`/org/${ORG_ID}/dm/agent/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
};
const click = async (el: HTMLElement) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};
const card = () => screen().getByRole("group", { name: "Aprovações esperando você" });

test("the routine ones share one button, sent as routine only with the card for the audit; the merge keeps its own", async () => {
  const state = seedState();
  ask(state, "ap-a", "Metas do trimestre", true);
  ask(state, "ap-b", "Riscos do trimestre, com um nome comprido de verdade para ver a linha quebrar", true);
  ask(state, "ap-c", "Time de vendas", true);
  await go(withDigest(state, ["ap-a", "ap-merge", "ap-b", "ap-c"]));

  const group = within(card()).getByRole("group", { name: "3 pedidos de rotina" });
  expect(group.textContent).toContain("Metas do trimestre");
  expect(group.textContent).toContain("Time de vendas");
  // What routine means, behind the ⓘ.
  expect(within(group).getByRole("button", { name: "Sobre 3 pedidos de rotina" })).toBeTruthy();
  // The merge is not in the group: it stands under it with its own button.
  expect(group.textContent).not.toContain("Fazer um merge");
  expect(within(card()).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();

  await click(within(group).getByRole("button", { name: "Aprovar os 3" }));
  expect(state.calls.find((c) => c.method === "approvals.decideMany")?.args).toEqual([
    ORG_ID,
    ["ap-a", "ap-b", "ap-c"],
    "approve",
    "routine",
  ]);
  expect(state.calls.find((c) => c.method === "via")?.args).toEqual([CARD]);
  expect(state.approvals.find((a) => a.id === "ap-merge")?.status).toBe("pending");
  // Decided, each says so on its own line and the group is gone. The merge still waits.
  expect(within(card()).queryByRole("group", { name: /pedidos de rotina/ })).toBeNull();
  expect(card().textContent).toContain("Aprovado por você");
  expect(within(card()).getByRole("button", { name: "Aprovar merge" })).toBeTruthy();
});

test("one by one shows each routine request on its own card, and nothing is sent", async () => {
  const state = seedState();
  ask(state, "ap-a", "Metas do trimestre", true);
  ask(state, "ap-b", "Riscos", true);
  await go(withDigest(state, ["ap-a", "ap-b", "ap-merge"]));
  await click(within(card()).getByRole("button", { name: "Um por um" }));
  expect(within(card()).queryByRole("group", { name: /pedidos de rotina/ })).toBeNull();
  expect(card().textContent).toContain("Metas do trimestre");
  expect(card().textContent).toContain("Riscos");
  expect(state.calls.some((c) => c.method === "approvals.decideMany")).toBe(false);
});

test("no group for one routine request, for none, or for someone who may not decide them", async () => {
  const state = seedState();
  ask(state, "ap-a", "Metas do trimestre", true);
  ask(state, "ap-b", "Riscos", false);
  const theirs = ask(state, "ap-c", "Time", true);
  theirs.canDecide = false;
  await go(withDigest(state, ["ap-a", "ap-b", "ap-c", "ap-merge"]));
  expect(within(card()).queryByRole("group", { name: /de rotina/ })).toBeNull();
  expect(within(card()).queryByRole("button", { name: /Aprovar os/ })).toBeNull();
  expect(card().textContent).toContain("Metas do trimestre");
});
