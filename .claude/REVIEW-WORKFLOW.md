# Review workflow — which agent sees what, and when

Written 2 October 2026, after a stretch where the big decisions were reviewed by
agents (the remediation plan, the AI-architecture choice, the catalogue
migration, the Gemini 3.5 trial) and the implementation work was not: wine
prompts, resolve-tickers, the spend functions, batch import with its migration,
and the statement diagnosis all shipped on tests alone.

Tests catch what someone thought to test. These gates exist for what nobody
thought of. The cost is minutes per change, against a codebase where every
expensive defect so far — a sign read backwards, a price written to the wrong
bottle, a shared column changing someone else's money — was silent, passed its
tests, and reached real data.

## The gate table

Triggered by what a change TOUCHES, not by how big it feels. More than one row
can apply; run them together, in one turn, in the background.

| A change that touches… | Agent | What it is asked |
|---|---|---|
| any non-trivial diff, before a push | `code-reviewer` | does it do what it claims, and handle its failures |
| `supabase/migrations/`, a schema file, or any SQL run by hand | `migration-guard` | do existing rows survive, can it be undone |
| RLS, auth, an edge function, a key, or user text reaching a prompt or a query | `security-auditor` | who else can reach this, and what happens when they try |
| money arithmetic, parsing, dates, FX, imports, returns | `test-writer` | what input breaks this, and is there a test proving it does not |
| a screen, a form, a report, anything a person reads | `ux-auditor` | can someone use this on a phone, does it belong |
| a fetch loop, batching, concurrency, a large render | `optimization-quality` | is it fast, does it scale, is it consistent |
| a model, a prompt, a provider, a time limit, a cost | `optimization-quality` + `security-auditor` | cost and latency; prompt abuse and limits |
| a new feature's shape, before code exists | `architect` | is this the right shape, what will it cost later |
| what to build and in what order | `product-owner` | should we build this, for whom, what is done |
| a release (version bump, changelog, deploy order) | `release-checker` | suite green, bumped only when required |
| the written description of the project | `docs-keeper` | does CLAUDE.md still match the code |

## How a change runs

1. **Build it**, with the tests the project's own rules demand (pure module →
   direct test; migration → the PGlite harness; a function → `npm run check:functions`).
2. **Run `npx vitest run` green.** A review of a red diff wastes everybody's time.
3. **Spawn the gates that apply, in parallel, in one message.** Give each one the
   diff range or the files, the intent, and the constraints it must respect
   (hand-run migrations, invite-only accounts, no build step, the page waits).
4. **Act on findings before pushing.** Each finding is fixed, or refused in
   writing with the reason. "Noted" is not an outcome.
5. **Say in the hand-over which gates ran and what they found** — including when
   a gate found nothing, because that is also evidence.

## Exempt, deliberately

- A one-line copy fix, a comment, a changelog line.
- A revert of something reviewed.
- A spike nobody will merge, clearly labelled as such.

Anything else that feels too small to review is the shape every entry in
CLAUDE.md's Common Pitfalls had before it reached real data.

## Reviewing is not approving

An agent's finding is an opinion from a reader with no stake. It can be wrong,
and three of them have been (the `WITH CHECK` claim, a "backwards allow-list"
that was already right, and a sum that was not a leak). Verify a finding against
the code before acting on it, and write down why when you disagree.
