# Working on this repository

One branch per milestone, merged to `main` by pull request. `main` is the line of
finished, reviewed work — not where writing happens.

This matters more here than in most projects for one reason: **a merge to `main`
publishes** ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)). In this
repository that is the static demo at `q4413-demo.filoga.me`; in a deployment of your own it
is whatever `main` is wired to. Either way merging is a public event, so it is worth the
ceremony of a PR.

## One-time setup

```bash
pnpm install
git config core.hooksPath .githooks   # refuses a direct push to main
```

The second line is not optional-but-nice, it is the only enforcement there is. GitHub's
branch protection and rulesets need Pro on a private repository, so the rule cannot be
enforced server-side. The hook is a habit with a tripwire: it lives in the repo, but a
clone that skips that `git config` has no hook, and `--no-verify` bypasses it. Treat `main`
as protected because it is, not because something stops you.

## The loop

```bash
git switch -c m3/position-states     # <milestone>/<what>, lowercase, hyphenated
# ... the first commit ...
git push -u origin m3/position-states
gh pr create --fill --draft          # now — not when the milestone is done
# ... then keep working, one commit per completed task ...
```

**Open the draft pull request before doing the work, not on the way out.** As soon as there
is a first commit to open it from — GitHub refuses a pull request with nothing between the
branches, so the branch cannot be opened completely empty.

`ci.yml` runs on `pull_request` and on pushes to `main`, so until a PR exists the branch
gets **no CI at all**, and two things go wrong if it is opened late. Every commit made
before it existed goes unchecked; and they all arrive in one job the moment it opens, so a
red run tells you the branch is broken without telling you which commit broke it. Opened
first, each push is checked on its own, and the draft doubles as somewhere to keep notes as
you go.

Mark it ready when the milestone's exit criterion is met.

**Marking a milestone `— **done**` in [ROADMAP.md](ROADMAP.md) changes its anchor**, because
the heading text is the anchor. Grep for links to the old one in the same commit
(`grep -rn '#m6--elimination' *.md`) or they die silently — a broken in-document link renders
as ordinary text and nothing complains.

Branch names: `m3/…`, `m4/…` for milestone work; `fix/…`, `ci/…`, `docs/…` for anything
that is not a milestone.

**A milestone may take more than one branch, and letters are how.** M9 closed on five —
`m9/crt-layer`, `m9/map-first`, `m9b/…`, `m9c/…`, `m9d/…` — because each one ended where
the next one's subject was visibly different, which is a better boundary than a planned
one. Two rules make that cheap rather than confusing. **Stack the PRs**: open `m9c` off
`m9b` rather than rebasing finished commits onto `main`, and GitHub retargets each to
`main` as its base merges. And **merge in order**, because a stacked branch's diff is only
its own commits once the one under it has landed.

The cost is that every merge in the stack is a separate deploy. That is the reason to keep
the stack short, not a reason to avoid it.

## Commits

One commit per **completed task**, never one per milestone. A milestone is the unit of
planning; a commit is the unit of review.

Format, as `git log` shows it: `type(scope): summary` — lowercase, often with a "why"
clause after a comma, as in `fix(web): proxy /j/<token> in dev, or no player can get in`.
Types in use are `feat`, `fix`, `docs`, `test`, `ci`, `config`, `build`; scopes are package
names (`core`, `web`, `workers`, or several).

The body is **prose, not bullets**, and explains the problem, the trade-off taken and how
it was verified — not what the diff already shows. Cite spec anchors (`§4`, `§6.2`, `R-52`)
where they apply. `git log` is the design record for this project; write for the person
who reads it in six months.

## Before marking a PR ready

Run what CI runs, because it is faster to find out locally:

```bash
pnpm typecheck      # tsc --build (TS 7) + svelte-check
pnpm test
pnpm build
```

A milestone closes on its **exit criterion** from [ROADMAP.md](ROADMAP.md), and an exit
criterion is an *observable* — something you can run, see or demonstrate. "Feels done" does
not close a milestone. Put the evidence in the PR, and say plainly what you did **not**
verify.

## Merging

Only when CI is green and the exit criterion is demonstrated. The merge publishes, so:

- **Never merge during a game**, wherever this is deployed. Replacing the Worker closes
  every live WebSocket. Clients reconnect with backoff and no data is lost, but every screen
  goes stale for a moment, and nobody needs that with six people in the field.
- **Never merge on game day** if it touches the ingest hostname or anything DNS-shaped. A
  cached negative DNS answer lasts 30 minutes and looks exactly like a broken setup.

To publish without a code change — rotating `INGEST_SECRET` between games (R-02), say — use
the **Run workflow** button on the workflow rather than an empty commit.
