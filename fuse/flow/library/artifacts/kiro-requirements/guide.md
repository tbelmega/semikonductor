# Writing a Kiro requirements document

A Kiro requirements document, `requirements.md`, is the first of the three files of a Kiro IDE
spec for one feature. It restates the feature's user stories and turns their acceptance criteria
into EARS (Easy Approach to Requirements Syntax) statements. In Kiro's spec-driven development it
is the source of truth for the design and the tasks that follow it: the `kiro-design` guide in the
fuse library (`fuse/flow/library/artifacts/kiro-design/guide.md` in the fuse-konductor clone)
builds on it.

## Inputs

Use the paths the step or its consumed artifacts give you, or the documents the request names;
search only for what they do not name.

1. The user stories, with acceptance criteria, written with the `user-stories` guide in the fuse
   library (`fuse/flow/library/artifacts/user-stories/guide.md` in the fuse-konductor clone).
2. The requirements document, written with the `requirements` guide in the fuse library
   (`fuse/flow/library/artifacts/requirements/guide.md`): requirements, quality requirements,
   constraints and assumptions.

## Where the file goes

Write one `requirements.md` for one feature, into the feature's spec directory. The step's
artifact path decides it: the spec directory is the folder of that path. When the step or its
caller names a spec directory instead (some callers call it `spec_dir`), write there. Only when
neither is given, use the Kiro IDE default, `.kiro/specs/<feature>/`, which is where Kiro itself
writes specs.

The feature's directory name is kebab-case: lowercase letters, digits and hyphens, derived from
the feature or epic name, two to four words.

| Feature                      | Directory name                 |
| ---------------------------- | ------------------------------ |
| Network Monitoring Dashboard | `network-monitoring-dashboard` |
| VPC Flow Log Analyzer        | `vpc-flow-log-analyzer`        |
| User Authentication & SSO    | `user-authentication`          |
| Alert Rule Management        | `alert-rule-management`        |

## EARS format reference

EARS has six patterns for writing unambiguous, testable requirements. Every acceptance criterion
MUST use one of them.

### 1. Ubiquitous

For requirements that apply at all times, with no trigger or precondition.

**Template:** `THE [system] SHALL [response]`

**Example:** `THE monitoring service SHALL encrypt all data at rest using AES-256`

### 2. Event-Driven

For requirements triggered by a specific event.

**Template:** `WHEN [trigger], THE [system] SHALL [response]`

**Example:** `WHEN a new VPC is discovered, THE monitoring service SHALL create a baseline configuration record`

### 3. State-Driven

For requirements that apply while a precondition holds.

**Template:** `WHILE [precondition], THE [system] SHALL [response]`

**Example:** `WHILE the monitoring agent is in degraded mode, THE system SHALL buffer metrics locally and retry upload every 60 seconds`

### 4. Optional

For requirements tied to an optional feature or configuration.

**Template:** `WHERE [feature included], THE [system] SHALL [response]`

**Example:** `WHERE custom alerting rules are enabled, THE system SHALL evaluate user-defined thresholds alongside default rules`

### 5. Unwanted

For requirements that handle error conditions, failures or unwanted behavior.

**Template:** `IF [trigger], THEN THE [system] SHALL [response]`

**Example:** `IF the DynamoDB write fails with a ConditionalCheckFailedException, THEN THE system SHALL retry with exponential backoff up to 3 times`

### 6. Complex

For requirements that combine a precondition with a trigger.

**Template:** `WHILE [precondition], WHEN [trigger], THE [system] SHALL [response]`

**Example:** `WHILE the system is processing a batch import, WHEN a duplicate record is detected, THE system SHALL skip the duplicate and log a warning with the record ID`

## Converting Given/When/Then to EARS

Acceptance criteria written as Given/When/Then convert to EARS with these mappings:

| Given/When/Then keyword | EARS keyword | Role                                           |
| ----------------------- | ------------ | ---------------------------------------------- |
| **Given**               | **WHILE**    | Precondition: the state that must hold         |
| **When**                | **WHEN**     | Trigger: the event that initiates the behavior |
| **Then**                | **SHALL**    | Response: the required system behavior         |

**Input:**

```
Given the user is authenticated
When they submit a monitoring configuration
Then the system saves the configuration and returns a confirmation
```

**EARS:**

```
WHILE the user is authenticated, WHEN a monitoring configuration is submitted, THE system SHALL save the configuration and return a confirmation with the configuration ID
```

**Input:**

```
Given the API rate limit is exceeded
Then the system returns a 429 status with a Retry-After header
```

**EARS:**

```
IF the API rate limit is exceeded, THEN THE system SHALL return a 429 status code with a Retry-After header indicating the reset time in seconds
```

Choose the pattern from the clauses present:

- Only **Then**: Ubiquitous (`THE system SHALL ...`).
- **When** and **Then**: Event-Driven (`WHEN ..., THE system SHALL ...`).
- **Given** and **Then**, with no When: when the Given clause describes an error or failure
  condition, Unwanted (`IF ..., THEN THE system SHALL ...`); otherwise State-Driven
  (`WHILE ..., THE system SHALL ...`).
- **Given**, **When** and **Then**: Complex (`WHILE ..., WHEN ..., THE system SHALL ...`).

Always make the response more specific than the original Then: add concrete values, status codes,
timeouts and identifiers.

## Document structure

The `requirements.md` MUST follow this structure:

```markdown
# Requirements Document

## Introduction

[2-4 sentence summary of the feature, its purpose, and the primary user persona it serves. Reference the source user stories or product requirements document.]

## Requirements

### Requirement 1: [Short descriptive title]

**User Story:** As a [role], I want [feature], so that [benefit]

#### Acceptance Criteria

1. WHEN [event] THE [system] SHALL [response]
2. WHILE [precondition], WHEN [trigger], THE [system] SHALL [response]
3. IF [error condition], THEN THE [system] SHALL [response]

### Requirement 2: [Short descriptive title]

**User Story:** As a [role], I want [feature], so that [benefit]

#### Acceptance Criteria

1. THE [system] SHALL [response]
2. WHEN [event], THE [system] SHALL [response]
3. WHERE [feature included], THE [system] SHALL [response]
```

- Each requirement maps to one user story.
- Requirement titles are short and descriptive, three to eight words.
- Each requirement has three to eight acceptance criteria in EARS format.
- Every criterion MUST contain the keyword `SHALL`.
- Number the criteria sequentially within each requirement.
- Group related requirements together, for example create, read, update and delete operations
  together, and error handling together.

## Method

1. **Read the user stories** and the requirements document from the inputs above.
2. **Keep to one feature.** One `requirements.md` covers one feature, the one whose spec
   directory you write to. Feature splitting happens earlier, in a feature split. When the stories
   span several features, keep only those in scope for this feature, using the feature scope the
   step gives you. Do not group them into several features or write more than one
   `requirements.md` in one pass; each feature gets its own pass with its own spec directory.
3. **Convert each story.** Keep the original story statement ("As a ..., I want ..., so that
   ..."). Convert each acceptance criterion to EARS with the rules above. Add the edge-case
   criteria the stories leave out: error handling, boundary conditions and concurrent access.
4. **Write the document.** Write the introduction, then each requirement with its story and its
   criteria, numbered within the requirement.
5. **Check it** against the checks below before you present it.

## Quality checks

**CRITICAL (must fix before done):**

- An acceptance criterion without EARS keywords (`SHALL`, `WHEN`, `WHILE`, `WHERE`, `IF`/`THEN`).
- A criterion without `SHALL`: every criterion must say what the system SHALL do.
- A requirement without its source user story.
- A feature directory name that is not kebab-case.
- `requirements.md` without the Introduction or the Requirements section.

**IMPORTANT (should fix):**

- Vague triggers without a specific event ("when something happens": name the exact event).
- Untestable criteria, with no measurable outcome or observable behavior. Replace vague terms
  with values: "fast" with "< 200ms", "many" with a count.
- Missing error or failure scenarios for a requirement that involves external calls or user
  input; cover them with the Unwanted pattern.
- Criteria that describe implementation details instead of observable behavior.
- Fewer than three acceptance criteria in a requirement.

**SUGGESTION:**

- Edge-case criteria: concurrent access, boundary values, empty states.
- Performance criteria in the Ubiquitous pattern (`THE system SHALL respond within X ms`).
- Security criteria in the Unwanted pattern (`IF unauthorized access is attempted, THEN ...`).
- Cross-references to the requirements document's quality requirements as additional criteria.

Report the findings in the order CRITICAL, IMPORTANT, SUGGESTION. Fix every CRITICAL finding
before you present the document, and present the rest with it, unless the step says how to handle
them.
