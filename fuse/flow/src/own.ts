// SPDX-License-Identifier: Apache-2.0
// Looking up an id in a dictionary keyed by ids. Every object inherits a
// property named "constructor", which is also a valid artifact id and check
// kind, so only the dictionary's own keys count.

export const has = (dict: object | undefined, key: string): boolean => dict !== undefined && Object.hasOwn(dict, key);

export function own<T>(dict: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return dict !== undefined && Object.hasOwn(dict, key) ? dict[key] : undefined;
}
