# Writing a threat model

A threat model names the security risks of a system within a defined scope and the controls that
mitigate them. It analyzes the documented architecture with the STRIDE categories, numbers every
threat and mitigation, and maps each threat to at least one mitigation, so that a security review
can check the design against it.

A step that only applies a threat model's checks to another artifact, for example while writing or
reviewing a design, needs only the "Threat checklist" and "Quality gate" sections below.

## Inputs

Use the paths the step or its consumed artifacts give you; search only for what they do not name.

- **System name** (required): the service or system being modeled.
- **Scope** (required): the boundaries of this threat model, which may be narrower than the whole
  system.
- **Design documents** (optional): architecture documents, design specs, API specifications,
  earlier security reviews.
- **Existing threat models** (optional): models of related systems to use as references.
- **Template** (optional): the organization's or project's threat model template. Without one, use
  the structure in "Document structure" below.

When the scope is not given, ask the owner, unless the step or its inputs already say.

## Confirmations

The model rests on your reading of the design, so the owner checks that reading at three points.
A calling workflow may handle a confirmation with a gate or step of its own. Where it has none for
a confirmation, ask the owner yourself at that point and wait for the answer, unless the workflow
says the step runs unattended; then record what was not confirmed as an assumption in the
Introduction. Used on its own, ask the owner yourself and wait for the answer each time:

- after documenting the architecture (method step 6) and before identifying threats: confirm the
  summarized scope, the architecture components, the trust boundaries and the security controls
  as you understood them;
- after defining the mitigations (method step 8) and before assembling the document: confirm the
  threat assessment and the mitigations, including each mitigation's implementation status;
- before handing over the document: confirm that the final document is accurate.

Correct the model with each answer before you go on.

## Principles

The model is only as accurate as its evidence. Follow these principles throughout:

- **Document-driven.** Base every threat on components that the design materials state explicitly.
- **No invented components.** Never assume a security control, service or component that the
  documents do not specify.
- **Ask rather than assume.** When a component or a security implementation is unclear, ask the
  owner, unless the step or its inputs already say. When no one can answer, record the gap as an
  assumption in the Introduction and do not build threats on it.
- **Stay in scope.** Limit the analysis to the documented architecture inside the scope.
- **Evidence-based threats.** Name threats that apply to the actual implementation, not every
  theoretical possibility.

## Method

### 1. Define the scope

List the in-scope components, features and aspects, and the out-of-scope ones explicitly. Note the
objective of the model, such as a launch, a compliance requirement or a security review, because it
decides how deep the analysis goes. Where the scope is open, start with specific features, follow
the data flows and trust boundaries, and focus on the highest-risk components.

### 2. Gather and summarize the design documents

Sort the documents by type (architecture, API specification, security review). Read them in batches
of two or three, extract what is in scope, and summarize each batch before reading the next. Note
gaps and contradictions between documents; when they disagree, ask the owner which takes
precedence, unless the step or its inputs already say. Consolidate the summaries into one view of
the architecture.

### 3. Collect the service information

Within the scope, record:

- core functionality and architecture components;
- how data is handled and stored;
- authentication and authorization;
- integration points with other services;
- known security concerns and requirements;
- the deployment model: internal, external, multi-tenant.

### 4. Analyze the template and reference models

Extract the required sections from the template. Read reference models at most two at a time,
summarize the patterns that apply, and use them as guidance for this model.

### 5. Write the introduction

Cover the project background and business context, a short service overview, the scope (in scope
and out of scope), the security tenets that apply, the key assumptions with their possible
mitigations, and administrative information: earlier security reviews, the owning team and the
documentation references.

### 6. Document the architecture

Describe the high-level design with architecture diagrams, the low-level design of the in-scope
components, the authentication and authorization mechanisms, and the API specifications (methods,
operations, authorization, accessibility). Build an asset inventory: each asset, whether it is new
or existing, its usage, its data classification and its security considerations. Mark out-of-scope
components clearly.

### 7. Identify the threats

Identify the threat actors, external and internal, and the security anti-patterns within scope.
Then go through each in-scope component against every STRIDE category in the "Threat checklist".
Number threats consistently (T-001, T-002, ...) and give each a priority. Expect roughly 10 to 15
candidate threats; consider components separately and use similar systems' models as references.

### 8. Define the mitigations

Start with the highest-priority threats. Document the baseline security controls that apply, then
the system-specific mitigations, each mapped to the threats it addresses. Number mitigations
consistently (M-001, M-002, ...). Give each mitigation its implementation status and the evidence
that verifies it. Every threat needs at least one mitigation. Add a security testing strategy: the
test cases, their coverage and the test types.

### 9. Assemble the document

Organize the sections by the template, complete every required section, and add the appendices.
Keep the STRIDE threats and system-specific mitigations in the main document, separate from
supplementary guidance. Check the result against the "Quality gate" below. Write it to the step's
artifact path; used on its own, put it next to the design documents it models, and confirm it
with the owner as "Confirmations" says.

## Working with large inputs

Design documents and templates are large. Summarize each document as soon as you have read it and
work from the summaries, not the raw text. Read at most two or three large documents per batch,
handle one item at a time, and build the final document section by section. If the context runs
short, continue with the information you have and record what was not covered.

## Document structure

Use the project's or organization's template when there is one. Otherwise use these sections:

1. **Introduction:** project background and service overview; scope (in scope and out of scope);
   security tenets and key assumptions; administrative information (security reviews, team,
   documentation).
2. **System architecture:** high-level and low-level design; authentication and authorization;
   API specifications and asset inventory.
3. **Threat analysis:** threat actors and security anti-patterns; a STRIDE threat table with
   number, category, component, description and priority.
4. **Mitigations:** baseline security controls; a system-specific mitigation table with number,
   the threats it addresses, implementation status and verification evidence; the security
   testing strategy.
5. **Appendix A:** terminology, monitoring and logging.
6. **Appendix B:** references and supporting documentation.

## Threat checklist

Apply every category to every in-scope component:

| Category                   | What it covers           |
| -------------------------- | ------------------------ |
| **S**poofing               | Identity                 |
| **T**ampering              | Data integrity           |
| **R**epudiation            | Audit trails             |
| **I**nformation disclosure | Data leaks               |
| **D**enial of service      | Availability             |
| **E**levation of privilege | Authorization bypass     |

Then check that:

- authentication and authorization threats are analyzed;
- encryption of data in transit and at rest is addressed;
- the external trust boundaries are identified;
- every threat has at least one mitigation, and every HIGH-priority threat has one defined;
- each mitigation states its implementation status;
- assumptions and limitations are written down.

## Quality gate

**CRITICAL (must fix):**

- Authentication and authorization threats not analyzed.
- Encryption of data in transit and at rest not addressed.
- No mitigations defined for HIGH-severity threats.
- External trust boundaries not identified.

**IMPORTANT (should fix):**

- STRIDE categories not covered for every component.
- No security testing strategy.

**SUGGESTION:**

- Score threat likelihood and impact.
- Name the specific AWS security service behind each mitigation, for AWS systems.

Also confirm that the scope is defined and applied consistently, every template section is
complete, every threat is categorized and mapped to a mitigation, and assumptions and limitations
are documented.

Present findings in the order CRITICAL, IMPORTANT, SUGGESTION. When you produced the threat model,
fix what the gate finds before handing it over. When you apply the gate to someone else's artifact,
report all findings and leave fixing to the caller.
