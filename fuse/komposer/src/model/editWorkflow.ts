// SPDX-License-Identifier: Apache-2.0
// Applying a list of structured edits to an open workflow as one change, and
// keeping each step's identity key across the edits, so Save can tell a moved
// or replaced step from a deleted and added one. No React: tested directly.

import { newStepKey, openWorkflow, type OpenWorkflow } from "../workflowView.ts";
import { applyEdit, type Edit } from "./yamlEdit.ts";

// The workflow after the edits, applied in order: either all apply or this
// throws and nothing changes. An insert followed at once by the deletion of
// the step just after it is a replacement (Compare's Apply all), and the new
// step takes the deleted step's key.
export function editedWorkflow(target: OpenWorkflow, list: Edit[]): OpenWorkflow {
  let nextText = target.openText;
  const stepKeys = [...target.stepKeys];
  let insertedAt: number | null = null;
  for (const edit of list) {
    nextText = applyEdit(nextText, edit);
    if (edit.op === "insertStep") stepKeys.splice(edit.at, 0, newStepKey());
    if (edit.op === "deleteStep") {
      const [key] = stepKeys.splice(edit.index, 1);
      if (insertedAt !== null && edit.index === insertedAt + 1) stepKeys[insertedAt] = key;
    }
    if (edit.op === "moveStep") {
      const [key] = stepKeys.splice(edit.from, 1);
      stepKeys.splice(edit.to, 0, key);
    }
    insertedAt = edit.op === "insertStep" ? edit.at : null;
  }
  return openWorkflow({ ...target, stepKeys, workingCopy: nextText === target.text ? undefined : nextText });
}

// The text a field bound to an engine-read value shows while it is typed in.
// The engine trims instructions, gate and condition texts and guides, so a
// space or line break typed at the end of one would vanish as soon as the
// edit is read back. The typed draft is shown while, trimmed, it is the
// value; once the value is something else (an edit elsewhere, another step
// selected, an edit refused) the value is shown.
export function shownText(draft: string | null, value: string): string {
  return draft !== null && draft.trim() === value.trim() ? draft : value;
}
