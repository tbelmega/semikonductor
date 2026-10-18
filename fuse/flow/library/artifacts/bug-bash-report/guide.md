# Writing a bug bash report

The report tells the owner what the bug bash achieved and what is left for them, in a few minutes
of reading. Every count and claim in it must match the findings index and the review records.

## What it holds, in this order

1. **For the owner:** the decisions they must make, each with the context to decide it and your
   recommendation. Point to the decisions file for those already recorded there.
2. **Outcome:** whether the run met its done condition or reached its limits; the number of
   findings by severity and by disposition; the commits and the checks that pass on the final head.
3. **What changed, by area:** the behaviours fixed, in a few lines per area, with no commit-by-commit
   list.
4. **Left as it is:** deferred, listed and rejected findings, each with the reason.
5. **Reviews:** for each fix series, the last review and its result.
6. **Method:** what each lens and model found and cost, what worked and what was wasted, and what
   the next bug bash should do differently.

In a report-only run, leave out what changed, and give each confirmed finding a recommended fix
and an estimate of its size instead.
