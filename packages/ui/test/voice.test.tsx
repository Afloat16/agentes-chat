import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { VoicePlayer, type VoicePlayerProps } from "../src/components/VoicePlayer";
import { peaksOf } from "../src/components/voice-recorder";
import { drawVoiceWave, waveAt } from "../src/components/voice-wave";

const realAudio = globalThis.Audio;
afterEach(() => {
  cleanup();
  globalThis.Audio = realAudio;
});

/** The media elements the player makes; `fail()` is a load that went wrong (a 503, a dropped connection). */
function fakeAudio(play: () => Promise<void> = () => Promise.resolve()) {
  const made: { src: string; fail: () => void }[] = [];
  globalThis.Audio = class {
    currentTime = 0;
    playbackRate = 1;
    onerror: (() => void) | null = null;
    onended: (() => void) | null = null;
    constructor(readonly src: string) {
      made.push({ src, fail: () => this.onerror?.() });
    }
    play = play;
    pause() {}
  } as unknown as typeof Audio;
  return made;
}

const labels: VoicePlayerProps["labels"] = {
  play: "Ouvir",
  pause: "Pausar",
  seek: "Posição",
  speed: (s) => `Velocidade ${s}`,
  expired: "Áudio expirado",
  showText: "Ver texto",
  hideText: "Ocultar texto",
  cantPlay: "Não deu para tocar o áudio.",
  retry: "Tentar de novo",
};
const player = (props: Partial<VoicePlayerProps> = {}) =>
  render(<VoicePlayer src="/a" peaks={[0.2, 0.8]} durationMs={12_000} labels={labels} {...props} />);

describe("VoicePlayer", () => {
  test("one line of the words under the wave, opened in place and closed again", () => {
    player({ words: "as palavras" });
    expect(screen.getByRole("button", { name: "Ver texto" }).textContent).toBe("as palavras");
    fireEvent.click(screen.getByRole("button", { name: "Ver texto" }));
    expect(screen.queryByRole("button", { name: "Ver texto" })).toBeNull();
    expect(document.querySelector(".ac-voice__words p")?.textContent).toBe("as palavras");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar texto" }));
    expect(screen.getByRole("button", { name: "Ver texto" })).toBeTruthy();
  });

  test("no words, no button", () => {
    player({ words: null });
    expect(screen.queryByRole("button", { name: "Ver texto" })).toBeNull();
  });

  test("expired: no play, no seek, says so, and the words still open", () => {
    player({ expired: true, words: "as palavras" });
    expect(screen.queryByRole("button", { name: "Ouvir" })).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(document.body.textContent).toContain("Áudio expirado");
    expect(screen.getByRole("button", { name: "Ver texto" })).toBeTruthy();
  });

  test("one that didn't load says so, and trying again loads it anew", async () => {
    const made = fakeAudio();
    player({ isGone: async () => false });
    fireEvent.click(screen.getByRole("button", { name: "Ouvir" }));
    await act(async () => made[0]?.fail());
    expect((await screen.findByRole("alert")).textContent).toContain("Não deu para tocar o áudio.");
    expect(screen.getByRole("button", { name: "Ouvir" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    // A new element: a new request, not the failed one again.
    expect(made.map((a) => a.src)).toEqual(["/a", "/a"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Pausar" })).toBeTruthy();
  });

  test("a pause before it started isn't a failure", async () => {
    fakeAudio(() => Promise.reject(Object.assign(new Error("interrupted"), { name: "AbortError" })));
    player({ isGone: async () => false });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Ouvir" })));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("peaksOf", () => {
  test("at most 48 bars, scaled to the loudest", () => {
    const peaks = peaksOf(Array.from({ length: 500 }, (_, i) => (i % 100) / 200));
    expect(peaks.length).toBe(48);
    expect(Math.max(...peaks)).toBe(1);
  });
  test("a short recording keeps what it has", () => {
    expect(peaksOf([0.1, 0.2]).length).toBe(2);
    expect(peaksOf([])).toEqual([]);
  });
});

describe("the wave's handle", () => {
  /** A canvas `width` wide whose context keeps what was drawn: each bar's left edge, width and fill, each dot. */
  function drawn(width: number, progress: number) {
    const bars: { x: number; w: number; fill: string }[] = [];
    const dots: { x: number; r: number }[] = [];
    const g = {
      fillStyle: "",
      setTransform() {},
      clearRect() {},
      beginPath() {},
      fill() {},
      roundRect(x: number, _y: number, w: number) {
        bars.push({ x, w, fill: g.fillStyle });
      },
      arc(x: number, _y: number, r: number) {
        dots.push({ x, r });
      },
    };
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { value: width });
    Object.defineProperty(canvas, "clientHeight", { value: 30 });
    canvas.getContext = (() => g) as unknown as HTMLCanvasElement["getContext"];
    canvas.getBoundingClientRect = () => ({ left: 100, width }) as DOMRect;
    // The played and unplayed tones come from the canvas's style, which this DOM doesn't cascade.
    const style = spyOn(globalThis, "getComputedStyle").mockImplementation(
      () => ({ color: "", getPropertyValue: (p: string) => (p === "--voice-on" ? "#111" : "#999") }) as never,
    );
    try {
      drawVoiceWave(canvas, [0.2, 0.9, 0.5, 0.7], { progress, handle: true });
    } finally {
      style.mockRestore();
    }
    return { canvas, bars, dots };
  }

  test("runs from the first bar's left edge at 0:00 to the last bar's end, whole on the canvas, like WhatsApp's dot", () => {
    for (const width of [200, 263, 401]) {
      const start = drawn(width, 0);
      const end = drawn(width, 1);
      const first = start.bars[0] as { x: number };
      const last = end.bars.at(-1) as { x: number; w: number };
      const [atStart] = start.dots as [{ x: number; r: number }];
      const [atEnd] = end.dots as [{ x: number; r: number }];
      expect([width, atStart.x, atEnd.x]).toEqual([width, first.x, last.x + last.w]);
      expect(atStart.x - atStart.r).toBeGreaterThanOrEqual(0);
      expect(atEnd.x + atEnd.r).toBeLessThanOrEqual(width);
      // Nothing is played at 0:00, all of it at the end.
      expect(new Set(start.bars.map((b) => b.fill)).size).toBe(1);
      expect(new Set(end.bars.map((b) => b.fill)).size).toBe(1);
      expect(start.bars[0]?.fill).not.toBe(end.bars[0]?.fill);
      // A press where the handle is goes there: 0 on the first bar's edge, 1 on the last one's end.
      expect(waveAt(start.canvas, 100 + atStart.x)).toBe(0);
      expect(waveAt(end.canvas, 100 + atEnd.x)).toBeCloseTo(1, 9);
    }
  });

  test("halfway, the handle's middle is where played bars end", () => {
    const { bars, dots } = drawn(263, 0.5);
    const dot = dots[0] as { x: number };
    const played = bars.filter((b) => b.fill === bars[0]?.fill);
    const rest = bars.slice(played.length);
    expect((played.at(-1)?.x ?? 0) + 1.5).toBeLessThanOrEqual(dot.x);
    expect((rest[0]?.x ?? 0) + 1.5).toBeGreaterThan(dot.x);
  });
});
