import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const go = async (state = seedState()) => {
  await renderApp(`/org/${ORG_ID}/agents/${ADA_ID}?tab=access`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(4);
};
const section = () => screen().getByRole("region", { name: "Aprovações" });
const updates = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "agents.update").map((c) => c.args[2]);

describe("Aprovações on an agent's page", () => {
  test("one line with the level in sight; its dialog's three choices are one height and a pick saves at once", async () => {
    const state = await go();
    const row = within(section()).getByRole("button", { name: /Aprovações/ });
    // An agent from a server that doesn't say asks for what is risky.
    expect(row.textContent).toBe("AprovaçõesSó o arriscado");
    await click(row);
    const dialog = screen().getByRole("dialog", { name: "Aprovações" });
    expect(dialog.textContent).toContain("Quando Ada pergunta a uma pessoa antes de agir.");
    const options = within(dialog).getAllByRole("radio");
    expect(options.map((o) => o.textContent)).toEqual([
      "Sempre perguntarPergunta antes de mudar algo em um app.",
      "Só o arriscadoPergunta antes de apagar, enviar ou pagar.",
      "Nunca perguntarAinda pergunta em merge, deploy e rollback.",
    ]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    // Nothing to confirm with: no footer, only the choices and the way out.
    expect(within(dialog).queryByRole("button", { name: /Salvar|Confirmar|Cancelar/ })).toBeNull();
    await click(options[2] as HTMLElement);
    expect(updates(state)).toEqual([{ approvalsLevel: "never" }]);
    expect(screen().queryByRole("dialog", { name: "Aprovações" })).toBeNull();
    expect(within(section()).getByRole("button", { name: /Aprovações/ }).textContent).toBe("AprovaçõesNunca perguntar");
    // Saved on its own: the page's save bar has nothing to hold.
    expect(screen().queryByRole("region", { name: "Alterações não salvas" })).toBeNull();
  });

  test("the saved level shows on the line and is the one chosen in the dialog", async () => {
    const state = seedState();
    const ada = state.agents.find((a) => a.id === ADA_ID);
    if (ada) ada.approvalsLevel = "always";
    await go(state);
    const row = within(section()).getByRole("button", { name: /Aprovações/ });
    expect(row.textContent).toBe("AprovaçõesSempre perguntar");
    await click(row);
    const dialog = screen().getByRole("dialog", { name: "Aprovações" });
    expect(
      within(dialog)
        .getByRole("radio", { name: /Sempre perguntar/ })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("who can't manage agents reads the level and opens nothing", async () => {
    const state = seedState();
    if (state.me?.organizations[0]) state.me.organizations[0].role = "member";
    await go(state);
    expect(within(section()).queryByRole("button")).toBeNull();
    expect(section().textContent).toBe("AprovaçõesSó o arriscado");
  });
});
