#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
#
# An example wrapper for a policy's launch command: it runs one agent task and
# returns once the task's output file is written, even when the command that
# wrote it keeps running, as some harnesses do after their last answer.
#
#   launch-once.sh <output-file> <timeout-seconds> <command> [<argument>...]
#
# It assumes nothing about what the output holds: a review's findings file, a
# judge's verdict, or any other file the task writes. The task must write the
# file in one go, such as by writing a temporary file and renaming it into
# place, because the wrapper takes the file's appearance as the end of the
# task. The file must not exist when the wrapper starts.
#
# Once the file appears, the command has LAUNCH_ONCE_GRACE seconds (10 by
# default) to exit by itself; then the wrapper stops it and exits 0. A command
# that exits by itself keeps its exit code, and one that exits 0 without
# writing the file fails with 1. After <timeout-seconds> without the file, the
# wrapper stops the command and exits 124. Whenever the wrapper exits, or is
# stopped itself, it stops everything the command started.
#
# Copy it into the project and name it in the policy, for example:
#   review:
#     launch:
#       command: .konductor/launch-once.sh {findings_file} 1800 opencode run -m {model} "$(cat {prompt_file})"

set -u

if [ "$#" -lt 3 ]; then
  echo "usage: launch-once.sh <output-file> <timeout-seconds> <command> [<argument>...]" >&2
  exit 64
fi
output=$1
timeout=$2
shift 2
grace=${LAUNCH_ONCE_GRACE:-10}
for number in "$timeout" "$grace"; do
  case $number in
    '' | *[!0-9]*)
      echo "launch-once.sh: the timeout and LAUNCH_ONCE_GRACE must be whole numbers of seconds, not '$number'" >&2
      exit 64
      ;;
  esac
done
if [ -e "$output" ]; then
  echo "launch-once.sh: $output exists already; remove it or name a new file, so an earlier output is not taken for this one" >&2
  exit 2
fi

# Job control gives the command a process group of its own, so stopping the
# group also stops what the command started, such as a harness's model server.
set -m
"$@" &
pid=$!
set +m

# Stop the command's process group, politely first.
stop() {
  kill -TERM -- "-$pid" 2>/dev/null || return 0
  for _ in 1 2 3 4 5; do
    kill -0 -- "-$pid" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL -- "-$pid" 2>/dev/null || true
}
trap stop EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

written() { [ -e "$output" ]; }

started=$SECONDS
seen=""
while kill -0 "$pid" 2>/dev/null; do
  if written; then
    seen=${seen:-$SECONDS}
    if [ $((SECONDS - seen)) -ge "$grace" ]; then exit 0; fi
  elif [ $((SECONDS - started)) -ge "$timeout" ]; then
    echo "launch-once.sh: no output in $output after $timeout seconds; the command was stopped" >&2
    exit 124
  fi
  sleep 1
done

wait "$pid"
code=$?
if [ "$code" -ne 0 ]; then exit "$code"; fi
if written; then exit 0; fi
echo "launch-once.sh: the command exited without writing $output" >&2
exit 1
