import { useMembers } from "@agenteschat/client";
import { type MemberChangesCard, memberRowDone } from "@agenteschat/client/lib/action-cards";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { router } from "@/ui/navigation";
import { OfferShell } from "./OfferShell";

/** The right hand's people card (ADR 0137 §4) as a waiting pill that opens the members screen. */
export function OfferPeople({ card }: { card: MemberChangesCard }) {
  const { t } = useTranslation();
  const { orgId } = useOrg();
  const members = useMembers(orgId);
  const names = [...new Set(card.rows.map((r) => r.name))].join(", ");
  const done = members.isSuccess && card.rows.every((r) => memberRowDone(r, members.data));
  return (
    <OfferShell
      icon="members"
      title={t("rightHand.people.title")}
      why={card.why}
      detail={names}
      done={done ? `${t("rightHand.people.done")}: ${names}` : null}
      action={t("rightHand.open.open")}
      onAction={() => router.push("/me/members" as never)}
      blocked=""
    />
  );
}
