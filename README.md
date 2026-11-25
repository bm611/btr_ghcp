# btr

A terminal UI for GitHub Copilot and other [Agent Client Protocol](https://agentclientprotocol.com/) agents. btr runs an agent in the current directory and displays its session; the agent handles tools, MCP servers, skills, and compaction.

## Requirements

- Bun 1.3.14+
- The `copilot` CLI, or another ACP agent configured with `BTR_AGENT`

The default command is `copilot --acp --model auto`.

## Install and run

```sh
bun install
bun src/main.ts
```

```text
btr [options] [prompt]

  -p, --print            Print a reply and exit (reads stdin when piped)
  -c, --continue         Continue the latest conversation in this directory
  -r, --resume [id]      Resume a conversation, or choose one
      --model <name>     Start with a model
      --mode <name>      Start in agent, plan, or autopilot mode
      --allow-all        With --print, approve every tool call
  -h, --help
  -v, --version
```

Set `BTR_AGENT="gemini --experimental-acp"` to use another agent. Agent stderr is written to `$TMPDIR/btr_ghcp-agent.log`; settings and prompt history are stored in `~/.btr` (override with `BTR_HOME`). Run `bun run demo` to explore the UI with a scripted agent.

## Interface

| Key | Action |
| --- | --- |
| `Enter` | Send a message, or queue it while the agent works |
| `Shift+Enter`, `Ctrl+J`, `Alt+Enter` | Insert a newline |
| `Ctrl+P` or `/` on an empty prompt | Open the command palette |
| `@` | Find and attach a file |
| `!` / `#` on an empty prompt | Run a shell command / add a note to instructions |
| `↑` / `↓`, `Ctrl+R` | Browse or search prompt history |
| `Ctrl+O`, `Alt+S` | Edit or stash the prompt |
| `Ctrl+V` | Paste an image (macOS); image files can also be dragged in |
| `Ctrl+F` | Search the transcript |
| `Esc` | Interrupt the current turn |
| `Ctrl+N`, `Ctrl+S` | Start a session / resume a session |
| `Ctrl+L`, `Shift+Tab` | Switch model / agent mode |
| `Ctrl+Y`, `Ctrl+D` | Toggle tool permissions / show details |
| `Ctrl+B`, `Ctrl+T` | Toggle sidebar / pin the to-do list |
| `PgUp` / `PgDn`, mouse wheel | Scroll; `Ctrl+End` jumps to the latest message |
| `?`, `Ctrl+G` | Show shortcuts |

During a turn, tool output and thinking stay compact; click an entry or press `Ctrl+D` to expand details. Finished turns fold into a summary with edited-file counts. Permission requests offer numbered choices, `a` to allow, `s` to allow for the session, and `d` to deny. The status line shows the model, permissions, mode, and context usage; the optional sidebar shows session details and changed files.

Use `Ctrl+P` to browse btr and agent commands. Common slash commands include `/new`, `/resume`, `/model`, `/mode`, `/permissions`, `/status`, `/copy`, `/export`, `/diff`, `/find`, `/wrap`, and `/theme`. Agent commands such as `/compact` and `/init` are passed through.

## Appearance

The default `fx` themes use a monochrome palette; `auto` selects dark or light based on the terminal. `charm` and `daylight` offer alternate colors. Replies use glow-inspired Markdown styling, configurable from the palette or with `/markdown`.

## Development

```sh
bun start
bun run demo
bun test
bun run typecheck
```

The code is organized into `core/` (shared logic), `agent/` (ACP connection), `ui/` (rendering), and `tui/` (application and interactions). Tests use a scripted agent in `test/fixtures/fake-agent.ts`.

To extend btr, add commands in `tui/commands.ts`, themes in `ui/theme.ts`, settings in `tui/settings.ts`, prompt modes in `tui/modes.ts`, or agent updates in `tui/conversation.ts`.
