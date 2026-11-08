# Keeping a pull request ledger

The ledger is the memory of a loop that babysits a set of pull requests. It holds everything a
wake needs, so the loop survives a long gap, a compacted conversation, a restarted session or a
new session that picks it up. Read it at the start of every step, and write to it before you
leave the step. Keep it short: a wake that changes nothing adds one line, not a page.

"Pull request" here means any review process of that kind: a pull or merge request, a code
review, a patch series on a list. Use the process the project uses, found as the workflow's first
steps describe.

## What it records

- **The set.** One row per pull request: a short name for the status line (`PR1`, `PR2`, or the
  number the process gives it), its link, where its fixes are made (the current checkout, or a
  separate checkout with its path and branch), and its state: `open`, `merged`, `blocked` or
  `stalled`. A stalled pull request counts as blocked. For a merged one, note who merged it and
  at which revision, where the process shows it.
- **The autonomy the owner granted**, as the autonomy step recorded it: the level, whether the
  agent may merge, and the permissions it asked for. Each level includes the ones before it:
  1. fix mechanical failures: failing analyzers, builds and tests;
  2. also fix trivial human or agent feedback, such as a name, the order of tests, a missing
     test case or a missing comment;
  3. also answer human questions about the pull request;
  4. full autonomy: act on all feedback you agree with.
- **A fingerprint per pull request**: what changes when something happens, such as the latest
  revision, the state of each check or analyzer, the newest comment's id and time, the approvals,
  and whether it is merged. Note when you last polled it and when it last changed.
- **Feedback items**, one per comment, review or tool result that asks for something: its pull
  request, where it came from, what it asks, and its status: `open`, `done` (with what you did),
  `out of level` (the granted level does not allow acting on it), or `disputed` (you disagree,
  with your reason). Items stay until they are done; a fingerprint only spares rereading data
  that has not changed, so an item still open from an earlier wake is worked on again.
- **Revisions**: for each revision with fixes, its pull request, what it fixes, what cleared it
  (the review that passed in that cycle, or the owner's explicit acceptance or waiver of a
  blocked review, with the owner's words), and whether it is published yet. Record it once the
  review passed, and mark it published when you publish it.
- **What the owner was told**: each blocker reported to the owner, with the time, so it is not
  reported twice. Record it in the wake whose message tells the owner.
- **The report**, as its last section, once the loop ends.

## Each wake

1. **The wait.** The step block's WAIT line gives the base wait. Lengthen it as the backoff
   below says. Wait with your harness's own way to wait or to schedule a wake-up, such as a
   monitor or a scheduled job in Kiro Crew, `/loop` in Claude Code, or an automation in the Codex
   app. If your harness has none, say so to the owner and offer the ways on: the owner says
   "continue" on coming back, you wait within this turn for a limited time, or the owner
   approves a system job that resumes the session. Before you wait, end your message with the
   status line. The first cycle has no wait.
2. **The fingerprint.** Read each pull request's fingerprint data with the cheapest call the
   process offers. Where nothing changed and no item is open, add nothing but the poll time.
   Read comments, diffs and logs only for a pull request whose fingerprint changed.
3. **New feedback** becomes feedback items. A pull request merged since the last wake is marked
   `merged`, however it got there.

## The status line

Every wake ends with one line that names every pull request and its state, in the order of the
set, so the latest line in the conversation shows the whole set at a glance:

    PR1: blocked - PR2: merged - PR3: open

Print it also on a wake that changed nothing and on one that could not act. It is the last line
of the message, after anything fuse-flow asks you to print; on a quiet wake, add nothing of your
own to it.

## Blocked pull requests

A pull request is blocked when it has feedback the granted level does not allow you to act on,
or feedback you disagree with. Feedback of a kind the level covers, such as a missing comment,
also blocks it when acting on it needs a fact only the owner has, such as what a value means;
the blocker then asks the owner that question. In the wake that marks it blocked, tell the owner once, before the
status line: what the feedback asks, why you cannot act on it (the level does not cover it, or
your reason for disagreeing), and what you suggest. Record that you told the owner. Keep polling a
blocked pull request while others are open: an approval, a reply or the owner's decision may
unblock it.

The owner may accept or waive a review that blocked a fix. Then the fix may be published,
recorded next to its revision with the owner's words. Never decide that yourself.

## Publishing

Publish a code fix only when the review of that cycle passed for its revision, or the owner
accepted or waived it. Check the pull request's state again right before you publish. If it was
merged in the meantime, by the owner or by anyone, publish nothing to it and post no reply on it:
mark it `merged`, record the fix's revision as not published, and list it in the report and in
what is left open. Leave the fix where it is, as a local commit, and keep the checkout that holds it; whether to
drop it or send it as a new pull request is the owner's decision. Merge only where the owner granted it and the house rules
let the author merge, and only once the process's required approvals and checks hold for the
revision you merge.

## Quiet pull requests

While anything happens, poll at the base wait. Once a pull request has been quiet for a few
hours, double the wait each cycle, up to about two hours; go back to the base wait on any change.
After about three days with no reviewer activity, mark it `stalled`, which counts as blocked,
tell the owner once, and suggest asking the reviewers. Stalled pull requests let the loop end.

## A wake that cannot act

Expired credentials, a tool approval that waits or times out, a permission mode a restart reset,
an outage: tell the owner once what is missing and how to restore it, as far as the house rules
or the tool's own messages say, record it, and mark no pull request blocked or stalled for it.
Record the failed poll on each pull request it affects, with the time and the error, so the ledger
shows the last state as last seen, not as current. Later steps of that cycle that need the review
tool, such as checking a state before publishing, publish nothing and reply nothing. Go on polling,
with the same backoff as for a quiet pull request; once access returns, go back to the base wait
and carry on where the ledger says.

## The report

The report step writes the report, once the loop has ended; the steps inside the loop leave its
section empty. Write it as the ledger's last section and print it: which pull
requests merged, which are blocked or stalled, and for each blocker what is asked, why you could
not act, and what you suggest. List any reviewed fix that was not published because its pull
request merged first.
