# Pilot

A personal, Codex-style web interface for [Pi](https://github.com/earendil-works/pi-mono). Pilot uses Pi's SDK directly and reuses the current OS user's models, credentials, settings, resources, extensions, tools, and JSONL sessions.

> **Security:** Pilot is not a sandbox. Pi's tools run with the permissions of the user who starts Pilot. Only use trusted repositories. Pilot listens on loopback and does not provide network authentication.

## Requirements

- Node.js 24+
- Pi credentials and configuration in Pi's default configuration directory
- pnpm 11+ when building or developing from source

The Pi SDK is an exact project dependency in `package.json`; Pilot does not import a global Pi installation.

## Install the `pilot` command

Build and install the command from a checkout:

```bash
pnpm install --frozen-lockfile
npm pack
npm install --global ./pilot-0.1.0.tgz
```

A downloaded release tarball can be installed with the same `npm install --global` command.

The package includes the compiled backend and frontend. It installs an executable named `pilot` and does not depend on the checkout after installation.

## Configuration

Pilot optionally reads a JSON configuration file. It does not read Pilot settings from environment variables. When the file is absent, Pilot uses port `3210` and log level `info`.

| OS      | Configuration path                                |
| ------- | ------------------------------------------------- |
| Linux   | `${XDG_CONFIG_HOME:-~/.config}/pilot/config.json` |
| macOS   | `~/Library/Application Support/Pilot/config.json` |
| Windows | `%APPDATA%\Pilot\config.json`                     |

When run as an installed command, Pilot appends JSON logs to the platform's standard log directory:

| OS      | Log path                                            |
| ------- | --------------------------------------------------- |
| Linux   | `${XDG_STATE_HOME:-~/.local/state}/pilot/pilot.log` |
| macOS   | `~/Library/Logs/Pilot/pilot.log`                    |
| Windows | `%LOCALAPPDATA%\Pilot\Logs\pilot.log`               |

Every setting is optional:

| Setting           | Default  | Purpose                                                         |
| ----------------- | -------- | --------------------------------------------------------------- |
| `port`            | `3210`   | Port used by the loopback server                                |
| `allowedOrigins`  | `[]`     | Additional exact HTTP(S) browser origins                        |
| `logLevel`        | `"info"` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent` |
| `titleGeneration` | —        | Optional automatic session titles using a configured Pi model   |

Runtime resource policy is automatic. Unusual installations can override it in an advanced section:

```json
{
  "advanced": {
    "runtimeIdleMinutes": 30,
    "maxRuntimes": 32,
    "runtimeCacheMiB": 128
  }
}
```

These advanced values control idle runtime disposal, concurrent or retained runtime capacity, and the memory budget for retained transcript/tool data. Project and session collections are paginated automatically rather than controlled by configuration.

### Automatic session titles

Pilot generates a title as soon as a session's first user message is submitted. The title request runs independently of the agent response, uses Pi's provider-neutral model runtime and existing credentials, and is not added to the conversation transcript:

```json
{
  "titleGeneration": {
    "enabled": true,
    "model": {
      "provider": "openai-codex",
      "id": "gpt-5.6-luna"
    },
    "maxCharacters": 30
  }
}
```

`maxCharacters` is optional and defaults to `30`. The generated title never replaces an existing or manually assigned session name. Title requests from different sessions may run concurrently without a global limit. Failures are logged and leave the normal first-message fallback unchanged. Set `enabled` to `false`, or omit the section, to disable title generation.

Projects are not configured in this file. Add individual server folders from Pilot's sidebar. Pilot persists that managed list in `projects.json` next to `config.json`; removing a project from Pilot never deletes its folder or Pi sessions.

The listener is fixed to `127.0.0.1`. Origins for `127.0.0.1` and `localhost` on the configured port are always allowed, so they do not belong in `allowedOrigins`. When present, the JSON is validated strictly at startup; unknown or invalid settings cause an error that includes the configuration path.

Session storage continues to follow Pi's own settings.

## Manage projects

Use **Add project** in the sidebar to open Pilot's server folder browser. Browse from Home or the filesystem root, use breadcrumbs, filter the current directory, reveal hidden folders when needed, or enter an absolute path directly. Pilot validates and resolves the selected directory before adding it.

Projects appear as collapsible sections with their active sessions. Search filters sessions across every project, including archived sessions. Use a project's actions menu to archive all of its sessions or remove it from Pilot's view. Running sessions must be stopped before archiving all. Removing a project does not modify its files or sessions, and adding the same folder later restores it with the same sessions and archive state.

## Run

```bash
pilot
```

Pilot serves both its frontend and API from `http://127.0.0.1:<port>`, using the configured port. Its terminal output shows the exact address, log path, and the `Ctrl+C` quit instruction.

From a checkout, a production build can also be run with:

```bash
pnpm build
pnpm start
```

## Develop

Development uses the same optional OS-level `config.json` as the installed command:

```bash
pnpm install
pnpm dev
```

The command starts Fastify on the configured backend port and Vite on an available loopback port. Unlike the installed command, the development server keeps Fastify logs on stdout. Vite prints the browser URL, chooses another port if its default is occupied, and proxies HTTP and WebSocket API traffic to Fastify. Loopback browser origins on any port are accepted only in development. Frontend changes use Vite hot-module reload; backend changes restart through `tsx` watch mode.

## Install on a phone

Pilot is a progressive web app. When served through an HTTPS endpoint such as Tailscale Serve, install it from the browser:

- **iPhone or iPad:** open Pilot in Safari, choose **Share**, then **Add to Home Screen**.
- **Android:** open Pilot in Chrome and choose **Install app** from the browser menu.

On a phone, swipe right from the left edge to open the sidebar. Swipe left across the sidebar or its backdrop to close it.

The installed app caches only Pilot's frontend shell. Projects, sessions, prompts, transcripts, and WebSocket traffic are never added to the offline cache, and working with Pi still requires a connection to the Pilot server. Keep the HTTPS origin in `allowedOrigins`; access through Tailscale Serve can continue to proxy to Pilot's loopback listener.

## Queue messages

While Pi is working, the composer uses Pi's native message queues:

- **Enter** queues a steering message for the next turn.
- **Alt+Enter** queues a follow-up for after the current work finishes.
- Pending messages appear above the composer, where they can be edited, changed between steering and follow-up delivery, deleted individually, or cleared together.
- **Stop** aborts the run and cancels messages that are still queued.

Pi's configured `steeringMode` and `followUpMode` delivery settings remain in effect.

## Transcript and composer controls

- Thinking and tool calls are grouped into collapsed disclosures that can be toggled at any time. While Pi is working, the active disclosure shows the live elapsed time in one indicator.
- Completed agent turns show their total elapsed time in the transcript.
- The composer footer shows current context-window usage as a compact ring next to the model and thinking effort. Hover or focus it for the exact percentage and token details.
- Type `/` to browse all commands discovered by Pi, including extension commands, prompt templates, and skills. Select a command, add optional arguments, and send it like any other prompt.
- Notifications emitted by extensions through `ctx.ui.notify()` appear as Pilot notifications.

## Upload files

Use the paperclip button, paste files into the composer, or drag them onto it. Pilot accepts PNG, JPEG, GIF, and WebP files for models that support image input, plus UTF-8 text, source code, configuration, data, log, diff, and patch files for every model. A prompt can include up to 5 images, with a 5 MiB per-image and 10 MiB combined limit, and up to 5 text or code files within the 64 KiB prompt limit. Attachments can be sent without accompanying text and remain part of queued messages.

## Manage sessions

Hover or focus a session in the sidebar and open its actions menu to rename, archive, or delete it. The sidebar search covers active sessions only. Archived sessions are available through the **Archived** button at the bottom, which opens a searchable dialog with a project selector. Archived sessions remain available to read; restore one before continuing its conversation. Archive state is stored as Pilot metadata in the Pi JSONL transcript. A running session must be stopped before it can be archived or deleted. Deletion is permanent and removes the transcript after confirmation.

## Validation

```bash
pnpm check
```

This runs type checking, linting, formatting checks, tests, and a production build.

## Security behavior

- Fastify always binds to `127.0.0.1`.
- Browser requests and WebSocket upgrades with an unexpected `Origin` are rejected.
- No CORS headers are enabled.
- Projects must be explicitly added through Pilot. Paths are canonicalized and verified as directories before use.
- The server folder browser returns directory names only; it does not expose file contents.
- Project and session API responses are cursor-paginated.
- Provider credentials and API keys stay server-side. Common credential patterns are redacted from projected text, tool arguments, and logs.
- Prompt, image attachment, request, WebSocket frame, transcript, and tool-output sizes are bounded. Uploaded image signatures are verified server-side before they reach Pi.
- A run belongs to one shared server-side runtime per session and continues if every browser disconnects.
- Different sessions, including sessions in the same project, may run concurrently. Pilot does not prevent file or Git conflicts.
