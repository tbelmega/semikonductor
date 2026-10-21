# Writing a usability review report

The report tells the owner, in a few minutes of reading, what their audience would meet and what
the agent recommends. Every count, step count and claim in it must match the findings index, the
walkthrough records and the cost ledger. The report recommends; it changes nothing and starts
nothing.

## What it holds, in this order

1. **Outcome:** whether every planned lens reported or the limits ended the run. When the limits
   ended it, list first every core task without a complete walkthrough or step count, every lens
   that did not run, and every state the inventory did not reach. Then the number of root causes
   and findings by severity and by disposition, and the questions still open in the decisions
   file, each with the default the run went ahead with.
2. **Recommended fixes:** one entry per root cause the owner accepted as a fix: the change, every
   place it applies, and an estimate of its size.
3. **Redesign proposals:** one entry per root cause the owner chose to redesign: the problem and
   the persona it hurts, the evidence, the shape of the change you propose, the findings it would
   close, and its size.
4. **Findings by core task and by screen,** each with its severity, persona and evidence (a
   screenshot, a walkthrough line or the code), and whether two model families found it.
5. **Step counts:** for each core task, the shortest path's count against each walkthrough's count,
   with the steps that made the difference.
6. **Left as it is:** deferred and rejected root causes, each with the reason, and every discarded
   blind result, walkthroughs and glossary guesses alike, with its lens and the reason.
7. **Method:** what each lens and model found and cost, from the cost ledger, with the costs it
   could not measure named; what worked, what was wasted, and what the next review should do
   differently.
8. **A test with real people,** when the plan asks for it: the script the usability-review-plan
   guide describes.

Write each entry so the owner can act on it later without the run's records: a fix or proposal
names what the user sees, not only finding ids.
