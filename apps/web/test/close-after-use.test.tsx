import { afterEach, expect, jest, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useRef, useState } from "react";
import { useCloseAfterUse } from "@/hooks/useCloseAfterUse";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

/** The channel's greeting in miniature: a band with its ×, and the page around it. */
function Band() {
  const box = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(true);
  useCloseAfterUse(box, () => setOpen(false), 8_000, open);
  return (
    <div>
      <button type="button">Enviar</button>
      {open && (
        <section ref={box} aria-label="Resumo">
          <button type="button">Fechar</button>
        </section>
      )}
    </div>
  );
}

const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms));

test("it closes 8 s after the first press elsewhere: never before the person does anything, never under the pointer", async () => {
  jest.useFakeTimers();
  const view = render(<Band />);
  const band = () => view.queryByRole("region", { name: "Resumo" });
  await wait(60_000);
  expect(band()).not.toBeNull();
  // Pressing on it is reading it, not moving on.
  fireEvent.pointerDown(view.getByRole("button", { name: "Fechar" }));
  await wait(8_000);
  expect(band()).not.toBeNull();
  fireEvent.keyDown(view.getByRole("button", { name: "Enviar" }), { key: "Enter" });
  await wait(7_900);
  expect(band()).not.toBeNull();
  // The pointer resting on it when the time comes: it stays until the pointer leaves.
  fireEvent.pointerEnter(band() as HTMLElement);
  await wait(5_000);
  expect(band()).not.toBeNull();
  await act(async () => void fireEvent.pointerLeave(band() as HTMLElement));
  expect(band()).toBeNull();
});

test("the focus inside it when the time comes keeps it until the focus goes elsewhere", async () => {
  jest.useFakeTimers();
  const view = render(<Band />);
  const band = () => view.queryByRole("region", { name: "Resumo" });
  const shut = view.getByRole("button", { name: "Fechar" });
  const send = view.getByRole("button", { name: "Enviar" });
  fireEvent.wheel(send);
  shut.focus();
  await wait(8_000);
  expect(band()).not.toBeNull();
  await act(async () => {
    send.focus();
    fireEvent.focusOut(shut, { relatedTarget: send });
  });
  expect(band()).toBeNull();
});
