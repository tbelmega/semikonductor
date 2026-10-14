# Planning security tests

This guide covers the security tests section of the test coverage report, for a step that asks
for a security test plan. The plan names the security tests the change needs, says which of them
exist, and records the missing ones as gaps. A plan that only lists tasks, without saying which
tests exist and which are missing, counts as not evaluated.

## 1. Read what the change exposes

Read, as far as they exist:

- the threat model and the security requirements, including the requirements document's quality
  requirements and prohibited behavior;
- the API specification: endpoints, their authentication, input schemas;
- the code of the change, by layer:
  - **frontend:** the UI framework, token and session storage, routing guards;
  - **backend:** the API framework, the authentication mechanism (JWT, OAuth, Amazon Cognito),
    database access, calls to other services;
  - **infrastructure:** infrastructure-as-code stacks, IAM policies and roles, API Gateway
    configuration, security groups and network settings;
- the existing tests and the test framework the project uses.

Say in the section which of these you had. A missing threat model is not a reason to skip the
plan; plan from the code and the API instead.

## 2. Pick the domains that apply

Plan by security domain and, within each, by layer. Skip a layer the change does not have, such as
the frontend of an API-only service, and say why a domain does not apply when you skip one.

| Domain | Frontend | Backend | Infrastructure |
| --- | --- | --- | --- |
| Authentication and authorization | session and token handling, access controls in the UI | token validation, multi-factor authentication, role-based access, authorization per endpoint, IAM enforcement | identity provider configuration, IAM role policies |
| Input validation and injection | cross-site scripting, cross-site request forgery, client-side validation and sanitization | SQL, NoSQL and command injection, schema validation of every input | web application firewall rules, API Gateway request validation |
| API security | | rate limiting, CORS, authentication and authorization per endpoint | API Gateway throttling, API keys and usage plans |
| Data protection and encryption | sensitive data in the browser, secure storage | encryption at rest and in transit, key management, PII handling | storage and database encryption, TLS and certificates |
| Session management | session storage, timeouts, secure cookies | session validation, session fixation, token expiry, refresh tokens | |
| Error handling and information disclosure | sanitized error display | generic error responses, no stack traces or internal IDs, no sensitive data in logs | |
| Infrastructure security | | | public access to storage, security group rules, network configuration, resource policies, least-privilege IAM |

Order the domains by how foundational they are: authentication and authorization first, then input
validation, API security, data protection, session management, error handling, and infrastructure.

Map each threat in the threat model to the domain that tests it, for example "SQL injection on
user input" to input validation, so every threat has at least one planned test.

## 3. Plan the test cases

For each domain and layer that applies, list the test cases in this order:

1. **Positive tests:** valid credentials are accepted, proper authorization grants access, valid
   input is processed, data travels encrypted.
2. **Negative tests:** invalid credentials are rejected (401), unauthorized access is denied (403),
   for both another user's resources (horizontal) and higher privileges (vertical), malicious input
   is blocked, unencrypted connections are refused.
3. **Edge cases:** expired tokens, concurrent sessions, boundary values, special characters.

For each case, say whether an existing test covers it, naming the test, or that it is missing.

Use OWASP's Top 10 and its Web Security Testing Guide, AWS's Foundational Security Best Practices,
the CIS AWS Foundations Benchmark for infrastructure, and the organization's own security
guidelines when it has them, to check that the plan misses nothing obvious. Name the practice a
case comes from when that helps the reader.

## 4. Classify the gaps

- **CRITICAL:** no test for authentication bypass; no injection test for a data input; no
  authorization test for horizontal or vertical privilege escalation.
- **IMPORTANT:** an OWASP Top 10 category that applies but has no test; no infrastructure security
  test where the change has infrastructure; no test that sensitive data stays out of logs and error
  messages.
- **SUGGESTION:** rate limiting and denial-of-service resilience tests; dependency vulnerability
  scanning in the pipeline.

A step that counts critical findings as gaps counts every CRITICAL item here.

## The report section

- **Inputs:** what you read, and what was missing.
- **Domains:** each domain and layer that applies, and each one skipped with the reason.
- **Test cases:** per domain and layer, the cases with their kind (positive, negative, edge) and
  the existing test or "missing".
- **Gaps:** the missing tests by severity, most severe first, and for each the threat or practice
  it covers.
