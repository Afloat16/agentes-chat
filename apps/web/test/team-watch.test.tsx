import { afterEach, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { cleanup, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { notification } from "./fakes/notifications";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

test("what the right hand found: who found it, then what and how to fix it in the reader's language, and Abrir", async () => {
  const state = seedState({
    notifications: [
      notification({
        id: "n-apps",
        kind: "team_watch",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        count: 4,
        latest: {
          reason: "connector",
          names: ["Slack", "Notion", "Linear"],
          text: "Needs reconnecting: Slack, Notion, Linear +1. Reconnect it in Settings",
        },
      }),
      notification({
        id: "n-budget",
        kind: "team_watch",
        actors: [{ type: "agent", id: ADA_ID }],
        source: { agentId: ADA_ID },
        latest: { reason: "budget_low", names: ["Ada"], text: "Budget about to run out this month: Ada" },
      }),
      // A cause from a newer server: its own sentence stands.
      notification({
        id: "n-new",
        kind: "team_watch",
        waiting: true,
        actors: [{ type: "agent", id: ADA_ID }],
        latest: { reason: "something_new", names: ["X"], text: "Algo novo parou. Veja em Configurações" },
      }),
    ],
  });
  await renderApp(`/org/${ORG_ID}/notifications`, { api: createFakeApi(state) });
  await settle(8);
  const waiting = screen().getByRole("region", { name: "Esperando você" });
  const apps = waiting.querySelector('[data-n="n-apps"]') as HTMLElement;
  expect(apps.querySelector(".rq__lead")?.textContent).toBe("Ada encontrou algo para resolver");
  expect(apps.querySelector(".nt-wr__sub")?.textContent).toBe(
    "Precisa reconectar: Slack, Notion, Linear +1. Reconecte em Configurações",
  );
  expect(apps.querySelector(".nt-wr__src")?.textContent).toBe("Conectores e MCPs");
  expect(within(apps).getByRole("button", { name: "Abrir" })).toBeTruthy();
  const unknown = waiting.querySelector('[data-n="n-new"]') as HTMLElement;
  expect(unknown.querySelector(".nt-wr__sub")?.textContent).toBe("Algo novo parou. Veja em Configurações");

  // A budget about to end waits on nobody: a plain row, its sentence said once.
  const budget = document.querySelector('[data-n="n-budget"]') as HTMLElement;
  expect(waiting.contains(budget)).toBe(false);
  expect(budget.querySelector(".nt-what")?.textContent).toBe("Ada encontrou algo para resolver");
  expect(budget.querySelector(".nt-snip")?.textContent).toBe(
    "O orçamento do mês está quase no fim: Ada. Aumente na página do agente",
  );
});
