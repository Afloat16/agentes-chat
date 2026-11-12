# 0174. The right hand's computer: a seat per person

- Status: Accepted (built: engine, the shared client's lists, the web and the phone app's row; not yet run on a real
  system-mode computer, see "Before it ships")
- Date: 2026-11-12
- Amends: ADR 0137 (§1 "it is on no computer", §4 and §13 "no computer", the 2026-11-12 amendment's "No computer
  yet"), ADR 0057 (§2: an OS user per id the server sends, not only per agent), ADR 0169 (§9: a seat has its
  containers service)
- Code: `packages/db/src/schema/agents.ts` (`right_hand_seats`), `packages/db/src/schema/runtime.ts`
  (`machine_tasks.scope_id`), migration `0255_right_hand_seats`, `packages/engine/src/right-hand-seats.ts` (`seatOf`,
  `seatPerson`, `machineScope`, `viewerScope`, `toolMachineId`, `seatState`, `screenKey`),
  `packages/engine/src/machine-hub.ts` (`outgoing`, `isLockedTurn`, `agentsChanged`, `MachineStatus.mode`),
  `packages/engine/src/machines.ts` (`machineAgents`, `deletedAgentIds`, `machineViews`, `computerDriving`),
  `packages/engine/src/sandbox.ts` (`withConnectedMachine`), `machine-tasks.ts` (`taskScope`), `git/machine.ts`,
  `git/proxy.ts`, `browser/tools.ts`, `browser/status.ts`, `browser/handoff.ts` (`screenAccess`), `browser/live.ts`,
  `desktop.ts` (`desktopTarget`), `desktop/tools.ts`, `desktop/status.ts`, `right-hand-prompt.ts` (`rightHandTools`),
  `right-hand.ts` (`RIGHT_HAND_COMPUTER_GRANTS`), `organizations.ts` (`removeSeat` on leaving)
- Tests: `packages/engine/test/right-hand-computer.test.ts`

## Context

The right hand is one `agents` row per workspace that every member talks to (ADR 0137). It had every tool an agent
can have but a computer's: `sandbox:run`, `browser:use` and `desktop:use` were kept off it, because a computer keeps an
agent's files, browser profile and sign-ins under the agent's id, and one id would have put every member in the same
home. The owner decided it is a normal agent with extra powers, with a full Linux user of its own for each person.

## Decision

### 1. One row, a stored seat per person

The one row stays: `unique(org_id, handle)` leaves one `@lodi`, and about 140 files read "the workspace's right hand".
Each (workspace, person) gets a seat: a row of `right_hand_seats` with a random uuid, made on the person's first use
(`seatOf`, only for a member). The seat's id is what the computer takes for an agent's id, so in system mode (ADR 0057)
it gets `ag-<first 8 of the seat id>`: its own OS user, home (0700), worker, slice, sub-ids, browser profile and
sign-ins, by the machinery every agent already has. The runner learns nothing new.

The id is stored, not derived from the agent's and the person's ids: the runner names a user from the first 8 letters
and digits of an id, so anything that starts with the agent's id would give everyone the same user; a clash can be
answered with a new row; and the computer must be able to list seats and hear which are gone.

### 2. The agent's own id never reaches a computer, but for its locked turn

Every request to a computer goes out through one function of the hub (`outgoing`, on the socket's replica, across
replicas and for a task's resume). There, a request whose agent is the right hand's own row is refused
(`not_allowed`) unless it is its locked chat turn or what follows one: `brain.turn` with `permissions.mode: "chat"`,
`brain.steer`, `brain.route` (`isLockedTurn`). So a call site that still builds a request from the agent's id fails
loudly and sends nothing, instead of putting every member in one shared home.

### 3. Who gets a seat

- **A run** gets the seat of the person behind it, in that person's own DM with it (`seatPerson`: `personBehindCall`
  and `readsAlone`). Stricter than `rightHandReader`: a routine's own run does not count as its creator here, since
  what a routine read may come from outside. A channel mention, a routine's run, a run a routine or an agent woke and
  a run with nobody behind it get no seat, and a computer tool answers with a plain line saying so and what to do
  instead (`NO_SEAT_MESSAGE`). Nothing is sent to the computer.
- **A person's own request** (watching, taking control, a terminal, the screen's state and picture) reaches the seat of
  whoever asks, through one function (`viewerScope`, called by `desktopTarget`). It takes who asks and never whose
  seat, so no route can name another person's. On the right hand, the checks of who may watch and drive
  (`screenAccess`, `computerDriving`) let every member through to their own seat and nobody to another's, admins
  included: an admin who opens it sees their own.
- **Where.** Only on the workspace's own computer (managed, else the server's own: `workspaceHomeId`), and only when
  it says `mode: "system"`. Anywhere else a seat would be a folder, not a user, so there is none: a computer a person
  brought, a phone's host and a computer that runs every agent as one user are refused with their own lines.

`agents.machine_id` stays null for the right hand. About ninety places read that column as where an agent's plan
thinks (outages, plan usage, the router's lending, AI settings), and its brain is on the computer where the plan's
account is signed in (ADR 0137 §1). The tools read its computer through `toolMachineId` instead.

### 4. What goes to the seat

Commands and files (`withConnectedMachine`, so `run_code`, the file tools, uploads, pulls and skill scripts),
background tasks (`machine_tasks.scope_id` keeps the seat for the task's later status, output, cancel and resume:
`taskScope`), `git_clone` and its proxy credential, the browser tools, the desktop tools, a Vault key or a made
password (sealed to the seat's id, which is what its worker opens with) and a person's streams.

What the server remembers of a screen between calls is kept per seat too: the look memory of the browser and desktop
tools (`screenKey`) and the desktop's recent picture.

### 5. The computer's lists

- The `agents` frame of the workspace's own computer lists each live seat like an agent: the right hand's handle and
  look, the name "Lodi (Ana)", the person's language, and `containers: true` (its turns never run there, so its
  containers service is no way out of a sandbox). A seat just made is announced before its first request
  (`agentsChanged`).
- A member who leaves, or whose account is deleted, has their seat tombstoned (`removed_at`), and the frame's
  `deleted` list names it, so the runner stops its worker and containers and clears what its sign-ins hold. Coming
  back gives a new seat with an empty home. The list is also computed from memberships, so a membership removed any
  other way still counts.
- `GET …/machines` names the right hand among the agents of that computer when it is in system mode. The apps find an
  agent's computer there, so its row on the web and the phone ("Computador") opens the viewer's own seat with the
  components any agent's page uses.

### 6. Grants

`sandbox:run`, `browser:use` and `desktop:use` are grant rows it is made with (`RIGHT_HAND_COMPUTER_GRANTS`; the
migration gives them to every existing right hand). Rows, not scopes held in code, so its access tab turns them on
and off like any agent's, `request_permission` offers one that was taken away, and nothing about them is special.

### 7. The locked turn is unchanged

On a plan its turn is still the runner's `chat` mode as the shared thinking user: the CLI gets our bridge and nothing
else (ADR 0137 §4). Every computer tool is ours, served by the Tool Gateway on the server, which sends the request
to the seat. The CLI itself is not unlocked to work as the seat's user: a plan's sign-in is lent to one OS user at a
time, so the workspace's plan could not be lent to every seat.

### 8. What it is told

"# Your tools" has three wordings (`rightHandTools`, by `seatState`): with a seat, that this conversation has a
computer that is this person's own place; in a channel or a run nobody asked for, that it has one only in a person's
private conversation; with no computer of the workspace's own in system mode, the earlier "no computer yet". "What you
can do" keeps naming no browser, clone or typed login only when the run has no seat.

## What is not in this change

- **No live view or take-over of its browser.** One view per agent goes to everyone watching, and the right hand's
  browser is a different one per person: `watch` answers "unavailable" for it. Its desktop shows each person their own.
  `browser_ask_person` and the browser's own hand-off still send the agent's id and are refused by the hub.
- **One open hand-off per agent.** While one person controls their seat's desktop, another's view of theirs reads
  "someone is in control". Nothing of the first person's screen is shown.
- **Folders granted on a computer**, **missions** and **devices people brought** are not for it: the first two send
  the agent's id (refused), the third is refused by name.
- **`claude` and `codex` background tasks** need a sign-in the seat does not have. Shell tasks run.

## Consequences

- One Linux user, and possibly a Chrome and a desktop, per member, sharing the agents' memory. Users are never removed
  from a computer (ADR 0057), so a departed member's home stays on disk with its worker stopped.
- The shared folder joins every user, so two seats, and a seat and an agent, can exchange files there.
- In their own DM a run reads web pages and files while it can act as that person on their seat. Outside content
  marks the run as before (ADR 0117).
- On a plan every command goes through the server.

## Before it ships

Nothing here was run on a real system-mode computer. The checks are listed with the change's hand-over: two seats get
two users with 0700 homes that cannot read each other's files, processes or browser profiles; a plan's chat turn still
runs as the thinking user and its tool call lands in the asker's seat; a removed member's worker and containers stop;
a single-user runner is refused cleanly.
