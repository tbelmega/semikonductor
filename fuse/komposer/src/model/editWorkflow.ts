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
