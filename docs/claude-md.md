# What belongs in CLAUDE.md

`CLAUDE.md` is loaded into every agent session in this repository, in full, before the agent knows
what it has been asked to do. Every line is paid for on every issue. It follows Anthropic's
context-engineering guidance for the Claude 5 generation of models: state the things the model
cannot work out for itself, and trust it for the rest.

## The test for a line

Would a competent engineer who has never seen this repository get this wrong after reading the code?
If no, delete it.

That single test settles most edits. The corollaries:

- **Non-obvious constraints earn their place.** `valleyBias: 1` produces NaN at fractional values.
  `src/world` must run headless because the sweeps import it. The `tsapi` alias exists because
  TypeScript 7 ships no JS API. None of these are visible from the file that breaks.
- **Things the file system already says do not.** Directory names, npm scripts, dependency versions,
  the fact that tests live in `test/`. The model reads `package.json` faster than it reads a table
  describing `package.json`.
- **Rules the tooling enforces are worth one line, not a section.** The determinism lint and the
  typecheck hook catch the violation and explain it at the point of failure. The file only needs to
  name the rule and where the helper lives, so the agent writes it right the first time.
- **Judgment beats enumeration.** "Never make a test slower to make it pass" covers more cases than
  a list of tests and their permitted timings, and stays true when the tests change.
- **Point instead of copying.** `spec.md`, `package.json` and `.claude/settings.json` are the
  source of truth for what they describe. Duplicating them here creates a second copy that goes
  stale silently. A pointer costs one line and never rots.

## What does not belong

- Practices that apply to any codebase: write tests, handle errors, keep functions small, do not
  commit secrets.
- Guardrails written for older models: reminders to read a file before editing it, to check that a
  command succeeded, to not invent APIs.
- Anything already stated in the harness's own instructions — the git workflow, PR etiquette, how to
  use the tools.
- Long-form explanations of a subsystem. Those go in `spec.md` or a doc under `docs/`, which the
  agent loads only when the work touches that subsystem.
- Specialised workflows that apply to a fraction of sessions. Those belong in a skill under
  `.claude/skills/`, loaded on demand.
- Anything that is really automation: a check, a setup step, a repeated fix-up. Put it in a hook
  under `scripts/hooks/` or a `scripts/` entry. A hook that fails with a message teaches the agent
  at the moment it matters, which prose at the top of the session does not.

## Shape

`scripts/check-size.ts` caps `CLAUDE.md` at 160 lines, wrapped at 100 columns, and every other
markdown file at 400. The cap is a floor on what the file has to be worth, not a target to fill.
Prose in short paragraphs and tight lists, not tables — a table wide enough to hold a constraint
mostly holds restated column headers.

The sections are: what the project is and where the spec lives, the tests, the docs it points at,
the size limits, determinism, per-directory constraints, the traps that cost a session with nothing
to say why, conventions, the writing rules and this maintenance note. New material joins an existing
section far more often than it justifies a new one.

A subsystem gets a doc of its own, read by the session whose work touches that directory.
`CLAUDE.md` keeps the traps that break a session in a way no file explains, and names `docs/` once
rather than listing it: the skill for each subsystem carries that pointer, and a list in two places
goes stale in one of them. When `CLAUDE.md` reaches its limit, move a subject into a doc; when a doc
reaches its own, split the subject. Neither is ever fixed by writing more tightly.

Every doc over a hundred lines opens with a contents list and is cut into `##` sections, because a
session that reads part of a file reads a window with no heading in it and takes away half an
answer. A doc is read by section.

A skill under `.claude/skills/` is the other half of this. A doc waits to be remembered; a skill's
`description` is matched against the task, so it loads itself. The rule between them: the doc holds
the gotchas, the skill holds the pointer into the doc and the first moves, and neither repeats the
other. A skill is held to the same 100 columns and 400 lines as a doc, its frontmatter excepted, and
its body is kept far shorter than that — a skill nobody finishes reading has failed twice over.

The writing rules the file states for the project apply to the file itself, and hardest here: the
audience includes non-native English speakers, so every line is short, plain and literal, and
carries something the reader could not get elsewhere.


## Maintaining it

Update `CLAUDE.md` in the same commit as the change that makes it wrong: a new directory, a newly
enforced rule, a gotcha that cost a session. Prefer editing a line over appending one, and delete a
line when its reason is gone — a rule the linter now catches, a workaround for a fixed bug, a
constraint that moved into a hook.

When the file grows past a page, the fix is not smaller wording. Something in it has stopped being a
gotcha and become documentation; move it to `spec.md`, a doc here, or a skill.
