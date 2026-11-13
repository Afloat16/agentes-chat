import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The phone's digest card as text: the component can't be rendered here, so what it must hold is read from it. */
const source = readFileSync(join(import.meta.dir, "../../src/features/ai/OfferApprovals.tsx"), "utf8");

test("the one tap approves only what the server calls routine, and the card works nothing out by itself", () => {
  expect(source).toContain('decision: "approve", only: "routine"');
  expect(source).toContain("digestGroups(");
  // The group shows on a digest only, never on a card an agent posted when asked.
  expect(source).toContain("card.digest ? digestGroups(");
  // Under each name, the agent that asked and what the call holds, as the web's card says them.
  expect(source).toContain("[dir.anyAgent(a.agentId)?.name, approvalDetail(a, i18n.language)]");
  // No risk is judged on the phone: the words that would do it never appear.
  expect(source).not.toMatch(/approvalRisk|approvalAction|highRisk/);
  // Approved, the phone says so as the conversation's "Aprovar tudo" does. A failure says its cause.
  expect(source).toContain("successHaptic()");
  expect(source).toContain('t("mobile.approval.approved")');
  expect(source).toContain("errorText(t, error, i18n.language)");
});
