# Writing user stories

Turn the requirements (a requirements summary, a product or business requirements document, a
feature description, or partial stories) into epics and user stories that a development team can
build from, each with testable acceptance criteria and traceable to a business objective.

## INVEST

Every user story is:

- **Independent:** it can be developed without depending on another story.
- **Negotiable:** it captures the essence without over-specifying the implementation.
- **Valuable:** it delivers clear value to a specific user.
- **Estimable:** it has enough detail to estimate the effort.
- **Small:** it can be completed in one iteration, one to five days.
- **Testable:** it has clear, verifiable acceptance criteria.

## Structure

- **Epic:** a title of five to ten words; a description of two to four sentences stating the
  business objective; three to five key objectives; the list of its stories.
- **User story:** a title of three to eight words; the description "As a [persona], I want [goal]
  so that [benefit]"; three to eight testable acceptance criteria as a bulleted list.

## Scope

Unless the step or the owner sets the scope, pick one and say which:

- **MVP:** 10 to 15 stories, the fastest path to value.
- **Production:** 20 to 30 stories, the full feature set.
- **Full:** 30 to 40 stories, including edge cases.

## Procedure

1. **Extract the requirements** from the inputs: business objectives, user needs, functional and
   non-functional requirements, constraints and assumptions. Note where each came from in the
   source, so every story can be traced back, and note ambiguities, overlaps and conflicts in the
   source. For tabular input, treat line items as candidate stories, group related items into
   epics, use column headers and metadata for acceptance criteria, and keep any priority or order.
2. **Decide the level:** an epic is a large feature needing several iterations or teams; a story
   delivers value within one iteration.
3. **For each epic,** write its title, description and three to five key objectives, then break it
   into three to eight stories that together fulfill it.
4. **For each story,** check it against INVEST and write three to eight specific, testable
   acceptance criteria. Suggest an epic when the story belongs to a larger feature.
5. **Throughout:**
   - Keep each story small and focused on one capability. Separate different filtering, sorting
     and display criteria into distinct stories.
   - Describe observable behavior and outcomes in the acceptance criteria, not implementation.
   - Keep each story traceable to a business objective, and state its assumptions and
     dependencies.
6. **Where the requirements are ambiguous or incomplete,** name the gap, state the assumption you
   made, and give the options. When the step lets you ask the owner, ask targeted questions.
7. **For a large volume of requirements,** group the stories logically, mark the highest-value
   ones, and suggest phases when that helps.

Say so in the document when you need more business context, when a story may create technical
dependencies that need an architect, when a story is still too large, or when an acceptance
criterion may not be feasible. Also say which parts of the input you could not process, such as an
unsupported file format, or did not cover because there was too much of it, and how the rest
should be handled. Never hand over stories as if they covered input you did not read.

## Examples

**Epic: Media Asset Filtering System**

Implement a filtering system for the ContentHub Media Assets tab, so users can search and organize
assets by several criteria and keep their preferred filter settings.

Key objectives: streamline asset discovery; target assets precisely through filter combinations;
support collaborative workflows through shared filters; keep user preferences across sessions.

- **Locale-based Asset Filtering.** As a content manager, I want to filter assets by locale so that
  I can focus on specific language versions of content.
  - A locale filter dropdown is available in the ContentHub Media Assets tab.
  - All available locales are listed in the dropdown.
  - The selected locale shows only matching assets.
  - Several locales can be selected at once.
  - The filter state is kept when navigating away and back.
  - A clear-filter option is available.
- **QA Status Filtering.** As a quality assurance specialist, I want to filter assets by QA status
  so that I can manage my review workflow efficiently.
  - The QA status filter offers Not Reviewed, QA Approved and QA Rejected.
  - The selected status shows only matching assets.
  - Several statuses can be selected at once; assets with any matching status are shown.
  - The filter state is kept when navigating away and back.
  - A clear-filter option is available.

**Epic: Media Asset Review Workflow**

A review system for QA of one or many media assets in ContentHub: an interface for reviewing assets,
managing QA status and keeping notes.

Key objectives: streamline QA review; keep status management consistent; capture detailed
feedback; handle special asset types; enable efficient bulk reviews.

- **Asset Slideshow Review Interface.** As a content reviewer, I want a slideshow-style interface to
  review several assets in sequence so that I can complete reviews faster.
  - A modal displays one asset at a time, centered and properly scaled, with its metadata.
  - The current position in the queue is shown, for example "3 of 10".
  - Navigation controls move forward and backward in the queue.
  - Loading states are handled gracefully.
- **QA Status Management.** As a quality analyst, I want to set and update the QA status of assets
  during review so that I can track progress and communicate approval decisions.
  - The status options Not Reviewed, QA Approved and QA Rejected are available.
  - The current status is clearly shown.
  - A status change is saved immediately and shown in the main asset list.
  - A status change is confirmed.

## Self-check

Check the stories before handing them over, and fix what you find.

**Must fix:**

- Stories are not independent: there are circular dependencies between them.
- Acceptance criteria describe implementation details instead of observable behavior.
- A story is too large to complete in one iteration of one to five days.
- Acceptance criteria miss error conditions and edge cases.

**Should fix:**

- Personas are generic ("user", "admin") instead of specific ("enterprise DevOps engineer").
- Acceptance criteria use vague terms ("fast", "easy") instead of measurable outcomes.
- Stories miss performance or scale requirements where they apply.

**Worth considering:**

- Splitting very large stories further.
- Adding non-functional requirements as explicit stories.
