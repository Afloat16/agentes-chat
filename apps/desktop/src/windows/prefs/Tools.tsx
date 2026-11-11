import type { RunnerExecutorInfo, RunnerTools } from "@agenteschat/adapters/machine-protocol";
import type { ControlStatus } from "@agenteschat/adapters/runner-control";
import {
  BrainPortrait,
  type BrainPortraitState,
  Button,
  Chip,
  Dialog,
  DialogFooter,
  Icon,
  type IconName,
  InfoHint,
  ProviderLogo,
  Switch,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useHost, useSnapshot, useStore } from "../../app";
import { type Home, orgName, pairedHomes } from "../../control/store";
import { CLI_INSTALL, toolsHere } from "../../control/this-mac";
import { usePending } from "../../hooks";
import { CommandCopy, OrgTile } from "../../ui/bits";
import { CardTitle, hintFor, PrefCard, PrefHead, PrefRow } from "../../ui/settings";
import { useToast } from "../../ui/Toast";
import { ToolAccounts } from "./Accounts";

type Cli = keyof typeof CLI_INSTALL;

/**
 * Claude Code, Codex and the browser are for the whole computer: every organization gets the same switch. Commands
 * are each organization's own, since they reach everything the person can on this computer.
 */
export function Tools() {
  const { t } = useTranslation();
  const host = useHost();
  const store = useStore();
  const snap = useSnapshot();
  const toast = useToast();
  const homes = pairedHomes(snap);
  const { tools } = toolsHere(homes);
  const executors: ControlStatus["executors"] = homes.find((h) => h.status)?.status?.executors ?? {};
  // Turning Commands on asks first, every time: what they reach is said once more before it happens.
  const [asking, setAsking] = useState<Home | null>(null);

  // One change at a time: its switch, and the others, wait for it.
  const [pending, run] = usePending<string>();
  const set = (tool: keyof RunnerTools, on: boolean) =>
    run(tool, async () => {
      try {
        await store.requestAll({ type: "tools.set", tool, on });
      } catch {
        toast(t("desktop.common.error"), "alert");
      }
    });
  const setCommands = (home: Home, on: boolean) =>
    run(`commands:${home.homeId}`, async () => {
      try {
        await store.request(home.homeId, { type: "tools.set", tool: "commands", on });
        if (on) toast(t("desktop.prefs.tools.commandsOn"), "code");
      } catch {
        toast(t("desktop.common.error"), "alert");
      }
      setAsking(null);
    });
  const flipCommands = (home: Home, on: boolean) => (on ? setAsking(home) : void setCommands(home, false));
  // Each organization's runner keeps its own list: all look again, so each server hears of the install too.
  const checkAgain = (cli: Cli, name: string) =>
    run(`check:${cli}`, async () => {
      // An older runner doesn't know the request: its status is still read again.
      await Promise.allSettled(homes.map((h) => store.request(h.homeId, { type: "executors.check" })));
      await Promise.all(homes.map((h) => store.refresh(h.homeId)));
      const found = pairedHomes(store.getSnapshot()).some((h) => h.status?.executors?.[cli]);
      if (!found) toast(t("desktop.tools.stillMissing", { tool: name }), "alert");
    });

  const exec = (info: RunnerExecutorInfo | undefined) =>
    !info ? (
      <Chip icon="dash">{t("desktop.tools.notFound")}</Chip>
    ) : info.loggedIn === false ? (
      <Chip icon="alert" tone="waiting">
        {t("desktop.tools.loggedOut")}
      </Chip>
    ) : (
      <Chip icon="check" tone="done">
        {t("desktop.prefs.tools.connected")}
      </Chip>
    );

  /** Found and logged in: the engine at rest; not found or logged out: off. */
  const engineState = (info: RunnerExecutorInfo | undefined): BrainPortraitState =>
    info && info.loggedIn !== false ? "idle" : "off";

  const logo = (icon: IconName) => (
    <span className="dk-logo">
      <Icon name={icon} size={16} />
    </span>
  );

  const cliRow = (cli: Cli, kind: "claude_code" | "codex", name: string, desc: string) => {
    const info = executors[cli];
    const checkLabel = t("desktop.tools.checkAgain");
    return (
      <PrefRow
        lead={<BrainPortrait kind={kind} state={engineState(info)} />}
        htmlFor={`tool-${cli}`}
        title={
          <>
            <ProviderLogo id={kind} size="xs" />
            {name}
          </>
        }
        hint={hintFor(t, name, desc)}
        chip={exec(info)}
        end={
          <Switch
            id={`tool-${cli}`}
            aria-describedby={`tool-${cli}-hint`}
            checked={tools[cli] && !!info}
            disabled={!info || homes.length === 0 || pending !== null}
            onCheckedChange={(on) => void set(cli, on)}
          />
        }
        under={
          !info && (
            <>
              <CommandCopy command={CLI_INSTALL[cli]} />
              <div className="dk-ver__acts">
                <Button
                  variant="ghost"
                  size="sm"
                  icon="refresh"
                  loading={pending === `check:${cli}`}
                  disabled={pending !== null}
                  onClick={() => void checkAgain(cli, name)}
                >
                  {checkLabel}
                </Button>
                <InfoHint name={t("common.about", { label: checkLabel })}>
                  {t(host.platform === "windows" ? "desktop.tools.lookPathWindows" : "desktop.tools.lookPath")}
                </InfoHint>
              </div>
            </>
          )
        }
      />
    );
  };

  const commandsSwitch = (home: Home, id: string) => (
    <Switch
      id={id}
      aria-describedby="tool-commands-hint"
      checked={home.access?.tools.commands === true}
      disabled={!home.access || pending !== null}
      onCheckedChange={(on) => flipCommands(home, on)}
    />
  );
  // One organization: its switch on the Commands row itself. Several: a row of their own each.
  const only = homes.length === 1 ? homes[0] : undefined;

  return (
    <>
      <PrefHead title={t("desktop.prefs.tools.title")} lead={t("desktop.prefs.tools.lead")} />
      <PrefCard>
        {cliRow("claude", "claude_code", t("desktop.tools.claudeName"), t("desktop.tools.claudeDesc"))}
        {cliRow("codex", "codex", t("desktop.tools.codexName"), t("desktop.tools.codexDesc"))}
        <PrefRow
          lead={logo("code")}
          htmlFor="tool-commands"
          title={t("desktop.tools.commandsName")}
          hint={hintFor(t, t("desktop.tools.commandsName"), t("desktop.tools.commandsAbout"))}
          end={only && commandsSwitch(only, "tool-commands")}
          under={
            !only &&
            homes.map((h) => (
              <PrefRow
                key={h.homeId}
                lead={<OrgTile logo={h.logo} />}
                htmlFor={`tool-commands-${h.homeId}`}
                title={orgName(h)}
                end={commandsSwitch(h, `tool-commands-${h.homeId}`)}
              />
            ))
          }
        />
        <PrefRow
          lead={logo("globe")}
          htmlFor="tool-browser"
          title={t("desktop.tools.browserName")}
          hint={hintFor(
            t,
            t("desktop.tools.browserName"),
            t("common.joinSentences", { a: t("desktop.tools.browserDesc"), b: t("desktop.tools.browserLogins") }),
          )}
          end={
            <Switch
              id="tool-browser"
              aria-describedby="tool-browser-hint"
              checked={tools.browser === true}
              disabled={homes.length === 0 || pending !== null}
              onCheckedChange={(on) => void set("browser", on)}
            />
          }
        />
      </PrefCard>

      <ToolAccounts homes={homes} executors={executors} />

      <CardTitle>{t("desktop.prefs.tools.protection")}</CardTitle>
      <PrefCard>
        <PrefRow
          lead={logo("shield")}
          htmlFor="protected-mode"
          title={t("desktop.prefs.tools.protectedTitle")}
          hint={hintFor(t, t("desktop.prefs.tools.protectedTitle"), t("desktop.prefs.tools.protectedDesc"))}
          end={
            <Switch
              id="protected-mode"
              aria-describedby="protected-mode-hint"
              checked={false}
              disabled
              onCheckedChange={() => {}}
            />
          }
        />
      </PrefCard>

      <Dialog
        open={!!asking}
        onOpenChange={(open) => !open && pending === null && setAsking(null)}
        title={t("desktop.tools.commandsAsk", { org: asking ? orgName(asking) : "" })}
        description={t("desktop.tools.commandsReach")}
        closeLabel={t("desktop.common.close")}
        width={440}
      >
        <DialogFooter bar>
          <Button variant="ghost" disabled={pending !== null} onClick={() => setAsking(null)}>
            {t("desktop.common.cancel")}
          </Button>
          <Button variant="primary" loading={pending !== null} onClick={() => asking && void setCommands(asking, true)}>
            {t("desktop.tools.commandsTurnOn")}
          </Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}
