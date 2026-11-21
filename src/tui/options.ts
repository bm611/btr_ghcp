import { choices, currentName, findChoice, isOn, onOff, selectOption } from "../agent/config-options";
import { routedModel } from "../agent/copilot";
import { errorText } from "../core/format";
import { G } from "../ui/theme";
import type { App } from "./app";

export type Options = ReturnType<typeof createOptions>;

/** The agent's model, mode and permission options: how they read, and the ways to change them. */
export function createOptions(app: App) {
  // What "auto" resolved to on the latest turn, read from Copilot's own session log.
  let routed = "";

  const option = (category: string) => (app.agent ? selectOption(app.agent.configOptions, category) : undefined);
  const nameOf = (category: string) => (app.agent ? currentName(app.agent.configOptions, category) : "");
  const modelName = () => nameOf("model");
  const isAuto = () => option("model")?.currentValue === "auto";

  /** The model as shown: "auto → mai code 2 flash" once Copilot has routed a turn. */
  const modelLabel = () => (isAuto() && routed ? `${modelName()} ${G.arrow} ${routed}` : modelName()).toLowerCase();

  async function refreshRouted() {
    const agent = app.agent;
    if (!agent || !isAuto()) return;
    const id = agent.sessionId;
    const found = await routedModel(id);
    if (id !== agent.sessionId || !found || found === routed) return;
    routed = found;
    app.chrome.drawStatus();
    app.chrome.drawSidebar();
  }

  /** Whether the agent approves everything on its own: a permissions option set to on. */
  function yolo() {
    const o = option("permissions");
    return !!o && isOn(o.currentValue);
  }

  async function set(category: string, value: string) {
    const agent = app.agent;
    const o = option(category);
    if (!agent || !o || o.currentValue === value) return;
    try {
      await agent.setConfigOption(o.id, value);
    } catch (err) {
      app.chrome.flash(`Could not set ${category}: ${errorText(err)}`, "error");
    }
    app.chrome.layout();
  }

  /** Sets a select option from what the user typed: a value, a name, or the start of one. */
  async function setByName(category: string, wanted: string): Promise<boolean> {
    const o = option(category);
    const match = o && findChoice(o, wanted);
    if (!match) return false;
    await set(category, match.value);
    return true;
  }

  function cycleMode() {
    const o = option("mode");
    if (!o) return app.chrome.flash("This agent has no modes", "warning");
    const list = choices(o);
    const i = list.findIndex((c) => c.value === o.currentValue);
    void set("mode", list[(i + 1) % list.length]!.value);
  }

  async function pick(category: "model" | "mode") {
    const o = option(category);
    if (!o) return app.chrome.flash(`This agent has no ${category} option`, "warning");
    const list = choices(o);
    const value = await app.menus.open({
      title: category === "model" ? "Switch Model" : "Switch Mode",
      options: list.map((c) => ({ label: c.name, value: c.value, hint: c.value === o.currentValue ? G.check : undefined })),
      initial: list.findIndex((c) => c.value === o.currentValue),
      filterable: true,
      placeholder: category === "model" ? "Choose a model" : "Choose a mode",
    });
    if (!value) return;
    await set(category, value);
    app.chrome.flash(`${category === "model" ? "Model" : "Mode"}: ${nameOf(category)}`, "success");
  }

  async function toggleYolo() {
    const o = option("permissions");
    if (!o) return app.chrome.flash("This agent has no allow-all option", "warning");
    const pair = onOff(o);
    if (!pair) {
      const value = await app.menus.open({ title: o.name, options: choices(o).map((c) => ({ label: c.name, value: c.value })) });
      if (value) await set("permissions", value);
      return;
    }
    await set("permissions", yolo() ? pair.off.value : pair.on.value);
    app.chrome.flash(yolo() ? "Yolo mode on: tools run without asking" : "Yolo mode off: tools ask first", yolo() ? "warning" : "info");
  }

  return {
    option,
    modelName,
    modeName: () => nameOf("mode"),
    modelLabel,
    refreshRouted,
    /** Forgets the routed model, for a new or resumed session. */
    forgetRouted() {
      routed = "";
    },
    yolo,
    set,
    setByName,
    cycleMode,
    pick,
    toggleYolo,
  };
}
