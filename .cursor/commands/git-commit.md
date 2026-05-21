# Git commit (generate message from changes)

Analyze the working tree, draft a commit message from the actual diff, then commit only after the user confirms (or when they explicitly asked to commit in the same message).

## 1. Inspect changes (run in parallel)

```bash
git status
git diff
git diff --cached
git log -15 --oneline
```

Read `AGENTS.md` (Conversational Style, Commands, Changelog, **CRITICAL Git Rules for Parallel Agents**) before staging or committing.

## 2. Draft the commit message

Base the message only on staged + unstaged diffs (and recent `git log` style). Do not invent changes.

**Format** (match recent history):

```
<type>(<scope>): <imperative summary>

Optional body: why, not a file list. Wrap at ~72 chars.
```

| Type | Use when |
|------|----------|
| `fix` | Bug fix |
| `feat` | New behavior |
| `chore` | Tooling, deps, CI, release mechanics |
| `docs` | Documentation only |
| `test` | Tests only |

**Scope**: package or area — e.g. `ai`, `coding-agent`, `agent`, `tui`, `web`, `hub`. Omit scope only for repo-wide `chore`/`docs` (see `chore:`, `docs:` in log).

**Rules**:

- English, imperative mood, no emoji, no fluff
- One logical change per commit; if diffs mix unrelated work, say so and split
- If closing an issue/PR: add `fixes #<n>` or `closes #<n>` on its own line in the body
- Do not commit secrets (`.env`, keys, tokens)
- Warn if `packages/ai/src/models.generated.ts` changed without matching source/script edits

**Present to the user** before committing:

1. Proposed subject line (and body if any)
2. Exact file paths you will stage
3. Ask for confirmation or edits

## 3. Pre-commit checks

- Code changes (not docs-only): user should have run `npm run check`; if unclear, run it and fix issues before commit
- Never `git add -A`, `git add .`, `git stash`, `git reset --hard`, `git checkout .`, `git clean -fd`, or `git commit --no-verify`
- **Parallel agents**: stage only files changed in **this** session; `git status` must show no unrelated paths staged
- Never push unless the user explicitly asks

## 4. Stage and commit

Stage explicit paths only:

```bash
git add path/to/file1 path/to/file2
```

**Commit message** (bash):

```bash
git commit -m "$(cat <<'EOF'
fix(scope): short summary

fixes #123
EOF
)"
```

**PowerShell** (multi-line):

```powershell
git commit -m @"
fix(scope): short summary

fixes #123
"@
```

Single-line is fine: `git commit -m "fix(scope): short summary"`

If the hook fails, fix and create a **new** commit (do not `--amend` unless the user asked and the prior commit was yours and unpushed).

After commit: `git status` to verify.

## 5. Default outcome

If the user only wanted a message: output the proposed message and file list; do not commit until they confirm.
