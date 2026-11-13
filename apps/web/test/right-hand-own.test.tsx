import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, type FakeState, LODI_ID, ORG_ID, seedState, withRightHand } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/**
 * What Lodi does by itself, on its page (ADR 0177): the daily card for everyone and the weekly one for admins, each
 * with when it comes, then a switch per feature the server has built, and none for one it has not.
 */

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const open = async (state: FakeState) => {
  await renderApp(`/org/${ORG_ID}/agents/${LODI_ID}`, { api: createFakeApi(state) });
  await settle(8);
  const heading = [...document.querySelectorAll(".rh-group .ac-grouphead__title")].find(
    (h) => h.textContent === "O que o Lodi faz por conta própria",
  );
  return within(heading?.closest(".rh-group") as HTMLElement);
};
const saved = (state: FakeState, method: string) =>
  state.calls.filter((c) => c.method === method).map((c) => c.args[1]);

test("an admin sets when each card comes and stops either, and sees no switch of a feature not built", async () => {
  const state = withRightHand(seedState());
  const own = await open(state);
  const day = own.getByRole("group", { name: "Resumo do dia" });
  const week = own.getByRole("group", { name: "Semana da equipe" });
  // The daily card has an hour, the weekly one a day and an hour.
  expect(within(day).getAllByRole("combobox")).toHaveLength(1);
  expect(within(week).getAllByRole("combobox")).toHaveLength(2);
  expect(own.queryAllByRole("switch")).toHaveLength(0);

  await act(async () => fireEvent.click(within(day).getByRole("button", { name: "Parar de receber" })));
  await settle(4);
  expect(saved(state, "orgs.setTeamWeek")).toEqual([{ dayOff: true }]);
  // Stopped: its hour waits, its button brings it back, and the weekly card is as it was.
  expect(within(day).getByRole("button", { name: "Voltar a receber" })).toBeTruthy();
  expect(within(week).getByRole("button", { name: "Parar de receber" })).toBeTruthy();
  await act(async () => fireEvent.click(within(week).getByRole("button", { name: "Parar de receber" })));
  await settle(4);
  expect(saved(state, "orgs.setTeamWeek").at(-1)).toEqual({ weekOff: true });
});

test("each feature the server has shows its switch: the person's own, and the workspace's for who configures it", async () => {
  const state = withRightHand(seedState());
  state.teamWeek = { switches: ["digest", "reminders", "teamWatch", "welcomePeople"], remindOff: true };
  const own = await open(state);
  const names = own.getAllByRole("switch").map((s) => s.getAttribute("aria-label"));
  expect(names).toEqual([
    "Resumir aprovações esperando",
    "Lembrar o que combinamos",
    "Cuidar da equipe",
    "Dar boas-vindas a quem entra",
  ]);
  const on = (name: string) => own.getByRole("switch", { name }).getAttribute("aria-checked");
  expect([on("Resumir aprovações esperando"), on("Lembrar o que combinamos"), on("Cuidar da equipe")]).toEqual([
    "true",
    "false",
    "true",
  ]);
  // The workspace's say who they are for, under their name.
  const watch = own.getByRole("switch", { name: "Cuidar da equipe" }).closest(".settings-row") as HTMLElement;
  expect(watch.querySelector(".settings-row__status")?.textContent).toBe("Para todo o workspace");
  expect(within(watch).getByRole("button", { name: "Sobre Cuidar da equipe" })).toBeTruthy();

  await act(async () => fireEvent.click(own.getByRole("switch", { name: "Resumir aprovações esperando" })));
  await settle(4);
  expect(saved(state, "orgs.setTeamWeek")).toEqual([{ digestOff: true }]);
  await act(async () => fireEvent.click(own.getByRole("switch", { name: "Cuidar da equipe" })));
  await settle(4);
  expect(saved(state, "orgs.updateSettings")).toEqual([{ teamWatch: false }]);
  expect(on("Cuidar da equipe")).toBe("false");
});

test("someone who administers nothing has the daily card and their own switches only", async () => {
  const state = withRightHand(seedState());
  if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
  state.teamWeek = { switches: ["digest", "teamWatch", "welcomePeople"] };
  const own = await open(state);
  expect(own.getByRole("group", { name: "Resumo do dia" })).toBeTruthy();
  expect(own.queryByRole("group", { name: "Semana da equipe" })).toBeNull();
  expect(own.getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(["Resumir aprovações esperando"]);
  expect(screen().queryByText("Para todo o workspace")).toBeNull();
});

test("on a server from before the two cards, a stop and a start are saved in the words it knows", async () => {
  const state = withRightHand(seedState());
  // What that server answers: its one card (here the daily, in place of the weekly) and none of the new fields.
  state.teamWeek = { weekOff: undefined, dayOff: undefined, off: false, daily: true, hour: 9 } as FakeState["teamWeek"];
  const own = await open(state);
  const day = own.getByRole("group", { name: "Resumo do dia" });
  const week = own.getByRole("group", { name: "Semana da equipe" });
  expect(within(week).getByRole("button", { name: "Voltar a receber" })).toBeTruthy();
  await act(async () => fireEvent.click(within(day).getByRole("button", { name: "Parar de receber" })));
  await settle(4);
  expect(saved(state, "orgs.setTeamWeek")).toEqual([{ off: true }]);
  expect(within(day).getByRole("button", { name: "Voltar a receber" })).toBeTruthy();
  await act(async () => fireEvent.click(within(week).getByRole("button", { name: "Voltar a receber" })));
  await settle(4);
  expect(saved(state, "orgs.setTeamWeek").at(-1)).toEqual({ off: false, daily: false });
  expect(within(week).getByRole("button", { name: "Parar de receber" })).toBeTruthy();
});
