import { describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, fireEvent, render, within } from "@testing-library/react";
import { FoldRow } from "../src";

describe("FoldRow", () => {
  test("one line that is a button; what it holds is out of reach until it opens, and again when it closes", async () => {
    const { container } = render(
      <FoldRow face={<i />} title="Gmail" end={<span>1 de 7 agentes</span>}>
        <span>Conectado como ana@example.com</span>
        <button type="button">Quem usa</button>
      </FoldRow>,
    );
    const row = container.querySelector(".ac-list__row.ac-foldrow") as HTMLElement;
    const head = within(row).getByRole("button", { name: /^Gmail/ });
    const fold = document.getElementById(head.getAttribute("aria-controls") ?? "") as HTMLElement;
    // The line: the face, the name, what ends it (which goes under the name in a narrow list), the chevron.
    expect([...head.children].map((c) => c.getAttribute("class"))).toEqual([
      "ac-mediarow__face",
      "ac-mediarow__head",
      "ac-mediarow__end ac-mediarow__end--wrap",
      "ac-icon ac-foldrow__chevron",
    ]);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(row.hasAttribute("data-open")).toBe(false);
    expect(fold.inert).toBe(true);
    expect(fold.getAttribute("aria-hidden")).toBe("true");
    expect(within(row).queryByRole("button", { name: "Quem usa" })).toBeNull();
    await act(async () => fireEvent.click(head));
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(row.hasAttribute("data-open")).toBe(true);
    expect(fold.inert).toBe(false);
    expect(within(row).getByRole("button", { name: "Quem usa" })).toBeTruthy();
    await act(async () => fireEvent.click(head));
    expect(fold.inert).toBe(true);
    expect(within(row).queryByRole("button", { name: "Quem usa" })).toBeNull();
  });

  test("its sheet: the fold has no height while closed, and moves only when motion is wanted", async () => {
    const css = await Bun.file(new URL("../src/styles/components.css", import.meta.url)).text();
    const body = (selector: string) => css.split(`\n${selector} {\n`)[1]?.split("\n}")[0] ?? "";
    expect(body(".ac-foldrow__fold")).toBe("  display: grid;\n  grid-template-rows: 0fr;");
    expect(body(".ac-foldrow[data-open] > .ac-foldrow__fold")).toBe("  grid-template-rows: 1fr;");
    // A padding would keep the closed fold that tall: the room under the last thing is its margin.
    expect(body(".ac-foldrow__more")).toContain("padding: 0 var(--space-4);");
    const moving = css.split(".ac-foldrow__fold {\n    transition:")[0] ?? "";
    expect(moving.slice(moving.lastIndexOf("@media"))).toStartWith("@media (prefers-reduced-motion: no-preference) {");
  });
});
