# Checking user-facing text

This guide covers the user-facing text section of the test coverage report, for a step that asks
you to check the text of a console-style user interface: labels, buttons, messages, help text and
descriptions. Check the text against the Cloudscape design system's writing guidance and the rules
below, and report findings by severity with the current text and the corrected text.

Skip the section, and say so in one line, when the change has no user-facing text.

## Sources

In priority order, where they disagree:

1. The project's own style guide or glossary, when it has one.
2. Cloudscape's help system pattern (https://cloudscape.design/patterns/general/help-system/) and
   help panel component (https://cloudscape.design/components/help-panel/).
3. Cloudscape's alert component (https://cloudscape.design/components/alert/).
4. Cloudscape's accessibility guidance
   (https://cloudscape.design/foundation/core-principles/accessibility/).

## What to check

### Voice and tone

- Active voice: "You can select", not "Can be selected".
- Second person, "you" and "your", for the customer; first person, "we", for the product or
  service.
- Present tense for current state and behavior.
- Direct and friendly, conversational yet professional, in plain everyday language without jargon.
- Never: "please" or "thank you", "sorry", exclamation points, ellipses, ampersands (except in
  brand names), "e.g.", "i.e.", "etc.", "just", "simply", future tense contractions such as
  "you'll".

### Capitalization and punctuation

- Sentence case for headers, buttons and labels, never title case.
- Proper nouns and service names capitalized as their owners publish them.
- End punctuation in body text and descriptions; none on headers, buttons or labels.

### Structure and clarity

- Short, scannable text; simple sentences with one main clause.
- Parallel construction in lists: all verbs or all nouns.
- Device-independent words: "choose" or "select", not "click".
- No directional words: "previous" and "following", not "above" and "below".
- Context before a request for action, and focus on the customer's task.
- A page description has at most two sentences; a section description has one.

### Terminology

- Terms consistent within the application and with its public documentation.
- Service, product and third-party names exactly as their owners publish them.
- New feature names in lowercase, not title case.
- Acronyms spelled out on first use, unless universally known.
- Inclusive terms. No internal code names, project names, employee names or email addresses.

### Help content

- An Info link next to each console page title.
- The help panel adds to the interface instead of repeating it, with one to three "Learn more"
  links to relevant documentation.
- Help links work and lead to real documentation, not a hardcoded placeholder. Links within the
  console stay in the console; links that leave it are marked as external.

### Components

- **Alerts:** say what happened, why, and what to do next, at the right severity.
- **Buttons:** one to three words, starting with a verb, saying what the action does: "Create
  bucket", not "Submit".
- **Links:** descriptive link text, never "click here".
- **Form fields:** a label in sentence case on every input, placeholder text or hints that show
  the constraints, and validation messages that say what is wrong and how to fix it.

### Accessibility and localization

- Enough context for a screen reader, and error messages with specific guidance.
- Concise wording that leaves room for 30% expansion in translation.
- Global English without idioms or culture-specific expressions.

### Accuracy and exposure

- The text describes what the feature actually does, and instructions are correct and complete.
- No content is missing: every label, message and help text the page needs actually renders.
- No internal system details reach the customer: stack traces, internal IDs, internal
  information about the company.
- Fictitious example names follow the organization's legal and brand guidance.

### Modal verbs

"Must" for obligations, "can" for capabilities, "we recommend" or "consider" for suggestions,
"might" or "may" for possibilities. Avoid "should", which is ambiguous between a recommendation
and a requirement.

## Examples

| Problem | Current | Corrected |
| --- | --- | --- |
| Passive voice | The instance can be stopped by clicking the button | To stop the instance, choose Stop |
| Title case | Create New Resource | Create new resource |
| Jargon | Instantiate a new compute resource | Create a new instance |
| Wordy | In order to be able to proceed with the configuration... | To configure... |
| Directional | Click the button below | Choose Create |

## Severity

- **CRITICAL:** an error message that exposes internal system details; an ambiguous action label;
  a form input without a label; text that misdescribes what the feature does; content that is
  missing or does not render.
- **WARNING:** a breach of the voice and tone rules, including a prohibited term; capitalization
  other than sentence case; jargon or an unexplained acronym; missing help content for a complex
  configuration option; a help link that does not work.
- **SUGGESTION:** a localization note for text that may not translate directly; an empty state
  without an actionable next step; wording that could be shorter.

## The report section

Give the overall verdict and the count of findings per severity, then each finding, most severe
first:

- **Where:** the page, component or file.
- **Problem:** what is wrong, with the current text quoted.
- **Rule:** the rule or source above that it breaks.
- **Fix:** the corrected text.

Before you finish, remove findings that turned out to be correct text, and make sure the counts
match the list.
