import { afterEach, expect, mock, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin, { ProviderSystemPromptsPlugin, resolveGlobalDirectory, ruleMatches } from "../src/index";

/** Every test owns its fixtures; cleanup never targets a shared directory. */
const tempDirs: string[] = [];
const originalXdg = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** Creates isolated rule storage inside the approved OpenCode temporary root. */
async function fixture(): Promise<string> {
  const root = path.join(os.tmpdir(), "opencode");
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "provider-prompts-"));
  tempDirs.push(directory);
  return directory;
}

/** Writes a rule without touching user configuration. */
async function writeRule(directory: string, name: string, source: string): Promise<void> {
  const root = path.join(directory, "provider-system-prompts");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, name), source);
}

/** Constructs an event with multiple native contributions and request settings. */
function context(): SessionContext {
  return {
    sessionID: "ses_test" as SessionContext["sessionID"],
    agent: "build" as SessionContext["agent"],
    model: { providerID: "test", id: "test-model" } as SessionContext["model"],
    system: [
      { type: "text", text: "Native provider", metadata: { source: "provider", opaque: { keep: true } } },
      { type: "text", text: "Native environment" },
    ],
    messages: [], tools: {}, options: { instructions: "Native request instructions" },
  };
}

/** Captures the public V2 registration and exposes its callback and disposal. */
async function setup(options: Record<string, unknown>) {
  let callback: ((event: SessionContext) => Promise<void> | void) | undefined;
  const dispose = mock(async () => {});
  const hook = mock(async (name: string, handler: typeof callback) => {
    expect(name).toBe("context");
    callback = handler;
    return { dispose };
  });
  const cleanup = await plugin.setup({ options, session: { hook } } as unknown as Plugin.Context);
  expect(hook).toHaveBeenCalledTimes(1);
  if (!callback) throw new Error("Plugin did not register its native context hook");
  return { run: callback, cleanup, dispose };
}

test("exports a stable standalone V2 definition and disposes its hook", async () => {
  expect(plugin).toBe(ProviderSystemPromptsPlugin);
  expect(plugin.id).toBe("opencode-provider-system-prompts");
  expect("server" in plugin).toBe(false);
  const registered = await setup({ globalDirectory: await fixture() });
  await registered.cleanup?.();
  expect(registered.dispose).toHaveBeenCalledTimes(1);
});

test("exact model rule appends once and strips all provider placeholders without duplicating native prompts", async () => {
  const directory = await fixture();
  await writeRule(directory, "10-test.md", "---\nmodel: test/test-model\n---\n{{opencode:provider}}\nCustom body\n{{opencode:provider}}");
  const { run } = await setup({ globalDirectory: directory });
  const event = context();
  const native = [...event.system];
  const originalOptions = { ...event.options };
  await run(event);
  await run(event);
  expect(event.system).toEqual([...native, { type: "text", text: "\nCustom body\n" }]);
  expect(event.system[0]).toBe(native[0]);
  expect(event.system[1]).toBe(native[1]);
  expect(event.options).toEqual(originalOptions);
});

test("uses lexical first enabled matching file, skipping disabled and nonmatching rules", async () => {
  const directory = await fixture();
  await writeRule(directory, "30-last.md", "---\nmodel: test/test-model\n---\nLast");
  await writeRule(directory, "00-disabled.md", "---\nenabled: false\n---\nDisabled");
  await writeRule(directory, "10-other.md", "---\nmodel: test/other\n---\nOther");
  await writeRule(directory, "20-first.MD", "---\nmodelRegex: ^TEST/TEST-MODEL$\nflags: i\n---\nFirst");
  const { run } = await setup({ globalDirectory: directory });
  const event = context();
  await run(event);
  expect(event.system.at(-1)?.text).toBe("First");
  expect(event.system).toHaveLength(3);
});

test.each(["g", "y", "gy"])("resets cached/stateful regex lastIndex for %s flags", (flags) => {
  const rule = { modelRegex: new RegExp("^test/test-model$", flags) };
  rule.modelRegex.lastIndex = 7;
  expect(ruleMatches(rule, "test/test-model")).toBe(true);
  expect(ruleMatches(rule, "test/test-model")).toBe(true);
  expect(ruleMatches(rule, "test/other")).toBe(false);
  expect(ruleMatches(rule, "test/test-model")).toBe(true);
});

test("preserves body whitespace and CRLF while deduplicating by exact text", async () => {
  const directory = await fixture();
  const body = "\r\n  Keep whitespace.  \r\n";
  await writeRule(directory, "10-test.md", `---\r\nmodel: test/test-model\r\n---\r\n${body}`);
  const { run } = await setup({ globalDirectory: directory });
  const event = context();
  event.system.push({ type: "text", text: body.trim() });
  await run(event);
  await run(event);
  expect(event.system.at(-1)?.text).toBe(body);
  expect(event.system).toHaveLength(4);
});

test("missing, nonmatching and placeholder-only rules leave native context untouched", async () => {
  const directory = await fixture();
  const { run } = await setup({ globalDirectory: directory });
  const event = context();
  const native = [...event.system];
  await run(event);
  await writeRule(directory, "10-test.md", "---\nmodel: test/other\n---\nOther");
  await run(event);
  await writeRule(directory, "10-test.md", "---\nmodel: test/test-model\n---\n{{opencode:provider}}\n");
  await run(event);
  expect(event.system).toEqual(native);
});

test("rereads edited rule bodies rather than retaining stale context", async () => {
  const directory = await fixture();
  const { run } = await setup({ globalDirectory: directory });
  await writeRule(directory, "10-test.md", "---\nmodel: test/test-model\n---\nBefore");
  const before = context();
  await run(before);
  await writeRule(directory, "10-test.md", "---\nmodel: test/test-model\n---\nAfter");
  const after = context();
  await run(after);
  expect(before.system.at(-1)?.text).toBe("Before");
  expect(after.system.at(-1)?.text).toBe("After");
});

test.each([
  ["no frontmatter", "YAML frontmatter"],
  ["---\nmodel: [\n---\nBody", "Invalid YAML"],
  ["---\n- item\n---\nBody", "must be a mapping"],
  ["---\nenabled: yes\nmodel: test/test-model\n---\nBody", "enabled must be boolean"],
  ["---\nmodel: 123\n---\nBody", "model must be a string"],
  ["---\nmodelRegex: 123\n---\nBody", "modelRegex must be a string"],
  ["---\nmodel: test/test-model\nmodelRegex: .*\n---\nBody", "exactly one"],
  ["---\nflags: i\n---\nBody", "exactly one"],
  ["---\nmodel: test/test-model\nflags: i\n---\nBody", "flags requires modelRegex"],
  ["---\nmodelRegex: test\nflags: 5\n---\nBody", "flags must be a string"],
  ["---\nmodelRegex: '['\n---\nBody", "Invalid modelRegex or flags"],
  ["---\nmodelRegex: test\nflags: zz\n---\nBody", "Invalid modelRegex or flags"],
])("invalid rule fails with source context: %s", async (source, message) => {
  const directory = await fixture();
  await writeRule(directory, "10-broken.md", source);
  const { run } = await setup({ globalDirectory: directory });
  const event = context();
  await expect(Promise.resolve().then(() => run(event))).rejects.toThrow(message);
  await expect(Promise.resolve().then(() => run(event))).rejects.toThrow("10-broken.md");
  expect(event.system).toEqual(context().system);
});

test.each(["codex", "beast", "gemini", "anthropic", "qwen", "unknown"])("rejects private builtin %s with migration guidance", async (name) => {
  const directory = await fixture();
  await writeRule(directory, "10-private.md", `---\nmodel: test/test-model\n---\n{{opencode:builtin:${name}}}`);
  const { run } = await setup({ globalDirectory: directory });
  await expect(Promise.resolve().then(() => run(context()))).rejects.toThrow("replace it with explicit text you maintain");
});

test("does not disguise directory I/O errors as missing rules", async () => {
  const directory = await fixture();
  await fs.writeFile(path.join(directory, "provider-system-prompts"), "not a directory");
  const { run } = await setup({ globalDirectory: directory });
  await expect(Promise.resolve().then(() => run(context()))).rejects.toThrow("Cannot read");
});

test("honors XDG global discovery and explicit globalDirectory precedence", async () => {
  const xdg = await fixture();
  const global = path.join(xdg, "opencode");
  process.env.XDG_CONFIG_HOME = xdg;
  await writeRule(global, "10-test.md", "---\nmodel: test/test-model\n---\nXDG");
  const { run } = await setup({});
  const event = context();
  await run(event);
  expect(event.system.at(-1)?.text).toBe("XDG");
  expect(resolveGlobalDirectory({ globalDirectory: xdg })).toBe(xdg);
  delete process.env.XDG_CONFIG_HOME;
  expect(resolveGlobalDirectory({})).toBe(path.join(os.homedir(), ".config", "opencode"));
});
