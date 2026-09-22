---
name: working-issues
description: Work a GitHub issue from claiming it to landing the pull request. Use when asked to work on, start, fix or implement a numbered issue, and when asked to merge that work to main with a PR. Covers the steps this repository expects and that a session usually forgets — claiming the issue, branching from a fresh main, one PR per issue, and releasing the issue afterwards.
---

# Working an issue

The whole job for one issue, in order. Steps 1 and 8 are the ones sessions skip: of the 57 past
sessions that opened a pull request, 17 claimed the issue first and 2 released it afterwards.
`node scripts/issue-ritual.ts` counts that again from the transcripts, so the claim stays honest.

`spec.md` is the source of truth. The issue points into it; read that section before the code.

Every step below runs through the `gh` CLI. A cloud session installs it in
`scripts/setup-cloud.sh`. If `gh` is missing anyway, do the same steps through the GitHub MCP
server — the duplicate search of step 5 included, since no script runs it for you then.

## 1. Read it and claim it

```
gh issue view <N>
gh issue edit <N> --add-assignee @me
```

Claiming it is how a parallel session knows the issue is taken. Do it before writing code, not
after.

Read the spec section the issue names, and the `docs/` page for the directory you are about to
touch. Section 1.2 of `spec.md` holds the hard vetoes; a proposal that breaks one is not an option.

## 2. Branch from a fresh main

```
git fetch -q origin main
git switch -c <type>/<N>-<slug> origin/main
```

`<type>` is the Conventional Commits type the work will carry: `feat`, `fix`, `perf`, `docs`.
Branching from `origin/main` rather than from whatever the tree holds avoids a rebase later.

## 3. Find your way around

Read the subsystem doc before the code. It usually names the file, which is faster than grepping
for a concept that has no name yet.

Imports carry explicit `.ts` extensions, so `grep -rn "from '.*roads.ts'"` finds every caller of a
module. A file re-exports the pieces it was split into, so the name a caller imports may not be the
file that defines it.

## 4. Implement

The hooks typecheck, determinism-lint and size-check every edit, so a mistake surfaces at the edit
rather than at verify time. Let them do that work; do not run those commands by hand after an edit.

Keep to one concern per file and to the 800-line limit. Split along the seams a file already has.

## 5. A problem outside the scope of this issue

File it. Do not fix it here, and do not leave a `TODO` or a note in the pull request body.

```
node scripts/file-issue.ts "<title>"
```

It searches open and closed issues first and refuses to file a duplicate. The issue is the
deliverable; carry on with the one you are on.

## 6. Verify and commit

```
npm run verify
```

One atomic change per commit, Conventional Commits, no attribution lines. The commit message says
what changed and why, in the plain English the repository writes everywhere else.

## 7. Open the pull request and land it

```
git push -q -u origin HEAD
gh pr create --base main --title "<type>(<scope>): <what>" --body "Closes #<N>. ..."
```

A hook runs `npm run verify` before the pull request is created. One pull request per issue, and its
body references the issue so closing the pull request closes the issue.

Then wait for the checks with one command instead of a poll loop:

```
node scripts/pr-wait.ts <pr>
```

It blocks until the merge-gating checks finish and prints one verdict; on a failure it prints the
failing step's own output. It exits 0 when they all passed.

When they pass, merge:

```
gh pr merge <pr> --rebase --delete-branch
```

Rebase, never squash or a merge commit. If the user asked you to stop before merging, stop here and
say the pull request is ready.

## 8. Release the issue

```
gh issue edit <N> --remove-assignee @me
```

The merged pull request closes the issue, but the assignee stays until it is removed. Two sessions
in fifty-seven did this, which is why it is a numbered step rather than a note.
