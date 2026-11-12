# 0173. An approvals level per agent: always ask, only what is risky, never ask

- Status: Accepted (amended 2026-11-12: `always` and `never` are absolute, see the last section, which replaces
  items 2 to 5 and the Consequences where they differ)
- Date: 2026-11-11
- Extends: ADR 0015 (Tool Gateway and approvals, "Aprovar sempre"), ADR 0053 (who is behind a run, a routine's
  bounds), ADR 0131 (autonomy brakes)
- Code: `packages/db/src/schema/agents.ts` (`approvals_level`, migration `0254_agent_approvals_level`),
  `packages/engine/src/tools/run-policy.ts` (`ApprovalsLevel`, `approvalsLevelOf`, `toolPolicy`'s third argument),
  `packages/engine/src/tools/gateway.ts` (`unaskedAtNever`, the listing and the call), `packages/engine/src/agents.ts`
  (who sets it), `packages/engine/src/agent-audit.ts` (`approvalsLevel: "never"` on a call that ran unasked),
  `packages/engine/src/git/repos.ts` (`mergeReposOfCall`), `apps/server/src/routes/app/schemas.ts`
  (`ApprovalsLevel`), `packages/client/src/lib/approvals-level.ts`, web `pages/agent/ApprovalsLevelCard.tsx`, phone
  `features/agents/ApprovalsLevelRow.tsx`

## Context

Whether a call asks a person was decided per tool: a connector's tool at the level `approval`, a tool the classifier
marks sensitive (deletes, sends, payments), merge, deploy and rollback by name (`ALWAYS_SENSITIVE`), and every write
to a connected app from a routine's run or a run its reading feeds (ADR 0053 §4 and its addendum of 2026-10-31).
"Aprovar sempre" (ADR 0015) removes one card at a time. People asked for one setting per agent: an agent that is
trusted to act alone, and an agent that asks about everything.

## Decision

Each agent has an approvals level, `agents.approvals_level`: `always`, `risky` (the default, and what every agent
did before) or `never`.

1. **`risky`** changes nothing: what is marked sensitive asks.
2. **`always`**: every write to a connected app asks (`toolKind` `external`: a connector's or a custom server's
   tool that isn't a read, a mailbox's send), on a person's run and on the agent's own. The policy answers `approve`
   for it, the answer a routine's run already gets, so the same rules follow: the tool lists as one that asks and
   takes its `why`, "Aprovar sempre" is neither offered nor read, and "Pode fazer merge sem perguntar" is off
   (`mergeReposOfCall` gives no repository), on the connector's merge and on the computer's. Reads, internal changes
   people can undo (issues, memory, Drive, its own branches) and the computer's own command policy are as before:
   they never asked through a card.
3. **`never`**: a connected app's tool that asks only because it is marked sensitive runs without a card
   (`unaskedAtNever`). It still asks for:
   - merge, deploy and rollback, and what starts them under another name or runs whatever its arguments say
     (`customAlwaysAsks`: a release, a build, a workflow, a trigger, a script, a raw request, GraphQL, SQL). This is
     the list "Aprovar sempre" never covers, read on the tool's name, its scope and the actions it runs, so the two
     can't disagree.
   - a call through a tool that runs other actions whose actions it can't read.
   - a tool with its own approvers (someone's mailbox: its owner answers for it, ADR 0038).
   - our own tools that ask (`request_approval`, `request_permission`, `send_feedback`, a workspace where every
     command asks): asking is what they do, or the workspace's own rule.
4. **Routines and outside text are not relaxed.** A routine's run, and a run nobody is behind that a routine's
   report or work woke, ask for every write to a connected app at every level, `never` included. Text nobody checked
   (inbound mail, a webhook, the web) feeds those runs, and a level set once on the agent's page is not a person
   reading that text. A routine keeps its own ways to act alone: the actions its creator allowed for its job, "Sempre
   nesta rotina" and an action approved ahead. `unaskedAtNever` refuses such a run by itself, whatever the policy
   answered for the tool.
5. **It never widens what the agent may use.** Scopes are checked first, then the level. The budget, a connector's
   tools turned off, a mailbox's recipients and From address, the team-action check and the autonomy brakes all apply
   as before. What `never` does lift is asking itself: a tool an admin set to ask, and a shared mailbox set to ask
   before a send or a delete, run without a card (a person's own mailbox still asks its owner).
6. **Who sets it.** Whoever may edit any agent (`manage_agents`), through the agent's `PATCH`, and at creation only
   with that permission. A new agent starts at `risky`. The right hand's level can be changed too.
7. **The audit says so.** A call that ran without its card because of `never` is recorded with
   `details.approvalsLevel = "never"`, and the audit's detail shows "Not asked (Never ask)" where an approval would
   be. Changing the level is an `agent.updated` row with the new value.
8. **The level is read on every listing and every call**, so narrowing it asks from the next call.

In the apps: one row, "Aprovações", on the agent's page under Ferramentas e acesso (web) and on its profile (phone),
showing the level. It opens the three choices, each a title and one line. "Nunca perguntar" says what it still asks
for. A choice saves at once.

## Consequences

- At `never` an agent deletes, sends and pays through its connected apps without a person, within its scopes. The
  audit is where a person sees it afterwards.
- A mission task's call through the bridge has no run: it follows the mission's own Autonomia, and no level moves it.
- `always` does not make internal changes or computer commands ask. A workspace that wants every command to ask has
  its own switch (sandbox settings), which the level leaves alone.
- An approval card doesn't yet say that its agent always asks. The level is on the agent's page, one tap from the
  card's agent.

## Amended 2026-11-12: always and never are absolute

People read "Sempre perguntar" and "Nunca perguntar" as always and never, and the exceptions above made both
untrue: an agent set to never ask still asked for merge, deploy, rollback, tools that run whatever their arguments
say, someone's mailbox and everything a routine wrote, and one set to always ask changed issues, files, messages
and its computer without a word. The levels now mean what they say. This replaces items 2, 3, 4 and the last
sentence of 5 above, and the Consequences where they differ.

1. **`never`: no approval card for anything the agent may already use**, on every run that has one (a person's,
   the agent's own, a routine's, one a routine's reading or outside text feeds). That covers merge, deploy and
   rollback, what starts them under another name or runs whatever its arguments say (`customAlwaysAsks`), a call
   whose actions can't be read, a tool with its own approvers (someone's mailbox), a connected app's write from a
   routine, our own sensitive tools (`run_code`, `run_skill_script` and `start_task` where every command asks,
   `desktop_do`), and a command the computer held: the computer ran nothing when it held it, so the gateway runs
   the same call again the approved way instead of asking. "Pode fazer merge sem perguntar" is not needed: the
   agent merges in any repository it may use, with the same audit line and receipt. The autonomy brakes' go-ahead
   card for costly work the agent started is skipped too.
2. **What `never` does not lift.** It lifts asking and nothing else. The policy's refusals (what a routine may
   not use), scopes, a tool turned off, the budget, a mailbox's recipients and From address, the git proxy's
   never-allowed operations, a secret read, an action a person refused ahead, a cost a person said never to and
   the hourly cap on pull requests all hold: they are limits, not questions. A mission task's call has no run and
   follows the mission's own setting, as before.
3. **What still shows a card at `never`**: only the tools whose job is asking a person, because the agent chose
   to ask: `request_approval`, `request_permission`, `send_feedback`, `request_branch_push`, the question and
   proposal cards (`ask_user`, `ask_choices`, `propose_*`, `offer_*`, `request_secret`) and `schedule_action`'s
   approval ahead.
4. **One place decides it.** `unaskedAtNever(level, tool, authority)` is read by the call, the listing (the tool
   lists without its `why` and is marked `unasked`, so no directory or prompt line says it asks), the held
   command and the brakes. The policy table still answers `approve` for a routine's write, and the gateway lifts
   the card, so a refusal in the table is never lifted with it.
5. **`always`: every call that changes something asks first, on every kind of run.** `toolPolicy` answers
   `approve` for the kinds `external`, `internal`, `elsewhere` and `unknown` (`asksAtAlways`), on a person's run,
   the agent's own, a routine's and a fed one: issues, memory, Drive, wiki, Vault, dashboards, code on its
   computer, posts and messages elsewhere, routines and reminders, tools the table doesn't know, and a click,
   typing or `browser_do` in its browser (`desktop_do` on its desktop). The brain's own shell asks too: the
   server's answer to a command that isn't a plain read is a refusal that sends it to `run_code` with its reason,
   and that call asks (`runPermissionPrompt`, `asksFirst`).
6. **What `always` leaves alone**, because asking there would be asking about asking, or would keep the run from
   ending: `pass`, `hand_off`, the run's own bookkeeping (`set_status`, `withdraw_request`, long work's tools,
   `request_approval`), what speaks in the run's own conversation (`ask_user`, `ask_choices`, the `propose_*` and
   `offer_*` cards, reactions, polls), the tools whose own card is the question (`request_secret`,
   `request_permission`, `request_settings_change`, `request_folder_access`, `send_feedback`, `propose_event`,
   `schedule_action`), a mission's tools, `update_widget` on a widget's refresh, a directory's search and
   `run_approved_action` (the tool behind them is judged), and every read: a connected app's, ours, and looking at
   a page in the browser (`browser_open`, `browser_read`, `browser_screenshot` and the like), `git_clone`
   included. `update_skill` and `update_skill_from_source` were filed as reads by their scope and are changes now.
7. **Opening a pull request never asks at `risky`**, on any run. Our `open_pull_request` already didn't. The
   GitHub connector's `create_pull_request` (the same tool when the GitHub App answers for the workspace, ADR
   0156) and a connected server's tool whose name ends in `create_pull_request` or `open_pull_request` are filed
   as the agent's own code work (`opensPullRequest`), so a routine's run and a fed one no longer get the card
   that read "vai abrir PR". A merge is another tool and follows the level: it asks at `risky` and `always`, not
   at `never`. At `always` opening a pull request asks like any other change.
8. **The audit** marks a call with `details.approvalsLevel = "never"` only when it would have asked: the policy
   said `approve`, the tool is marked sensitive, the call said why, or the computer held its command.
9. **What the agent is told** follows the level: the prompt's line on approvals, a routine's brief and what a
   routine's own actions cover say that nothing waits (`never`) or that every change does (`always`).

Consequences of the amendment:

- At `never` a routine acts on text nobody checked (inbound mail, a webhook, the web) without a person. That is
  the choice the level's line states: "Never asks, merge, deploy, payments and routines included."
- At `always` an agent that works on its computer opens a card per command that changes something. Plain reads
  run. A workspace's "every command asks" switch (sandbox settings) is no longer the only way to get that.
- Not covered at `always`, because the computer decides them before the server hears of them: an edit a computer
  brain makes to a file inside its own folders, and a push alone to the agent's own branch. Making those ask
  needs the level in what the runner is told for a turn.
- Other screens still say that sensitive actions "always ask for approval". For an agent set to never ask that is
  no longer so.
