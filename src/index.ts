import { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const PLUGIN_ID = "opencode-provider-system-prompts";
const PROVIDER_PLACEHOLDER = "{{opencode:provider}}";
const PRIVATE_BUILTIN_PLACEHOLDER = /{{\s*opencode:builtin:[^}]+}}/;

/** Untrusted YAML values are validated before a rule can affect context. */
interface RuleFrontmatter {
  readonly model?: unknown;
  readonly modelRegex?: unknown;
  readonly flags?: unknown;
  readonly enabled?: unknown;
}

/** Exactly one matcher is present; the body retains its original whitespace. */
interface ProviderRule {
  readonly model?: string;
  readonly modelRegex?: RegExp;
  readonly body: string;
}

/** Recognizes missing files without suppressing permission or other I/O errors. */
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "ENOENT";
}

/** Resolves the global OpenCode config root, with an optional explicit override. */
export function resolveGlobalDirectory(options: Readonly<Record<string, unknown>>): string {
  const configured = options.globalDirectory;
  if (typeof configured === "string" && configured.length > 0) {
    return path.resolve(configured);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "opencode") : path.join(os.homedir(), ".config", "opencode");
}

/** Extracts YAML without normalizing the Markdown body's text or line endings. */
function splitFrontmatter(source: string, filePath: string): { frontmatter: string; body: string } {
  const match = /^---[^\S\r\n]*\r?\n([\s\S]*?)^---[^\S\r\n]*(?:\r?\n|$)/m.exec(source);
  if (!match || match.index !== 0) {
    throw new Error(`[${PLUGIN_ID}] Missing or unterminated YAML frontmatter in ${filePath}`);
  }
  return { frontmatter: match[1], body: source.slice(match[0].length) };
}

/** Parses one enabled rule and reports actionable configuration errors. */
async function parseRule(filePath: string): Promise<ProviderRule | undefined> {
  let source: string;
  try {
    source = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`[${PLUGIN_ID}] Cannot read ${filePath}`, { cause: error });
  }
  const document = splitFrontmatter(source, filePath);
  let decoded: unknown;
  try {
    decoded = parseYaml(document.frontmatter);
  } catch (error) {
    throw new Error(`[${PLUGIN_ID}] Invalid YAML in ${filePath}`, { cause: error });
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error(`[${PLUGIN_ID}] YAML frontmatter must be a mapping in ${filePath}`);
  }
  const meta = decoded as RuleFrontmatter;
  if (meta.enabled === false) return undefined;
  if (meta.enabled !== undefined && typeof meta.enabled !== "boolean") {
    throw new Error(`[${PLUGIN_ID}] enabled must be boolean in ${filePath}`);
  }
  if (meta.model !== undefined && typeof meta.model !== "string") {
    throw new Error(`[${PLUGIN_ID}] model must be a string in ${filePath}`);
  }
  if (meta.modelRegex !== undefined && typeof meta.modelRegex !== "string") {
    throw new Error(`[${PLUGIN_ID}] modelRegex must be a string in ${filePath}`);
  }
  const model = meta.model as string | undefined;
  const pattern = meta.modelRegex as string | undefined;
  if ((model === undefined) === (pattern === undefined)) {
    throw new Error(`[${PLUGIN_ID}] Define exactly one of model or modelRegex in ${filePath}`);
  }
  if (meta.flags !== undefined && typeof meta.flags !== "string") {
    throw new Error(`[${PLUGIN_ID}] flags must be a string in ${filePath}`);
  }
  if (meta.flags !== undefined && pattern === undefined) {
    throw new Error(`[${PLUGIN_ID}] flags requires modelRegex in ${filePath}`);
  }
  let modelRegex: RegExp | undefined;
  if (pattern !== undefined) {
    try {
      modelRegex = new RegExp(pattern, (meta.flags as string | undefined) ?? "");
    } catch (error) {
      throw new Error(`[${PLUGIN_ID}] Invalid modelRegex or flags in ${filePath}`, { cause: error });
    }
  }
  const unsupported = document.body.match(PRIVATE_BUILTIN_PLACEHOLDER)?.[0];
  if (unsupported) {
    throw new Error(
      `[${PLUGIN_ID}] Unsupported private builtin placeholder ${unsupported} in ${filePath}; ` +
      "remove it to retain native V2 prompts, or replace it with explicit text you maintain. " +
      "The public V2 API cannot retrieve private builtin prompts.",
    );
  }
  return { model, modelRegex, body: document.body.split(PROVIDER_PLACEHOLDER).join("") };
}

/** Makes global and sticky regex matching independent of previous requests. */
export function ruleMatches(rule: Pick<ProviderRule, "model" | "modelRegex">, modelKey: string): boolean {
  if (rule.model !== undefined) return rule.model === modelKey;
  if (!rule.modelRegex) return false;
  rule.modelRegex.lastIndex = 0;
  return rule.modelRegex.test(modelKey);
}

/** Reads fresh rules in lexical filename order and selects the first enabled match. */
async function findRule(globalDirectory: string, modelKey: string): Promise<ProviderRule | undefined> {
  const directory = path.join(globalDirectory, "provider-system-prompts");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new Error(`[${PLUGIN_ID}] Cannot read ${directory}`, { cause: error });
  }
  const names = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name).sort();
  for (const name of names) {
    const rule = await parseRule(path.join(directory, name));
    if (rule && ruleMatches(rule, modelKey)) return rule;
  }
  return undefined;
}

/** Adds one rule body without replacing, reconstructing, or copying native prompts. */
export async function applyProviderRule(
  event: Pick<SessionContext, "model" | "system">,
  globalDirectory: string,
): Promise<void> {
  const rule = await findRule(globalDirectory, `${event.model.providerID}/${event.model.id}`);
  if (!rule || !rule.body.trim()) return;
  if (event.system.some((block) => block.type === "text" && block.text === rule.body)) return;
  event.system.push({ type: "text", text: rule.body });
}

/** Standalone native V2 entrypoint; no V1 adapter or private OpenCode imports. */
export const ProviderSystemPromptsPlugin = Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const globalDirectory = resolveGlobalDirectory(ctx.options);
    const registration = await ctx.session.hook("context", (event) => applyProviderRule(event, globalDirectory));
    return () => registration.dispose();
  },
});

export default ProviderSystemPromptsPlugin;
