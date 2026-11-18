import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ignoredSettings } from "./shared/ignored-settings.js";

export default function contribute(server: PluginServerContext) {
  // Wires up settings.look-at-me-ignored.read/write/reset so the client's
  // useSettings() hook (and the "Ignored sessions" settings screen) works.
  server.registerSettings(ignoredSettings);
  return () => {};
}
