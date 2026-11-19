import { useEffect, useState, useSyncExternalStore } from "react";
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { ignoredSettings } from "./shared/ignored-settings.js";
import { ignoredSettingsRpc } from "./shared/ignored-settings.js";
import { Pressable, Text, View } from "react-native";

interface WatchedAgent {
  id: string;
  title?: string | null;
  requiresAttention?: boolean;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
  activeTurnId?: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asAgent(value: unknown): WatchedAgent | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string") return null;
  const turn = record.activeTurn as Record<string, unknown> | null | undefined;
  return {
    id: record.id,
    title: asString(record.title) ?? asString(record.name),
    requiresAttention: record.requiresAttention === true,
    attentionReason: asString(record.attentionReason),
    attentionTimestamp: asString(record.attentionTimestamp),
    updatedAt: asString(record.updatedAt),
    lastUserMessageAt: asString(record.lastUserMessageAt),
    activeTurnId:
      turn && typeof turn === "object" ? asString(turn.turnId) : null,
  };
}

// Identity of one attention event. Null means "not needing attention".
// Any reason counts: finished, error, permission, or whatever new ones come.
function attentionKey(agent: WatchedAgent): string | null {
  if (agent.requiresAttention !== true) return null;
  if (agent.attentionReason === null || agent.attentionReason === undefined)
    return agent.attentionTimestamp ?? "";
  return `${agent.attentionReason}#${agent.attentionTimestamp ?? ""}`;
}

// Identity of the latest user prompt / turn. Changes when the user sends
// a new prompt, which is when the green circle must go away.
function promptMarker(agent: WatchedAgent): string {
  return `${agent.lastUserMessageAt ?? ""}#${agent.activeTurnId ?? ""}`;
}

function reasonLabel(reason: string | null): string {
  if (reason === "finished") return "finished";
  if (reason === "error") return "failed";
  if (reason === "permission") return "needs permission";
  return reason ?? "waiting";
}

// Shared state between the watcher and the screen, per app instance.
interface WaitingEntry {
  reason: string | null;
  title: string | null;
  updatedAt: number;
}
const waiting = new Map<string, WaitingEntry>();
let waitingVersion = 0;
const waitingListeners = new Set<() => void>();
// Sessions consumed by circle clicks. A duplicate echo of the same attention
// event must not re-add them; a genuinely new event (new key) un-consumes.
const consumed = new Set<string>();
// Last attention key per agent, and last prompt marker per agent. Module-level
// like `waiting` so the ignore filter (also module-level) can re-arm them.
const seen = new Map<string, string>();
const prompts = new Map<string, string>();
// Last full snapshot per agent, so un-ignoring can immediately re-surface a
// session that is still waiting instead of staying silent until its next
// (possibly never-coming) event.
const lastAgent = new Map<string, WatchedAgent>();
// Last known title per agent, so the ignored list can show titles even
// though ignored sessions no longer pass through the waiting map.
const titles = new Map<string, string>();
// Sessions whose notifications are filtered out ("ignore this session's
// updates"). While ignored, attention events never queue and any pending entry
// is dropped; un-ignoring (x) re-arms the session so its next event notifies
// again.
const ignored = new Set<string>();
let ignoredVersion = 0;
const ignoredListeners = new Set<() => void>();
// Handoff receipts for the screen: takeNext deletes the entry at click time,
// so the opening screen resolves its target from this list (plus the live
// map), not from the map alone. Bounded; rapid multi-clicks each keep theirs.
const recentConsumed: string[] = [];
// Module-level handle so the circle press handler can request a sidebar
// refresh (refreshSidebar itself lives in activate scope).
let requestSidebarRefresh: (() => void) | null = null;
// Module-level handle so the ignore actions can ask for a replay of the
// latest snapshot (replay itself lives in contribute scope next to noteAgent).
let requestReplay: ((agentId: string) => void) | null = null;

function bumpWaiting(): void {
  waitingVersion += 1;
  waitingListeners.forEach((listener) => listener());
}

function subscribeWaiting(listener: () => void): () => void {
  waitingListeners.add(listener);
  return () => {
    waitingListeners.delete(listener);
  };
}

function getWaitingVersion(): number {
  return waitingVersion;
}

function bumpIgnored(): void {
  ignoredVersion += 1;
  ignoredListeners.forEach((listener) => listener());
}

function subscribeIgnored(listener: () => void): () => void {
  ignoredListeners.add(listener);
  return () => {
    ignoredListeners.delete(listener);
  };
}

function getIgnoredVersion(): number {
  return ignoredVersion;
}

function sortedIgnoredIds(): string[] {
  return [...ignored].sort();
}

// Persisted mirror of the ignore list: shown and editable in the plugin's
// Settings screen (one-by-one ✕ plus remove-all), and surviving app restarts.
// Definition lives in shared/; the daemon side is wired up in index.server.ts
// via server.registerSettings. Memory stays the live filter used by
// noteAgent; the settings screen unions the two on open, so ignores made
// while Settings is closed are kept, not clobbered.

// Latest saver from the mounted settings screen, if any. Saves can fail on a
// stale revision (returns false, never throws); the next Settings open
// re-unions and converges, so a failed save is never a lost ignore.
let saveIgnoredSettings: (() => void) | null = null;
let syncedSettingsRevision: string | null = null;

function persistIgnored(): void {
  try {
    saveIgnoredSettings?.();
  } catch {
    // Settings screen not mounted; memory still filters, union on next open.
  }
}

function ignoreAgent(agentId: string): void {
  ignored.add(agentId);
  seen.delete(agentId);
  prompts.delete(agentId);
  consumed.delete(agentId);
  if (waiting.delete(agentId)) bumpWaiting();
  bumpIgnored();
  persistIgnored();
  requestSidebarRefresh?.();
}

function unignoreAgent(agentId: string): void {
  if (!ignored.delete(agentId)) return;
  // Re-arm: the next attention event must count as new even if the daemon
  // still raises the same key.
  seen.delete(agentId);
  prompts.delete(agentId);
  consumed.delete(agentId);
  bumpIgnored();
  persistIgnored();
  requestSidebarRefresh?.();
  // Re-surface a session that is still waiting right now.
  requestReplay?.(agentId);
}

function unignoreAllAgents(): void {
  if (ignored.size === 0) return;
  const ids = [...ignored];
  ignored.clear();
  for (const id of ids) {
    seen.delete(id);
    prompts.delete(id);
    consumed.delete(id);
  }
  bumpIgnored();
  persistIgnored();
  requestSidebarRefresh?.();
  // Re-surface sessions that are still waiting right now.
  for (const id of ids) requestReplay?.(id);
}

// Remembers which single entry already auto-opened, so viewing the
// screen again does not re-jump to the same session.
let lastAutoOpenedKey: string | null = null;

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

// First 7 symbols of the paseo id, used by the ignored-sessions list.
function short7(id: string): string {
  return id.slice(0, 7);
}

// Recency order: most recent first, then older ones.
let clickSeq = 0;

function sortedWaitingIds(): string[] {
  return [...waiting.entries()]
    .sort((a, b) => {
      if (b[1].updatedAt !== a[1].updatedAt) return b[1].updatedAt - a[1].updatedAt;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([agentId]) => agentId);
}

// Click-to-consume: each circle click opens the most recent waiting session
// and removes exactly that one entry. Entries never die from the daemon's
// attention-clear alone — only a circle click or a new prompt in the session
// clears them, so the circle stays until every waiting session got its turn.
function takeNextWaitingAgentId(): string | null {
  const ids = sortedWaitingIds();
  if (ids.length === 0) return null;
  const next = ids[0] ?? null;
  if (next) {
    waiting.delete(next);
    consumed.add(next);
    recentConsumed.push(next);
    if (recentConsumed.length > 10) {
      recentConsumed.splice(0, recentConsumed.length - 10);
    }
  }
  return next;
}

// Label target: what the next click would open, without consuming it.
function peekNextWaitingAgentId(): string | null {
  const ids = sortedWaitingIds();
  if (ids.length === 0) return null;
  return ids[0] ?? null;
}

function FinishedRow({ count }: { count: number }) {
  const nextId = peekNextWaitingAgentId();
  const nextTitle = nextId ? (waiting.get(nextId)?.title ?? shortId(nextId)) : null;
  // Largest count that still fits the 120px circle: bold digits are ~0.62em
  // wide with ~0.72em cap height, so size tiers by digit count.
  const digits = String(count).length;
  const fontSize = digits <= 1 ? 128 : digits === 2 ? 76 : digits === 3 ? 50 : 36;
  return function Row({ theme, openScreen }: PluginSidebarItemProps) {
    useSyncExternalStore(subscribeWaiting, getWaitingVersion);
    useSyncExternalStore(subscribeIgnored, getIgnoredVersion);
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const ignoredIds = sortedIgnoredIds();
    // The session the next circle click would open. Shown with its own
    // ignore action so filtering never requires opening the list screen
    // first (a single waiting entry auto-opens the agent on click).
    const nextId = peekNextWaitingAgentId();
    const openNext = () => {
      const agentId = takeNextWaitingAgentId();
      if (!agentId) return;
      clickSeq += 1;
      bumpWaiting();
      requestSidebarRefresh?.();
      openScreen({
        screenId: "look-at-me-list",
        params: { agent: agentId, n: String(clickSeq) },
      });
    };
    const clearAll = () => {
      // Clear everything: the circle vanishes until a genuinely new
      // notification arrives (seen keys are kept, so old echoes stay
      // silent; prompts tracking is untouched).
      waiting.clear();
      consumed.clear();
      recentConsumed.length = 0;
      bumpWaiting();
      requestSidebarRefresh?.();
    };
    const clearNext = () => {
      // Dismiss only the notification the next click would open: consume
      // exactly that entry without opening its session. A duplicate echo of
      // the same event stays silent (consumed); a genuinely new event
      // re-arms it.
      const agentId = takeNextWaitingAgentId();
      if (!agentId) return;
      bumpWaiting();
      requestSidebarRefresh?.();
    };
    return (
      <View style={{ alignItems: "center", paddingVertical: 12 }}>
        <View style={{ position: "relative", width: "100%", alignItems: "center" }}>
          {count > 0 && (
            <View
              style={{
                position: "absolute",
                left: 8,
                top: 0,
                maxWidth: 100,
                alignItems: "flex-start",
              }}
            >
              <Pressable
                onPress={clearAll}
                accessibilityRole="button"
                accessibilityLabel="Clear all waiting notifications"
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                  ✕ clear all
                </Text>
              </Pressable>
              {ignoredIds.length > 0 && (
                <View style={{ marginTop: 6, gap: 6, alignItems: "flex-start" }}>
              {ignoredIds.map((id) => {
                const title = titles.get(id) ?? null;
                return (
                  <View
                    key={id}
                    style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                  >
                    <Pressable
                      onPress={() => unignoreAgent(id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Stop ignoring ${title ?? short7(id)}`}
                    >
                      <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                        ✕
                      </Text>
                    </Pressable>
                    <Pressable
                      onHoverIn={() => setHoveredId(id)}
                      onHoverOut={() => setHoveredId(null)}
                    >
                      <Text
                        style={{ color: theme.colors.foreground, fontSize: 12, textAlign: "left", maxWidth: 70 }}
                        numberOfLines={1}
                        ellipsizeMode="tail"
                      >
                        {title ? `${short7(id)} ${title}` : short7(id)}
                      </Text>
                    </Pressable>
                    {hoveredId === id && title && (
                      <View
                        style={{
                          position: "absolute",
                          top: 20,
                          left: 0,
                          zIndex: 10,
                          maxWidth: 220,
                          paddingHorizontal: 8,
                          paddingVertical: 4,
                          borderRadius: 6,
                          backgroundColor: theme.colors.foreground,
                        }}
                      >
                        <Text style={{ color: theme.colors.surface0, fontSize: 12 }}>
                          {`${short7(id)} ${title}`}
                        </Text>
                      </View>
                    )}
                  </View>
                );
              })}
                </View>
              )}
            </View>
          )}
          <View style={{ position: "relative" }}>
          {count > 0 && (
            <Pressable
              onPress={openNext}
              accessibilityRole="button"
              accessibilityLabel={nextTitle ? `Open waiting session ${nextTitle}` : "Open waiting session"}
            >
              <View
                style={{
                  width: 120,
                  height: 120,
                  borderRadius: 60,
                  backgroundColor: "#22c55e",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ color: "#ffffff", fontSize, fontWeight: "bold" }}>
                  {count}
                </Text>
              </View>
            </Pressable>
          )}
          {count > 0 && (
            <Pressable
              onPress={clearNext}
              accessibilityRole="button"
              accessibilityLabel="Clear this waiting notification"
              style={{ position: "absolute", top: 0, right: 0, padding: 0, transform: [{ translateX: "75%" }] }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                ✕ clear this
              </Text>
            </Pressable>
          )}
          </View>
        </View>
        {count > 0 && nextId && (
        <View style={{ marginTop: 8, alignItems: "center", gap: 4 }}>
          <Pressable onPress={openNext}>
            <Text style={{ color: theme.colors.foreground }}>
              {nextTitle ? `${nextTitle} — tap to open` : (count === 1 ? "session waiting — tap to open" : "sessions waiting — tap to open")}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => ignoreAgent(nextId)}
            accessibilityRole="button"
            accessibilityLabel={`Ignore this session's updates (${nextTitle ?? shortId(nextId)})`}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
              🧠 ignore this session's updates
            </Text>
          </Pressable>
        </View>
        )}
      </View>
    );
  };
}

function DoneListScreen({ navigation, theme, params }: PluginScreenProps) {
  useSyncExternalStore(subscribeWaiting, getWaitingVersion);
  const entries = [...waiting.entries()];
  // Circle click target: open the requested waiting session directly.
  // Falls back to the legacy single-entry auto-open when opened bare.
  const paramAgent = typeof params.agent === "string" ? params.agent : null;
  const requestedId =
    paramAgent && (recentConsumed.includes(paramAgent) || waiting.has(paramAgent))
      ? paramAgent
      : null;
  const singleKey =
    entries.length === 1 && !requestedId
      ? `${entries[0][0]}#${entries[0][1].updatedAt}`
      : null;
  const targetKey = requestedId
    ? `${requestedId}#${waiting.get(requestedId)?.updatedAt ?? 0}#${params.n ?? "0"}`
    : singleKey;
  const targetId = requestedId ?? (singleKey ? entries[0][0] : null);
  useEffect(() => {
    if (targetId && targetKey && targetKey !== lastAutoOpenedKey && navigation) {
      lastAutoOpenedKey = targetKey;
      navigation.openAgent({ agentId: targetId });
    }
  }, [targetId, targetKey, navigation]);
  if (targetId && navigation) {
    const entry = waiting.get(targetId);
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foreground }}>
          Opening {entry?.title ?? shortId(targetId)}…
        </Text>
      </View>
    );
  }
  return (
    <View style={{ padding: 16, gap: 12 }}>
      {entries.length === 0 ? (
        <Text style={{ color: theme.colors.foreground }}>
          Nothing waiting. New prompts clear entries from this list.
        </Text>
      ) : (
        entries.map(([agentId, entry]) => {
          const label = entry.title ?? shortId(agentId);
          const row = (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                paddingVertical: 10,
              }}
            >
              <View
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 8,
                  backgroundColor: "#22c55e",
                }}
              />
              <View style={{ flex: 1 }}>
                <Text
                  style={{
                    color: theme.colors.foreground,
                    fontSize: 16,
                    fontWeight: "600",
                  }}
                >
                  {label}
                </Text>
                <Text style={{ color: theme.colors.foreground }}>
                  {reasonLabel(entry.reason)}
                </Text>
                <Pressable
                  onPress={() => ignoreAgent(agentId)}
                  accessibilityRole="button"
                  accessibilityLabel={`Ignore this session's updates (${label})`}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
                    🧠 ignore this session's updates
                  </Text>
                </Pressable>
              </View>
            </View>
          );
          if (!navigation) return <View key={agentId}>{row}</View>;
          return (
            <Pressable
              key={agentId}
              onPress={() => navigation.openAgent({ agentId })}
            >
              {row}
            </Pressable>
          );
        })
      )}
    </View>
  );
}

function IgnoredSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(ignoredSettings);
  useSyncExternalStore(subscribeIgnored, getIgnoredVersion);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Keep the saver pointed at the latest ready revision; clear on unmount.
  useEffect(() => {
    if (settings.status !== "ready") {
      saveIgnoredSettings = null;
      return () => {
        saveIgnoredSettings = null;
      };
    }
    const snap = settings;
    saveIgnoredSettings = () => {
      void snap.save({ ignoredIds: [...ignored] }, snap.revision);
    };
    return () => {
      if (saveIgnoredSettings !== null) saveIgnoredSettings = null;
    };
  }, [settings]);

  // Union stored + live sets once per revision, then save back only when the
  // stored list differs (otherwise a post-save revision bump would loop).
  useEffect(() => {
    if (settings.status !== "ready") return;
    if (syncedSettingsRevision === settings.revision) return;
    syncedSettingsRevision = settings.revision;
    const stored = settings.values.ignoredIds;
    const union = [...new Set([...stored, ...ignored])];
    let changed = false;
    let waitingChanged = false;
    for (const id of union) {
      if (!ignored.has(id)) {
        ignored.add(id);
        if (waiting.delete(id)) waitingChanged = true;
        changed = true;
      }
    }
    if (changed) bumpIgnored();
    if (waitingChanged) bumpWaiting();
    if (changed || waitingChanged) requestSidebarRefresh?.();
    const needsSave =
      union.length !== stored.length || union.some((id, i) => stored[i] !== id);
    if (needsSave) {
      void settings.save({ ignoredIds: union }, settings.revision);
    }
  }, [settings]);

  if (settings.status === "loading") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foreground }}>Loading…</Text>
      </View>
    );
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <View style={{ padding: 16 }}>
        <Text style={{ color: theme.colors.foreground }}>
          Ignored list unavailable: {settings.error}
        </Text>
      </View>
    );
  }

  const ids = sortedIgnoredIds();
  return (
    <View style={{ padding: 16, gap: 12 }}>
      {ids.length > 0 && (
        <Pressable
          onPress={unignoreAllAgents}
          accessibilityRole="button"
          accessibilityLabel="Stop ignoring all sessions"
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>
            Stop ignoring all ({ids.length})
          </Text>
        </Pressable>
      )}
      {ids.length === 0 ? (
        <Text style={{ color: theme.colors.foreground }}>
          No ignored sessions. Ignored sessions never raise the green circle.
        </Text>
      ) : (
        ids.map((id) => {
          const title = titles.get(id) ?? null;
          return (
            <View
              key={id}
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <Pressable
                onPress={() => unignoreAgent(id)}
                accessibilityRole="button"
                accessibilityLabel={`Stop ignoring ${title ?? short7(id)}`}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 16 }}>
                  ✕
                </Text>
              </Pressable>
              <Pressable
                style={{ flex: 1 }}
                onHoverIn={() => setHoveredId(id)}
                onHoverOut={() => setHoveredId(null)}
              >
                <View>
                  <Text
                    style={{ color: theme.colors.foreground, fontSize: 16 }}
                    numberOfLines={1}
                  >
                    {short7(id)}
                  </Text>
                  {title && (
                    <Text
                      style={{ color: theme.colors.foreground, fontSize: 12 }}
                      numberOfLines={1}
                    >
                      {title}
                    </Text>
                  )}
                </View>
              </Pressable>
              {hoveredId === id && title && (
                <View
                  style={{
                    position: "absolute",
                    top: 40,
                    left: 0,
                    zIndex: 10,
                    maxWidth: 260,
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 6,
                    backgroundColor: theme.colors.foreground,
                  }}
                >
                  <Text style={{ color: theme.colors.surface0, fontSize: 12 }}>
                    {title}
                  </Text>
                </View>
              )}
            </View>
          );
        })
      )}
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  let stopped = false;
  let removeSidebarItem: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let releaseObservation: (() => void) | null = null;

  let removeScreen: (() => void) | null = null;
  try {
    removeScreen = client.addScreen({
      id: "look-at-me-list",
      title: "Sessions waiting",
      Component: DoneListScreen,
    });
  } catch {
    // Older host without screens; the circle still shows the count.
    removeScreen = null;
  }

  let removeSettingsScreen: (() => void) | null = null;
  try {
    removeSettingsScreen = client.addSettingsScreen({
      id: "look-at-me-ignored",
      title: "Ignored sessions",
      icon: "EyeOff",
      Component: IgnoredSettingsScreen,
    });
  } catch {
    // Older host without settings screens; the sidebar list still works.
    removeSettingsScreen = null;
  }

  function refreshSidebar(): void {
    try {
      removeSidebarItem?.();
    } catch {
      // Host already dropped it; nothing to do.
    }
    removeSidebarItem = null;
    // The whole footer (circle AND ignored list) shows only while at least
    // one session is waiting: no circle, no ignored lines.
    if (waiting.size === 0) return;
    try {
      removeSidebarItem = client.addSidebarFooterItem({
        id: "look-at-me",
        title: "Sessions waiting",
        Component: FinishedRow({ count: waiting.size }),
      });
    } catch {
      // Older host without sidebar items; nothing to show.
    }
  }
  requestSidebarRefresh = refreshSidebar;
  requestReplay = (agentId: string) => {
    const snapshot = lastAgent.get(agentId);
    if (snapshot) noteAgent(snapshot, true);
  };

  function noteAgent(agent: WatchedAgent, live: boolean): void {
    // Remember the snapshot and title before any filtering: un-ignoring
    // replays the latest snapshot so a still-waiting session re-surfaces.
    lastAgent.set(agent.id, agent);
    if (agent.title != null) titles.set(agent.id, agent.title);
    if (ignored.has(agent.id)) {
      // Filtered out ("ignore this session's updates"): never queue, and
      // drop any stale entry so the circle stays quiet for this session.
      if (waiting.delete(agent.id)) {
        bumpWaiting();
        refreshSidebar();
      }
      return;
    }
    // A new prompt (or turn) clears this agent's done state, even before
    // we look at attention state. This is the "until user sends a new
    // prompt" rule.
    const marker = promptMarker(agent);
    if (prompts.has(agent.id) && prompts.get(agent.id) !== marker) {
      consumed.delete(agent.id);
      if (waiting.delete(agent.id)) {
        bumpWaiting();
        refreshSidebar();
      }
    }
    prompts.set(agent.id, marker);

    const key = attentionKey(agent);
    if (key === null) {
      // Attention cleared on the daemon side (viewed elsewhere, flag
      // dropped). The entry stays: only a circle click or a new prompt in
      // the session removes it, so the circle survives until every waiting
      // session got its turn. Record the reset so the next real event
      // still counts as new.
      seen.set(agent.id, "");
      return;
    }
    // Needing attention. Show the circle only for a genuinely new event:
    // a different key, or (with no key detail) a false->true transition.
    // A new prompt bumping updatedAt while the old flag is still set keeps
    // the same key, so it stays as-is.
    const prev = seen.get(agent.id);
    // Clicked-through entries ignore duplicate echoes of the same event.
    if (key !== "" && consumed.has(agent.id) && prev === key) return;
    const isNew =
      prev === undefined || prev === "" || (key !== "" && prev !== key);
    seen.set(agent.id, key === "" ? "untracked-event" : key);
    if (!live || !isNew) return;
    consumed.delete(agent.id);
    if (!waiting.has(agent.id)) {
      waiting.set(agent.id, {
        reason: agent.attentionReason ?? null,
        title: agent.title ?? null,
        updatedAt: Date.now(),
      });
    } else {
      const entry = waiting.get(agent.id);
      if (entry) {
        entry.reason = agent.attentionReason ?? null;
        // Updates often arrive without a title (partial upserts); never let
        // a title-less update wipe the title we already know.
        if (agent.title != null) entry.title = agent.title;
        entry.updatedAt = Date.now();
      }
    }
    bumpWaiting();
    refreshSidebar();
  }

  function forgetAgent(agentId: string): void {
    seen.delete(agentId);
    prompts.delete(agentId);
    lastAgent.delete(agentId);
    titles.delete(agentId);
    consumed.delete(agentId);
    if (waiting.delete(agentId)) {
      bumpWaiting();
      refreshSidebar();
    }
  }

  async function restoreIgnored(): Promise<void> {
    try {
      const result = await client.rpc(ignoredSettingsRpc.read, {});
      if (result.status !== "ready") return;
      const values = result.values as unknown as { ignoredIds?: unknown };
      if (!Array.isArray(values.ignoredIds)) return;
      let changed = false;
      let waitingChanged = false;
      for (const id of values.ignoredIds) {
        if (typeof id !== "string" || ignored.has(id)) continue;
        ignored.add(id);
        seen.delete(id);
        prompts.delete(id);
        consumed.delete(id);
        if (waiting.delete(id)) waitingChanged = true;
        changed = true;
      }
      if (changed) bumpIgnored();
      if (waitingChanged) bumpWaiting();
      if (changed || waitingChanged) refreshSidebar();
    } catch {
      // Older host without settings RPCs, or store unreadable: memory only.
    }
  }

  async function watch(): Promise<void> {
    // Restore the persisted ignore list before observing: without this, an
    // app restart wipes in-memory ignores and they silently stop working
    // until the Settings screen happens to open.
    await restoreIgnored();
    let directory;
    try {
      directory = await client.paseo.agents.list({
        filter: { includeArchived: false },
        subscribe: {},
      });
    } catch {
      // Daemon unreachable or list failed; stay quiet, no watcher this run.
      return;
    }
    if (stopped) {
      await directory.subscription.release().catch(() => undefined);
      return;
    }
    // Never mark state that already exists on startup.
    for (const entry of directory.entries) {
      const agent = asAgent((entry as { agent?: unknown }).agent);
      if (agent) noteAgent(agent, false);
    }
    unsubscribe = directory.subscription.subscribe({
      snapshot(result) {
        for (const entry of result.entries) {
          const agent = asAgent((entry as { agent?: unknown }).agent);
          if (agent) noteAgent(agent, false);
        }
      },
      update(message) {
        if (message.type !== "agent_update") return;
        const payload = message.payload as {
          kind?: unknown;
          agent?: unknown;
          agentId?: unknown;
        };
        if (payload.kind === "remove") {
          if (typeof payload.agentId === "string") forgetAgent(payload.agentId);
          return;
        }
        if (payload.kind !== "upsert") return;
        const agent = asAgent(payload.agent);
        if (agent) noteAgent(agent, true);
      },
    });
    releaseObservation = () => {
      void directory.subscription.release().catch(() => undefined);
    };
  }

  void watch();

  return () => {
    stopped = true;
    requestSidebarRefresh = null;
    requestReplay = null;
    unsubscribe?.();
    unsubscribe = null;
    releaseObservation?.();
    releaseObservation = null;
    waiting.clear();
    try {
      removeSidebarItem?.();
    } catch {
      // Already gone.
    }
    removeSidebarItem = null;
    try {
      removeScreen?.();
    } catch {
      // Already gone.
    }
    removeScreen = null;
    try {
      removeSettingsScreen?.();
    } catch {
      // Already gone.
    }
    removeSettingsScreen = null;
    saveIgnoredSettings = null;
  };
}
