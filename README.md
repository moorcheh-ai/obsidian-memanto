# Memanto for Obsidian

Browse, search and ask questions about your agents' memory from inside Obsidian.

[Memanto](https://github.com/moorcheh-ai/memanto) stores what your coding agents learn
(decisions, preferences, facts and mistakes) from tools like Claude Code, Cursor and Codex.
This plugin brings those memories into your vault as Markdown notes and adds a chat sidebar
for searching them.

## Features

**Sync memories into the vault.** Each memory becomes a note with frontmatter for its type,
confidence and provenance, so you can query them with Dataview:

````
```dataview
TABLE x_memanto.confidence AS Confidence, x_memanto.provenance AS Source
FROM "Memanto"
WHERE type = "decision"
SORT file.name
```
````

If you edit a synced note, later syncs leave it alone and list the files they skipped.

**Chat in the sidebar.** Pick an agent, then choose a mode:

- **Recall** lists matching memories with their type, confidence, provenance and date.
  You can also view the most recent memories, memories as of a date, or what changed
  since a date.
- **Answer** gives a written reply based on the stored memories.

Any result can be copied or inserted into the note you're editing.

## Requirements

- **Obsidian 1.7.2** or newer, on **desktop**. The chat needs a Memanto server running on
  `127.0.0.1`, which mobile can't reach. Synced notes are plain Markdown and open fine on
  mobile.
- **[Memanto](https://github.com/moorcheh-ai/memanto)**, which needs Python 3.11 or newer.

## Setup

The plugin doesn't install anything. It checks what's already on your machine and shows
the commands for anything missing, each with a copy button. Open them any time with
**Memanto: Setup steps** in the command palette.

If Memanto is already set up, there's nothing to configure. The plugin reads your API key
from `~/.memanto/.env` and your active agent from `~/.memanto/config.yaml`.

To start from scratch, run two commands. The plugin starts the server for you.

```bash
pip install memanto          # or: uv tool install memanto / pipx install memanto
memanto                      # choose a backend and enter your key
```

The cloud backend needs a free key from
[console.moorcheh.ai/api-keys](https://console.moorcheh.ai/api-keys) (100,000 operations,
no card required). The on-prem backend needs no key and runs locally through Docker.

## Commands

| Command | What it does |
| --- | --- |
| **Memanto: Open chat** | Opens the chat sidebar. Also available from the ribbon. |
| **Memanto: Sync memories to vault** | Exports memories and writes them into your sync folder. |
| **Memanto: Start server** | Tries to start the server again after a failure. |
| **Memanto: Setup steps** | Shows the install steps with copyable commands. |

## Network use and privacy

The plugin only connects to a Memanto server on your own machine at `127.0.0.1`.

That server connects to [Moorcheh](https://www.moorcheh.ai) only if you chose the cloud
backend, in which case your memories are stored there. With the on-prem backend, nothing
leaves your machine. Run `memanto config show` to check which backend you're using.

Your API key is read from `~/.memanto/.env`. The plugin never saves it in the vault, because
vault files can sync to other devices and git remotes.

The plugin doesn't send your notes to Memanto. Only what you type into the chat is sent.

## The server

When Obsidian opens, the plugin starts its own `memanto serve` on a free port, using the
`memanto` executable on your PATH. It stops that server when Obsidian closes. If you run
`memanto serve` yourself on any port, the plugin doesn't use or stop it. Each open vault gets
its own server.

If Obsidian crashes before stopping the server, the next launch reuses that server and stops
it when you close Obsidian.

To use a server you run yourself, set **Server** to *Connect to my own server* in settings.
The plugin then uses the address in `~/.memanto/config.yaml`.

### Sessions

Memanto allows one session per agent. Starting a new session signs out every other client
using that agent, including the CLI and your coding agents. To avoid this, the plugin reuses
the agent's current session and only starts a new one when the agent doesn't have one.

## Building from source

```bash
npm install
npm run build      # typechecks, then bundles to main.js
npm run dev        # rebuilds on every change
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/memanto/`, then enable the plugin under Community plugins.

## Licence

MIT. See [LICENSE](LICENSE).
