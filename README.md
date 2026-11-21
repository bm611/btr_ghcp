# btr

A terminal UI for GitHub Copilot and other agents that support the Agent Client Protocol (ACP). Built with OpenTUI, it mixes Claude Code's interaction model (inline diffs, `@` file mentions, `!` shell mode, queued messages, prompt history, session resume, a headless print mode) with a monochrome look modeled on Vercel's fx: a one-line welcome, a `┃` prompt rail, `● Ran …` tool lines with `│` output, a shimmering `• Generating (12s)` line, a command palette and pickers in a centered box (type `/` to open it), approvals that rise from the bottom, and a dim status line under the prompt. The earlier Crush-inspired Charm and Daylight themes are still available.

btr launches an ACP agent in the current directory and displays the session. The agent handles the work—including tools, MCP servers, skills and compaction—while btr acts as the client.

## Requirements

- Bun 1.3.14 or newer
- The `copilot` CLI on your PATH, or another ACP agent set with `BTR_AGENT`

The default agent command is `copilot --acp --model auto`.

## Install and run

```sh
bun install
cd /path/to/project
bun /path/to/btr_ghcp/src/main.ts
```

```
btr [options] [prompt]

  -p, --print            Print the reply to the prompt and exit (reads stdin when piped)
  -c, --continue         Continue the most recent conversation in this directory
  -r, --resume [id]      Resume a conversation by id, or pick one from a list
      --model <name>     Start with this model
      --mode <name>      Start in this mode (agent, plan, autopilot)
      --allow-all        With --print: approve every tool call instead of declining
  -h, --help
  -v, --version
```

`BTR_AGENT="gemini --experimental-acp" bun start` runs a different agent. The agent's stderr goes to `$TMPDIR/btr_ghcp-agent.log`. Settings and prompt history live in `~/.btr` (`BTR_HOME` moves them).

`bun run demo` opens the interface against a scripted fake agent (`test/fake-agent.ts`), which is the quickest way to see every part of it without spending Copilot requests.

## The prompt

| Key | What it does |
| --- | --- |
| `Enter` | Send. While the agent works, queue the message for when it finishes |
| `Shift+Enter`, `Ctrl+J`, `Alt+Enter`, `\` then `Enter` | New line |
| `Ctrl+P`, or `/` on an empty prompt | The command palette. Typing searches btr's commands and the agent's together; `Tab` switches between the two lists while you browse. `Space` puts the highlighted command in the prompt so you can add arguments (`/chron` `Space` gives `/chronicle `), and anything that matches nothing is typed out as-is |
| `@` | Mention a file. `Tab` or `Enter` completes; mentioned files are attached to the prompt |
| `!` on an empty prompt | Shell mode: run a command yourself. Its output joins your next prompt |
| `#` on an empty prompt | Memory mode: append a note to `AGENTS.md` or a Copilot instructions file |
| `?` on an empty prompt, `Ctrl+G` | Show every shortcut |
| `↑` / `↓` | Prompt history for this directory |
| `Ctrl+R` | Search the history |
| `Ctrl+O` | Edit the prompt in `$VISUAL` / `$EDITOR` |
| `Alt+S` | Stash the prompt; again on an empty prompt to restore it |
| `Ctrl+V` | Paste an image from the clipboard (macOS). Dragging an image file in works too |

A paste longer than four lines folds into `[Pasted text #1 +12 lines]` and expands when sent.

## The session

| Key | What it does |
| --- | --- |
| `Esc` | Interrupt the turn; queued messages return to the prompt. Twice on an idle prompt clears it |
| `Ctrl+N` | New session |
| `Ctrl+S` | Sessions: resume an earlier one |
| `Ctrl+L` | Switch model |
| `Shift+Tab` | Cycle the agent's modes (Agent, Plan, Autopilot) |
| `Ctrl+Y` | Yolo mode: the agent runs tools without asking (its allow-all option) |
| `Ctrl+D` | Details: full tool output and thinking, and every folded turn expanded |
| `Ctrl+B` | Toggle the sidebar (off by default; windows 110 columns or wider) |
| `Ctrl+T` | Pin the to-do list above the prompt |
| `PgUp` / `PgDn`, mouse wheel | Scroll. `Ctrl+End` jumps to the latest message |
| `Ctrl+C` | Clear the prompt, else interrupt, else (twice) quit |
| `Ctrl+Z` | Suspend; `fg` resumes |

While a turn runs, its thinking and tool calls show as they happen. When it ends they fold into one line above the reply, such as `▸ ⚙ 8 tool calls  ≡ 6  ⌕ 1  $ 1  ∴ 3s`. The icons are `≡` read, `⌕` search, `$` shell command, `✎` edit, `✚` new file, `⌫` delete, `⇢` move, `⇣` fetch, `✗` failed and `∴` thinking time. Click the line to expand or fold that turn. Errors and warnings stay in view.

Selecting text with the mouse copies it. When a turn ends or needs approval while the terminal is unfocused, the terminal bell rings.

Permission requests open a panel at the bottom with what the tool wants, the command (`$ …`) or diff, and numbered choices. Pick with `1`–`3`, `↑`/`↓` and `Enter`, or press `a` (allow), `s` (allow for the session) or `d` (deny); `Esc` declines and interrupts the turn.

The status line under the prompt reads like fx's: `ask` (or `full access` in yolo mode) · model · mode when it is not the default · context `15.4k/128k 12%`. Messages flash in its place for a moment. With Copilot's `auto` model the line shows what auto picked for the latest turn, as `auto → mai code 2 flash`. ACP only ever reports `auto`, so btr reads that from the event log Copilot keeps in `~/.copilot/session-state/<session>/events.jsonl` (or under `$COPILOT_HOME`); other agents just show their model.

The sidebar, off by default, shows the session title and directory, the model and mode, a context-usage bar, the files the agent changed with their line counts, the to-do list, and whether yolo mode is on.

## Commands

Everything is in the palette (`Ctrl+P`). Besides the shortcuts above, it has Copy Last Reply, Export Conversation, Show Git Diff, Session Info, Usage, Initialize Project, Compact Conversation, Themes, Markdown Style, Toggle Background Color, Toggle Notifications and Sign In. Its Agent tab lists the agent's own commands and skills; one that takes arguments is put in the prompt for you to finish.

Commands can also be typed, for example from history or after the palette fills them in:

| Command | What it does |
| --- | --- |
| `/help` | List the commands |
| `/new`, `/clear` | Start a new conversation |
| `/sessions [id]`, `/resume [id]` | Resume an earlier conversation |
| `/model [name]`, `/mode [name]` | Switch model or mode, from a list or by name |
| `/yolo`, `/sidebar`, `/details`, `/todos`, `/keys` | The toggles |
| `/status`, `/cost` | Session info and usage |
| `/copy`, `/export [file]`, `/diff` | Copy the last reply, save the conversation as Markdown, show uncommitted changes |
| `/theme [auto\|fx\|fx-light\|charm\|daylight]` | Theme |
| `/login`, `/exit`, `/quit` | Sign-in help, quit |

Any other slash command (`/compact`, `/context`, `/usage`, `/init`, `/review`, `/mcp`, your skills…) is the agent's and is sent to it as typed.

## Look

A terminal program cannot choose the font: it draws in whatever font your terminal uses. The look comes from the glyphs and colors: `┃` prompt and message rail, `●` tool lines with a trailing `✓` or `✗`, `│` output rails, `•` thinking and working lines, `›` selection, `○` `→` `✓` to-dos, `▪` cancelled turns. They render in any font with reasonable Unicode coverage (the macOS defaults, JetBrains Mono, any Nerd Font).

The default themes, fx and fx light (`auto` picks by the terminal's background), follow the palette in fx's source: xterm grays from 235 to 255, one blue for links, and green and red only for diff markers. btr takes its look from fx and uses none of its code. Charm (dark, violet to pink) and Daylight (light) bring back the Crush-inspired colors and hatched titles. btr keeps the terminal's background unless you turn on Toggle Background Color.

Replies are styled after glow's dark and light styles: headings keep their `##` markers, a top-level heading is a colored band, inline code is padded on a gray background, and code blocks are indented and colored with glow's colors. It is OpenTUI's own Markdown renderer with glow's colors and layout, so replies still stream and glow does not need to be installed. glow's colors apply in every theme, picked dark or light by the theme, so under fx they are the one splash of color. "Markdown Style" in the palette (or `/markdown btr`) switches to the theme's own colors, which stay monochrome under fx.

## Scripts

```sh
bun start          # the interface
bun run demo       # the interface against the fake agent
bun test           # unit tests
bun run typecheck
```

## Layout

- `src/main.ts` parses the command line and starts the interface or print mode.
- `src/tui.ts` is the interface: layout, keys, prompt, suggestions, commands, turns.
- `src/transcript.ts` holds the conversation as items and draws each one; it redraws them all on a theme or verbosity change.
- `src/menu.ts` draws the centered dialogs: the command palette, pickers, searches and permission requests.
- `src/agent.ts` starts the ACP agent and wraps its session API (new, load, list, prompt, cancel, config options).
- `src/tools.ts` turns a tool call into its header, summary, output and patches.
- `src/attachments.ts` handles pastes, images and `@` mentions; `src/files.ts` indexes and fuzzy-matches paths.
- `src/config.ts` stores settings and history; `src/theme.ts` has the palettes, glyphs, gradients and logo.
- `src/print.ts` is `--print`.
