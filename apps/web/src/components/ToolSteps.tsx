import { type MachineAccess, useMachines } from "@agenteschat/client";
import { allowsInApp, toolOnCommand } from "@agenteschat/client/lib/machines";
import { Icon, LogoMark } from "@agenteschat/ui";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CommandBlock } from "@/components/machine-bits";
import { useOrg } from "@/components/org-context";
import { OpenPrefsButton, useIsThisMac } from "@/components/ThisMac";
import "@/components/browser/browser.css";

/**
 * The steps card's head: the computer on the title's first line, then Esperando with its loader, under the title from
 * its words' edge when the row has no room for both.
 */
function StepsHead({ title }: { title: string }) {
  const { t } = useTranslation();
  return (
    <div className="brw-steps__head ac-iconline">
      <Icon name="computer" size={16} />
      <span className="brw-steps__headline">
        <b>{title}</b>
        <span className="brw-steps__wait" role="status">
          <Icon name="spinner" size={14} />
          {t("agentPage.work.steps.waiting")}
        </span>
      </span>
    </div>
  );
}

/**
 * What turns one of a computer's tools on, there (the browser, or the program a plan thinks with); the page notices by
 * itself, since the computer's switches come back as its own event. The app's three clicks, drawn small; on a Linux
 * computer, which may be a server without the app, the command. In the agentes.chat app on this very computer: one
 * button to Preferences → Tools instead (ADR 0036). `name`: the tool as its switch names it there ("Claude Code");
 * none for the browser, which has its own words.
 */
export function ToolSteps({
  computer,
  machineId,
  tool,
  name,
}: {
  computer: string;
  machineId: string | undefined;
  tool: keyof MachineAccess["tools"];
  name?: string;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const here = useIsThisMac(org.id, machineId ?? "");
  const row = useMachines(org.id).data?.find((m) => m.id === machineId);
  if (here) {
    const title = name ? t("machines.thisMac.toolTitle", { tool: name }) : t("machines.thisMac.browserTitle");
    return (
      <section className="brw-steps" aria-label={title}>
        <StepsHead title={title} />
        <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span className="small muted" style={{ flex: 1, minWidth: 200 }}>
            {t("machines.thisMac.browserText")}
          </span>
          <OpenPrefsButton tab="tools">{t("machines.thisMac.openTools")}</OpenPrefsButton>
        </div>
      </section>
    );
  }
  const step = (n: number, shot: ReactNode, text: string) => (
    <div className="brw-step">
      <div className="brw-step__shot" aria-hidden="true">
        {shot}
      </div>
      <p>
        <i>{n}</i>
        {text}
      </p>
    </div>
  );
  const bar = (hit?: boolean) => (
    <div className="brw-mbar">
      <span />
      <span />
      <span className="brw-mbar__me" data-hit={hit || undefined}>
        <LogoMark size={12} />
      </span>
      <b>14:32</b>
    </div>
  );
  // The Tools tab as the app draws it: the switch to flip is the one lit, the others already on.
  const switches = [
    { label: name ?? "Claude Code", flip: name !== undefined },
    { label: t("agentPage.work.steps.commands"), flip: false },
    { label: t("agentPage.work.computer.browser"), flip: name === undefined },
  ];
  return (
    <section className="brw-steps" aria-label={t("agentPage.work.steps.title", { computer })}>
      <StepsHead title={t("agentPage.work.steps.title", { computer })} />
      {row && !allowsInApp(row.os) ? (
        <div className="stack-4" style={{ gap: 6 }}>
          {!name && <span className="small">{t("browser.machine.offHelp")}</span>}
          <span className="small muted">{t("machines.access.grantTerminal")}</span>
          <CommandBlock command={toolOnCommand(row, tool)} />
        </div>
      ) : (
        <div className="brw-steps__grid">
          {step(1, bar(true), t("agentPage.work.steps.one"))}
          {step(
            2,
            <>
              {bar()}
              <div className="brw-mmenu">
                <span>{t("agentPage.work.steps.menuOpen")}</span>
                <hr />
                <span data-hl>{t("agentPage.work.steps.menuPrefs")}</span>
                <span>{t("agentPage.work.steps.menuPause")}</span>
                <hr />
                <span>{t("agentPage.work.steps.menuQuit")}</span>
              </div>
            </>,
            t("agentPage.work.steps.two"),
          )}
          {step(
            3,
            <div className="brw-mwin">
              <div className="brw-mwin__bar">{t("agentPage.work.steps.tools")}</div>
              {switches.map((s) => (
                <div key={s.label} className="brw-mwin__row" data-hl={s.flip || undefined}>
                  {s.label} <i {...(s.flip ? { "data-flip": true } : { "data-on": true })} />
                </div>
              ))}
            </div>,
            name ? t("agentPage.work.steps.turnOn", { tool: name }) : t("agentPage.work.steps.three"),
          )}
        </div>
      )}
      <p className="brw-steps__done ac-iconline">
        <Icon name="check" size={14} />
        {t("agentPage.work.steps.done")}
      </p>
    </section>
  );
}
