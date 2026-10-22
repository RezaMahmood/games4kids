---
name: diagnose-player-data
description: Diagnose why a child's data looks wrong in games4kids by reading the live Azure Table Storage rows and correlating them with Application Insights requests. Use this whenever someone reports that a player's scores, progress, practice minutes, scoreboard row, name, grants or settings are missing, wrong, stale or different between the games site and the admin console ("X's scores aren't on the board", "practice shows 20 minutes but nothing counted", "her name didn't change", "he can't see the game"), even if they don't mention tables or telemetry. Not for code-only bugs that reproduce locally with no production data.
---

# Diagnose a child's data

A report like "her scores don't show" is a claim about production state. Answer it from the real rows and the real requests, not from reading code alone. Code tells you what *should* happen; the rows tell you what *is*; the request log tells you *how it got that way*. A diagnosis needs all three.

Everything here is read-only. Never write, delete or "fix up" a row while diagnosing. A child's data is the evidence, and the owner decides what changes.

## Before you start

The tool runs as whoever is signed in to `az` on the Mac.

- **Table read access.** `node tools/bootstrap.mjs --apply --after-first-deploy` gives the owner Storage Table Data Reader on every tagged account: the portal and each game. A game added later is covered on the next run. If the tool says "you cannot read", run that, then wait. A new role assignment takes a few minutes to apply, and ARM's own listing of it can lag by about 2 minutes.
- **App Insights read access.** Querying `appi-g4k` needs Reader on the resource group or above. The bootstrap owner is subscription Owner, which covers it.
- If you are an agent and a command fails for access, say which role is missing and give the bootstrap command. Don't try other credentials.

## The tool

`tools/player-data.mjs` holds the repeatable parts. Its logic lives in `tools/player-data.ts`, which `test/player-data.test.ts` covers.

```
node tools/player-data.mjs who <name or id>                         # match a display name (any part, any case) or a user id
node tools/player-data.mjs rows <name or id> [--out file.json]      # every row in every portal and game table that names the child
node tools/player-data.mjs timeline <name or id> --from <iso> [--to <iso>] [--all]   # requests that touched the child, with their writes
```

- `rows` scans every table in every tagged account except `shared`, which holds only Functions host state. It keeps any row whose keys or string fields contain the child's id. That catches the different ways games key a child: `attempts` partitioned by id, `results` with a `practice-<id>` partition, a `board` row keyed by id, and the portal's `emails` row that holds the id as a field. Write `--out` to the scratchpad when you want to compute over the rows.
- `timeline` finds requests by their table calls. Every request on a child's behalf reads `profiles` and `members` with the child's id in the URL, so this finds the child's own requests and an admin's requests about the child. The `role` column tells you which app answered: `func-g4k-<game>` is the child's own request, `func-g4k-admin` is an admin's. Each request lists its writes (`create`, `update`, `upsert`, `delete`) and the table calls with status codes. It hides the four portal reads that admission makes on every request, and `--all` shows them.

## Workflow

1. **Pin down the claim.** Restate what the person expects and where they see it: which page, which app, which day. "Today" depends on the child's time zone (`profiles.timeZone`), and the games compute days in that zone. Stored times are UTC.
2. **Identify the child.** Run `who`. If the name matches more than one child, ask which one, or use the id.
3. **Read the rows.** Run `rows`. Note the facts that bear on the claim, with their timestamps: counts, the newest and oldest, flags such as `since`, `hard` or `state`.
4. **Find the rule that turns rows into what they see.** Follow the read path in code: the page calls a route in `games/<id>/play/api/index.ts` (or `apps/*/api`), and the route calls a function in `games/<id>/data/`. That function is the rule, for example `buildBoard` in `games/letterjoin/data/board.ts`. Note every filter it applies: time windows, opt-in times, best-of-day, totals above zero, and the time zone used for days.
5. **Reproduce with the production code.** Write a short script in the scratchpad. It imports the real function, feeds it the rows from `rows --out`, and prints what the child sees. Run it with `node --conditions=source <script>`. This turns "I think the filter drops them" into output you can paste. When a rule is in question, also run the variant that shows what would change, such as a different `since`.
6. **Explain how the state got there.** Run `timeline` over the window that matters. Line up the writes against the rows. Ask whether each state change was a legitimate action: a switch the child flipped, a rename, an admin's grant. Or was it a write that shouldn't have happened, which is a bug?
7. **Decide: bug or design.** If the code did what it was designed to do, look for the design intent: `git log -S '<distinctive phrase>'`, the PR body (`gh pr view`), and the issue. A deliberate, tested rule that surprises the owner is a product decision for them, not a bug to patch. Recommend, don't change it unasked. If the code did something it shouldn't, it's a bug. Hand off to fixing it with a failing test built from the real rows.

## Report

Lead with the answer in one sentence, then the evidence. Use this shape:

- **Answer.** Bug or by design, and why, in a sentence or two.
- **Evidence.** A small table of the facts that decide it, each with its source: which table, which query, or the repro output.
- **Timeline.** A table of the writes in time order, when how the state arose matters.
- **Repro.** The script's output, pasted as-is.
- **What the child will see next**, and what the owner can do. If it's by design, give a recommendation with its trade-off.

Mark each claim as measured or inferred. Telemetry has gaps, so say so when a conclusion rests on telemetry being complete.

## Where things live

- **Portal account** (tag `game=portal`). `profiles` (display name, time zone, `renamedAt`), `members` (state, granted games), `emails` and `identities` (sign-in to user id), `games` (paused games), `admins`.
- **A game's account** (tag `game=<id>`). The tables its `games/<id>/manifest.ts` declares under `storage.tables`. The row shapes are in `games/<id>/data/stores.ts` (or the game's store module). Read that file to learn a game's partitions before guessing.
- **App Insights `appi-g4k`** (resource group `rg-games4kids`). Use `requests`, `dependencies` (table calls, with full URLs), `exceptions` and `traces`. Request rows carry no user id. The child shows up only in dependency URLs, which is why `timeline` matches there.

## Gotchas

- **Telemetry can be incomplete.** Retention is 30 days. Log Analytics has a daily cap of 0.16 GB, after which ingestion stops for the rest of that day. Functions use adaptive sampling by default, and `timeline` marks a row `(sampled …)` when one row stands for several requests. A missing request is not proof that nothing happened.
- **A 404 on a table read** is often expected. For example, a read before an opt-in row exists logs a `ResourceNotFound` exception. Check whether the code treats "absent" as a normal state before calling it an error.
- **Times.** Rows and telemetry are UTC. The child's "today" uses their zone, and the UK is UTC+1 in summer.
- **Privacy.** Rows include children's names and email addresses. Keep raw dumps in the scratchpad, quote only the fields the answer needs, and never publish them as a shared page or artifact.
- **The data is shared and live.** Don't write to it. To test a fix, use the local dev stack or unit tests built from copied rows.

## Worked example

"Cutest Hello Kitty ever has 20 minutes of practice, but no scores on the Friends board."

- `rows` showed 32 attempts and a `board` row with `since` 18:55:19 UTC.
- The rule in `buildBoard` counts only attempts on or after `since` and hides a child whose total is 0.
- The repro, with her real rows, showed no row on the board, and a full row when `since` was set to the start of the week.
- `timeline` showed the switch going off and on 9 times. Every scored attempt finished while the switch was off. Each off-and-on reset `since`, because switching off deletes the row.
- The practice minutes come from a separate page-time clock, not from attempts.
- Verdict: the code did what it was designed to do. The opt-in rule was deliberate (commit e840b9e, PR #51), and children toggling the switch defeat it. That's a product decision for the owner.
