# 0177. Lodi acts first

- Status: Proposed
- Date: 2026-11-13
- Amends: ADR 0137 (§2: it posts nothing unless someone writes to it, with one exception, §9), ADR 0172 (what waits on
  a person)

## Context

The right hand answered when asked and posted one card by itself: "Semana da equipe", for admins, plus the same card
every day for whoever asked for it. Everything else that goes wrong in a workspace waited for a person to notice: an
AI sign-in that ended, approvals piling up, a task handed over that never came back, a person who joined and was
greeted by nobody.

Seven things change that. Each is small, calls no model unless a person is waiting for the answer, and has a switch.
They share one foundation, built first, so the seven can be built side by side.

## Decision

### 0. What they share

**A person's choice** lives in `organization_members.team_week` (the column keeps its name) and is read in one place,
`packages/engine/src/right-hand-prefs.ts`:

| Field | What | Default |
|---|---|---|
| `dayOff`, `dayHour` | "Resumo do dia", everyone's, in the person's own time zone (else the workspace's) | on, 9h |
| `weekOff`, `day`, `weekHour` | "Semana da equipe", an administrator's, in the workspace's time zone | on, Friday 17h |
| `digestOff` | the summary of approvals waiting (§4) | on |
| `remindOff` | reminders of what was agreed (§5) | on |
| `muted` | suggestions this person put away for good (§3), the newest 200 | none |

The writer merges (`team_week || patch`), so a key a version does not know survives a save.

**Who had stopped the card gets nothing new.** Rows saved before the two cards were told apart hold `off`, `daily` and
one `hour`. They are read as what they meant: `off` stops both cards, `daily` is the day's card in place of the week's
at that hour, and any other saved row has the day's card off, since it was off unless asked for. Only a row that
never chose gets the day's card by default. The same rules exist once in SQL (`lodiPrefsSql`), and a test holds the
two together.

**App builds from before** still send and read `off`, `daily` and `hour`. `GET …/team-week` answers them beside the new
fields (`off` only when nothing comes, `daily` when the day's card comes alone, `hour` of the card that build shows),
and a `PUT` that carries them is applied as that build meant it: `off: true` stops both cards, so its one switch still
stops everything, and `off: false` starts the one card that build draws (the week's for an administrator, the day's
for anyone else), never a card the person has no control for there. The row keeps those three beside the new keys, so
a server of the version before reads the same choice. Two saves at once take turns on the member's row.

**New app builds on a server from before** (a self-hosted server not yet updated) read its `off`, `daily` and `hour`
and save in the same words (`legacyPatch`, `packages/client/src/lib/right-hand-prefs.ts`): that server keeps one card,
so a stop stops it and a start picks which one comes.

**Two slots.** The worker's `rightHand` tick (every 10 minutes) queues the week's card as `team_week.post` and the
day's as `team_day.post`, each with `period` in its payload: the day's for every member who has it on, the week's for
administrators, one job per person and day and one per person and week (the dedupe key). On the day an
administrator's weekly card is due they get that card alone. The statement keeps only members within the six hours
after their slot who have no job for that card yet (it rebuilds the dedupe key and looks it up), and asks who
administers only for those, on a day a weekly card may be due. So a tick reads who it may queue, and they are queued a
thousand per statement. Both kinds and `team_watch.check` are long jobs (ADR 0053 §10): a card for every member at the
same hour never stands in front of a message's routing.

The day's card has a kind of its own because a server of the version before knows `team_week.post` and would read a
day's job as a week's. While both versions run, that server fails a `team_day.post` job it claims (no handler), and
that person's card of that day is not sent.

**Helpers** (`right-hand-proactive.ts`): `lodiFor` (the right hand, or null in a closed workspace, when it is archived,
or when it may not talk to that person), `postFromLodi` (one message in a person's DM, in their language, ringing only
when asked, said once), `saidOnce` (a finished outbox row whose dedupe key is the memory, stored with the workspace
and a prefix no job uses), `setCardOnMessage`, `lodiSwitches`. No new table: what was done once is an outbox key, what was told once is an inbox group key, what was
put away is on the card's message.

**Lanes.** Each feature below that runs by itself is one file that calls `defineLodiLane` (`right-hand-lane.ts`) with
its switch, whether it is built (`live`), its outbox jobs, its sweep and its block of the right hand's prompt. The
server reads the list in four places: the job handlers, the worker's sweep, the prompt, and the switches. A lane that
is not `live` is wired and does nothing, and its switch shows nowhere: not on the page, not in `set_team_week` or
`update_workspace`, not in the prompt. A lane whose prompt block fails adds none and is reported: the right hand
still answers.

**Switches.** On the right hand's page, web and phone, one group "O que o Lodi faz por conta própria": the day's card
with its hour (everyone), the week's card with its day and hour (administrators), then one switch per live lane. Two
are the workspace's (`organization_settings.team_watch` and `welcome_people`, migration 0259, on by default and on
with no settings row), saved by who configures the workspace, and say so under their name. The right hand flips the
person's own when asked (`set_team_week`: `card`, `off`, `day`, `hour`, and `digest`, `reminders` once live) and the
workspace's through `update_workspace`.

**New row kinds on the card** travel in `card.moreRows`. Builds from before never read it, and a kind they do not know
would break their card. The apps draw `rows` then `moreRows`, known kinds only.

### 1. Team watch ("Cuidar da equipe")

A sweep with no model call. It fixes what is safe and tells the one person who can act, through "Esperando você"
(ADR 0172), never in a DM message.

- Tells: an AI sign-in that ended (the plan's owner), a connector or a database to reconnect for over 20 minutes (who
  connected it, else who manages connectors), a mailbox (its owner only), a budget on pace to end early or already out
  (the agent's owner if they may raise it, else the workspace's owner), a brought computer offline for over 30 minutes
  with agents on it (who paired it). One row per person and cause, its objects listed and counted, updated in place,
  at most three new rows a person a day. No row while the same person already has one for the same thing from another
  kind (a failed run, a usage limit, a stalled routine).
- Fixes: a routine paused as failing is resumed once per pause, only when every recent failure came from its
  surroundings and its agent can think now. A schedule routine that failed on a passing cause gets one retry.
- Reminds: one push a person a day that counts what still waits on them unread, in their own daytime, and none while
  the approvals summary (§4) is the reminder.
- It never raises a budget, reconnects, signs in or moves agents. Rows carry names and a cause, nothing from a DM, a
  vault, memory or a mailbox, and name only agents their reader sees.

### 2. The daily brief ("Resumo do dia")

The day's card for everyone, from stored data.

- It posts only when something is the reader's: something waits on them, a run they asked for or of an agent they own
  finished or is stuck, a task they made or follow was closed by an agent. Counts across the workspace never post it.
- Rows: what waits on them (up to three, opening "Esperando você"), what is stuck and why (a cause code and one button
  to its conversation, never run text), then the rest, five at most. Money and channel rows stay on the week's card.
- It rings only with something waiting or stuck. The same items as the day before, and nothing else, post nothing.
- Nothing from a channel the reader cannot read, administrators included.

### 3. Suggestions on "Semana da equipe"

Two more rows on an administrator's weekly card, never on the day's: an agent idle for 28 days with no routine and no
open task (archive it), and an agent on a large model whose work is light (one tier down, never the smallest). One of
each per card, applied as the admin who clicks, with Undo. A row can be put away alone: for good and for every admin
on those two, per person on unanswered questions. One left alone returns after four weeks at most. Both are counted
over all runs, private conversations included, so these rows never name a channel or link a run. Archiving is never
part of "Aplicar as N".

### 4. Approvals digest ("Resumir aprovações esperando")

When three or more approvals a person was told about wait on them, one card from the right hand in their DM, 10 to 20
minutes after the newest: the routine ones listed with one button for all, each risky one as its own card. The server
decides which are routine (never a merge, deploy, delete, send or publish, a command, unproven SQL, a mailbox's, or a
tool whose job is asking) and the one-tap decision skips anything else. The card is updated in place for 12 hours,
then a new one replaces it, two a person a day at most. It never rings and adds no inbox row. The right hand decides
nothing.

### 5. Follow-through ("Lembrar o que combinamos")

- A task the right hand handed to an agent for a person is followed to its end: when it is done or canceled after the
  hand-over was reported back, the right hand is woken once per hand-over in that person's DM. Not when they made the
  change themselves, asked the run that made it in their own words, or it did so for them, and not while the
  hand-over's own report is still to come, or came after the change or within five minutes before it (that report
  tells the end). An agent's background
  work that ends the task counts too. The inbox row of the same change is done for them when a turn starts, so one
  thing tells them. Its push may already have left.
- A handed task that has not changed and whose conversation was quiet for four hours is looked at a day after the
  hand-over, then daily while it moves, seven looks in all, and said once per task with what it waits on, read from the
  task's own conversation: the people something there waits on (also while the hand-over is still out), else its
  agent's run paused on something else, else nothing. Never said: a task that waits on the requester (their inbox has
  it), and a hand-over that failed or was never taken (told when it closed).
- What the right hand is told is a notice only it reads (`wait_result` with `refs.task`, agent-only on every build),
  which names the run that handed the task over, so the turn it starts is that person's own.
- A commitment with a time becomes a plain reminder, said in one line. A run at that time only when the person asked
  the right hand to do something then. It keeps at most three by itself in one DM, a rule of its prompt, which also
  lists the ones waiting there. A reminder a person asks for in words has no such cap.
- At most three wakes a person a day, in their own time zone. Past it the notice is written and read with the next
  turn, and the inbox row stays. Each wake is one turn on that person's AI, through the gateway, budget checked and
  cost recorded. The looks and the reminders call no model.
- The person's switch stops all of it: the task's end, the looks and the reminders it sets by itself.

### 6. Welcome ("Dar boas-vindas a quem entra")

One stored message from the right hand when a person joins a workspace, with their work areas to tap, then an
ordinary conversation. Never for the workspace's creator, on a rejoin, when they wrote first, with the switch off or
on a billing hold, and never later for someone who was missed. While they are new (30 days, no agent of their own)
the right hand's prompt says so, and its DM's own intro shows only the way to connect an AI, so they are asked one
thing at a time. The greeting calls no model.

### 7. Action cards

Two more changes the right hand starts as a card, only on a person's request: inviting people (every address and role
on the card, sent as whoever applies it, each address's outcome on the receipt) and removing an API key (refused
while agents use it). Neither applies at once, and a build that does not word such a card may not apply it: the click
says which action it knows (`knows`), and the server refuses without it. A plan's sign-in is removed on its own
screen. On the phone the people card applies each row as on the web. There is no switch: nothing happens without a
tap.

## Consequences

- Everyone gets the day's card by default, which was opt-in. It ships only together with §2, whose rule keeps it to
  days with something of the reader's own.
- A person's worst day is bounded per feature (one day's card, one week's card, two digests, three watch rows, one
  reminder push, three follow-through wakes, one welcome ever).
- No model call anywhere except §5's wakes and turns a person starts.
- `team_week` holds more than the weekly card. Renaming the column would be a migration that buys nothing.
