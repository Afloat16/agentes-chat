import type { Message } from "@agenteschat/client";
import { CardVia, useApproval, useApprovals, useMembers } from "@agenteschat/client";
import type { ApprovalsCard } from "@agenteschat/client/lib/action-cards";
import { useTranslation } from "react-i18next";
import { ApprovalAsk } from "@/components/ApprovalAsk";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { inlineWords } from "@/lib/markdown";

/**
 * The right hand's approvals card (`offer_approvals`, ADR 0137 §4): each approval as the conversation shows it, with its
 * own buttons, holds and confirmations, decided as whoever clicks (audited via the right hand); decided, its one line.
 */
export function ApprovalsCardView({ message, card }: { message: Message; card: ApprovalsCard }) {
  const { t } = useTranslation();
  return (
    <CardVia messageId={message.id}>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset */}
      <div className="rh-cards" role="group" aria-label={t("rightHand.approvals.title")}>
        {card.why && <p>{inlineWords(card.why)}</p>}
        {card.approvalIds.map((id) => (
          <CardApproval key={id} id={id} />
        ))}
      </div>
    </CardVia>
  );
}

export function CardApproval({ id }: { id: string }) {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const list = useApprovals(org.id);
  const listed = list.data?.find((a) => a.id === id);
  const one = useApproval(org.id, id, !listed && list.isSuccess);
  const people = useMembers(org.id).data;
  const members = new Map((people ?? []).map((m) => [m.userId, m]));
  const approval = listed ?? one.data;
  if (!approval) return null;
  const agent = dir.anyAgent(approval.agentId);
  return <ApprovalAsk approval={approval} agent={agent} members={members} />;
}
