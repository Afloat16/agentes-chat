import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { teamWeekWhen } from "@agenteschat/client/lib/right-hand-prefs";
import { teamWeekCardOf, teamWeekRowText } from "@agenteschat/client/lib/team-week";
import { resources } from "@agenteschat/i18n";
import i18next, { type TFunction } from "i18next";

/** Lodi's weekly card on the phone (ADR 0137 §9), as on the web: the same card, stacked, and its schedule in Settings. */

const src = (f: string) => readFileSync(new URL(`../../src/features/${f}`, import.meta.url), "utf8");

const tOf = (lng: string) => {
  const instance = i18next.createInstance();
  void instance.init({ lng, fallbackLng: "en", resources, initAsync: false });
  return instance.t.bind(instance) as unknown as TFunction;
};

test("an agent's message with the week's card draws it under its words, after the settings cards", () => {
  const row = src("chat/MessageRow.tsx");
  const settings = row.indexOf("<SettingsProposals message={m} />");
  const week = row.indexOf("<TeamWeek message={m} />");
  expect(settings).toBeGreaterThan(0);
  expect(week).toBeGreaterThan(settings);
  // Its week ("Como foi a semana do time…") is the message's own text on the phone: the card doesn't repeat it.
  expect(src("right-hand/TeamWeekCard.tsx")).not.toContain('t("chat.body.team_week"');
});

test("stacked rows: every fix's button under its words, full width, and the footer's day and hour open Settings", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  expect(card).toMatch(/variant="secondary"\s+size="sm"\s+wide/);
  expect(card).toContain('t("teamWeek.applyAll", { count: bulk.length })');
  expect(card).toContain("onPress={openRightHandSettings}");
  // Approvals open the phone's own approval screen, as the approvals card does.
  expect(card).toContain("router.push(`/approval/");
});

test("Configurações › Lodi: Resumo do dia and its hour for anyone, the week's day and hour for admins", () => {
  const screen = src("right-hand/SettingsScreen.tsx");
  expect(screen).toContain("<OwnRows name={agent.name} />");
  expect(screen).toContain('can(org, "administrator")');
  expect(screen).toContain('teamWeekOn(prefs, "day", admin)');
  expect(screen).toContain("toggle={dayOn}");
  expect(screen).toContain("onPress={() => save({ dayOff: dayOn })}");
  expect(screen).toContain("{admin ? (");
  expect(screen).toContain("toggle={weekOn}");
  expect(screen).toContain("onPick={(weekHour) => save({ weekHour })}");
  expect(screen).toContain('t("teamWeek.settings.dayLabel")');
});

test("the other switches show only for a feature the server lists, the workspace's only to who configures it", () => {
  const screen = src("right-hand/SettingsScreen.tsx");
  expect(screen).toContain("const shows = (s: LodiSwitch) => prefs.switches.includes(s);");
  expect(screen).toContain(".filter((r) => shows(r.id))");
  expect(screen).toContain('can(org, "configure") && settings');
  // A workspace switch says who it is for under its name, and saves through the workspace's settings.
  expect(screen).toContain('sub={t("rightHand.settings.groupWorkspace")}');
  expect(screen).toContain("setSettings.mutate({ [r.id]: !on }, { onError: failed })");
  // Nothing takes a second press while a change is being saved.
  expect(screen).toContain("disabled={set.isPending}");
  expect(screen).toContain("disabled={setSettings.isPending}");
});

test("the card's footer says when the card it sits on comes", () => {
  const card = src("right-hand/TeamWeekCard.tsx");
  expect(card).toContain('const period = admin ? (card.period ?? "week") : "day";');
  expect(card).toContain("teamWeekOn(prefs, period, admin) ? teamWeekWhen(t, locale, prefs, period)");
});

test("the approvals and the people cards live in files of their own, drawn as the other offers", () => {
  const offer = src("ai/OfferCard.tsx");
  expect(offer).toContain('if (card.kind === "approvals") return <OfferApprovals card={card} />;');
  expect(offer).toContain('if (card.kind === "member_changes") return <OfferPeople card={card} />;');
  expect(src("ai/OfferApprovals.tsx")).toContain("<OfferShell");
  expect(src("ai/OfferPeople.tsx")).toContain("<OfferShell");
});

test("the phone reads the same card and says its rows in the person's language", () => {
  const meta = {
    actionCard: {
      kind: "team_week",
      forUserId: "u1",
      from: "2026-10-30",
      to: "2026-11-06",
      timezone: "UTC",
      stats: { done: 1, stuck: 0, waiting: 0, spentNanoUsd: 0, budgetNanoUsd: 0 },
      rows: [{ id: "u", kind: "unanswered", channelId: "c", count: 1 }],
    },
  };
  const card = teamWeekCardOf(meta);
  expect(card?.rows).toHaveLength(1);
  const t = tOf("pt-BR");
  const names = {
    agent: () => "Ada",
    handle: () => null,
    channel: () => "atendimento",
    usd: () => "US$ 0",
    join: (l: string[]) => l.join(", "),
    since: () => "",
  };
  expect(teamWeekRowText(t, "pt-BR", card?.rows[0] as never, names).line).toBe(
    "1 pergunta ficou sem resposta em #atendimento esta semana.",
  );
  expect(teamWeekWhen(tOf("en"), "en", { day: 5, weekHour: 17, dayHour: 9 }, "week")).toMatch(
    /^Every Friday at 5:00\sPM$/,
  );
  expect(teamWeekWhen(tOf("en"), "en", { day: 5, weekHour: 17, dayHour: 9 }, "day")).toMatch(/^Every day at 9:00\sAM$/);
});
