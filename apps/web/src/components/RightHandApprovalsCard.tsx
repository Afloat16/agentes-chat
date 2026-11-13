import type { Approval, Message } from "@agenteschat/client";
import { CardVia, useApproval, useApprovals, useDecideApprovals, useMembers } from "@agenteschat/client";
import type { ApprovalsCard } from "@agenteschat/client/lib/action-cards";
import { digestGroups } from "@agenteschat/client/lib/approval-card";
import { approvalDetail, approvalTitle } from "@agenteschat/client/lib/approval-words";
import { Button, HintLine } from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApprovalAsk } from "@/components/ApprovalAsk";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { inlineWords } from "@/lib/markdown";
import { ConnectorMark } from "@/pages/ApprovalsPage";
import { RequestCard } from "./RequestCard";

/**
 * The right hand's approvals card (`offer_approvals`, ADR 0137 §4): each approval as the conversation shows it, with its
 * own buttons, holds and confirmations, decided as whoever clicks (audited via the right hand); decided, its one line.
 * Its digest (ADR 0177 §4) puts the ones the server calls routine together first, with one button for all of them.
 */
export function ApprovalsCardView({ message, card }: { message: Message; card: ApprovalsCard }) {
  const { t } = useTranslation();
  return (
    <CardVia messageId={message.id}>
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group inside a message, not a fieldset */}
      <div className="rh-cards" role="group" aria-label={t("rightHand.approvals.title")}>
        {card.why && <p>{inlineWords(card.why)}</p>}
        {card.digest ? (
          <Digest id={message.id} approvalIds={card.approvalIds} />
        ) : (
          card.approvalIds.map((id) => <CardApproval key={id} id={id} />)
        )}
      </div>
    </CardVia>
  );
}

/** A digest's approvals: the routine ones as one request with one button, then every other on its own card. */
function Digest({ id, approvalIds }: { id: string; approvalIds: string[] }) {
  const { org } = useOrg();
  const list = useApprovals(org.id).data;
  // The person asked to read them one by one: the group is gone for as long as the card stays on screen.
  const [each, setEach] = useState(false);
  const items = approvalIds.flatMap((approvalId) => list?.find((a) => a.id === approvalId) ?? []);
  const routine = each ? [] : digestGroups(items).routine;
  const grouped = new Set(routine.map((a) => a.id));
  return (
    <>
      {routine.length > 0 && <RoutineGroup id={id} routine={routine} onEach={() => setEach(true)} />}
      {approvalIds.map((approvalId) =>
        grouped.has(approvalId) ? null : <CardApproval key={approvalId} id={approvalId} />,
      )}
    </>
  );
}

/**
 * The routine requests of a digest as one request: what each is, one button that approves them all as whoever clicks,
 * and the way to read them one by one. The server decides only the ones it still calls routine (`only`).
 */
function RoutineGroup({ id, routine, onEach }: { id: string; routine: Approval[]; onEach: () => void }) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const decide = useDecideApprovals(org.id);
  const count = routine.length;
  const title = t("rightHand.digest.routine", { count });
  return (
    <RequestCard
      id={`digest-${id}`}
      kind="approval"
      agent={undefined}
      label={title}
      mine
      lead={
        <HintLine name={t("common.about", { label: title })} hint={t("rightHand.digest.help")}>
          {title}
        </HintLine>
      }
      what={title}
      locked={decide.isPending}
      body={
        <ul className="rq__items">
          {routine.map((a) => {
            const under = [dir.anyAgent(a.agentId)?.name, approvalDetail(a, i18n.language)].filter(Boolean).join(" · ");
            return (
              <li key={a.id} className="rq__item">
                <div className="rq__well">
                  <span className="rq__logo">
                    <ConnectorMark approval={a} />
                  </span>
                  <span className="rq__wt">
                    <b>{approvalTitle(t, a)}</b>
                    {under && <small>{inlineWords(under, "dg")}</small>}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      }
      actions={
        <>
          <Button
            variant="primary"
            size="sm"
            icon="check"
            disabled={decide.isPending}
            loading={decide.isPending}
            onClick={() => decide.mutate({ ids: routine.map((a) => a.id), decision: "approve", only: "routine" })}
          >
            {t("rightHand.digest.approve", { count })}
          </Button>
          <Button size="sm" disabled={decide.isPending} onClick={onEach}>
            {t("rightHand.digest.each")}
          </Button>
        </>
      }
    />
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
