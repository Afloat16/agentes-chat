# 0180. Two licenses, and a contributor license agreement for outside contributions

- Status: Proposed
- Date: 2026-11-13
- Revises: [ADR 0002](0002-editions-and-modules.md) §5
- Code: `CLA.md`, `.github/workflows/cla.yml`, `COMMERCIAL.md`, `CONTRIBUTING.md` ("Licensing of your contribution"),
  `.github/PULL_REQUEST_TEMPLATE.md`

## Context

ADR 0002 §5 took outside contributions in under the repository's license (inbound = outbound), with no
contributor license agreement. Codari Global, LLC therefore holds them only under the AGPL: it can't license them
on any other terms, and any private code in the server process would form one program with them and have to be
published too.

Some people can't or won't take the AGPL: a company that changes agentes.chat and doesn't want to publish its
changes, a reseller that wants its own brand without the attribution `NOTICE` asks for (section 7(b)), or a legal
department that allows no AGPL software. Codari wants to offer them the same code under a commercial license. It
can only license what it owns or holds broad enough rights to: the team's code is Codari's by contract, but every
outside contribution would stay AGPL-only.

## Decision

1. **Two licenses, one codebase.** The public license doesn't change: AGPL-3.0-only with the terms in `NOTICE`
   (the app stores permission and the attribution), and MIT for the packages that say so. Codari also licenses
   the same code under commercial terms, by contract (`COMMERCIAL.md`). The code knows nothing of it: no license
   key or check, which anyone could remove from AGPL code anyway, and nothing that behaves differently.
2. **A contributor license agreement.** Every outside contribution comes in under `CLA.md`, based on the Apache
   Individual Contributor License Agreement: the contributor keeps the copyright and grants Codari, its successors
   and the recipients of what it distributes a perpetual, worldwide, irrevocable copyright license, with the right
   to sublicense and relicense under any terms, commercial ones included, and a patent license; they state the
   code is theirs to give (with their employer's permission where it has rights in it), and someone accepting for
   a company binds the company, so the one text covers people and companies. Contributions are still licensed to
   everyone under the license of the code they go into, as before; the agreement adds Codari's rights on top.
3. **Asked in the pull request.** `.github/workflows/cla.yml` runs the CLA Assistant Lite action
   (`contributor-assistant/github-action`, pinned to a commit) on `pull_request_target` and on comments: the
   workflow file is always main's, and the pull request's code is never checked out. The bot comments on a first
   pull request, the contributor accepts with a comment, and the bot records it in
   `signatures/version1/cla.json` on the `cla-signatures` branch (outside main, unprotected) and locks the merged
   pull request's conversation so the comment stays. The job's check, `CLA`, is required on main. A new version
   of `CLA.md` gets a new signatures path, so everyone accepts it again.
4. **Who isn't asked.** Pull requests opened by the organization's members and collaborators, and by bots
   (Dependabot, the GitHub App that opens the agents' pull requests), skip the bot's step and pass: their work is
   Codari's by contract. An outside contribution reaches main only through a pull request of its own, where it is
   asked, even when a maintainer later carries it in an integration branch.
5. **Earlier contributions stay as they are.** Nobody is asked to sign for code merged before this decision.
   Code from outside the team merged before it is still held only under the AGPL: the commercial license doesn't
   cover it until the team rewrites it. Until then the rule of ADR 0002 §5 holds unchanged: nothing private runs
   in the server process, and Cloud-only behavior is public code switched on by environment variables or a
   separate service over the network. Lifting that rule takes a new ADR, once no such code is left.

## Consequences

- An outside contributor's first pull request waits for one comment. Later ones don't.
- The signatures live in this repository, versioned, with no third-party service holding them.
- The README, `SELF_HOSTING.md` and `CONTRIBUTING.md` no longer say there is nothing to sign or no paid tier;
  self-hosting stays free under the AGPL.
- The team's own code being Codari's rests on its contracts, not on this agreement.

## Alternatives considered

- **CLA Assistant, the hosted service.** The same flow, but the signatures sit in a third party's database and it
  needs an OAuth app with access to the organization. The action keeps everything in the repository.
- **A Developer Certificate of Origin.** It certifies where the code comes from but grants no right to relicense,
  so it doesn't allow a commercial license.
- **Copyright assignment.** It gives Codari the copyright itself, more than a commercial license needs, and puts
  off contributors.
