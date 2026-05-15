import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderSystemPromptsPlugin } from "../src/index";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("replaces chat params instructions from an exact model rule", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode/provider-prompts-"));
  tempDirs.push(configDir);
  const rulesDir = path.join(configDir, "provider-system-prompts");
  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(
    path.join(rulesDir, "10-test.md"),
    "---\nmodel: test/test-model\n---\nCustom {{opencode:provider}}\n",
  );

  const logs: unknown[] = [];
  const hooks = await ProviderSystemPromptsPlugin({
    client: {
      app: { log: async (entry: unknown) => logs.push(entry) },
      path: { get: async () => ({ data: { config: configDir } }) },
    },
  } as any);
  const output = { options: { instructions: "Default provider" } };

  await hooks["chat.params"]?.(
    {
      model: { providerID: "test", api: { id: "test-model" } },
    } as any,
    output as any,
  );

  expect(output.options.instructions).toBe("Custom Default provider\n");
  expect(logs).toEqual([]);
});

test("ignores disabled markdown rules", async () => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode/provider-prompts-"));
  tempDirs.push(configDir);
  const rulesDir = path.join(configDir, "provider-system-prompts");
  await fs.mkdir(rulesDir, { recursive: true });
  await fs.writeFile(
    path.join(rulesDir, "10-disabled.md"),
    "---\nmodel: test/test-model\nenabled: false\n---\nDisabled\n",
  );

  const hooks = await ProviderSystemPromptsPlugin({
    client: {
      app: { log: async () => undefined },
      path: { get: async () => ({ data: { config: configDir } }) },
    },
  } as any);
  const output = { options: { instructions: "Default provider" } };

  await hooks["chat.params"]?.(
    {
      model: { providerID: "test", api: { id: "test-model" } },
    } as any,
    output as any,
  );

  expect(output.options.instructions).toBe("Default provider");
});
