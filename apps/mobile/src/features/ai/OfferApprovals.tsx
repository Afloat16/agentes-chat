import { useApprovals } from "@agenteschat/client";
import type { ApprovalsCard } from "@agenteschat/client/lib/action-cards";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { router } from "@/ui/navigation";
import { OfferShell } from "./OfferShell";

/** The right hand's approvals card (ADR 0137 §4) as a waiting pill that opens the next one still waiting. */
export function OfferApprovals({ card }: { card: ApprovalsCard }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const approvals = useApprovals(orgId);
  const rows = card.approvalIds.map((id) => approvals.data?.find((a) => a.id === id));
  const next = rows.find((a) => a?.status === "pending");
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
      onAction={() => router.push(`/approval/${next?.id ?? ""}` as never)}
      blocked=""
    />
  );
}
