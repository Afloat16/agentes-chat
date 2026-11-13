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

- It posts only when something is the reader's and new: something waits on them, a run they asked for or of an agent
  they own is stuck, their agent finished work they did not ask for themselves, a task they made was closed by an
  agent, a how-to of their agent is ready to become a skill. Counts across the workspace never post it, an
  administrator's included: the team's view is the week's card. What they asked for themselves answered them where
  they asked, so it is counted on a card that goes out and never posts one.
- A run is the reader's when its agent is theirs, or when they wrote the message that started it or the first message
  of its thread. That is one statement for all their runs. Work one agent passed to another outside that thread shows
  on its owner's card only.
- Rows: approvals of the agents their inbox says are asking, one row that counts what else waits on them (it opens
  "Esperando você" and stores inbox ids, never a question's words), what is stuck and why (up to three, one of six
  causes and one button to its conversation or task, never run text), then their agents' how-tos and stalled steps of
  a task they made. Five at most. Money, channel, routine and unanswered rows stay on the week's card.
- Stuck is a run that failed with no good run after it in the same conversation, or one parked for four hours or more
  on a plan, a budget or a computer. A run a person stopped or a restart cut is neither. A held run's cause is what
  it waits on: a budget (a long work paused on the agent's budget included), a plan's limit, a sign-in that ended,
  a computer away or full. Any other wait (a computer a person paused, a plan its owner did not share) reads as
  "the conversation shows what".
- The card keeps what was still open when it went out (`seen`). The next day's card posts only for something not in
  it, so what waits or is held is said once, and it rings only for a new thing waiting or held. A run that failed
  told its person when it did (the inbox's `run_failed`), so it is on the card without a second ring. What only
  finished posts without ringing.
- It covers from the last day's card to its slot, three days back at most, so a day with no card is not lost. A run
  counts on the day it ended, so one still working at the slot is on the next card (one that began more than three
  days before the window is on none). Its job is found again by the slot kept on the card, whatever the window was.
- A task counts as closed by an agent when its last change of status in the window is an agent's, to done, on both
  cards. A person closing it, or a comment on a closed task, is not.
- Nothing from a conversation the reader cannot read: an administrator reads every channel and never another
  person's DM.

### 3. Suggestions on "Semana da equipe"

Two more rows on an administrator's weekly card, never on the day's: an agent idle for 28 days with no routine and no
open task (archive it), and an agent on a large model whose work is light (one tier down, never the smallest). One of
each per card, applied as the admin who clicks, with Undo. A row can be put away alone: for good and for every admin
on those two, per person on unanswered questions. One left alone returns after four weeks at most. Both are counted
over all runs, private conversations included, so these rows never name a channel or link a run. Archiving is never
part of "Aplicar as N".

- A suggestion rides a card that goes out anyway. A week with nothing else to say posts no card and makes no
  proposal, so a dormant workspace hears nothing. While one suggestion of a kind from the reader's last four weeks
  of cards is undecided, no other agent is offered the same: at most one proposal of each kind waits on a person.

- Light work: 20 or more finished runs in four weeks, nine in ten of them with two model calls and 800 output tokens
  at most. A run with no recorded usage never counts as light. The next model down is the provider's middle one (for
  Claude Code, `sonnet` in place of `opus`).
- Each administrator's card carries a proposal of its own: a settings proposal the right hand makes for a person is
  shown to nobody else until that person sends it on, so one shared row would be hidden from the others. Putting a
  row away refuses the reader's proposal as them and closes the copies on the other cards. An agent is never offered
  the same suggestion again once anyone decided it, applied and undone included.
- Unanswered questions in a team take two people asking. Put away, that channel is muted for that person
  (`muted`). On the wire a row is put away with `{ rowId, skip: true }`, and a body that mixes a row with the card's
  own `dismiss` is refused, so it is never read as "Agora não". The card keeps rows put away in `skipped`, apart
  from `done`: builds from before read any row in `done` as applied. A row put away is not applied afterwards.
- The two reasons reach the apps as `whyCode` `idle` and `light_work`, with the English sentence in `why` for builds
  from before them.

### 4. Approvals digest ("Resumir aprovações esperando")

When three or more approvals a person was told about wait on them, one card from the right hand in their DM, 10 to 20
minutes after the newest: the routine ones listed with one button for all, each risky one as its own card. The server
decides which are routine (never a merge, deploy, delete, send or publish, a command, unproven SQL, a mailbox's, or a
tool whose job is asking) and the one-tap decision skips anything else. The card is updated in place for 12 hours,
then a new one replaces it, two a person a day at most. It never rings and adds no inbox row. The right hand decides
nothing.

### 5. Follow-through ("Lembrar o que combinamos")

- A task the right hand handed to an agent for a person is followed to its end: when it is done or canceled after its
  first report, the right hand is woken once in that person's DM, unless they made the change themselves or it did so
  for them. The inbox row of the same change is resolved, so one thing tells them.
- A handed task that has not moved is looked at a day later, then daily for a week, and said once, with who it waits
  on, from the task's own conversation.
- A commitment with a time becomes a plain reminder, said in one line. A run at that time only when the person asked
  the right hand to do something then.
- At most three wakes a person a day. Each wake is one turn on that person's AI, through the gateway, budget checked
  and cost recorded.

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
