# Monitor

`Monitor` runs a shell command as a detached background task and turns **complete
stdout lines** into event notifications. The agent receives those notifications
as soon as they are delivered; it does not need to poll task output or wait for
process completion. Both stdout and stderr are retained in the task output log,
but only stdout lines are events.

## Two modes

Use `persistent=false` (the default) for a one-shot condition: “start this check
and tell me when X happens.” The first complete stdout line becomes one event,
and the process is then asked to stop. Later lines are ignored. One-shot monitors
have a default five-minute timeout; use `timeout` to choose a shorter or longer
limit, up to one hour.

Use `persistent=true` for a stream that should remain active: a log tail, a
status poller, a directory watcher, or a similar long-lived process. Notifications
are debounced for 250 ms. When several lines arrive together, only the latest
line is delivered and the event states how many earlier lines were coalesced.
The monitor remains alive until `TaskStop`, session shutdown, or process exit.
Persistent monitors intentionally have no tool timeout; stop them explicitly.

## Monitor versus Bash

Use `Bash` with `run_in_background=true` when you need to run a command and
inspect its accumulated output or its final exit status. Use `Monitor` when a
selected stdout line is an event that should wake the agent without waiting for
completion. A monitor is not a replacement for a normal build, test, or data
processing task.

Every event is a message to the agent. Filter aggressively in the command so
that routine noise does not consume attention. The monitor limits pending event
notifications and coalesces bursts, but a very noisy source can still be
expensive and less useful.

## Make the script observable

Many programs buffer stdout when they are not attached to a terminal. For
streaming filters, use `grep --line-buffered` where supported. In `awk`, call
`fflush()` after writing an event. Emit one meaningful state per line and avoid
multi-line records unless the complete record is genuinely the event.

For poll loops, add `|| true` where a transient non-zero response should not
terminate the loop, and print a clear line for every state that matters. The
filter must match **all terminal states**, not only success: include failure,
cancelled, timeout, and unavailable states as appropriate. Otherwise silence
can be mistaken for “still running.”

Use intervals of at least 30 seconds for remote APIs unless there is a strong
reason to poll faster. For local files or processes, 0.5–1 second may be
reasonable, but prefer event-driven watchers when available. Use neutral test
endpoints such as `https://example.com/status` in examples and scripts.

## Lifecycle

The monitor command runs in the session working directory with a non-interactive
shell environment. Standard input is closed immediately. Use `TaskList` to see
active monitors, `TaskOutput` for a bounded output snapshot, and `TaskStop` to
cancel a monitor. Do not create duplicate monitors while waiting for an event;
the event notification is automatic.
