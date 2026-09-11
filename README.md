# Memanto for Obsidian

Your coding agents write things down. This plugin puts what they wrote in your vault.

[Memanto](https://github.com/moorcheh-ai/memanto) is a memory agent that manages what your
other agents remember — across Claude Code, Cursor, Codex and the rest. It already stores
decisions, preferences, facts and failures in one estate. This plugin gives that estate a
human-readable surface: real Markdown notes you can link and query, plus a side pane for
searching and questioning it live.

It is not another "chat with your notes" plugin. It works in the other direction.

## What it does

**Syncs memories into the vault as notes.** One note per memory, with the frontmatter
Memanto already emits — so Dataview works on day one:

````
```dataview
TABLE x_memanto.confidence AS Confidence, x_memanto.provenance AS Source
FROM "Memanto"
WHERE type = "decision"
SORT file.name
```
````

Notes you edit by hand are never overwritten. A sync that would clobber your changes skips
that file and tells you which ones it left alone.

**Searches and questions the estate from a side pane.** Pick an agent, then either
**Recall** for a ranked list of what is stored, or **Answer** for a grounded reply. Results
carry their type, confidence, provenance and date, and can be inserted straight into the
note you are writing.

Recall also does time: most recent, as of a date, or changed since a date.

## Requirements

- **Obsidian 1.7.2** or newer, **desktop only.** Memanto runs as a local server on
  `127.0.0.1`, which mobile cannot reach. Notes synced into the vault are plain Markdown
  and read fine on mobile — the side pane is what needs the desktop.
- **[Memanto](https://github.com/moorcheh-ai/memanto)** installed and configured. It is a
  Python command-line tool and needs Python 3.11 or newer.

## Setup

**This plugin does not install anything for you.** It detects what you already have and
shows you the commands for whatever is missing, with a copy button on each. Open them any
time from the command palette: **Memanto: Setup steps**.

If you already use Memanto, there is nothing to configure. The plugin reads the API key
from the environment where the CLI stored it, and the port and active agent from
`~/.memanto/config.yaml`. Most existing users never see the setup screen.

Starting from nothing, it is four commands:

```bash
pip install memanto          # or: uv tool install memanto / pipx install memanto
memanto                      # asks which backend, stores your key
memanto serve                # leave running, or let the plugin manage it
```

For the cloud backend you need a free key from
[console.moorcheh.ai/api-keys](https://console.moorcheh.ai/api-keys) — 100,000 operations,
no card. Or choose **on-prem** during `memanto` setup and skip the key entirely: that runs
everything locally through Docker, and nothing leaves your machine.

## Commands

| Command | What it does |
| --- | --- |
| **Memanto: Open side pane** | Recall and answer against the running server. |
| **Memanto: Sync memories to vault** | Export the estate and write it into your sync folder. |
| **Memanto: Setup steps** | The install walkthrough, with copyable commands. |

## Network use and privacy

The plugin itself talks to exactly one address: the Memanto server on your own machine,
by default `http://127.0.0.1:8000`. It contacts no other host.

That local server is what reaches the network, and only if you configured the **cloud**
backend — in which case your memories are stored by [Moorcheh](https://www.moorcheh.ai).
Configure Memanto with the **on-prem** backend instead and nothing leaves your machine.
Run `memanto config show` to see which is active.

Your API key is read from the `MOORCHEH_API_KEY` environment variable, where the Memanto
CLI puts it. **The plugin never writes it into the vault**, because vault files sync to
your other devices and to any git remote you have configured.

The plugin sends nothing from your vault to Memanto. It only reads.

## Managing the server

By default the plugin connects to a server if one is running and otherwise tells you to
start one. Set **Server** to *Start and stop with Obsidian* in settings and it will run
`memanto serve` for you, using the `memanto` executable already on your PATH.

It never starts a second server when one is already listening, and it never stops a server
it did not start.

## Building from source

```bash
npm install
npm run build      # typechecks, then bundles to main.js
npm run dev        # watch mode
```

Copy `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/memanto/` and enable it in Community plugins.

## Licence

MIT. See [LICENSE](LICENSE).
