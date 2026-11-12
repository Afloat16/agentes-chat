import { type AgentAction, type Message, useApi } from "@agenteschat/client";
import { actionCardOf } from "@agenteschat/client/lib/action-cards";
import {
  hookToCopy,
  type ReceiptRow,
  receiptLines,
  receiptPieces,
  receiptRows,
  routineOwnActions,
  rowFiles,
} from "@agenteschat/client/lib/actions";
import { ownActionName } from "@agenteschat/client/lib/approval-words";
import { joinNames } from "@agenteschat/client/lib/format";
import { handedTasksOf } from "@agenteschat/client/lib/issues";
import { can } from "@agenteschat/client/lib/permissions";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, LayoutAnimationConfig } from "react-native-reanimated";
import { useOrg } from "@/providers/org";
import { CARD_PAD, Card, LineIcon, Text, useReducedMotion, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { agoOf } from "../agents/logic";
import { agoText } from "../agents/work";
import { useColors, useDirectory, useMeId, useOrgId } from "../shared/hooks";
import { SheetTitle } from "../shared/PromptForm";
import { copyText, tapHaptic } from "../shared/parts";
import { useSheetIfAny } from "../shared/SheetHost";
import { groupStart, receiptIcon, receiptLayout, targetHref } from "./actions";
import { useCardTop } from "./look";

/**
 * What the agent changed with this reply (ADR 0037 round 2), on the card of the reply's tools (a hairline, the cut
 * corner): one change is a row (A); two or more are a group with "N mudanças · há X" and a row each, those of one kind
 * said once ("Criei as tarefas #58, #59 e #60") (B). Every row and every line under it is one line, cut with "…". The
 * bold part of a sentence opens the thing itself, where it is fixed or removed; a tap on the rest of its words lists
 * each change whole in a sheet. One undone elsewhere stays as history: struck through, with "Desfeito por …".
 */
export function Receipts({ message: m }: { message: Message }) {
  const { t } = useTranslation();
  const c = useColors();
  const meId = useMeId();
  const dir = useDirectory();
  const sheet = useSheetIfAny();
  // A task the right hand handed on is its chip (`HandedTaskChips`): its agent is at work on it already.
  const handed = new Set(handedTasksOf(m.meta).map((h) => h.issueId));
  // A workspace change's card says what was applied and has its own Undo.
  const onCard = actionCardOf(m.meta)?.kind === "workspace_action";
  const list = (m.actions ?? []).filter(
    (a) => !(a.kind === "issue.created" && handed.has(a.target.id)) && !(onCard && a.kind === "workspace.changed"),
  );
  const layout = receiptLayout(list);
  // A card under the message's words: the body's card gap above it, as every card in a message.
  const cardTop = useCardTop();
  if (layout === "none") return null;
  const rows = receiptRows(list, t, meId ?? undefined);
  const title = t("agentActions.group", { name: dir.nameOf(m.author) });
  const row = (r: ReceiptRow, size: "one" | "item") => {
    const a = r.actions[0] as AgentAction;
    const files = rowFiles(r);
    const whole = sheet
      ? () => {
          tapHaptic();
          sheet.open(<ChangesSheet row={r} channelId={m.channelId} title={title} close={sheet.close} />);
        }
      : undefined;
    return (
      <View style={styles.grow}>
        <Sentence row={r} channelId={m.channelId} struck={Boolean(a.undoneAt)} size={size} whole={whole} />
        {files.length > 0 ? (
          <Text variant="caption" tone="faint" numberOfLines={1} style={styles.under}>
            {t("agentActions.issue.files", { names: joinNames(files, t) })}
          </Text>
        ) : null}
        <OwnActions action={a} />
        {a.undoneAt ? <UndoneBy action={a} /> : r.refs ? null : <CopyHook action={a} />}
      </View>
    );
  };
  const start = groupStart(list);
  // What changes while it shows (undone from somewhere else) fades in; what is there when it mounts just shows.
  return (
    <View style={cardTop}>
      <LayoutAnimationConfig skipEntering>
        {layout === "one" ? (
          <View style={[styles.one, styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
            <LineIcon name={receiptIcon((list[0] as AgentAction).kind)} size={15} color={c.muted} variant="small" />
            {row(rows[0] as ReceiptRow, "one")}
          </View>
        ) : (
          <View style={[styles.group, styles.card, { backgroundColor: c.raised, borderColor: c.line2 }]}>
            <View style={styles.hd}>
              <Text variant="small" tone="muted" style={styles.grow}>
                <Text variant="small" tone="ink" style={styles.bold}>
                  {t("agentActions.changes", { count: list.length })}
                </Text>
                {start ? ` · ${agoText(t, agoOf(start))}` : ""}
              </Text>
            </View>
            {rows.map((r) => (
              <View key={r.actions[0]?.id} style={[styles.it, { borderTopColor: c.line2 }]}>
                <LineIcon
                  name={receiptIcon((r.actions[0] as AgentAction).kind)}
                  size={13}
                  color={c.muted}
                  variant="footnote"
                />
                {row(r, "item")}
              </View>
            ))}
          </View>
        )}
      </LayoutAnimationConfig>
    </View>
  );
}

/**
 * The sentence, one line ("Criei a tarefa **#23** · …"): its bold parts open their own thing when the phone has its
 * screen ("Criei as tarefas **#58**, **#59**"); a tap on the rest of its words lists each change whole (`whole`).
 */
function Sentence({
  row,
  channelId,
  struck,
  size,
  whole,
}: {
  row: ReceiptRow;
  channelId: string;
  struck: boolean;
  size: "one" | "item";
  whole?: () => void;
}) {
  const { t } = useTranslation();
  const meId = useMeId();
  const variant = size === "one" ? "small" : "footnote";
  return (
    <Text
      variant={variant}
      tone={struck ? "faint" : "ink2"}
      style={struck && styles.struck}
      numberOfLines={1}
      onPress={whole}
      accessibilityRole={whole ? "button" : undefined}
      suppressHighlighting
    >
      {receiptPieces(row, t, meId ?? undefined).map((p, i) => {
        if (!p.bold) return p.text;
        const href = p.opens ? targetHref(p.opens.target, channelId) : null;
        return (
          <Text
            key={String(i)}
            variant={variant}
            tone={struck ? "faint" : "ink"}
            style={styles.bold}
            onPress={href ? () => router.push(href) : undefined}
            accessibilityRole={href ? "link" : undefined}
            suppressHighlighting
          >
            {p.text}
          </Text>
        );
      })}
    </Text>
  );
}

/** A row's changes whole, one a line, each opening its own thing where the phone has it (no tip on a phone). */
function ChangesSheet({
  row,
  channelId,
  title,
  close,
}: {
  row: ReceiptRow;
  channelId: string;
  title: string;
  close: (then?: unknown) => void;
}) {
  const { t } = useTranslation();
  const meId = useMeId();
  const c = useColors();
  return (
    <>
      <SheetTitle title={title} />
      <Card>
        {receiptLines(row, t, meId ?? undefined).map((l, i) => {
          const href = targetHref(l.action.target, channelId);
          const body = (pressed: boolean) => (
            <View
              style={[
                styles.change,
                i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line2 },
                pressed && { backgroundColor: c.plate },
              ]}
            >
              <LineIcon name={receiptIcon(l.action.kind)} size={15} color={c.muted} />
              <View style={styles.grow}>
                <Text variant="body" tone={href ? "ink" : "ink2"}>
                  {l.text}
                </Text>
                {l.files ? (
                  <Text variant="small" tone="muted">
                    {l.files}
                  </Text>
                ) : null}
              </View>
              {href ? <LineIcon name="right" size={15} color={c.faint} /> : null}
            </View>
          );
          if (!href) return <View key={l.action.id}>{body(false)}</View>;
          return (
            <Pressable
              key={l.action.id}
              onPress={() => close(() => router.push(href))}
              accessibilityRole="link"
              accessibilityLabel={l.files ? `${l.text}, ${l.files}` : l.text}
            >
              {({ pressed }) => body(pressed)}
            </Pressable>
          );
        })}
      </Card>
    </>
  );
}

/**
 * A webhook routine the agent just made: its address, kept out of the message text, copied from here by who may
 * manage the routine (the person who asked, admins; the server checks again).
 */
function CopyHook({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const api = useApi();
  const orgId = useOrgId();
  const meId = useMeId();
  const manages = can(useOrg().org, "manage_routines");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const routineId = hookToCopy(a, { userId: meId, managesRoutines: manages });
  if (!routineId) return null;
  const copy = async () => {
    tapHaptic();
    setBusy(true);
    try {
      const hook = await api.routines.hook(orgId, routineId);
      const ok = await copyText(hook.url);
      toast({ title: t(ok ? "routines.webhookCopied" : "agentActions.errors.generic"), icon: ok ? "check" : "x" });
    } catch {
      toast({ title: t("agentActions.errors.generic"), icon: "x" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Pressable
      onPress={() => void copy()}
      disabled={busy}
      accessibilityRole="button"
      hitSlop={12}
      style={({ pressed }) => [styles.copyHook, pressed && styles.pressed]}
    >
      <Text variant="footnote" tone="ink" style={styles.bold}>
        {t("agentActions.copyWebhook")}
      </Text>
    </Pressable>
  );
}

/** Under a created routine: what it does in connected apps without asking. */
function OwnActions({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const own = routineOwnActions(a);
  if (own.length === 0) return null;
  return (
    <Text variant="caption" tone="faint" numberOfLines={1} style={styles.under}>
      {t("agentActions.routine.ownActions", {
        actions: joinNames(
          own.map((name) => ownActionName(t, name)),
          t,
        ),
      })}
    </Text>
  );
}

/** "Desfeito por você" / "Desfeito por Ana". */
function UndoneBy({ action: a }: { action: AgentAction }) {
  const { t } = useTranslation();
  const meId = useMeId();
  const dir = useDirectory();
  const name =
    a.undoneByUserId && a.undoneByUserId === meId
      ? t("agentActions.you")
      : dir.nameOf({ type: "user", id: a.undoneByUserId }) || t("mobile.chat.someone");
  const reduced = useReducedMotion();
  return (
    <Animated.View entering={reduced ? undefined : FadeIn.duration(160)}>
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.under}>
        {t("agentActions.undoneBy", { name })}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  // The tool block's card (ToolCalls.tsx): a hairline and the cut corner, bottom left.
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    borderBottomRightRadius: 14,
    borderBottomLeftRadius: 6,
  },
  // The icon on the sentence's line (as the conversation's event lines): a list row's 12 above and below, one line 44.
  one: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingVertical: 12, paddingHorizontal: 12 },
  pressed: { opacity: 0.6 },
  under: { marginTop: 2 },
  copyHook: { alignSelf: "flex-start", marginTop: 6, paddingVertical: 2 },
  group: { overflow: "hidden" },
  // A change in the sheet, a list row's room: its words wrap whole there.
  change: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: CARD_PAD, paddingVertical: 14 },
  hd: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 12 },
  it: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
