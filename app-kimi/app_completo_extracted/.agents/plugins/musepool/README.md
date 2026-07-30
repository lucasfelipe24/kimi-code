# musepool plugin

This directory was scaffolded by `catalog init`. It is an **always-full**
template: it declares a remote MCP server AND a skill. Delete whatever you
don't need.

## kimi.plugin.json

`kimi.plugin.json` is the manifest. It is plain JSON (no comments allowed),
so all guidance lives here. Editors that honor the `$schema` field will give
you completion and validation.

Fields to edit (anything marked `TODO`):

- `name` — kebab/snake-case label (already set to `musepool`), unique per owner.
- `version` — semantic version of this release.
- `description` / `interface.*` — catalog display metadata.
- `mcpServers.musepool.url` — your remote MCP server URL (must be https). If your
  plugin has no MCP server, delete the whole `mcpServers` block (and the
  matching `interface.mcpOverrides` entry).
- `skills/` — one directory per skill, each with a `SKILL.md`. If your plugin
  ships no skill, delete the `skills` field and the `skills/` directory.

## Workflow

```sh
catalog validate --dir .     # local validation, no network
catalog pack --dir .         # produce bundle.zip locally
catalog publish --dir .      # upload + create draft + validate (server)
catalog publish --dir . --publish   # ...and publish if validation passes
```
