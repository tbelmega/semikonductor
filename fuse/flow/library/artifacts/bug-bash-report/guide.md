# Writing a bug bash report

The report tells the owner what the bug bash achieved and what is left for them, in a few minutes
of reading. Every count and claim in it must match the findings index and the review records.

## What it holds, in this order

1. **For the owner:** the decisions they must make, each with the context to decide it and your
   recommendation. Point to the decisions file for those already recorded there. Each area the
   run stopped fixing because it did not converge comes with its refactoring proposal, as the
   bug-bash-plan guide describes.
2. **Outcome:** whether the run met its done condition or reached its limits; the number of
   findings by severity and by disposition; the commits and the checks that pass on the final head.
   When the limits ended the run with findings at or above the threshold open, the case for a
   second pass: what this run found and fixed for its cost, what is open, and the time and cost a
   second pass would take, estimated from the cost ledger.
3. **What changed, by area:** the behaviours fixed, in a few lines per area, with no commit-by-commit
   list.
4. **Left as it is:** deferred, listed and rejected findings, each with the reason.
5. **Reviews:** for each fix series, the last review and its result.
6. **Method:** what each lens and model found and cost, from the cost ledger, with the costs it
   could not measure named; what worked and what was wasted, and what the next bug bash should do
   differently.

In a report-only run, leave out what changed, and give each confirmed finding a recommended fix
and an estimate of its size instead.
