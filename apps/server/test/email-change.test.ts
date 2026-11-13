import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type Browser, browser, createTestServer, lastCode, signUp, type TestServer } from "./harness";

/*
 * A new address for an account, made safe (ADR 0088 §2, addendum 2026-11-13): one door, the code sent to the current
 * address or a fresh sign-in, then the link to the new one, and "This wasn't me" for the old one.
 */

let t: TestServer;
afterEach(async () => {
  await t?.close();
});

const userOf = async (email: string) =>
  (await t.db.select().from(schema.users).where(eq(schema.users.email, email)))[0];
/** The person signed in a while ago: past the 10 minutes when a sign-in stands in for the code. */
async function signedInLongAgo(email: string) {
  const user = await userOf(email);
  await t.db
    .update(schema.sessions)
    .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
    .where(eq(schema.sessions.userId, user?.id ?? ""));
}
const change = (b: Browser, body: { newEmail: string; code?: string }) => b("/api/app/account/email", { json: body });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
/** The emails sent to `to`, oldest first. */
const mailTo = (to: string) => t.email.sent.filter((m) => m.to.includes(to));
const linkIn = (text: string, path: string) => {
  const found = new RegExp(`https?://\\S+${path}\\S*`).exec(text)?.[0] ?? "";
  const url = new URL(found);
  return `${url.pathname}${url.search}`;
};
/** Someone opens the link in the newest email to `to`: an address the link changes. */
async function openLink(b: Browser, to: string) {
  await t.drain();
  const text = mailTo(to).at(-1)?.text ?? "";
  return b(linkIn(text, "/api/auth/verify-email"), { origin: null });
}

describe("one door", () => {
  test("Better Auth's own change-email answers nothing over HTTP, however it's spelled, and update-user refuses it", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    for (const path of [
      "/api/auth/change-email",
      "/api/auth/change-email/",
      "/api/auth//change-email",
      "/api/auth/Change-Email",
      "/api/auth/change%2Demail",
      "/api/auth/./change-email",
    ]) {
      const res = await ana(path, { json: { newEmail: "thief@example.com", callbackURL: "/" } });
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    const update = await ana("/api/auth/update-user", { json: { email: "thief@example.com" } });
    expect(update.status).toBe(400);
    await t.drain();
    expect(mailTo("thief@example.com")).toEqual([]);
    expect((await userOf("ana@example.com"))?.id).toBeTruthy();
  });

  test("the address it has, or another's just left, is refused before any code goes", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const same = await change(ana, { newEmail: "ANA@example.com" });
    expect([same.status, await errorOf(same)]).toEqual([400, "email.same"]);
    const signedOut = await browser(t)("/api/app/account/email", { json: { newEmail: "x@example.com" } });
    expect(signedOut.status).toBe(401);
  });
});

describe("on a server that sends email", () => {
  test("a session that signed in a while ago gets a code at its current address, naming the new one", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    await signedInLongAgo("ana@example.com");
    const asked = await change(ana, { newEmail: "ana.nova@example.com" });
    expect(asked.status).toBe(202);
    expect(await asked.json()).toEqual({ status: "code", email: "ana@example.com", resendIn: 60 });
    await t.drain();
    const mail = mailTo("ana@example.com").find((m) => /^\d{6} /.test(m.subject));
    expect(mail?.subject).toMatch(/^\d{6} é seu código para mudar seu e-mail$/);
    // Addresses in an email carry hair spaces, so no mail client makes them links.
    expect(mail?.text.replaceAll("\u200a", "")).toContain("ana.nova@example.com");
    expect(mailTo("ana.nova@example.com")).toEqual([]);
    const code = lastCode(t);

    // Without the code, a wrong one, or the code typed for another address: nothing changes, no link goes.
    const again = await change(ana, { newEmail: "ana.nova@example.com" });
    expect([again.status, await errorOf(again)]).toEqual([429, "reauth.code_wait"]);
    const wrong = await change(ana, {
      newEmail: "ana.nova@example.com",
      code: code === "000000" ? "000001" : "000000",
    });
    expect([wrong.status, await errorOf(wrong)]).toEqual([400, "reauth.code_wrong"]);
    const other = await change(ana, { newEmail: "thief@example.com", code });
    expect([other.status, await errorOf(other)]).toEqual([400, "reauth.code_wrong"]);
    await t.drain();
    expect(mailTo("thief@example.com")).toEqual([]);

    // The code for this address: the link goes to it, in a change's words, and the address waits for it.
    const right = await change(ana, { newEmail: "ana.nova@example.com", code });
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ status: "sent", email: "ana.nova@example.com" });
    await t.drain();
    expect(mailTo("ana.nova@example.com").at(-1)?.subject).toBe("Confirme seu novo e-mail no agentes.chat");
    expect((await userOf("ana@example.com"))?.id).toBeTruthy();
    // Spent: it proves one change.
    const reused = await change(ana, { newEmail: "ana.nova@example.com", code });
    expect([reused.status, await errorOf(reused)]).toEqual([400, "reauth.code_wrong"]);

    // Opened: the same account under the new address, and the old one is told, with "This wasn't me".
    const before = await userOf("ana@example.com");
    expect((await openLink(browser(t), "ana.nova@example.com")).status).toBe(302);
    const after = await userOf("ana.nova@example.com");
    expect(after?.id).toBe(before?.id ?? "");
    expect(after?.emailVerified).toBe(true);
    await t.drain();
    const notice = mailTo("ana@example.com").at(-1);
    expect(notice?.subject).toBe("O e-mail da sua conta do agentes.chat mudou");
    expect(notice?.text).toContain("Não fui eu");
    expect(notice?.text).toMatch(/\/email-undo\?token=[\w-]{40,}/);
  });

  test("a sign-in in the last 10 minutes stands in for the code", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const sent = await change(ana, { newEmail: "ana.nova@example.com" });
    expect(await sent.json()).toEqual({ status: "sent", email: "ana.nova@example.com" });
    await t.drain();
    expect(mailTo("ana@example.com").some((m) => /^\d{6} /.test(m.subject))).toBe(false);
    expect(mailTo("ana.nova@example.com")).toHaveLength(1);
  });

  test("“This wasn't me” brings the old address back and ends every session, once, and only by its button", async () => {
    t = await createTestServer();
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    const userId = (await userOf("ana@example.com"))?.id ?? "";
    await change(ana, { newEmail: "thief@example.com" });
    await openLink(browser(t), "thief@example.com");
    await t.drain();
    const text = mailTo("ana@example.com").at(-1)?.text ?? "";
    const token = new URL(`http://x${linkIn(text, "/email-undo")}`).searchParams.get("token") ?? "";
    expect(token).not.toBe("");
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).not.toEqual([]);

    // Opening the link is the web app's page: no route acts on a GET.
    expect((await browser(t)(`/api/app/email-undo?token=${token}`)).status).toBe(404);
    const undo = await browser(t)("/api/app/email-undo", { json: { token } });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ email: "ana@example.com" });
    expect(await userOf("ana@example.com")).toMatchObject({ id: userId, emailVerified: true });
    expect(await t.db.select().from(schema.sessions).where(eq(schema.sessions.userId, userId))).toEqual([]);
    const twice = await browser(t)("/api/app/email-undo", { json: { token } });
    expect([twice.status, await errorOf(twice)]).toEqual([404, "email.undo_gone"]);
  });

  test("the old address is held while its undo works: no sign-up, no other account's change", async () => {
    t = await createTestServer({ env: { ALLOW_SIGNUP: "true" } });
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    await change(ana, { newEmail: "ana.nova@example.com" });
    await openLink(browser(t), "ana.nova@example.com");
    const someone = browser(t);
    const signUpRes = await someone("/api/auth/sign-up/email", {
      json: { email: "ana@example.com", password: "correct horse battery", name: "Someone" },
    });
    expect(signUpRes.status).toBe(403);
    expect(((await signUpRes.json()) as { code: string }).code).toBe("EMAIL_HELD");
    const bia = browser(t);
    await signUp(bia, "bia@example.com");
    const taken = await change(bia, { newEmail: "ana@example.com" });
    expect([taken.status, await errorOf(taken)]).toEqual([409, "email.held"]);
    // Not against the account that left it.
    const back = await change(ana, { newEmail: "ana@example.com" });
    expect(back.status).toBe(200);
  });

  test("“This wasn't me” takes 10 tries per 10 minutes from one address", async () => {
    t = await createTestServer();
    const b = browser(t);
    for (let i = 0; i < 10; i++) {
      const res = await b("/api/app/email-undo", { json: { token: `made-up-token-${i}-xxxxxxxx` } });
      expect(res.status).toBe(404);
    }
    const limited = await b("/api/app/email-undo", { json: { token: "made-up-token-10-xxxxxxxx" } });
    expect([limited.status, await errorOf(limited)]).toEqual([429, "rate_limited"]);
  });
});

describe("on a server that sends no email", () => {
  test("the address changes at once, as before, with no code and nobody told", async () => {
    t = await createTestServer({ emailDelivers: false, env: { ALLOW_SIGNUP: "true" } });
    const ana = browser(t);
    await signUp(ana, "ana@example.com");
    await signedInLongAgo("ana@example.com");
    const res = await change(ana, { newEmail: "ana.nova@example.com" });
    expect(await res.json()).toEqual({ status: "changed", email: "ana.nova@example.com" });
    expect((await userOf("ana.nova@example.com"))?.id).toBeTruthy();
    await t.drain();
    expect(t.email.sent).toEqual([]);

    // Another account's address: said, since nothing changed.
    const bia = browser(t);
    await signUp(bia, "bia@example.com");
    const taken = await change(bia, { newEmail: "ana.nova@example.com" });
    expect([taken.status, await errorOf(taken)]).toEqual([409, "email.taken"]);
    // An address a sign-in provider confirmed needs email to change.
    await t.db.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.email, "bia@example.com"));
    const confirmed = await change(bia, { newEmail: "bia.nova@example.com" });
    expect([confirmed.status, await errorOf(confirmed)]).toEqual([409, "email.no_mail"]);
  });
});
