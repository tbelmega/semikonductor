#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# One smoke run of a fuse-flow workflow: a fresh project with fuse-konductor
# installed, a fuse agent working in it, and an orchestrator agent that plays
# the user and judges the run. See fuse/smoke/README.md.
set -uo pipefail

usage() {
  cat >&2 <<'EOF'
usage: run.sh [--workflow <name or file>] [--fuse-harness kiro|opencode] [--fuse-model <model>]
              [--orchestrator-harness kiro|opencode] [--orchestrator-model <model>]
              [--out <dir>] [--max-turns <n>] [--timeout-min <n>] [--turn-timeout-min <n>]
              [--opencode-profile <aws profile>] [--opencode-region <region>]
defaults: _k-phase-chain; fuse agent opencode with amazon-bedrock/global.openai.gpt-6-luna;
          orchestrator opencode with amazon-bedrock/global.openai.gpt-6.1-sol; ~/fuse-smoke-runs, 30 turns,
          60 minutes for the whole run, 30 minutes per fuse agent turn,
          opencode on Amazon Bedrock with the standard AWS credential chain: without
          --opencode-profile and --opencode-region, opencode reads AWS_PROFILE and AWS_REGION,
          and uses us-east-1 when no region is set
Each <n> is a whole number of at least 1.
A workflow name is looked up at any depth of fuse/flow/workflows/, then in fuse/smoke/fixtures/. A workflow
that does not ship with fuse-flow is copied into the project's .konductor/workflows/ as <name>.yml, so the
fuse agent finds it by name, together with the review guides and workflows it names by relative path. A
sibling <name>.policy-overrides file is copied to the project's .konductor/policy-overrides.yml, and a
sibling <name>.library/ directory is copied to the project's .konductor/library/. For an opencode role,
the model is an opencode model id such as amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0.
EOF
  exit 64
}

workflow=_k-phase-chain
fuse_harness=opencode
fuse_model=amazon-bedrock/global.openai.gpt-6-luna
orchestrator_harness=opencode
orchestrator_model=amazon-bedrock/global.openai.gpt-6.1-sol
opencode_profile=
opencode_region=
out="$HOME/fuse-smoke-runs"
max_turns=30
timeout_min=60
turn_timeout_min=30
# Every option takes a value, so an option without one is a usage error.
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] && [ -n "$2" ] || usage
  case "$1" in
    --workflow) workflow="$2" ;;
    --fuse-harness) fuse_harness="$2" ;;
    --fuse-model) fuse_model="$2" ;;
    --opencode-profile) opencode_profile="$2" ;;
    --opencode-region) opencode_region="$2" ;;
    --orchestrator-harness) orchestrator_harness="$2" ;;
    --orchestrator-model) orchestrator_model="$2" ;;
    --out) out="$2" ;;
    --max-turns) max_turns="$2" ;;
    --timeout-min) timeout_min="$2" ;;
    --turn-timeout-min) turn_timeout_min="$2" ;;
    *) usage ;;
  esac
  shift 2
done
# say.sh compares the turn count with the budget, and timeout treats 0 as no
# limit, so anything but a whole number of at least 1 would lift a limit.
for n in "$max_turns" "$timeout_min" "$turn_timeout_min"; do
  case "$n" in '' | *[!0-9]* | 0*) usage ;; esac
done

smoke="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
clone="$(cd "$smoke/../.." && pwd)"
case "$workflow" in
  */* | *.yml | *.yaml) workflow_file="$(cd "$(dirname "$workflow")" && pwd)/$(basename "$workflow")" ;;
  *) # A name is looked up like fuse-flow does: at any depth of the shipped workflows, then fixtures.
     found="$(find -L "$clone/fuse/flow/workflows" -name "$workflow.yml" -type f 2>/dev/null)"
     [ "$(printf '%s\n' "$found" | grep -c .)" -le 1 ] ||
       { echo "run.sh: workflow name $workflow is ambiguous:" >&2; echo "$found" >&2; exit 64; }
     workflow_file="${found:-$smoke/fixtures/$workflow.yml}" ;;
esac
[ -f "$workflow_file" ] || { echo "run.sh: no workflow named or at $workflow" >&2; exit 64; }
# The workflow's name, and the stem its sibling files share, without .yml or .yaml.
case "$workflow_file" in *.yaml) stem="${workflow_file%.yaml}" ;; *) stem="${workflow_file%.yml}" ;; esac
workflow_name="$(basename "$stem")"
policy_file="$stem.policy-overrides"
library_dir="$stem.library"
shipped=no
case "$workflow_file" in "$clone/fuse/flow/workflows/"*) shipped=yes ;; esac
case "$fuse_harness" in kiro | opencode) ;; *) usage ;; esac
case "$orchestrator_harness" in kiro | opencode) ;; *) usage ;; esac
command -v kiro-cli >/dev/null || { echo "run.sh: kiro-cli is not on PATH" >&2; exit 1; }
if [ "$fuse_harness" = opencode ] || [ "$orchestrator_harness" = opencode ]; then
  command -v opencode >/dev/null || { echo "run.sh: opencode is not on PATH" >&2; exit 1; }
fi
command -v bun >/dev/null || { echo "run.sh: bun is not on PATH" >&2; exit 1; }
[ -d "$clone/fuse/flow/node_modules" ] || (cd "$clone/fuse/flow" && bun install --frozen-lockfile >/dev/null) || exit 1
# A copied workflow loses the files it names by relative path unless they are
# copied with it, so list them before anything is created.
references=
if [ "$shipped" = no ]; then
  references="$(bun "$smoke/references.ts" "$workflow_file")" ||
    { echo "run.sh: $workflow_file cannot be copied into a test project with the files it names" >&2; exit 64; }
fi

# mktemp's suffix keeps runs that start in the same second apart.
mkdir -p "$out" || exit 1
# Keep the run directory short and free of dates: agents retype long absolute
# paths, and they "correct" a date stamp such as a model id's 20251001 or mangle
# other parts on the way. The label names the run inside the directory instead.
label() { echo "$1-$(basename "$2" | sed -E 's/^(global|us|eu|apac|jp|au|in|ca)\.//; s/-[0-9]{8}.*$//; s/:/_/g')"; }
run="$(mktemp -d "$out/$(date -u +%m%d-%H%M%S)-XXXX")" || exit 1
echo "$workflow_name fuse $(label "$fuse_harness" "$fuse_model") orchestrator $(label "$orchestrator_harness" "$orchestrator_model")" > "$run/label"
project="$run/project"
mkdir -p "$project" "$run/orchestrator/.kiro/agents" || exit 1
echo "smoke run: $run"

# The project: an empty repository with fuse-konductor installed, committed so
# the fuse agent starts from a clean tree, as a user's repository would.
# install.sh writes its clone pointer into the home it runs under, so it runs
# under a home of its own and leaves the user's ~/.konductor alone.
install_home="$run/install-home"
mkdir -p "$install_home" || exit 1
(
  cd "$project" &&
  git init -q -b main &&
  HOME="$install_home" "$clone/install.sh" --project . > "$run/install.log" 2>&1 &&
  if [ "$shipped" = no ]; then
    mkdir -p .konductor/workflows && cp "$workflow_file" ".konductor/workflows/$workflow_name.yml" &&
    printf '%s\n' "$references" | while IFS= read -r ref; do
      [ -z "$ref" ] && continue
      mkdir -p ".konductor/workflows/$(dirname "$ref")" &&
        cp "$(dirname "$workflow_file")/$ref" ".konductor/workflows/$ref" || exit 1
    done
  fi &&
  if [ -f "$policy_file" ]; then
    mkdir -p .konductor && cp "$policy_file" .konductor/policy-overrides.yml
  fi &&
  if [ -d "$library_dir" ]; then
    mkdir -p .konductor/library && cp -R "$library_dir"/. .konductor/library/
  fi &&
  if [ "$fuse_harness" = kiro ]; then
    mkdir -p .kiro/agents &&
    # The fuse agent sees only what a fresh user's project gives it: AGENTS.md
    # and the installed skills, without this machine's global steering.
    cat > .kiro/agents/fuse-smoke.json <<'EOF'
{
  "name": "fuse-smoke",
  "description": "Smoke-test stand-in for a fresh user's default agent: built-in tools, the project's AGENTS.md and installed skills only.",
  "tools": ["@builtin"],
  "allowedTools": ["@builtin"],
  "includeMcpJson": false,
  "resources": ["file://AGENTS.md", "skill://.kiro/skills/**/SKILL.md"]
}
EOF
  fi &&
  git add -A &&
  git -c user.name=smoke -c user.email=smoke@localhost commit -q -m "Install fuse-konductor" &&
  # A local bare remote stands in for the user's forge, so workflows that push
  # branches can do so without reaching any real repository.
  git init -q --bare "$run/origin.git" &&
  git remote add origin "$run/origin.git" &&
  git push -q -u origin main
) || { echo "run.sh: project setup failed; see $run/install.log" >&2; exit 1; }

# Profile and region go into the opencode config only when given, so that
# otherwise opencode takes them from AWS_PROFILE and AWS_REGION.
bedrock_options=
[ -n "$opencode_profile" ] && bedrock_options="\"profile\": \"$opencode_profile\""
[ -n "$opencode_region" ] && bedrock_options="${bedrock_options:+$bedrock_options, }\"region\": \"$opencode_region\""

# opencode reads skills and instructions from the home directory (~/.agents,
# ~/.claude, ~/.config/opencode), so each opencode role gets a home of its own:
# the opencode config for Bedrock, the clone pointer install.sh wrote, and a
# git identity. The AWS SDK looks for profiles and cached sign-ins under
# ~/.aws, so that one directory links back to the real home.
# OpenCode's read tool takes an absolute path, and a model expands
# ~/.konductor/fuse-konductor-clone from the project's path, which lies under
# the real home when --out does. It would then drive the clone the user's own
# pointer names instead of this one, so each role is denied the real
# ~/.konductor, by the path HOME gives and by its real path; the shell, whose
# HOME is the private home, still reads the copy.
# $2 is a JSON array of instruction files, or [] for none.
konductor_deny="\"$HOME/.konductor/*\": \"deny\""
_resolved="$(cd "$HOME" && pwd -P)" || exit 1
[ "$_resolved" = "$HOME" ] || konductor_deny="$konductor_deny, \"$_resolved/.konductor/*\": \"deny\""
opencode_home() {
  mkdir -p "$1/.config/opencode" "$1/.konductor" || return 1
  cp "$install_home/.konductor/fuse-konductor-clone" "$1/.konductor/" || return 1
  if [ -d "$HOME/.aws" ]; then
    ln -s "$HOME/.aws" "$1/.aws" || return 1
  fi
  printf '[user]\n\tname = smoke\n\temail = smoke@localhost\n' > "$1/.gitconfig"
  cat > "$1/.config/opencode/opencode.json" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "enabled_providers": ["amazon-bedrock"],
  "share": "disabled",
  "autoupdate": false,
  "instructions": $2,
  "permission": {
    "read": { "*": "allow", $konductor_deny },
    "external_directory": { "*": "allow", $konductor_deny }
  },
  "provider": { "amazon-bedrock": { "options": { $bedrock_options } } }
}
EOF
}
fuse_home="$run/fuse-home"
if [ "$fuse_harness" = opencode ]; then
  opencode_home "$fuse_home" '[]' || exit 1
fi

# A Kiro CLI fuse agent runs in the real home, where the project's AGENTS.md
# sends it to ~/.konductor/fuse-konductor-clone for fuse-flow. For the run,
# that pointer names this clone; the user's own pointer, or its absence, is
# put back when run.sh exits. Kiro CLI runs share that one pointer, so each
# holds a lock from before it reads the pointer until it has put it back, and
# a second run waits for the first. The lock is a symlink whose target is the
# owner's process id: ln creates it with the id in one step, which works
# without flock, so a run stopped at any point leaves either no lock or one
# that names it. A lock that names a run which is gone, because that run was
# killed, stops the next run with a message: the user checks the pointer and
# removes the lock by hand. No run removes another run's lock, so an rm that
# outlives a killed run can only remove the lock that run held.
user_pointer="$HOME/.konductor/fuse-konductor-clone"
smoke_pointer="$install_home/.konductor/fuse-konductor-clone"
pointer_lock="$HOME/.konductor/fuse-smoke-pointer.lock"
restore=no
# Prints the process id the lock names, or nothing when there is none.
owner_of() { readlink -- "$1" 2>/dev/null; }
# An older run.sh made the lock a directory, and ln -s would create a link
# inside it instead of failing.
refuse_old_lock() {
  if [ -d "$1" ] && [ ! -L "$1" ]; then
    echo "run.sh: $1 was left by an older run.sh; remove it once no other smoke run is active, and run again" >&2
    exit 1
  fi
}
release_pointer() {
  # Only what this run created and still owns.
  if [ "$restore" = yes ]; then
    if [ -f "$run/user-clone-pointer" ]; then
      cp -p "$run/user-clone-pointer" "$user_pointer"
    else
      rm -f "$user_pointer"
    fi
  fi
  if [ "$(owner_of "$pointer_lock")" = "$$" ]; then rm -f -- "$pointer_lock"; fi
}
if [ "$fuse_harness" = kiro ]; then
  mkdir -p "$HOME/.konductor" || exit 1
  trap release_pointer EXIT
  trap 'exit 130' INT TERM HUP
  waiting=no
  while :; do
    refuse_old_lock "$pointer_lock"
    ln -s "$$" "$pointer_lock" 2>/dev/null && break
    holder="$(owner_of "$pointer_lock")"
    # A run that exits removes its lock before it is gone, so a lock that
    # still names its run once that run is gone was left by a killed run.
    if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null && [ "$(owner_of "$pointer_lock")" = "$holder" ]; then
      echo "run.sh: $pointer_lock names process $holder, which is no longer running: a Kiro CLI smoke run was killed. It may have left $user_pointer naming its own clone; your own pointer, if you had one, is saved as user-clone-pointer in that run's folder. Put your pointer back, remove $pointer_lock, and run again." >&2
      exit 1
    fi
    if [ "$waiting" = no ]; then
      echo "run.sh: waiting for another Kiro CLI smoke run${holder:+ (process $holder)} to put $user_pointer back" >&2
      waiting=yes
    fi
    sleep 1
  done
  if ! cmp -s "$smoke_pointer" "$user_pointer"; then
    [ ! -L "$user_pointer" ] || { echo "run.sh: $user_pointer is a symlink; move it away and run again" >&2; exit 1; }
    if [ -e "$user_pointer" ]; then cp -p "$user_pointer" "$run/user-clone-pointer" || exit 1; fi
    restore=yes
    cp "$smoke_pointer" "$user_pointer" || exit 1
  fi
fi

cat > "$run/run.env" <<EOF
WORKFLOW='$workflow_name'
FUSE_HARNESS='$fuse_harness'
FUSE_HOME='$fuse_home'
FUSE_MODEL='$fuse_model'
ORCHESTRATOR_HARNESS='$orchestrator_harness'
ORCHESTRATOR_MODEL='$orchestrator_model'
PROJECT='$project'
MAX_TURNS='$max_turns'
TURN_TIMEOUT_MIN='$turn_timeout_min'
EOF
# The wrapper restores the real home, which an opencode orchestrator replaces.
printf '#!/usr/bin/env bash\nexport HOME=%q\nunset XDG_CONFIG_HOME\nexec %q %q "$@"\n' "$HOME" "$smoke/say.sh" "$run" > "$run/say"
chmod +x "$run/say"
project_workflow="$workflow_file"
[ "$shipped" = no ] && project_workflow="$project/.konductor/workflows/$workflow_name.yml"

cat > "$run/orchestrator/brief.md" <<EOF
# Brief for this smoke run

- Workflow under test: \`$workflow_name\` (its definition: \`$project_workflow\`)
- Talk to the fuse agent with: \`$run/say "<your message>"\`
- Turn budget: $max_turns messages
- The fuse agent's project, which you may read but never change: \`$project\`
- Write your verdict to: \`$run/verdict.md\`
EOF
cat > "$run/orchestrator/.kiro/agents/smoke-orchestrator.json" <<EOF
{
  "name": "smoke-orchestrator",
  "description": "Plays the user in a fuse-flow smoke run and judges whether the workflow works end to end.",
  "tools": ["@builtin"],
  "allowedTools": ["@builtin"],
  "includeMcpJson": false,
  "resources": ["file://$smoke/orchestrator.md", "file://$run/orchestrator/brief.md"]
}
EOF

start=$(date +%s)
prompt="Run the smoke test described in your brief now."
if [ "$orchestrator_harness" = opencode ]; then
  orchestrator_home="$run/orchestrator-home"
  opencode_home "$orchestrator_home" "[\"$smoke/orchestrator.md\", \"$run/orchestrator/brief.md\"]" || exit 1
  # One say call waits for a whole fuse agent turn; opencode's bash tool
  # otherwise kills a command after two minutes.
  ( cd "$run/orchestrator" && HOME="$orchestrator_home" XDG_CONFIG_HOME="$orchestrator_home/.config" \
      OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS=$(( (turn_timeout_min + 2) * 60000 )) \
      timeout -k 30 "${timeout_min}m" \
      opencode run --pure --auto -m "$orchestrator_model" "$prompt" ) > "$run/orchestrator.out" 2> "$run/orchestrator.err"
else
  ( cd "$run/orchestrator" && timeout -k 30 "${timeout_min}m" \
      kiro-cli chat --no-interactive --trust-all-tools --agent smoke-orchestrator --model "$orchestrator_model" \
      "$prompt" ) > "$run/orchestrator.out" 2> "$run/orchestrator.err"
fi
orchestrator_rc=$?
wall=$(( $(date +%s) - start ))

# Checked against the harness's own copies of the workflow and the policy, so
# an edit to the project's copy of either cannot make a run pass, and in the
# home the fuse agent ran in, so fuse-flow finds the same workflows and user
# policy it found.
check_home="$HOME"
[ "$fuse_harness" = opencode ] && check_home="$fuse_home"
policy_args=()
[ -f "$policy_file" ] && policy_args=(--policy "$policy_file")
HOME="$check_home" bun "$smoke/check.ts" --project "$project" --workflow "$workflow_file" "${policy_args[@]}" \
  > "$run/mechanical.txt" 2>&1
bun "$smoke/summary.ts" "$run" "$wall" "$orchestrator_rc"

mechanical=$(grep -o 'MECHANICAL: [A-Z]*' "$run/mechanical.txt" | tail -1)
verdict() { grep -m1 -E "^$1: " "$run/verdict.md" 2>/dev/null | tr -d '[:space:]' | cut -d: -f2; }
engine=$(verdict ENGINE); workflow_verdict=$(verdict WORKFLOW); guidance=$(verdict GUIDANCE)
if [ "$mechanical" = "MECHANICAL: PASS" ] && [ "$engine" = PASS ] && [ "$workflow_verdict" = PASS ]; then
  [ "$guidance" = PASS ] && exit 0
  [ "$guidance" = FRICTION ] && exit 2
fi
exit 1
