---
name: video_generation
description: "Use Video Generation for AI video generation from text with optional public image, video, or audio references; supports multiple ratios, 480p/720p, 4-12 seconds, and local mp4 saving."
---

# Video Generation

Use this skill to create an mp4 video from a text description (and optional
reference media) with AI video generation, then save it locally and display it
to the user.
The gateway request deliberately keeps `version` set to `v2`.

## Setup

Before the first use, ensure the agent-gw Python SDK (version 0.2.6 or newer) is installed. This checks the current environment and installs or upgrades it only when needed:

```bash
python3 scripts/video_generation_tool.py ensure-deps
```

The SDK needs an API key from `api_key=...`, `KIMI_API_KEY`, or
`~/.kimi/agent-gw.json`.

## Parameters

- `description` (required): detailed text description of the video to generate.
- `ratio`: one of `16:9, 4:3, 1:1, 3:4, 9:16, 21:9`. Default `16:9`.
- `resolution`: one of `480p, 720p`. Default `720p`.
- `duration`: integer seconds, range `4`-`12`. Default `5`.
- `reference_image`: public URL(s) that guide the video style/appearance. Repeat
  `--reference-image` for multiple, max `9`. The gateway only accepts public
  URLs, so a local image must be converted with `image-to-url` first (see
  "Reference media" below); passing a local path to `generate` is rejected.
- `reference_video`: public URL(s) that guide motion/content. Repeat
  `--reference-video` for multiple, max `3`. The gateway only accepts public
  URLs, so a local video must be converted with `video-to-url` first (see
  "Reference media" below); passing a local path to `generate` is rejected.
- `reference_audio`: public URL(s) that guide audio. Repeat `--reference-audio`
  for multiple, max `3`. The gateway only accepts public URLs, so a local audio
  file must be converted with `audio-to-url` first (see "Reference media"
  below); passing a local path to `generate` is rejected.
- `output` (required): local output path ending in `.mp4`.

## Workflow

1. Build a detailed, descriptive `description` from the user's request: include
   subject, action/motion, style, lighting, colors, and mood.
2. Choose `ratio`, `resolution`, and `duration` (4-12 seconds). Use `720p` by
   default.
3. Pick an `output` file path ending in `.mp4`.
4. If the user supplies reference media, they must be public URLs. For any local
   media file (a file on the execution environment, whether that is a sandbox or
   the client's local machine), first run the matching `image-to-url`,
   `video-to-url`, or `audio-to-url` command to upload it and get a public URL,
   then pass that URL with the matching reference option. The gateway only
   accepts public reference URLs; passing a local path to `generate` is rejected.
5. Run the `generate` command (see "Script"). It calls `generate_video` on the
   gateway, reads `media.url` / `media.mime_type` from the response, and
   downloads the video to your `output` path with `curl`. Video generation and
   download are slow, so the script allows up to 60 minutes.
6. If the call fails, explain the failure reason from the printed error. Do not
   invent a video or a local path.
7. On success, the script prints the saved file path. Then **display the video
   to the user by calling the `readFile` tool on that path**. Reading the video
   to show it is the model's job, not this plugin's work.

## Background workflow for long jobs

Reference conversion (`image-to-url`, `video-to-url`, `audio-to-url`) still runs
normally. Only the generation step should be backgrounded.

When the user wants to generate a video, launch the generate command with
`nohup`, redirecting stdout and stderr to a log file. Then start
`scripts/video_generation_watch.py` directly in the foreground (without
`nohup` or `&`); it checks the log every minute and keeps this sandbox alive
until the job finishes or fails.

```bash
nohup python3 scripts/video_generation_tool.py generate \
  --description "..." \
  --ratio "16:9" \
  --resolution "720p" \
  --duration 5 \
  --reference-image "https://..." \
  --output "/path/to/output.mp4" \
  > /tmp/video_generation.generate.log 2>&1 &

python3 scripts/video_generation_watch.py \
  --log-file /tmp/video_generation.generate.log \
  --interval-seconds 60
```

Keep the watcher command running in the foreground. It exits with status 0 and
prints the saved path when generation succeeds, or exits with status 1 and
prints the failure reason. The watcher itself has no timeout: it keeps polling
until one of those terminal states appears in the generation log.

The command-execution environment that runs the foreground watcher may impose
its own timeout. Set that **outer execution timeout** to at least 15 minutes.
This is an execution-tool setting, not a watcher CLI option; do not add a
nonexistent timeout argument to the watcher.

If the outer environment times out while the generation log is still pending,
start `video_generation_watch.py` again in the foreground with the **same
`--log-file` path**. It immediately inspects the existing log and resumes
one-minute checks. Do not start another `generate` command: the original
background generation job continues independently, and starting it again would
create a duplicate video task. The `generate` command's internal gateway and
download timeouts remain fixed in the tool script and cannot be overridden from
the command line.

## Reference media

The plugin runs in an execution environment that may be a sandbox or the
client's local machine. Either way, gateway reference media must be public URLs,
so any local reference media has to be converted first. This is an explicit,
separate step — `generate` does **not** accept local paths.

Convert each local file to a public URL with the matching command (it uploads
the file via the agent-gw `upload_storage` API and returns the public
`signed_url`), then pass the printed public URL to `generate`:

```bash
python3 scripts/video_generation_tool.py image-to-url --image-path /path/to/local.png
python3 scripts/video_generation_tool.py video-to-url --video-path /path/to/local.mp4
python3 scripts/video_generation_tool.py audio-to-url --audio-path /path/to/local.mp3
```

## Script

Use the bundled script from the plugin directory.

Generate a video:

```bash
python3 scripts/video_generation_tool.py generate \
  --description "A serene mountain lake at sunrise, gentle ripples, slow camera push-in, cinematic" \
  --ratio "16:9" \
  --resolution "720p" \
  --duration 5 \
  --output "/path/to/output.mp4"
```

For long-running jobs, run the same command with `nohup` and keep the log path
for the foreground watcher shown above.

Convert local reference media to public URLs first, then pass those URLs:

```bash
# Step 1: upload local files, capture the printed public URLs
python3 scripts/video_generation_tool.py image-to-url --image-path /path/to/local_ref.png
python3 scripts/video_generation_tool.py video-to-url --video-path /path/to/local_ref.mp4
python3 scripts/video_generation_tool.py audio-to-url --audio-path /path/to/local_ref.mp3

# Step 2: pass public URLs (only) to generate
python3 scripts/video_generation_tool.py generate \
  --description "Same character walking through a snowy forest, cinematic" \
  --ratio "9:16" \
  --resolution "720p" \
  --duration 8 \
  --reference-image "https://example.com/ref1.jpg" \
  --reference-image "https://<public-url-from-step-1>" \
  --reference-video "https://<public-video-url-from-step-1>" \
  --reference-audio "https://<public-audio-url-from-step-1>" \
  --output "/path/to/output.mp4"
```

The script:

- `generate` accepts only public `--reference-image`, `--reference-video`, and
  `--reference-audio` URLs and sends them as `reference_image_urls`,
  `reference_video_urls`, and `reference_audio_urls`; a local path is rejected
  with a hint to use the matching `*-to-url` command
- `image-to-url`, `video-to-url`, and `audio-to-url` upload local media via the
  agent-gw `upload_storage` API and print the resulting public `signed_url`
- sends `{"description", "ratio", "resolution", "duration_seconds",
  "reference_image_urls", "reference_video_urls", "reference_audio_urls"}` to
  the gateway `generate_video` API
- reads the generated `media.url` and `media.mime_type` from the response
- downloads the video to the `--output` path with `curl` (allowing up to 60
  minutes), naming the file as `.mp4`
- prints the saved path and a reminder to display it with `readFile`

`generate_video` response shape (`resp.json()`):

```python
{
    "media": {
        "url": str,        # public URL of the generated video
        "mime_type": str,  # e.g. "video/mp4"
    }
}
```

> This skill uses the agent-gw Python SDK: `client.tools.generate_video(...)`
> for generation and `client.upload_storage(...)` (which returns a `signed_url`)
> to turn local reference media into public URLs.
