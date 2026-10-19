# opencode-provider-system-prompts

A standalone, native [OpenCode V2](https://opencode.ai/v2/docs/build/plugins) plugin for **additive** model-specific system instructions. Targets OpenCode and `@opencode/plugin` **2.0.32**. Its stable plugin ID is `opencode-provider-system-prompts`; V1 is not supported by this version.

## Behavior

On each agent-loop model request, `ctx.session.hook("context")` reads Markdown rule files from the global `provider-system-prompts/` directory. The global root is `$XDG_CONFIG_HOME/opencode` when set, otherwise `~/.config/opencode`. There are no project-level provider rules.

Files are sorted lexically by filename. The **first enabled matching rule** wins; `enabled` defaults to `true`. Each file must have YAML frontmatter with exactly one matcher against the native `providerID/model.id` key:

```markdown
---
model: openai/gpt-5.5
enabled: true
---
Your additional model-specific instructions.
```

Regex matching supports optional JavaScript flags, including repeatable global/sticky matching:

```markdown
---
modelRegex: ^anthropic/claude
flags: i
---
Your additional instructions.
```

The plugin appends one native `{ type: "text", text: ... }` system block. It leaves **every existing system block and its metadata intact**, never rewrites request options, and deduplicates by exact text without trimming or normalizing the appended body. Empty/whitespace-only additions are skipped. Rules are reread for each request, so file edits are picked up without a restart. Only the agent-loop `context` hook is registered; title, compaction, and transient generation requests are not changed.

Missing rule directories/files are harmless. Invalid frontmatter, invalid regex/flags, and other filesystem errors fail the hook with a source-path diagnostic before changing context; they are not silently treated as successful configuration. Disabled files are skipped without validating their matchers/body.

## Migration from the V1 plugin

**This changes the old replacement/override behavior.** V1 attempted to replace a provider prompt and `options.instructions` using private OpenCode modules. The native V2 plugin is deliberately additive: native provider, agent, environment, and other system contributions remain untouched. A rule without a placeholder now adds instructions instead of removing OpenCode's native prompt. If you require actual replacement, this plugin is not an equivalent migration.

- `{{opencode:provider}}` means **keep the already-present native prompt once**. Every occurrence is removed from the added body; native text is not copied or expanded into it. A current rule such as `{{opencode:provider}}` followed by extra instructions continues to preserve native context and add those instructions.
- `{{opencode:builtin:codex}}`, `beast`, `gemini`, `anthropic`, `qwen`, and other `builtin:*` placeholders **are unsupported and cause an actionable error**. Public V2 APIs cannot retrieve those private builtin templates. Remove the placeholder to retain the currently selected native prompts, or replace it with explicit text you own and maintain. Neither choice reproduces selecting a different private builtin prompt, and no equivalence is claimed.
- There are no private imports, prompt-prefix heuristics, V1 hooks, or compatibility shims.

See the [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1) and [plugin migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1).

## Install

For a local checkout, install dependencies with `npm ci`, then use native V2 configuration in `opencode.jsonc` (adjust the relative package path):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "./plugins/opencode-provider-system-prompts" }
  ]
}
```

The checkout's default source export is the native V2 entrypoint; do not load an older published V1 package expecting automatic conversion. After publishing a native V2 package version, its package spec can replace the local path.

An optional `options.globalDirectory` string overrides the global OpenCode root, useful for isolated testing or staged configs:

```jsonc
{
  "plugins": [
    {
      "package": "./plugins/opencode-provider-system-prompts",
      "options": { "globalDirectory": "./test-config/opencode" }
    }
  ]
}
```

Relative overrides resolve against the server process working directory. Omit the option for normal XDG-aware discovery.

For a bundled local install:

```sh
npm ci
npm run bundle
config_home="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$config_home/plugins"
cp dist/provider-system-prompts.js "$config_home/plugins/provider-system-prompts.js"
```

The bundle contains this plugin and YAML support, but leaves the public `@opencode/plugin` runtime external. Make `@opencode/plugin@2.0.32` resolvable from your OpenCode config directory (for example, declare it in that directory's `package.json` and install dependencies). Do not register both the bundle and source package. Reload plugins or restart OpenCode after changing registrations.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run bundle
```

Tests exercise the native V2 registration, additive behavior, placeholder handling, lexical precedence, disabled rules, regex state/flags, exact-text deduplication, XDG discovery, file changes, and failure diagnostics.
