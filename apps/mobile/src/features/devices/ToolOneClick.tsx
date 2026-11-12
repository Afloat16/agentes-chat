import type { Machine, MachineTool, Message } from "@agenteschat/client";
import { useAllowMachineTool, useMachines } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { firstName } from "@agenteschat/client/lib/format";
import { brainUnavailableOf, waitToolOff } from "@agenteschat/client/lib/machine-outages";
import { type ToolOneClick, toolOneClick, toolWords } from "@agenteschat/client/lib/machines";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, Text, useToast } from "@/ui";
import { useMeId, useOrgId } from "../shared/hooks";

/**
 * The phone's one way out where a tool is off on a computer, as the web's (ADR 0036 §8): its owner turns it on here,
 * anyone else asks them, an app too old says to update it; nothing where nobody can. Several tools: one ask for all.
 */
export function ToolOneClickButton({
  machineId,
  machineName,
  oneClick,
  tool,
  label,
  onAllowed,
}: {
  machineId: string;
  machineName: string;
  oneClick: ToolOneClick | null;
  tool: MachineTool | readonly MachineTool[];
  label?: string;
  onAllowed?: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const allow = useAllowMachineTool(useOrgId());
  if (!oneClick) return null;
  if (oneClick.kind === "outdated")
    return (
      <Text variant="caption" tone="muted">
        {t("machines.oneClick.outdated", { machine: machineName })}
      </Text>
    );
  const fail = (err: unknown) => toast({ title: errorText(t, err), icon: "x" });
  const tools: readonly MachineTool[] = typeof tool === "string" ? [tool] : tool;
  if (oneClick.kind === "ask") {
    const name = firstName(oneClick.ownerName);
    return (
      <Button
        variant="secondary"
        size="sm"
        label={t("machines.oneClick.ask", { name })}
        loading={allow.isPending}
        onPress={() =>
          Promise.all(tools.map((x) => allow.mutateAsync({ machineId, tool: x, ask: true }))).then(
            () => toast({ title: t("machines.oneClick.asked", { name }) }),
            fail,
          )
        }
      />
    );
  }
  return (
    <Button
      variant="primary"
      size="sm"
      label={label ?? t("machines.oneClick.allow", { tool: toolWords(t, tools[0] as MachineTool) })}
      loading={allow.isPending}
      onPress={() =>
        allow.mutate(
          { machineId, tool: tools[0] as MachineTool },
          {
            onSuccess: () =>
              onAllowed ? onAllowed() : toast({ title: t("machines.oneClick.done", { machine: machineName }) }),
            onError: fail,
          },
        )
      }
    />
  );
}

/** Under an agent's note that waits for a switch on its computer (its CLI or commands off): the one click, until on. */
export function WaitToolOffAction({ message }: { message: Pick<Message, "meta"> }) {
  const off = waitToolOff(brainUnavailableOf(message.meta));
  const machine = useMachines(useOrgId(), Boolean(off)).data?.find((m) => m.id === off?.machineId);
  if (!off || !machine || machine.access?.tools[off.tool] === true) return null;
  return (
    <View style={styles.wait}>
      <MachineToolButton machine={machine} tool={off.tool} />
    </View>
  );
}

const styles = StyleSheet.create({ wait: { flexDirection: "row", marginTop: 6 } });

/** The same for a computer the screen already has. */
export function MachineToolButton({
  machine,
  tool,
  label,
  onAllowed,
}: {
  machine: Machine;
  tool: MachineTool | readonly MachineTool[];
  label?: string;
  onAllowed?: () => void;
}) {
  const meId = useMeId();
  return (
    <ToolOneClickButton
      machineId={machine.id}
      machineName={machine.name}
      oneClick={toolOneClick(machine, meId)}
      tool={tool}
      {...(label ? { label } : {})}
      {...(onAllowed ? { onAllowed } : {})}
    />
  );
}
