---
name: review-change
description: Run the project's agent review gates over a change before pushing. Use after building anything non-trivial in this repo, and whenever the user asks for a review, a second opinion, or "did the agents look at this".
---

# Review a change through the project's gates

The gate table and the reasoning behind it are in `.claude/REVIEW-WORKFLOW.md`.
Read it, then follow it. This skill is the procedure.

## 1. Establish what changed

```bash
git status --short
git diff --stat origin/main...HEAD        # or the range the user named
```

Work out which gates apply from the paths touched, using the table. Err towards
one more gate rather than one fewer: the cost is a few minutes, and every
expensive defect in this codebase so far was silent and passed its tests.

## 2. Refuse to review a red diff

```bash
npx vitest run
npm run check:functions      # when supabase/functions changed
```

Green first. A review of a failing diff wastes the reviewer's effort on noise.

## 3. Spawn the gates in parallel, in ONE message

One `Agent` call per gate, all in the same message, `run_in_background: true`.
Each prompt must stand alone — a subagent starts cold:

- the repo path, and "read CLAUDE.md first";
- the diff range or the exact files, and how to get them (`git diff A..B -- path`);
- what the change is FOR, in one or two sentences;
- the constraints that make this project unusual: migrations and edge functions
  are hand-run by the owner, accounts are invite-only so an account holder is
  untrusted, there is no build step, `services/` reloads on every visit while
  `wine/ spend/ holdings/ css/ lib/` need a version bump, and the pages wait a
  fixed time for each AI call;
- "return findings as text; do not edit files" unless the gate is `test-writer`
  and the user asked for tests to be written.

## 4. Act on every finding

Fix it, or refuse it in writing with the reason. Verify a finding against the
code before acting: agents have been wrong here before, and a wrong fix made on
an agent's say-so is worse than the finding it answered.

## 5. Report

Say which gates ran, what each found, and what was done about it — including
gates that found nothing. Then push.
