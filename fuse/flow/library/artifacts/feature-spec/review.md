# Reviewing a feature spec

Criteria every review of a feature spec applies, together with the review gate's own guide and
the feature-spec guide. Use the review findings priorities: P0 wrong or unsafe, P1 a requirement
missed or a defect a user would hit, P2 worth fixing, P3 a nit.

**P1:**

- A published contract the spec changes without a compatibility plan. A contract is published
  when something outside this change reads or writes it: other repositories, deployed clients,
  stored data, or files that users write. The plan says whether the change is additive or
  breaking and how it is versioned and migrated, and the spec puts it to the owner as a decision.
