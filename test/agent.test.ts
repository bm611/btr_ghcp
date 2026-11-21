import type * as acp from "@agentclientprotocol/sdk";
import { expect, test } from "bun:test";
import { choices, currentName, findChoice, isOn, onOff, selectOption } from "../src/agent/config-options";

const select = (category: string, currentValue: string, options: acp.SessionConfigSelect["options"]): acp.SessionConfigOption => ({
  type: "select",
  id: category,
  name: category,
  category,
  currentValue,
  options,
});

const model = select("model", "sonnet-5", [
  { group: "fast", name: "Fast", options: [{ value: "gpt-6-mini", name: "GPT-6 mini" }] },
  {
    group: "all",
    name: "All",
    options: [
      { value: "sonnet-5", name: "Sonnet 5" },
      { value: "gpt-6-mini", name: "GPT-6 mini" },
    ],
  },
]);
const allow = select("permissions", "off", [
  { value: "on", name: "On" },
  { value: "off", name: "Off" },
]);

test("options are found by category, flattened and named", () => {
  const o = selectOption([model, allow], "model")!;
  expect(choices(o).map((c) => c.value)).toEqual(["gpt-6-mini", "sonnet-5"]);
  expect(currentName([model], "model")).toBe("Sonnet 5");
  expect(currentName([model], "mode")).toBe("");
});

test("typed names match exactly first, then by prefix or part", () => {
  const o = selectOption([model], "model")!;
  expect(findChoice(o, "SONNET 5")?.value).toBe("sonnet-5");
  expect(findChoice(o, "gpt")?.value).toBe("gpt-6-mini");
  expect(findChoice(o, "6-mini")?.value).toBe("gpt-6-mini");
  expect(findChoice(o, "gemini")).toBeUndefined();
});

test("switch-like options read as on or off", () => {
  const o = selectOption([allow], "permissions")!;
  expect(isOn(o.currentValue)).toBe(false);
  expect(onOff(o)).toMatchObject({ on: { value: "on" }, off: { value: "off" } });
  expect(onOff(selectOption([model], "model")!)).toBeNull();
});
