import { useState, useEffect, useRef, useCallback } from 'react';
import type { Topic, UpdateTopicRequest } from '../../types';
import { topicsApi } from '../../lib/api';
import {
  autonomyKey,
  effortKey,
  isDraftTopicId,
  providerOnlyKey,
  providerOverrideKey,
  rememberAutonomySelection,
  rememberEffort,
  rememberProviderSelection,
  safeStore,
  sameSelection,
  seedAutonomy,
  seedEffort,
  seedProviderOnly,
  seedProviderOverride,
} from '../../lib/composerMemory';
import type { useToast } from '../Shared/Toast';

interface ComposerPicksParams {
  topic: Topic;
  onUpdateTopic: (id: string, data: UpdateTopicRequest) => Promise<Topic | null>;
  toast: ReturnType<typeof useToast>;
}

/** The composer's per-chat choices (fast mode, engine and model, effort, routing, autonomy) and how they persist. */
export function useComposerPicks({ topic, onUpdateTopic, toast }: ComposerPicksParams) {
  // "Plan Mode" used to live here: a per-device localStorage state that sent a
  // per-turn flag and ended up in a prompt block nobody enforced. The plan is
  // now ONE autonomy level (`ask`), persisted on the topic and handed to the
  // CLI as `--permission-mode plan`; the route injects the same block when
  // that level is active. See `handleAutonomyChange`.
  // Fast Mode toggle (openspec change `chat-fast-mode`). Two sources of truth:
  //   1. `topic.fastMode` (server, persisted, synced cross-window via WS).
  //   2. `localStorage["fastMode:<topic.id>"]`, used purely to avoid a flash
  //      of the OFF state during the first render before the topic prop
  //      hydrates from the API.
  // On mount we prefer the server value when present; otherwise localStorage.
  // On every toggle we write both AND optimistically POST to the server.
  const [fastMode, setFastMode] = useState<boolean>(() => {
    if (typeof topic.fastMode === 'boolean') return topic.fastMode;
    try { return localStorage.getItem(`fastMode:${topic.id}`) === 'true'; } catch { return false; }
  });
  // Reconcile if the server-pushed topic.fastMode diverges (cross-window sync,
  // or app boot order where topic arrives after first paint). When the topic
  // has NO explicit server value (undefined, never toggled there), re-seed
  // from THAT topic's own localStorage: the old boolean-only guard skipped
  // this case, so an in-place switch from a fastMode:true topic carried
  // `true` into topics that had never turned it on.
  useEffect(() => {
    if (typeof topic.fastMode === 'boolean') {
      if (topic.fastMode !== fastMode) {
        setFastMode(topic.fastMode);
        try { localStorage.setItem(`fastMode:${topic.id}`, String(topic.fastMode)); } catch { /* local mirror of fastMode; the server value is the source of truth */ }
      }
    } else {
      try { setFastMode(localStorage.getItem(`fastMode:${topic.id}`) === 'true'); }
      catch { setFastMode(false); }
    }
    // `fastMode` (the local state) is not a dependency: this effect
    // reconciles from the SERVER towards the local value, and listing it would
    // make it fire right after every user toggle, that is, answer a click by
    // re-applying the old value. The inputs are the value pushed by the
    // server and the identity of the topic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.fastMode, topic.id]);
  // Picker keeps a simple local override per pane. On first paint we seed it
  // from the topic's persisted `provider`/`model` (set previously via PATCH);
  // after that, picking a model is purely local, we no longer auto-PATCH on
  // every click. This avoids the draft→real promotion flash where the topic
  // id changes mid-flight and async state updates raced the chat submit.
  //
  // Cross-window sync stays available via the read path (next page load picks
  // up `topic.model` from the server). A future revisit can add per-window
  // live sync when we have a deliberate UX for it.
  // Where the picker starts from: what the topic PERSISTS, then the choice
  // made on this draft, then the last choice made on any chat. The rule lives
  // in `lib/composerMemory.ts`, with its tests: drafts have no server row, and
  // this order had already gone wrong once.
  const [providerOverride, setProviderOverride] = useState<{ provider: string; model: string } | null>(
    () => seedProviderOverride({
      topicId: topic.id,
      topicProvider: topic.provider,
      topicModel: topic.model,
      store: safeStore(),
    }),
  );
  // Mirror state into a ref so the session-switch effect can read the latest
  // override without listing it as a dep (which would re-run the reseed every
  // time the user picks a model, the opposite of what we want).
  const providerOverrideRef = useRef(providerOverride);
  useEffect(() => { providerOverrideRef.current = providerOverride; }, [providerOverride]);
  // The engine this chat runs with no model of its own (revision 2026-10-04
  // §3.7, «Automatico» within an engine that lists none): a topic's
  // `{provider, model: null}`, or what a draft chose before it exists.
  const [providerOnly, setProviderOnly] = useState<string | null>(
    () => seedProviderOnly({ topicId: topic.id, topicProvider: topic.provider, topicModel: topic.model, store: safeStore() }),
  );
  const providerOnlyRef = useRef(providerOnly);
  useEffect(() => { providerOnlyRef.current = providerOnly; }, [providerOnly]);

  // Per-topic effort-tier override (migration 033). Same draft-aware pattern as
  // the provider/model override above: real topics read `topic.effort` (kept in
  // sync via the `topic:updated` broadcast); drafts have no server row yet, so
  // the pick lives in localStorage until the draft is promoted.
  const [effort, setEffort] = useState<string | null>(
    () => seedEffort({ topicId: topic.id, topicEffort: topic.effort, store: safeStore() }),
  );
  const effortRef = useRef(effort);
  useEffect(() => { effortRef.current = effort; }, [effort]);

  // AICTRL-01 routing switch. No draft-only path (unlike provider/model
  // above): a fresh draft simply keeps the default (off) until sent, since
  // there is no server row to reload it from before that.
  const [topicsRouting, setTopicsRouting] = useState<boolean | null>(topic.topicsRouting ?? null);
  useEffect(() => { setTopicsRouting(topic.topicsRouting ?? null); }, [topic.id, topic.topicsRouting]);
  const handleTopicsRoutingChange = useCallback((next: boolean) => {
    setTopicsRouting(next);
    if (isDraftTopicId(topic.id)) return;
    void onUpdateTopic(topic.id, { topicsRouting: next });
  }, [onUpdateTopic, topic.id]);

  // Autonomy level: the SAME pattern as provider/model, Fast Mode and effort,
  // and it was the only one of the four composer selectors without it. It read
  // `topic.autonomyLevel` directly and PATCHed unconditionally: on a NEW chat
  // the topic is synthetic (`draft:<uuid>`, minted in
  // `state/pane/adapters/paneConfig.ts`) and does not exist on the server, so
  // the PATCH could only fail, and the user saw "could not change the
  // autonomy" on every attempt to choose before writing the first message.
  // Measured in the prod log: `PATCH /api/topics/draft:a7bfeee2-…`.
  const [autonomy, setAutonomy] = useState<import('../../types').AutonomyLevel | null>(() => {
    const seeded = seedAutonomy({ topicId: topic.id, topicAutonomy: topic.autonomyLevel, store: safeStore() });
    return seeded === 'ask' || seeded === 'auto-apply' || seeded === 'yolo' ? seeded : null;
  });
  const autonomyRef = useRef(autonomy);
  useEffect(() => { autonomyRef.current = autonomy; }, [autonomy]);
  // A real topic can change autonomy from ANOTHER window (`topic:updated`
  // broadcast): the source of truth stays the server, the local value is only
  // the choice made here and not yet persisted.
  useEffect(() => {
    if (topic.autonomyLevel) setAutonomy(topic.autonomyLevel);
  }, [topic.autonomyLevel]);
  // Keep local effort in sync when the server row updates (cross-window sync,
  // or our own PATCH echoed back via topic:updated).
  useEffect(() => {
    if (!isDraftTopicId(topic.id)) setEffort(topic.effort ?? null);
  }, [topic.effort, topic.id]);
  // Track the previous topic id so we can detect a draft → real promotion vs
  // a genuine session switch.
  const prevTopicIdRef = useRef(topic.id);
  // Latest fastMode read by the promotion effect below. Captured in a ref so
  // we don't have to put `fastMode` in the effect deps (it'd refire on every
  // toggle and re-PUT the same value). The ref is updated by another effect.
  const fastModeRef = useRef(false);
  useEffect(() => { fastModeRef.current = fastMode; }, [fastMode]);

  useEffect(() => {
    const prevId = prevTopicIdRef.current;
    prevTopicIdRef.current = topic.id;
    const wasDraft = isDraftTopicId(prevId);
    const isNowReal = !isDraftTopicId(topic.id);
    if (wasDraft && isNowReal && prevId !== topic.id) {
      // Draft → real promotion: the user's pick from the draft phase must
      // survive (server just created the real topic with NULL provider/model
      // because the PATCH was gated while still a draft). Keep the override
      // in local state AND persist it to the new topic id now.
      const pick = providerOverrideRef.current;
      if (pick) {
        void onUpdateTopic(topic.id, { provider: pick.provider, model: pick.model });
      } else if (providerOnlyRef.current) {
        void onUpdateTopic(topic.id, { provider: providerOnlyRef.current, model: null });
      }
      // The draft pick was persisted under the draft id (see
      // handleProviderOverrideChange); the real topic now carries it on the
      // server, so drop the stale draft key (mirrors the fastMode migration
      // below).
      safeStore().removeItem(providerOverrideKey(prevId));
      safeStore().removeItem(providerOnlyKey(prevId));
      // Same story for Fast Mode (openspec change `chat-fast-mode`). The
      // composer toggle wrote to `fastMode:draft:abc` and skipped the PUT
      // (drafts have no server-side row to PUT to). Now that the real topic
      // exists, persist the bit to its id, migrate the localStorage key
      // (old key kept for one render in case another component still reads
      // it; cleaned up on next mount), and broadcast via PUT for
      // cross-window sync.
      if (fastModeRef.current) {
        void onUpdateTopic(topic.id, { fastMode: true });
        try {
          localStorage.setItem(`fastMode:${topic.id}`, 'true');
          localStorage.removeItem(`fastMode:${prevId}`);
        } catch { /* local mirror of fastMode; the server PUT above is authoritative */ }
      }
      // Same migration for the per-topic effort override (migration 033).
      if (effortRef.current) {
        void onUpdateTopic(topic.id, { effort: effortRef.current });
        const store = safeStore();
        store.setItem(effortKey(topic.id), effortRef.current);
        store.removeItem(effortKey(prevId));
      }
      // Same migration for the autonomy. Without it, a choice made on the
      // draft ("Free" before writing) was lost at promotion and the chat
      // started on the default, so the selector promised something the
      // first turn did not honour.
      if (autonomyRef.current) {
        void onUpdateTopic(topic.id, { autonomyLevel: autonomyRef.current });
        try {
          localStorage.setItem(autonomyKey(topic.id), autonomyRef.current);
          localStorage.removeItem(autonomyKey(prevId));
        } catch { /* local mirror of autonomy; the server PUT above is authoritative */ }
      }
      return;
    }
    // A DRAFT has no server row: there is nothing to reseed from, and
    // reseeding anyway meant wiping the choice just made. It really happened:
    // `onUpdateTopic` is among the dependencies and for drafts the chat group
    // passes a NEW one on every render (`isDraft ? async () => null : ...`,
    // StandaloneChatGroup), so the effect fired by itself and put the default
    // model back under the fingers of whoever had just changed it. The draft's
    // choice lives in the local state and in localStorage until the
    // promotion carries it to the real topic.
    if (isDraftTopicId(topic.id)) return;
    // Genuine session switch, reseed from whatever the new topic persists.
    const seeded = seedProviderOverride({
      topicId: topic.id,
      topicProvider: topic.provider,
      topicModel: topic.model,
      store: safeStore(),
    });
    // Same value, new object: assigning it would be an extra render for
    // nothing (and with an unstable dependency, a render on every render).
    setProviderOverride((prev) => (sameSelection(prev, seeded) ? prev : seeded));
    setProviderOnly(seedProviderOnly({ topicId: topic.id, topicProvider: topic.provider, topicModel: topic.model, store: safeStore() }));
  }, [topic.sessionKey, topic.id, topic.provider, topic.model, onUpdateTopic]);

  const isDraftTopic = isDraftTopicId(topic.id);
  const handleProviderOverrideChange = useCallback((next: { provider: string; model: string } | null) => {
    setProviderOverride(next);
    setProviderOnly(null);
    // Update the "global memory" of the last selection: new chats read it at
    // initialisation and start with the right model already. Going back to
    // the app default CLEARS it, since that is a choice too, and keeping the
    // old model would make it reappear in the next chat.
    rememberProviderSelection(safeStore(), next);
    if (isDraftTopic) {
      // No server row to PATCH yet, persist the pick device-locally (same
      // approach as Fast Mode for drafts) so it survives a reload before the
      // draft is promoted on send. The promotion effect above migrates it to
      // the real topic id + the server and clears this key.
      const store = safeStore();
      store.removeItem(providerOnlyKey(topic.id));
      if (next) store.setItem(providerOverrideKey(topic.id), JSON.stringify(next));
      else store.removeItem(providerOverrideKey(topic.id));
      return;
    }
    // Best-effort persist so a reload (or another pane on the same topic) sees
    // the same selection. Failures are non-fatal, the local state still
    // drives the next chat request.
    void onUpdateTopic(topic.id, {
      provider: next?.provider ?? null,
      model: next?.model ?? null,
    });
  }, [isDraftTopic, onUpdateTopic, topic.id]);

  // «Automatico» within one engine (revision 2026-10-04 §3.7): the chat keeps
  // that provider and no model of its own; the override goes, since it always
  // names a model. One PATCH, so the two fields cannot land out of order. A
  // draft keeps the engine on this device until the promotion carries it to
  // the topic, as it does for a complete choice.
  const handleProviderOnlyChange = useCallback((provider: string) => {
    setProviderOverride(null);
    setProviderOnly(provider);
    rememberProviderSelection(safeStore(), null);
    if (isDraftTopic) {
      const store = safeStore();
      store.removeItem(providerOverrideKey(topic.id));
      store.setItem(providerOnlyKey(topic.id), provider);
      return;
    }
    void onUpdateTopic(topic.id, { provider, model: null });
  }, [isDraftTopic, onUpdateTopic, topic.id]);

  const handleEffortChange = useCallback((next: string | null) => {
    setEffort(next);
    // Same memory as the model: the last choice applies to new chats, and
    // putting the provider default back clears it.
    rememberEffort(safeStore(), next);
    if (isDraftTopic) {
      // No server row yet, persist device-locally; the promotion effect above
      // migrates it to the real topic id on first send.
      const store = safeStore();
      if (next) store.setItem(effortKey(topic.id), next);
      else store.removeItem(effortKey(topic.id));
      return;
    }
    // Persist through the topic PATCH; the server forces an idle CLI respawn so
    // the new tier applies on the next turn, and broadcasts topic:updated for
    // cross-window sync.
    void onUpdateTopic(topic.id, { effort: next });
  }, [isDraftTopic, onUpdateTopic, topic.id]);

  // What this chat INHERITS from when there is no complete override. The
  // case that matters is narrow but real: `providerOverride` exists only if
  // the topic has provider AND model, so what is left here is the topic that
  // chose the provider and not the model (the dispatcher and the MCP bridge
  // do that); the picker then resolves the default model of THAT provider
  // instead of the first ready one.
  //
  // Above this step there is the app default, and it does NOT go through
  // here: the picker and the SessionConfigPopover already subscribe to the
  // same snapshot and `resolveEffectiveProvider` falls back by itself on the
  // row with `isDefault`, which is the same value as
  // `snapshot.defaultProvider`. Passing it as a prop would be the same
  // information taken twice, at the price of a snapshot subscription inside
  // ChatPane, which would redraw on every push (the fast mode state sends
  // one at every turn start and end).
  // The engine pinned without a model is held locally too, so a draft (no
  // topic row) and a saved chat (before the `topic:updated` echo) agree.
  const defaultProviderLabel = (providerOverride ? topic.provider : providerOnly) ?? undefined;
  // MSEL-06: with no runtime pinned the server judges the route on the
  // topic's model (`/model`), so the chip and the band are given it too.
  const pinnedModel = topic.provider ? null : topic.model ?? null;
  // Toggle Fast Mode. Updates: (1) local state for immediate UI feedback,
  // (2) localStorage for cold-boot hydration, (3) server via PUT so other
  // windows of the same topic sync via the `topic:updated` WS broadcast.
  // The PUT is fire-and-forget, UI doesn't wait. If it fails, the next
  // topic hydration corrects the divergence (see the reconciliation effect
  // above keyed on `topic.fastMode`).
  const toggleFastMode = useCallback(() => {
    // Side effects MUST live outside the setState callback, in React 18
    // Strict Mode the updater is invoked twice during development, which
    // would double-fire `onUpdateTopic` and double-write localStorage. The
    // setter itself is dedupe-safe (Object.is), but the side effects aren't.
    const next = !fastModeRef.current;
    setFastMode(next);
    fastModeRef.current = next;
    try { localStorage.setItem(`fastMode:${topic.id}`, String(next)); } catch {}
    // Draft topics aren't persisted yet, skip the PUT (would 404). Local
    // state is sufficient until the draft is promoted; the promotion effect
    // above migrates the bit to the new real topic id once it exists.
    if (!topic.id.startsWith('draft:')) {
      void onUpdateTopic(topic.id, { fastMode: next });
    }
  }, [topic.id, onUpdateTopic]);
  /** Changes how much this chat may do on its own. The PATCH forces the
   *  respawn of the CLI session (`--permission-mode` is a spawn flag), so the
   *  choice applies from the next turn; the server takes care of that. */
  const handleAutonomyChange = useCallback(async (level: import('../../types').AutonomyLevel) => {
    setAutonomy(level);
    // Remembered as the last choice of ANY chat, same scheme as
    // provider/model and effort, so a new chat inherits it instead of always
    // starting from the app default.
    rememberAutonomySelection(safeStore(), level);
    if (isDraftTopic) {
      // No server row to PATCH: the draft exists only here. It is persisted
      // device-locally like provider/model, Fast Mode and effort, and the
      // promotion effect above carries it to the real topic.
      try { localStorage.setItem(autonomyKey(topic.id), level); } catch { /* storage refused */ }
      return;
    }
    try {
      await topicsApi.update(topic.id, { autonomyLevel: level });
    } catch {
      // The local value goes back: leaving it ahead would show a level the
      // next turn will not use.
      setAutonomy(topic.autonomyLevel ?? null);
      toast.error('Non sono riuscito a cambiare l\'autonomia.');
    }
  }, [isDraftTopic, topic.id, topic.autonomyLevel, toast]);
  return {
    fastMode, providerOverride, providerOnly, effort, topicsRouting, autonomy, setAutonomy, isDraftTopic,
    handleTopicsRoutingChange, handleProviderOverrideChange, handleProviderOnlyChange, handleEffortChange,
    defaultProviderLabel, pinnedModel, toggleFastMode, handleAutonomyChange,
  };
}
