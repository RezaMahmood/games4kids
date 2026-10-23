# Round check eval

`games/timedetectives/admin/api/check.ts` asks TypeSafe's Jev whether an AI-written round spoils its own quiz. This eval runs that exact code over labelled rounds against the live API, so a change to a question, a threshold or the model becomes a measured difference.

```sh
with-typesafe npm run eval:jev
```

It is not part of `npm test`, because it needs the key and calls the API. Replies are kept in `.cache/` by request body, so a rerun of unchanged questions is free.

## The rounds

`rounds.json` holds 8 good rounds and 39 broken copies. Each copy changes its good round in one way that should make one check fire, and is marked `subtle` when the fault is indirect. The fault types are:

- `brief_leak`
- `decoy_supported`
- `answer_missing`
- `hint_leak`

The question wording was chosen on these same rounds, so they flatter it. Add real drafts as they come in.

## Rules for changing the check

- Run the eval before and after any change, and put both tables in the PR.
- When a yes/no question misfires, define what yes and no mean with `criteria` before you reword the question. That is what fixed the hint check: good rounds sent back for a rewrite fell from 2 of 8 to 0 of 8.
- Keep thresholds in code (`FAIL_AT`, `UNSURE_AT`), not in the questions.
- `MODEL` is pinned. Move it only after the eval shows the new version is no worse. On jev-1.13.0, the old hint question marked 7 of 24 good hints unsure. On jev-1.14.0 it marked 19 of 24.
