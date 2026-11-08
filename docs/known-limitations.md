# Known limitations

Effects of fuse-flow that are known and accepted as they are.

## A replaced step can reuse the old step's review results

fuse-flow decides whether a review ran by looking for its findings file, and it finds that file by its name. It does not check which step wrote the file.

If you edit a workflow while a workstream runs, and replace a finished step with a new one whose findings files have the same names, the old step's files count for the new step. For example, a step `spec-gate1` with one review writes `spec-gate1-round-1.json`. You replace it with a step `spec` that has two reviews, whose first review writes files with that same name. The new step's first review then counts as run, because the old file is still there, although no reviewer ran it.

The review cost shown in `status` also includes those old files.

This only happens after such an edit. To avoid it, give the new step a name that none of the old step's findings files start with.

## Komposer can save a workflow whose broken policy review guide fuse-flow would refuse

Komposer's validation opens no guide, so it cannot tell whether a gate's own guide hands the judgement to the working agent. On a gate with a guide of its own, a policy's or an artifact's review guide that is missing or is not a file is therefore a warning in Komposer, and the workflow can be saved.

`fuse-flow validate` reads the guide. When the gate's guide does not declare the working agent, it refuses the same workflow, and so does `start`. When the gate's guide does declare it, no review guide of a policy applies, and both accept the workflow.

A problem with the gate's own guide, and any problem on a gate with no guide of its own, is an error in Komposer as well.
