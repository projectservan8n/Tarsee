# Hooks

A hook runs something of yours when Tarsee does something: a message arrives, a tool finishes, a conversation ends,
Tarsee has started.

## What changed

The Node.js version of Tarsee loaded every `workspace/hooks/*.js` file as a JavaScript module. This version of Tarsee
is a single compiled program and cannot run JavaScript, so a `.js` file in `workspace/hooks/` is **not run**. At start
Tarsee logs one line for each such file:

```
[hooks] notify.js is a JavaScript hook, which this version of Tarsee cannot run: see docs/hooks.md
```

A hook is now a **program**: any executable or script, in any language, described by a small JSON file. The same goes
for plugins: `workspace/plugins/*/index.js` is found, logged and not run.

The three built-in hooks (the start-up announcement, the tool log in the daily notes, and the note when a long
conversation ends) are part of Tarsee and keep working.

## The manifest

Put a file named `<name>.hook.json` in `workspace/hooks/`:

```json
{
  "name": "notify",
  "events": ["message:received", "session:end"],
  "command": "notify.sh",
  "args": ["--quiet"]
}
```

- `name`: shown in the logs and the hook list. The file's name when left out.
- `events`: when it runs. One or more of `message:received`, `message:before_send`, `message:after_send`,
  `tool:before_execute`, `tool:after_execute`, `session:start`, `session:end`, `boot:ready`, `heartbeat:tick`,
  `memory:saved`, `agent:spawned`. As in the Node.js version, Tarsee itself emits only `boot:ready` (2 seconds after
  it starts) for now; the other names are the ones hooks can be registered for.
- `command`: the program. A file next to the manifest (`notify.sh`), a path inside the workspace (`scripts/notify.py`),
  an absolute path, or a program on the PATH (`python3`).
- `args`: what it is started with (optional).

## How it runs

On each of its events Tarsee starts the program:

- in the workspace folder, with Tarsee's environment (so the keys you set for Tarsee are there);
- with the event as one line of JSON on stdin: `{"event": "message:received", "data": {...}}`;
- for at most 5 seconds, after which it is stopped.

Whatever it prints on stdout, if it is JSON, is the hook's result. A program that exits with an error code is logged
as `[hooks] <name> error on <event>: exited with code <n>: <what it wrote on stderr>`. Hooks of one event run one after
the other.

## Example

`workspace/hooks/log-messages.hook.json`:

```json
{ "events": ["message:received"], "command": "python3", "args": ["hooks/log_messages.py"] }
```

`workspace/hooks/log_messages.py`:

```python
import json, sys

event = json.load(sys.stdin)
with open("memory/messages.log", "a") as log:
    log.write(json.dumps(event["data"]) + "\n")
print(json.dumps({"logged": True}))
```

The script's path is relative to the workspace, because that is where the program runs.
