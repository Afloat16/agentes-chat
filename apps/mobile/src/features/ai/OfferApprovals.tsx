import { useApprovals, useDecideApprovals } from "@agenteschat/client";
import type { ApprovalsCard } from "@agenteschat/client/lib/action-cards";
import { digestGroups } from "@agenteschat/client/lib/approval-card";
import { approvalDetail } from "@agenteschat/client/lib/approval-words";
import { errorText } from "@agenteschat/client/lib/errors";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { EventPillAction, EventPillText, Text, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { approvalTitleText } from "../approvals/parts";
import { AskWaiting } from "../chat/asks";
import { parseInline } from "../chat/logic";
import { Spans } from "../chat/MessageSpans";
import { useDirectory } from "../shared/hooks";
import { successHaptic } from "../shared/parts";
import { OfferShell } from "./OfferShell";

/**
 * The right hand's approvals card (ADR 0137 §4) as a waiting pill that opens the next one still waiting. Its digest
 * (ADR 0177 §4), while the server calls two or more of them routine: each by name, with the agent that asked and what
 * it holds under it as on the web (two requests of one kind never read the same), one action that approves them all as
 * whoever taps (the server decides only the ones it still calls routine), and the way to read each.
 */
export function OfferApprovals({ card }: { card: ApprovalsCard }) {
  const { t, i18n } = useTranslation();
  const { orgId } = useOrg();
  const toast = useToast();
  const dir = useDirectory();
  const approvals = useApprovals(orgId);
  const decide = useDecideApprovals(orgId);
  const rows = card.approvalIds.map((id) => approvals.data?.find((a) => a.id === id));
  const routine = card.digest ? digestGroups(rows.flatMap((a) => a ?? [])).routine : [];
  const next = rows.find((a) => a?.status === "pending");
  const open = () => router.push(`/approval/${next?.id ?? ""}` as never);
  if (routine.length > 0) {
    const count = routine.length;
    return (
      <AskWaiting
        forMe
        mark="shield"
        words={t("rightHand.digest.routine", { count })}
        actions={
          <>
            <EventPillAction
              primary
              label={t("rightHand.digest.approve", { count })}
              loading={decide.isPending}
              onPress={() =>
                decide.mutate(
                  { ids: routine.map((a) => a.id), decision: "approve", only: "routine" },
                  {
                    // The same answer as the conversation's "Aprovar tudo". The agents are several: no name under it.
                    onSuccess: () => {
                      successHaptic();
                      toast({ title: t("mobile.approval.approved") });
                    },
                    onError: (error) => toast({ title: errorText(t, error, i18n.language), icon: "x" }),
                  },
                )
              }
            />
            <EventPillAction label={t("rightHand.digest.each")} disabled={decide.isPending} onPress={open} />
          </>
        }
        below={
          <EventPillText>
            <View style={styles.items}>
              {routine.map((a) => {
                const under = [dir.anyAgent(a.agentId)?.name, approvalDetail(a, i18n.language)]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <View key={a.id}>
                    <Text variant="footnote">{approvalTitleText(t, a)}</Text>
                    {under ? (
                      <Text variant="footnote" tone="muted">
                        <Spans inline={parseInline(under)} />
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
            <Text variant="footnote" tone="muted">
              {t("rightHand.digest.help")}
            </Text>
          </EventPillText>
        }
      />
    );
  }
  const titles = rows
    .map((a) => a?.title)
    .filter(Boolean)
    .join(", ");
  return (
    <OfferShell
      icon="shield"
      title={t("rightHand.approvals.title")}
      why={card.why}
      detail={titles}
      done={approvals.isSuccess && !next ? `${t("rightHand.approvals.done")}: ${titles}` : null}
      action={next ? t("rightHand.open.open") : null}
      onAction={open}
      blocked=""
    />
  );
}

const styles = StyleSheet.create({
  // Each request and its line read as one, apart from the next.
  items: { gap: 4 },
});
