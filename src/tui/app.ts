import type { CliRenderer } from "@opentui/core";
import type { Agent } from "../agent/connection";
import type { Attachments } from "../core/attachments";
import type { Menus } from "../ui/menu";
import type { Transcript } from "../ui/transcript";
import type { Chrome } from "./chrome";
import type { Commands } from "./commands";
import type { Conversation } from "./conversation";
import type { History } from "./history";
import type { Look } from "./look";
import type { Modes } from "./modes";
import type { Options } from "./options";
import type { Prompt } from "./prompt";
import type { Settings } from "./settings";
import type { View } from "./view";

/**
 * What the parts of the interface share. Each part is made by its module's `createX(app)`
 * (see index.ts) and reaches the others through this object when it runs, never while it
 * is being made, so the parts can be made in any order.
 */
export type App = {
  cwd: string;
  renderer: CliRenderer;
  settings: Settings;
  history: History;
  attachments: Attachments;
  /** The agent connection; null until it starts. */
  agent: Agent | null;
  /** The theme in use. */
  look: Look;
  /** The nodes of the layout. */
  view: View;
  transcript: Transcript;
  menus: Menus;
  /** The status line, sidebar and panels around the conversation. */
  chrome: Chrome;
  /** Session updates, turns and the message queue. */
  conversation: Conversation;
  /** The agent's model, mode and permission options. */
  options: Options;
  prompt: Prompt;
  /** What the prompt's shell (!) and note (#) modes do. */
  modes: Modes;
  /** The command palette, typed /commands and the keys bound to them. */
  commands: Commands;
};
