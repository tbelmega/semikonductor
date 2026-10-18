// SPDX-License-Identifier: Apache-2.0
// A dictionary keyed by ids. z.record refuses any object that has its own
// "constructor" key, taking it for a class instance, and "constructor" is a
// valid artifact id and check kind. So a dictionary is an object with a
// catchall, as the state file's steps are, and its keys are checked one by one.

import { z } from "zod";

export function idRecord<V extends z.ZodType>(key: z.ZodString, value: V) {
  const { $schema: _, ...propertyNames } = z.toJSONSchema(key) as Record<string, unknown>;
  return z
    .object({})
    .catchall(value)
    .superRefine((dict, ctx) => {
      for (const name of Object.keys(dict)) {
        for (const issue of key.safeParse(name).error?.issues ?? []) {
          ctx.addIssue({ code: "custom", path: [name], message: `key "${name}": ${issue.message}` });
        }
      }
    })
    .meta({ propertyNames });
}
