# Checking AWS service claims

How to check a document's claims about AWS services and features against AWS documentation: what
a service supports, its limits and quotas, its pricing model, its regional availability, and
whether it is generally available or in preview. The result is a validation report that classifies
each claim CONFIRMED, UNVERIFIED or INCORRECT, with evidence URLs and corrections, so that wrong or
invented claims are found before anyone relies on them.

## Steps

### Step 1: Extract AWS Claims

Scan the document and extract every verifiable AWS assertion:

- **Feature claims**: "DynamoDB Streams supports filter patterns", "Lambda supports response streaming"
- **Regional availability**: "available in us-east-1", "not yet GA in ap-southeast-2"
- **Pricing model**: "charged per request", "no cost for idle capacity"
- **Service limits/quotas**: "max payload 6 MB", "15-minute Lambda timeout"
- **GA/Preview status**: "generally available", "in preview"

List each claim as: `{service, feature, region (if applicable), assertion}`.

### Step 2: Validate Each Claim

For each extracted claim, use the `aws-mcp` tools in this order:

1. **`aws___search_documentation`**: search for the service + feature to locate the relevant doc page
2. **`aws___read_documentation`**: read the located page to confirm or deny the assertion
3. **`aws___get_regional_availability`**: for any regional availability claim, call this tool with the service and region

Do not accept the document's own assertion as evidence. Always consult the primary source.

If the `aws-mcp` tools are not available in the session, do not validate from memory. Follow the
`aws-mcp-usage` skill's "When the tools are missing" section: tell the user the server is not
configured, and classify every claim as UNVERIFIED with the reason "aws-mcp tools unavailable".

### Step 3: Classify Each Claim

| Status     | Definition                                                         |
| ---------- | ------------------------------------------------------------------ |
| CONFIRMED  | Primary source explicitly confirms the assertion                   |
| UNVERIFIED | No primary source found; service may be too new or claim too vague |
| INCORRECT  | Primary source contradicts the assertion                           |

For INCORRECT claims, provide the correction and the evidence URL.
For UNVERIFIED claims, note what was searched and why it could not be confirmed.

### Step 4: Produce Validation Report

Output a markdown report in this format:

```markdown
## AWS Validation Report

| Claim                                         | Service           | Status     | Evidence                                       | Correction                                                       |
| --------------------------------------------- | ----------------- | ---------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| "DynamoDB Streams filter patterns support OR" | DynamoDB Streams  | INCORRECT  | https://docs.aws.amazon.com/...                | Filter patterns do not support OR; use multiple Lambda triggers  |
| "Lambda max timeout is 15 minutes"            | Lambda            | CONFIRMED  | https://docs.aws.amazon.com/...                | —                                                                |
| "EventBridge Pipes GA in ap-south-2"          | EventBridge Pipes | UNVERIFIED | Searched regional table; ap-south-2 not listed | Flag for human review                                            |

**Summary:** N claims checked: N CONFIRMED, N UNVERIFIED, N INCORRECT.
```

## Pitfalls

- **Do not block on UNVERIFIED**. Mark and proceed. New services may not yet appear in documentation.
- **Do not validate pricing claims from memory**. Always call `aws___search_documentation` for pricing pages.
- **Regional availability changes frequently**. Always call `aws___get_regional_availability` rather than relying on prior knowledge.
- **Feature names drift**. Search by both the marketing name and the API/console name if the first search returns no results.

## Verification

After producing the report, confirm:

- Every claim in the document has a row in the report
- Every INCORRECT finding has a correction and an evidence URL that resolves
- No CONFIRMED finding is based solely on the document's own assertion

## Quality Gate

The fact-check passes when:

- **0 INCORRECT findings** remain unaddressed in the document
- All INCORRECT findings are either corrected inline or flagged with `> ⚠️ INCORRECT: <correction>` callouts
- UNVERIFIED findings are flagged with `> ⚠️ UNVERIFIED: <what was searched>` callouts
- The validation report is written where the calling step says; for standalone use on a design
  document, the default is `docs/design/<name>-aws-validation.md`
