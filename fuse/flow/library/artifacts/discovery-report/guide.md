# Writing a discovery report

A discovery report maps a deployed web application as it runs in the browser: every page reached,
every interactive element on it, and every form with its validation rules, error messages and
conditional fields. It is the input for writing the application's UI tests, whether test prompts
or functional specs, so it records what the live DOM shows, not what the code or the screenshots
suggest. Form inspection follows `dom-inspection.md` next to this file; read it as well.

This guide defines what to discover and how to structure the report. When a calling workflow runs
the discovery, the workflow handles the credentials, the owner's confirmation and the cleanup, and
passes in what it decided: the application's URL, the path of a credentials file (empty when the
application is public), whether forms may be submitted, and any limits that replace the defaults
below.

## Used on its own

Without a calling workflow, settle the same things yourself before you open the application:

- Ask the owner for the URL and for the account to use, unless the request already says. Take the
  credentials as a credentials file or as values you keep out of every file you write; never
  write a password into the report, a screenshot name, a log line or any other artifact, and
  never display it.
- Ask the owner to confirm that you may use this live application with that account, and
  separately whether discovery may submit forms on it, because a submission can create records,
  send email or start workflows. Until the owner says yes to submission, treat it as not
  confirmed.
- At the end, sign out if you signed in and close the browser session you opened, as Phase 6
  says.

## Discovery protocol

### Phase 1: Authentication

Skip this phase only when no credentials were given: the calling workflow passed an empty
credentials file path, or, used on its own, the owner gave neither a credentials file nor the
values. The application then needs no sign-in.

Otherwise take the credentials before navigating, from the credentials file or from the values the
owner gave, then sign in with the selectors of the login page. Values given directly stay out of
every file you write, as the file's contents do. Choose the flow that matches the application's
sign-in behavior.

**Flow A: redirect-based sign-in** (for example Cognito Hosted UI, OAuth or single sign-on, a SAML
identity provider). After signing in, call `waitForURL('**', { waitUntil: 'networkidle' })` so the
redirect completes.

**Flow B: in-page sign-in** (a single-page application that authenticates without navigating). Do
NOT use `waitForURL`: it hangs waiting for a redirect that never happens. Wait for a positive
signal instead, in this order of preference:

1. A selector of an authenticated page becoming visible (navigation bar, avatar, dashboard
   heading): `page.waitForSelector(<post-auth-selector>, { timeout: 10000 })`.
2. A URL change away from the login URL: `page.waitForURL(url => url !== loginUrl, { timeout:
   10000 })`.
3. Only when neither signal is available, `page.waitForTimeout(3000)`, and note in the report that
   the fallback was used.

In both flows, reuse the session for every later page; do NOT sign in again on each page.

### Phase 2: UI framework detection

On the first page past any login or single sign-on page, inspect the DOM:

- `awsui-` prefixed elements: `ui_framework=cloudscape`.
- `MuiButton`, `MuiTextField`: `ui_framework=material-ui`.
- Otherwise: `ui_framework=plain-html`.

Put `ui_framework` in the report. Test generation uses it to choose framework-specific selector
patterns.

### Phase 3: Page crawl

Navigate depth-first from the URL:

- Track the visited URLs and visit none twice.
- Take a screenshot after each page loads.
- Stop after 50 pages or 30 minutes, whichever comes first, unless the caller set other limits.
  When a limit is reached, note the cutoff in the report.
- Do NOT leave the application's domain. The identity provider's redirects while signing in are
  allowed.

### Phase 4: Per-element capture

For every interactive element on each page, capture:

| Field                 | Description                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `selector_type`       | Most reliable selector: `data-testid` → `aria-label` → role → placeholder → CSS fallback |
| `exact_text`          | Exact visible label or button text as rendered, not inferred                             |
| `initial_state`       | `enabled`, `disabled`, `hidden`, or `checked` at page load                               |
| `interaction_pattern` | `click`, `two-step` (open → select), `type`, `checkbox`, `radio`, `form-submit`          |
| `duplicate_dom`       | Flag if multiple elements match the same selector                                        |

### Phase 5: Form DOM inspection

For every form on each page, follow `dom-inspection.md`:

- Extract the HTML5 validation attributes (`required`, `pattern`, `min`, `max`, `minlength`,
  `maxlength`).
- Determine the `validation_trigger` (submit, blur, change or unknown). Try submitting only when
  submission was confirmed, by the caller or by the owner.
- Capture the error message selectors and the exact error texts.
- Identify conditional field visibility and cross-field business rules.

### Phase 6: Cleanup

After the report is fully written, sign out of the application if you signed in, then close the
browser session you opened, and only that one. No browser process remains running after
discovery, so a later test pass that launches its own browser meets no conflicting session.

## The report

```
## Discovery Report

**URL:** {url}
**Pages discovered:** N
**UI framework:** cloudscape | material-ui | plain-html
**Limit reached:** yes/no

### Pages

#### {page-name} — {url}
**Screenshot:** {path}

**Interactive elements:**
| Selector | Label | Type | Initial State | Interaction Pattern | Duplicate DOM |
|---|---|---|---|---|---|
| ... | ... | ... | ... | ... | ... |

**Forms:**
{DOM inspection output per form, in the structure dom-inspection.md gives}

**Failed paths:** {list of URLs or actions that failed, with reason}
```

Write the report to the step's artifact path. Used on its own, ask the owner where it goes, unless
the request says; propose `discovery-report.md` in the current working directory.

## Constraints

- Never log, display or write a password.
- Never leave the application's domain during the crawl; the identity provider's redirects while
  signing in are allowed.
- When navigation fails or sign-in is rejected (wrong credentials, a multi-factor or CAPTCHA wall,
  an unreachable application), report the error and stop. Never present a partial report without
  saying what failed.

## Quality checks

**CRITICAL:**

- `ui_framework` not detected and set.
- Forms present on a page but DOM inspection not run.
- A password appears anywhere in the report.

**IMPORTANT:**

- `duplicate_dom` not flagged for elements with ambiguous selectors.
- A crawl limit reached without the cutoff noted in the report.
