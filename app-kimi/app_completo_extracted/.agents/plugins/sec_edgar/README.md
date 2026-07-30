# SEC EDGAR Kimi Plugin

This plugin bundles a Kimi skill and helper script for querying the SEC EDGAR
datasource through `agent-gw`.

## Contents

- `kimi.plugin.json`: catalog manifest for the Kimi plugin.
- `skills/sec_edgar/SKILL.md`: model instructions for selecting and calling SEC
  EDGAR datasource APIs.
- `scripts/sec_edgar_tool.py`: command-line wrapper around
  `get_data_source_desc` and `call_data_source_tool`.

## Local Usage

Check whether the agent-gw Python SDK is available in the current Python environment, and install it only if the check fails:

```bash
python3 -c "import agent_gw" || python3 -m pip install "$(curl -s https://cdn.kimi.com/agentgw/pysdk/manifest.json | python3 -c "import json,sys; print(json.load(sys.stdin)['latest']['url'])")"
```

The SDK reads its API key from `api_key=...`, `KIMI_API_KEY`, or
`~/.kimi/agent-gw.json`.

From this plugin directory:

```bash
python3 scripts/sec_edgar_tool.py describe
python3 scripts/sec_edgar_tool.py call --api-name "<api name>" --params-json '{"ticker":"AAPL"}'
```

## Catalog

Validate and publish from this directory after connecting to the internal network
and setting `MOONGATE_ACCESS_TOKEN`:

```bash
catalog validate
catalog publish
```
