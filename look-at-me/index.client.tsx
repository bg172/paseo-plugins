import { useEffect, useSyncExternalStore } from "react";
import type {
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
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
// Handoff receipts for the screen: takeNext deletes the entry at click time,
// so the opening screen resolves its target from this list (plus the live
// map), not from the map alone. Bounded; rapid multi-clicks each keep theirs.
const recentConsumed: string[] = [];
// Module-level handle so the circle press handler can request a sidebar
// refresh (refreshSidebar itself lives in activate scope).
let requestSidebarRefresh: (() => void) | null = null;

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

// Remembers which single entry already auto-opened, so viewing the
// screen again does not re-jump to the same session.
let lastAutoOpenedKey: string | null = null;

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
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
    return (
      <View style={{ alignItems: "center", paddingVertical: 12 }}>
        <View style={{ position: "relative" }}>
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
          <Pressable
            onPress={clearAll}
            accessibilityRole="button"
            accessibilityLabel="Clear all waiting notifications"
            ref={(el) => {
              // Take keyboard focus when the button appears (web); harmless
              // no-op on native targets without a focus concept.
              try {
                (el as unknown as { focus?: () => void } | null)?.focus?.();
              } catch {
                // Focus unsupported here; the button still works by tap.
              }
            }}
            style={{ position: "absolute", top: 0, right: 0, padding: 0, transform: [{ translateX: "50%" }] }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>
              ✕ clear
            </Text>
          </Pressable>
        </View>
        <Pressable onPress={openNext} style={{ marginTop: 8 }}>
          <Text style={{ color: theme.colors.foreground }}>
            {nextTitle ? `${nextTitle} — tap to open` : (count === 1 ? "session waiting — tap to open" : "sessions waiting — tap to open")}
          </Text>
        </Pressable>
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

export default function contribute(client: PluginClientContext) {
  let stopped = false;
  const seen = new Map<string, string>();
  const prompts = new Map<string, string>();
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

  function refreshSidebar(): void {
    try {
      removeSidebarItem?.();
    } catch {
      // Host already dropped it; nothing to do.
    }
    removeSidebarItem = null;
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

  function noteAgent(agent: WatchedAgent, live: boolean): void {
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
    consumed.delete(agentId);
    if (waiting.delete(agentId)) {
      bumpWaiting();
      refreshSidebar();
    }
  }

  async function watch(): Promise<void> {
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
  };
}
