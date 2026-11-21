import type * as acp from "@agentclientprotocol/sdk";

/**
 * Helpers for an agent's session config options (ACP `configOptions`). btr looks
 * options up by category: "model", "mode", and "permissions" for an allow-all switch.
 */

/** The select-type config option in a category, such as "mode" or "model". */
export function selectOption(options: acp.SessionConfigOption[], category: string) {
  const o = options.find((o) => o.category === category && o.type === "select");
  return o?.type === "select" ? o : undefined;
}

/** A select option's choices, flattened out of their groups and without duplicates. */
export function choices(o: acp.SessionConfigSelect) {
  const flat = o.options.flatMap((x) => ("group" in x ? x.options : [x]));
  return flat.filter((x, i) => flat.findIndex((y) => y.value === x.value) === i);
}

/** The display name of the current choice in a category; empty when the agent has no such option. */
export function currentName(options: acp.SessionConfigOption[], category: string) {
  const o = selectOption(options, category);
  return o ? (choices(o).find((c) => c.value === o.currentValue)?.name ?? String(o.currentValue)) : "";
}

/** The choice matching what someone typed: a value or name exactly, else the start of a name or part of a value. */
export function findChoice(o: acp.SessionConfigSelect, wanted: string) {
  const w = wanted.toLowerCase();
  const list = choices(o);
  return (
    list.find((c) => c.value.toLowerCase() === w || c.name.toLowerCase() === w) ??
    list.find((c) => c.name.toLowerCase().startsWith(w) || c.value.toLowerCase().includes(w))
  );
}

const ON = /^(on|true|yes|allow)/i;
const OFF = /^(off|false|no|ask)/i;

/** Whether a switch-like value reads as on. */
export const isOn = (value: unknown) => ON.test(String(value));

/** The on and off choices of a switch-like option, when it has both. */
export function onOff(o: acp.SessionConfigSelect) {
  const list = choices(o);
  const on = list.find((c) => ON.test(c.value));
  const off = list.find((c) => OFF.test(c.value));
  return on && off ? { on, off } : null;
}
