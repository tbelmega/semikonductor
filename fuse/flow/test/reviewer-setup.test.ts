// SPDX-License-Identifier: Apache-2.0
// The reviewer setup install.sh runs: the questions, the rows it writes to the
// user's policy file, and what it leaves alone.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { HARNESSES, type Io, family, merge, setsReviewer, setup } from "../src/reviewer-setup.ts";

let dir: string;
let policy: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reviewer-setup-"));
  policy = join(dir, ".konductor", "policy-overrides.yml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function scripted(answers: string[]): Io & { out: string } {
  const queue = [...answers];
  const io = {
    out: "",
    async ask(prompt: string) {
      io.out += prompt;
      return queue.shift();
    },
    say(text: string) {
      io.out += `${text}\n`;
    },
  };
  return io;
}

const template = (id: string) => HARNESSES.find((h) => h.id === id)!.template!;
const written = () => parse(readFileSync(policy, "utf8"));

describe("family", () => {
  test("recognises the usual model names, with or without a provider prefix", () => {
    expect(family("claude-opus-5.5")).toBe("Claude");
    expect(family("amazon-bedrock/us.anthropic.claude-sonnet-5")).toBe("Claude");
    expect(family("openai.gpt-6.1-sol")).toBe("GPT");
    expect(family("gemini-4-carbon")).toBe("Gemini");
    expect(family("us.xai.grok-4.7")).toBe("Grok");
    expect(family("my-house-model")).toBeUndefined();
  });
});

describe("merge", () => {
  test("adds rows and keeps every other key and comment", () => {
    const text = "# my policy\nchecks:\n  default: bun run check\nreview:\n  max_rounds: 3\n";
    const out = merge(text, new Map([["claude-opus-5.5", { model: "gpt-6.1-sol", launch: "subagent" as const }]]));
    if ("error" in out) throw new Error(out.error);
    expect(out.text).toContain("# my policy");
    expect(parse(out.text)).toEqual({
      checks: { default: "bun run check" },
      review: { max_rounds: 3, reviewers: { "claude-opus-5.5": { model: "gpt-6.1-sol", launch: "subagent" } } },
    });
  });

  test("refuses a file that is not YAML, a key in the way that is not a mapping, and a result the schema rejects", () => {
    const row = new Map([["a-model", { model: "b-model", launch: "subagent" as const }]]);
    expect(merge("review: [\n", row)).toMatchObject({ error: expect.stringContaining("not valid YAML") });
    expect(merge("review: 3\n", row)).toMatchObject({ error: expect.stringContaining("not a mapping") });
    expect(merge("unknown_key: 1\n", row)).toMatchObject({ error: expect.stringContaining("not be a valid policy file") });
  });

  test("an empty file becomes a policy with only the rows", () => {
    const out = merge("", new Map([["a", { model: "b", launch: { command: "run {model}" } }]]));
    if ("error" in out) throw new Error(out.error);
    expect(parse(out.text)).toEqual({ review: { reviewers: { a: { model: "b", launch: { command: "run {model}" } } } } });
  });
});

describe("setsReviewer", () => {
  test("is true when review.reviewers or review.launch is set, and false otherwise", () => {
    expect(setsReviewer("")).toBe(false);
    expect(setsReviewer("review:\n  max_rounds: 2\n")).toBe(false);
    expect(setsReviewer("review:\n  launch: subagent\n")).toBe(true);
    expect(setsReviewer("review:\n  reviewers:\n    a: { model: b }\n")).toBe(true);
  });
});

describe("setup", () => {
  test("a reviewer in another harness gets that harness's command, and the reverse row the author's", async () => {
    const io = scripted(["1", "claude-opus-5-5", "2", "gpt-6.1-sol", "", "", ""]);
    expect(await setup(io, policy, false)).toBe(0);
    expect(io.out).toContain("develop with Opus and review with GPT Sol");
    expect(io.out).toContain(template("codex").replaceAll("{model}", "gpt-6.1-sol"));
    expect(written()).toEqual({
      review: {
        reviewers: {
          "claude-opus-5-5": { model: "gpt-6.1-sol", launch: { command: template("codex") } },
          "gpt-6.1-sol": { model: "claude-opus-5-5", launch: { command: template("claude") } },
        },
      },
    });
  });

  test("a reviewer in the same harness is started as a subagent, written out", async () => {
    const io = scripted(["kiro", "claude-opus-5.5", "4", "gpt-6.1-sol", "n"]);
    expect(await setup(io, policy, false)).toBe(0);
    expect(written()).toEqual({ review: { reviewers: { "claude-opus-5.5": { model: "gpt-6.1-sol", launch: "subagent" } } } });
  });

  test("the user can type their own command, and must type one for another harness", async () => {
    const io = scripted(["1", "claude-opus-5-5", "5", "local-llm", "my-reviewer --model {model} < {prompt_file}", "y", "my command"]);
    expect(await setup(io, policy, false)).toBe(0);
    expect(written().review.reviewers).toEqual({
      "claude-opus-5-5": { model: "local-llm", launch: { command: "my-reviewer --model {model} < {prompt_file}" } },
      "local-llm": { model: "claude-opus-5-5", launch: { command: "my command" } },
    });
  });

  test("an empty first answer, or the end of the input, writes nothing", async () => {
    for (const answers of [[""], [], ["1", "claude-opus-5-5"]]) {
      const io = scripted(answers);
      expect(await setup(io, policy, false)).toBe(0);
      expect(io.out).toContain("No reviewer was set up");
      expect(existsSync(policy)).toBe(false);
    }
  });

  test("a same-family pairing is warned about and written only when the user keeps it", async () => {
    const declined = scripted(["1", "claude-opus-5-5", "1", "claude-sonnet-5-5", ""]);
    expect(await setup(declined, policy, false)).toBe(0);
    expect(declined.out).toContain("Both are Claude models");
    expect(existsSync(policy)).toBe(false);
    const kept = scripted(["1", "claude-opus-5-5", "1", "claude-sonnet-5-5", "y", "n"]);
    expect(await setup(kept, policy, false)).toBe(0);
    expect(written().review.reviewers["claude-opus-5-5"]).toEqual({ model: "claude-sonnet-5-5", launch: "subagent" });
  });

  test("the same model id on both sides asks no reverse question", async () => {
    const io = scripted(["1", "shared-model", "2", "shared-model", ""]);
    expect(await setup(io, policy, false)).toBe(0);
    expect(io.out).not.toContain("Also have");
    expect(Object.keys(written().review.reviewers)).toEqual(["shared-model"]);
  });

  test("without --force it asks nothing while a reviewer is set; with it, a changed row is replaced only on a yes", async () => {
    const before = "review:\n  reviewers:\n    claude-opus-5-5: { model: old-reviewer }\n";
    writeFileSync((mkdirp(), policy), before);
    const quiet = scripted([]);
    expect(await setup(quiet, policy, false)).toBe(0);
    expect(quiet.out).toBe("");

    const refused = scripted(["1", "claude-opus-5-5", "2", "gpt-6.1-sol", "", "n", ""]);
    expect(await setup(refused, policy, true)).toBe(0);
    expect(refused.out).toContain("already says who reviews claude-opus-5-5");
    expect(readFileSync(policy, "utf8")).toBe(before);

    const replaced = scripted(["1", "claude-opus-5-5", "2", "gpt-6.1-sol", "", "n", "y"]);
    expect(await setup(replaced, policy, true)).toBe(0);
    expect(written().review.reviewers["claude-opus-5-5"]).toEqual({ model: "gpt-6.1-sol", launch: { command: template("codex") } });
  });

  test("a policy file the merge cannot keep valid is left unchanged, with the reason", async () => {
    const before = "review: 3\n";
    writeFileSync((mkdirp(), policy), before);
    const io = scripted(["1", "claude-opus-5-5", "2", "gpt-6.1-sol", "", "n"]);
    expect(await setup(io, policy, false)).toBe(1);
    expect(io.out).toContain("was not changed, because");
    expect(readFileSync(policy, "utf8")).toBe(before);
  });

  test("the end of the input at the reverse question writes no reverse row", async () => {
    const io = scripted(["4", "claude-opus-5.5", "4", "gpt-6.1-sol"]);
    expect(await setup(io, policy, false)).toBe(0);
    expect(Object.keys(written().review.reviewers)).toEqual(["claude-opus-5.5"]);
  });

  test("a file changed while the questions were answered is not overwritten", async () => {
    writeFileSync((mkdirp(), policy), "checks:\n  default: make\n");
    const io = scripted(["4", "claude-opus-5.5", "4", "gpt-6.1-sol", "n"]);
    const ask = io.ask;
    io.ask = async (prompt) => {
      if (prompt.startsWith("Also have")) writeFileSync(policy, "checks:\n  default: make check\n");
      return ask(prompt);
    };
    expect(await setup(io, policy, false)).toBe(1);
    expect(io.out).toContain("it changed while the questions were answered");
    expect(readFileSync(policy, "utf8")).toBe("checks:\n  default: make check\n");
  });

  test("a symlinked policy file keeps its link and the target its permissions", async () => {
    const target = join(dir, "dotfiles", "policy.yml");
    mkdirSync(join(dir, "dotfiles"));
    writeFileSync(target, "checks:\n  default: make\n", { mode: 0o600 });
    mkdirp();
    symlinkSync("../dotfiles/policy.yml", policy);
    expect(await setup(scripted(["4", "claude-opus-5.5", "4", "gpt-6.1-sol", "n"]), policy, false)).toBe(0);
    expect(lstatSync(policy).isSymbolicLink()).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(parse(readFileSync(target, "utf8")).review.reviewers["claude-opus-5.5"].model).toBe("gpt-6.1-sol");
    expect(readdirSync(join(dir, "dotfiles"))).toEqual(["policy.yml"]);
  });

  test("a home folder link retargeted while the questions were answered is reported, with no .konductor on either side", async () => {
    mkdirSync(join(dir, "one"));
    mkdirSync(join(dir, "two"));
    symlinkSync("one", join(dir, "home"));
    const linked = join(dir, "home", ".konductor", "policy-overrides.yml");
    const io = scripted(["4", "claude-opus-5.5", "4", "gpt-6.1-sol", "n"]);
    const ask = io.ask;
    io.ask = async (prompt) => {
      if (prompt.startsWith("Also have")) (rmSync(join(dir, "home")), symlinkSync("two", join(dir, "home")));
      return ask(prompt);
    };
    expect(await setup(io, linked, false)).toBe(1);
    expect(io.out).toContain("it changed while the questions were answered");
    expect(existsSync(join(dir, "one", ".konductor"))).toBe(false);
    expect(existsSync(join(dir, "two", ".konductor"))).toBe(false);
  });

  test("a policy file that uses YAML anchors or aliases is not edited, with the reason", async () => {
    const before = "review:\n  reviewers:\n    claude-opus-5.5: &shared { model: old, launch: subagent }\n    other: *shared\n";
    writeFileSync((mkdirp(), policy), before);
    const io = scripted(["4", "claude-opus-5.5", "4", "gpt-6.1-sol", "n", "y"]);
    expect(await setup(io, policy, true)).toBe(1);
    expect(io.out).toContain('{"model":"old","launch":"subagent"}');
    expect(io.out).toContain("uses YAML anchors or aliases; add the pairing to it by hand");
    expect(readFileSync(policy, "utf8")).toBe(before);
  });

  test("a .konductor folder that is a symlink retargeted while the questions were answered is reported", async () => {
    for (const name of ["one", "two"]) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "policy-overrides.yml"), "checks:\n  default: make\n");
    }
    symlinkSync("one", join(dir, ".konductor"));
    const io = scripted(["4", "claude-opus-5.5", "4", "gpt-6.1-sol", "n"]);
    const ask = io.ask;
    io.ask = async (prompt) => {
      if (prompt.startsWith("Also have")) (rmSync(join(dir, ".konductor")), symlinkSync("two", join(dir, ".konductor")));
      return ask(prompt);
    };
    expect(await setup(io, policy, false)).toBe(1);
    expect(io.out).toContain("it changed while the questions were answered");
    for (const name of ["one", "two"]) expect(readFileSync(join(dir, name, "policy-overrides.yml"), "utf8")).toBe("checks:\n  default: make\n");
  });

  test("a file removed or replaced by a directory while the questions were answered is reported, not thrown", async () => {
    for (const change of [() => rmSync(policy), () => (rmSync(policy), mkdirSync(policy))]) {
      writeFileSync((mkdirp(), policy), "checks:\n  default: make\n");
      const io = scripted(["4", "claude-opus-5.5", "4", "gpt-6.1-sol", "n"]);
      const ask = io.ask;
      io.ask = async (prompt) => {
        if (prompt.startsWith("Also have")) change();
        return ask(prompt);
      };
      expect(await setup(io, policy, false)).toBe(1);
      expect(io.out).toContain("it changed while the questions were answered");
      rmSync(policy, { recursive: true, force: true });
    }
  });

  test("a model id that is also a name of an object's built-in property is written like any other", async () => {
    const io = scripted(["4", "__proto__", "4", "constructor", ""]);
    expect(await setup(io, policy, false)).toBe(0);
    const text = readFileSync(policy, "utf8");
    expect(text).toContain("__proto__:");
    expect(text).toContain("constructor:");
  });
});

describe("the templates", () => {
  test("pass the review's effort on, and do not trust a workspace's own configuration", () => {
    for (const h of HARNESSES.filter((x) => x.template)) expect(h.template).toContain("{effort}");
    expect(template("kiro")).not.toContain("--trust-workspace");
  });
});

function mkdirp(): void {
  mkdirSync(join(dir, ".konductor"), { recursive: true });
}
