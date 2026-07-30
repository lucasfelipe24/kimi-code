# Video Generation Kimi Plugin

This plugin bundles a Kimi skill and helper script for creating mp4 videos from
text descriptions (and optional reference media) through the `agent-gw` video
tools. Generation requests use the gateway's `v2` request version.

## Contents

- `kimi.plugin.json`: catalog manifest for the Kimi plugin.
- `skills/video_generation/SKILL.md`: model instructions for prompting,
  parameter selection, reference-media handling, and displaying the result.
- `scripts/video_generation_tool.py`: command-line wrapper around the gateway
  `generate_video` API and the `upload_storage` API (for turning a local
  reference media file into a public URL), with result download.

## Local Usage

Before the first use, ensure the agent-gw Python SDK (version 0.2.6 or newer) is installed. This checks the current environment and installs or upgrades it only when needed:

```bash
python3 scripts/video_generation_tool.py ensure-deps
```

The SDK reads its API key from `api_key=...`, `KIMI_API_KEY`, or
`~/.kimi/agent-gw.json`.

From this plugin directory:

```bash
python3 scripts/video_generation_tool.py generate \
  --description "A serene mountain lake at sunrise, slow camera push-in, cinematic" \
  --ratio "16:9" --resolution "720p" --duration 5 \
  --output "/path/to/output.mp4"

python3 scripts/video_generation_tool.py image-to-url --image-path /path/to/local.png
python3 scripts/video_generation_tool.py video-to-url --video-path /path/to/local.mp4
python3 scripts/video_generation_tool.py audio-to-url --audio-path /path/to/local.mp3
```

## Long-running Usage

Reference URL conversion runs normally. For video generation, start the command
with `nohup`, then start `scripts/video_generation_watch.py` directly in the
foreground. The watcher checks the generation log every minute and keeps the
sandbox alive until generation succeeds or fails.

```bash
nohup python3 scripts/video_generation_tool.py generate \
  --description "A serene mountain lake at sunrise, slow camera push-in, cinematic" \
  --ratio "16:9" --resolution "720p" --duration 5 \
  --output "/path/to/output.mp4" \
  > /tmp/video_generation.generate.log 2>&1 &

python3 scripts/video_generation_watch.py \
  --log-file /tmp/video_generation.generate.log \
  --interval-seconds 60
```

Keep the watcher command running in the foreground. It exits with status 0 on
success and status 1 on failure. The watcher itself has no timeout and continues
checking once per minute until the generation log contains a terminal result.

Set the outer command-execution timeout to at least 15 minutes. If that outer
timeout expires, run the same watcher command again with the same `--log-file`;
it resumes from the existing log. Do not launch a second generate command. The
generation job continues in the background, while the generation and download
timeouts remain fixed inside the tool script and are not exposed as command-line
arguments.

## Gateway APIs

The plugin name is `video_generation`, but generation requests intentionally
send `version: "v2"` to the gateway.

- `client.tools.generate_video(description, *, ratio, resolution,
  duration_seconds, reference_image_urls, reference_video_urls,
  reference_audio_urls)` → `resp.json()` =
  `{"media": {"url", "mime_type"}}`.
- `client.upload_storage(file, *, filename, content_type)` → `{"signed_url", ...}`;
  the `signed_url` is a public URL used for reference media URLs.

Supported resolutions are `480p` and `720p`. Reference limits are 9 images, 3
videos, and 3 audio files.

## Catalog

Validate and publish from this directory after connecting to the internal network
and setting `MOONGATE_ACCESS_TOKEN`:

```bash
catalog validate
catalog publish
```
