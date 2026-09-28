<!--
A merge to main deploys. Filling this in is how the next reader knows what was
actually established, as opposed to what was intended.
-->

## What this is

<!-- The problem, and the shape of the decision taken. Not a list of the diff. -->

## Exit criterion

<!--
Which milestone, and its exit criterion from ROADMAP.md verbatim. An exit criterion
is an observable: something you can run, see or demonstrate. Paste the evidence —
command output, what you saw on the phone, the audit result.

Not a milestone? Delete this section.
-->

## Verified

<!--
What you actually ran, and against what. "Tests pass" is weaker than it looks —
say whether this was exercised against `wrangler dev`, against the deployed Worker,
or on a real phone.
-->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`

## Not verified

<!--
Load-bearing, and the section most worth filling in honestly. Anything you could
not check here — no browser on the machine, needs a second phone, needs the
dashboard, one config line that only the first CI run can prove. An unstated gap
reads as a covered one.
-->

## Deploy impact

<!--
Does merging change production behaviour, or is it documentation only? Anything
that needs doing in the Cloudflare dashboard, a secret to rotate, a migration to
watch. If this touches DNS or the ingest hostname, say so — do not merge that on
game day.
-->
