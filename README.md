# opencode-provider-system-prompts

An [opencode](https://opencode.ai) plugin for replacing provider system prompts by model.

## Behavior

The plugin loads markdown rule files from `~/.config/opencode/provider-system-prompts/*.md`. Each file must have YAML frontmatter with exactly one matcher:

```markdown
---
model: openai/gpt-5.5
---
Your replacement provider prompt.
```

Regex matching is also supported:

```markdown
---
modelRegex: ^anthropic/claude
flags: i
---
Your replacement prompt.
```

Templates can reference:

- `{{opencode:provider}}` - the current provider prompt.
- `{{opencode:builtin:codex}}`
- `{{opencode:builtin:beast}}`
- `{{opencode:builtin:gemini}}`
- `{{opencode:builtin:anthropic}}`
- `{{opencode:builtin:qwen}}`

## Install

With `opencode-plugin-manager`:

```jsonc
{
  "plugins": [
    {
      "source": "git",
      "repo": "https://github.com/optix2000/opencode-provider-system-prompts.git"
    }
  ]
}
```

For local bundled install:

```sh
bun install
bun run bundle
cp dist/provider-system-prompts.js ~/.config/opencode/plugins/provider-system-prompts.js
```

Restart opencode after changing plugin registrations.

## Development

```sh
bun install
bun test
bunx tsc --noEmit
bun run bundle
```
