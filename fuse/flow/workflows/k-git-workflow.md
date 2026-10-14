# Commits and branches in the k- workflows

How the implementation steps of the `_k-` workflows commit and branch. Where the step's
instruction says otherwise, the instruction wins.

## Commits

### Atomic commits

Each commit contains exactly one logical change. Split work into separate commits:

- One commit per bug fix
- One commit per feature addition
- One commit per refactor
- Never mix formatting changes with logic changes

### Conventional commit messages

Format: `<type>(<scope>): <description>`

| Type       | When to use                                |
| ---------- | ------------------------------------------ |
| `feat`     | New feature or capability                  |
| `fix`      | Bug fix                                    |
| `refactor` | Code restructuring without behavior change |
| `test`     | Adding or updating tests                   |
| `docs`     | Documentation changes                      |
| `chore`    | Build config, dependencies, tooling        |

Examples:

- `feat(api): add ListNetworkDevices operation`
- `fix(dynamodb): add condition expression to prevent overwrites`
- `refactor(handler): extract validation into shared utility`

### Commit hygiene

- Imperative mood: "add feature" not "added feature"
- Subject line under 72 characters
- Every commit compiles and passes the tests
- No secrets or credentials in any commit

## Branches

- Branch from the integration branch, usually `main`, for new work
- Naming: `<type>/<short-description>` (e.g., `feat/network-monitoring`, `fix/throttling-retry`)
- Keep branches short-lived: merge within days, not weeks
- Rebase on the integration branch before opening a pull request

## History

Start with `git status` and `git diff`, then use targeted commands for deeper investigation:

| Command                     | Purpose                                  |
| --------------------------- | ---------------------------------------- |
| `git log --oneline -20`     | Recent commit history                    |
| `git log --author=<name>`   | Commits by author                        |
| `git blame <file>`          | Line-by-line attribution                 |
| `git bisect start/bad/good` | Binary search for regression             |
| `git log -S "<string>"`     | Find commits that added/removed a string |

## Self-check

**Must fix:** a non-atomic commit mixing unrelated changes; a commit that breaks compilation or
tests; a commit with secrets or credentials.

**Should fix:** a commit message not in the conventional format; a branch not rebased before its
pull request; a feature branch older than two weeks without a merge.

**Worth considering:** a clearer commit description; splitting a large commit further.
