import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Persisted mirror of the ignore list: shown and editable in the plugin's
// Settings screen (one-by-one ✕ plus remove-all), and surviving app restarts.
// Scope "host": stored on the daemon next to the agent ids it filters (and
// the only scope the plugin's pinned SDK 0.11.4 accepts).
export const ignoredSettings = defineSettings({
  id: "look-at-me-ignored",
  scope: "host",
  version: 1,
  schema: z.object({ ignoredIds: z.array(z.string()).default([]) }),
});
