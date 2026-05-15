import type { Plugin } from "@opencode-ai/plugin";
import type { Dirent } from "node:fs";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { parse as parseYaml } from "yaml";

type NormalizedRule = {
  matchExact?: string;
  matchRegex?: RegExp;
  prompt?: string;
};

type MarkdownCacheEntry = {
  signature: string;
  rules: NormalizedRule[] | null;
};

type SystemPromptModule = {
  SystemPrompt: {
    provider: (model: unknown) => string[];
    instructions: () => string;
  };
};

type BuiltinPrompts = {
  codex: string;
  beast: string;
  gemini: string;
  anthropic: string;
  qwen: string;
};

type MarkdownRuleMeta = {
  model?: string;
  modelRegex?: string;
  flags?: string;
  enabled?: boolean;
};

export const ProviderSystemPromptsPlugin: Plugin = async ({
  client,
}) => {
  const markdownCache = new Map<string, MarkdownCacheEntry>();
  const regexCache = new Map<string, RegExp | null>();
  const warned = new Set<string>();
  let systemPromptModulePromise: Promise<SystemPromptModule | null> | null =
    null;
  let builtinsCache: BuiltinPrompts | null = null;
  let globalConfigDir: string | null = null;

  const ENV_MARKER = "You are powered by the model named ";
  const LOG_SERVICE = "provider-system-prompts";

  function warnOnce(key: string, message: string) {
    if (warned.has(key)) return;
    warned.add(key);
    void log("warn", message);
  }

  async function log(level: "warn" | "error", message: string) {
    try {
      await client.app.log({
        body: {
          service: LOG_SERVICE,
          level,
          message,
        },
      });
    } catch {
      // Logging is best-effort only; prompt transformation should continue.
    }
  }

  async function resolveGlobalConfigDir(): Promise<string> {
    if (globalConfigDir) return globalConfigDir;
    try {
      const result = await client.path.get();
      const configDir = result.data?.config;
      if (typeof configDir === "string" && configDir.length > 0) {
        globalConfigDir = configDir;
        return configDir;
      }
    } catch {
      warnOnce(
        "global-config-dir",
        "provider-system-prompts: failed to resolve global config dir, using ~/.config/opencode",
      );
    }
    globalConfigDir = path.join(os.homedir(), ".config", "opencode");
    return globalConfigDir;
  }

  async function loadSystemPromptModule(): Promise<SystemPromptModule | null> {
    if (systemPromptModulePromise) return systemPromptModulePromise;
    systemPromptModulePromise = (async () => {
      const specifiers = [
        "@/session/system",
        "@opencode-ai/opencode/src/session/system",
        "@opencode-ai/opencode/dist/session/system",
      ];
      for (const specifier of specifiers) {
        try {
          const mod = (await import(specifier)) as Partial<SystemPromptModule>;
          if (
            typeof mod.SystemPrompt?.provider === "function" &&
            typeof mod.SystemPrompt.instructions === "function"
          ) {
            return mod as SystemPromptModule;
          }
        } catch {
          continue;
        }
      }
      warnOnce(
        "systemprompt-import",
        "provider-system-prompts: failed to import SystemPrompt, built-in placeholders may be empty",
      );
      return null;
    })();
    return systemPromptModulePromise;
  }

  async function getBuiltinPrompts(): Promise<BuiltinPrompts | null> {
    if (builtinsCache) return builtinsCache;
    const mod = await loadSystemPromptModule();
    if (!mod) return null;
    try {
      const { SystemPrompt } = mod;
      const codex = coercePrompt(SystemPrompt.instructions());
      const beast = coercePrompt(
        SystemPrompt.provider(makeModelLike("gpt-4", "openai"))?.[0],
      );
      const gemini = coercePrompt(
        SystemPrompt.provider(makeModelLike("gemini-2", "google"))?.[0],
      );
      const anthropic = coercePrompt(
        SystemPrompt.provider(makeModelLike("claude", "anthropic"))?.[0],
      );
      const qwen = coercePrompt(
        SystemPrompt.provider(makeModelLike("qwen", "qwen"))?.[0],
      );
      builtinsCache = {
        codex: codex ?? "",
        beast: beast ?? "",
        gemini: gemini ?? "",
        anthropic: anthropic ?? "",
        qwen: qwen ?? "",
      };
      return builtinsCache;
    } catch {
      warnOnce(
        "builtin-prompts",
        "provider-system-prompts: failed to load built-in prompts",
      );
      return null;
    }
  }

  async function getDefaultProviderPrompt(model: unknown): Promise<string | null> {
    const mod = await loadSystemPromptModule();
    if (!mod) return null;
    try {
      const provider = mod.SystemPrompt.provider(model);
      const prompt = coercePrompt(provider?.[0]);
      return prompt ?? null;
    } catch {
      warnOnce(
        "provider-prompt",
        "provider-system-prompts: failed to resolve default provider prompt",
      );
      return null;
    }
  }

  async function loadMarkdownRulesFromDir(
    rulesDir: string,
  ): Promise<NormalizedRule[] | null> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(rulesDir, { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      warnOnce(
        `markdown-dir:${rulesDir}`,
        `provider-system-prompts: failed to read ${rulesDir}`,
      );
      return null;
    }

    const markdownFiles = entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort();

    if (markdownFiles.length === 0) return null;

    const signatureParts: string[] = [];
    for (const name of markdownFiles) {
      try {
        const stats = await fs.stat(path.join(rulesDir, name));
        signatureParts.push(`${name}:${stats.mtimeMs}`);
      } catch {
        signatureParts.push(`${name}:missing`);
      }
    }
    const signature = signatureParts.join("|");
    const cached = markdownCache.get(rulesDir);
    if (cached && cached.signature === signature) {
      return cached.rules;
    }

    const collected: NormalizedRule[] = [];
    for (const name of markdownFiles) {
      const filePath = path.join(rulesDir, name);
      const parsed = await parseMarkdownRuleFile(filePath);
      if (!parsed) continue;
      collected.push(parsed);
    }

    const result = collected.length ? collected : null;
    markdownCache.set(rulesDir, { signature, rules: result });
    return result;
  }

  async function parseMarkdownRuleFile(
    filePath: string,
  ): Promise<NormalizedRule | null> {
    try {
      const file = Bun.file(filePath);
      if (!(await file.exists())) return null;
      const text = await file.text();
      const split = splitFrontmatter(text);
      if (!split) {
        warnOnce(
          `missing-frontmatter:${filePath}`,
          `provider-system-prompts: missing YAML frontmatter in ${filePath}`,
        );
        return null;
      }

      let meta: MarkdownRuleMeta = {};
      try {
        const parsed = parseYaml(split.frontmatter) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          meta = parsed as MarkdownRuleMeta;
        }
      } catch {
        warnOnce(
          `invalid-yaml:${filePath}`,
          `provider-system-prompts: invalid YAML frontmatter in ${filePath}`,
        );
        return null;
      }

      if (typeof meta.enabled === "boolean" && meta.enabled === false) {
        return null;
      }
      if (typeof meta.enabled !== "undefined" && typeof meta.enabled !== "boolean") {
        warnOnce(
          `invalid-enabled:${filePath}`,
          `provider-system-prompts: enabled must be boolean in ${filePath}`,
        );
      }

      const model = typeof meta.model === "string" ? meta.model : undefined;
      const modelRegex =
        typeof meta.modelRegex === "string" ? meta.modelRegex : undefined;
      const hasFlags = typeof meta.flags !== "undefined";
      if (hasFlags && typeof meta.flags !== "string") {
        warnOnce(
          `invalid-flags:${filePath}`,
          `provider-system-prompts: flags must be string in ${filePath}`,
        );
        return null;
      }
      const flags = typeof meta.flags === "string" ? meta.flags : "";
      if ((model && modelRegex) || (!model && !modelRegex)) {
        warnOnce(
          `invalid-match:${filePath}`,
          `provider-system-prompts: must define exactly one of model or modelRegex in ${filePath}`,
        );
        return null;
      }
      if (hasFlags && !modelRegex) {
        warnOnce(
          `invalid-flags:${filePath}`,
          `provider-system-prompts: flags requires modelRegex in ${filePath}`,
        );
        return null;
      }

      const rule: NormalizedRule = {};
      if (model) {
        rule.matchExact = model;
      } else if (modelRegex) {
        const regex = getCachedRegex(modelRegex, flags, filePath, 0, 0);
        if (!regex) return null;
        rule.matchRegex = regex;
      }

      let prompt = split.body;
      if (prompt.startsWith("\n")) prompt = prompt.slice(1);
      rule.prompt = prompt;

      return rule;
    } catch {
      warnOnce(
        `markdown-read:${filePath}`,
        `provider-system-prompts: failed to read ${filePath}`,
      );
      return null;
    }
  }

  function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length === 0) return null;
    if (lines[0].trim() !== "---") return null;
    let end = -1;
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        end = i;
        break;
      }
    }
    if (end === -1) return null;
    const frontmatter = lines.slice(1, end).join("\n");
    const body = lines.slice(end + 1).join("\n");
    return { frontmatter, body };
  }

  function getCachedRegex(
    pattern: string,
    flags: string,
    configPath: string,
    index: number,
    mtimeMs: number,
  ): RegExp | null {
    const key = `${pattern}::${flags}`;
    if (regexCache.has(key)) return regexCache.get(key) ?? null;
    try {
      const regex = new RegExp(pattern, flags);
      regexCache.set(key, regex);
      return regex;
    } catch {
      warnOnce(
        `invalid-regex:${configPath}:${mtimeMs}:${index}`,
        `provider-system-prompts: invalid modelRegex '${pattern}' in ${configPath}`,
      );
      regexCache.set(key, null);
      return null;
    }
  }

  async function findMatchingRule(modelKey: string): Promise<{
    rule: NormalizedRule;
  } | null> {
    const globalDir = await resolveGlobalConfigDir();
    const globalMarkdownDir = path.join(globalDir, "provider-system-prompts");
    const globalMarkdownRules = await loadMarkdownRulesFromDir(globalMarkdownDir);
    const markdownRule = matchRule(globalMarkdownRules, modelKey);
    if (markdownRule) return { rule: markdownRule };
    return null;
  }

  function matchRule(
    rules: NormalizedRule[] | null,
    modelKey: string,
  ): NormalizedRule | null {
    if (!rules || !rules.length) return null;
    for (const rule of rules) {
      if (rule.matchExact && rule.matchExact === modelKey) return rule;
      if (rule.matchRegex && rule.matchRegex.test(modelKey)) return rule;
    }
    return null;
  }

  async function resolveRulePrompt(rule: NormalizedRule): Promise<string | null> {
    return typeof rule.prompt === "string" ? rule.prompt : null;
  }

  async function renderPrompt(
    template: string,
    context: {
      model: unknown;
      systemText?: string;
      defaultProviderPrompt?: string | null;
    },
  ): Promise<string> {
    let rendered = template;

    if (rendered.includes("{{opencode:provider}}")) {
      let providerPrompt = context.defaultProviderPrompt ?? null;
      if (!providerPrompt && context.systemText) {
        const split = splitProviderPrefixFromSystemText(context.systemText);
        providerPrompt = split ? split.prefix.trimEnd() : null;
      }
      if (!providerPrompt) {
        warnOnce(
          "provider-placeholder",
          "provider-system-prompts: could not resolve {{opencode:provider}} placeholder",
        );
        providerPrompt = "";
      }
      rendered = replaceAll(rendered, "{{opencode:provider}}", providerPrompt);
    }

    const builtinKeys: Array<keyof BuiltinPrompts> = [
      "codex",
      "beast",
      "gemini",
      "anthropic",
      "qwen",
    ];
    const needsBuiltins = builtinKeys.some((key) =>
      rendered.includes(`{{opencode:builtin:${key}}}`),
    );
    if (needsBuiltins) {
      const builtins = await getBuiltinPrompts();
      for (const key of builtinKeys) {
        const token = `{{opencode:builtin:${key}}}`;
        if (!rendered.includes(token)) continue;
        const replacement = builtins?.[key] ?? "";
        if (!replacement) {
          warnOnce(
            `builtin-placeholder:${key}`,
            `provider-system-prompts: could not resolve ${token} placeholder`,
          );
        }
        rendered = replaceAll(rendered, token, replacement);
      }
    }

    return rendered;
  }

  function replaceAll(input: string, search: string, replacement: string) {
    if (!input.includes(search)) return input;
    return input.split(search).join(replacement);
  }

  function splitProviderPrefixFromSystemText(systemText: string): {
    prefix: string;
    rest: string;
  } | null {
    const trimmed = systemText.trimStart();
    if (!trimmed) return null;
    const idx = trimmed.indexOf(ENV_MARKER);
    if (idx === -1) return null;
    const prefixRaw = trimmed.slice(0, idx);
    const prefix = prefixRaw.trimEnd();
    return {
      prefix,
      rest: trimmed.slice(prefix.length),
    };
  }

  function coercePrompt(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return value.trim();
  }

  function makeModelLike(apiId: string, providerID: string) {
    return {
      api: { id: apiId },
      providerID,
    } as { api: { id: string }; providerID: string };
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      const providerID = input.model?.providerID ?? "";
      const apiID = input.model?.api?.id ?? "";
      const modelKey = `${providerID}/${apiID}`;
      const match = await findMatchingRule(modelKey);
      if (!match) return;

      const template = await resolveRulePrompt(match.rule);
      if (template === null) return;

      if (!output.system || typeof output.system[0] !== "string") return;
      const systemText = output.system[0];

      const defaultProviderPrompt = await getDefaultProviderPrompt(input.model);
      const trimmedSystem = systemText.trimStart();
      if (defaultProviderPrompt) {
        if (!trimmedSystem.startsWith(defaultProviderPrompt)) return;
      } else {
        const split = splitProviderPrefixFromSystemText(systemText);
        if (!split?.prefix) return;
      }

      const rendered = await renderPrompt(template, {
        model: input.model,
        systemText,
        defaultProviderPrompt,
      });

      const leadingWhitespace = systemText.slice(
        0,
        systemText.length - trimmedSystem.length,
      );
      const providerPrefix =
        defaultProviderPrompt ??
        splitProviderPrefixFromSystemText(systemText)?.prefix ??
        "";
      const rest = trimmedSystem.slice(providerPrefix.length);
      output.system[0] = `${leadingWhitespace}${rendered}${rest}`;
    },
    "chat.params": async (input, output) => {
      if (!output.options || typeof output.options !== "object") return;
      if (typeof output.options.instructions !== "string") return;

      const agentAny = (input as any).agent;
      const agentName = typeof agentAny === "string" ? agentAny : agentAny?.name;
      const agentHasPrompt =
        (typeof agentAny === "object" && typeof agentAny?.prompt === "string" && agentAny.prompt.trim() !== "") ||
        (typeof agentName === "string" &&
          (agentName === "explore" ||
            agentName === "title" ||
            agentName === "summary" ||
            agentName === "compaction"));
      if (agentHasPrompt) return;

      const existingInstructions = output.options.instructions;

      const providerID = input.model?.providerID ?? "";
      const apiID = input.model?.api?.id ?? "";
      const modelKey = `${providerID}/${apiID}`;
      const match = await findMatchingRule(modelKey);
      if (!match) return;

      const template = await resolveRulePrompt(match.rule);
      if (template === null) return;
      const rendered = await renderPrompt(template, {
        model: input.model,
        defaultProviderPrompt: existingInstructions,
      });
      output.options.instructions = rendered;
    },
  };
};

export default ProviderSystemPromptsPlugin;
