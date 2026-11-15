// index.ts
import { Plugin } from "@opencode/plugin";

// lib/config.ts
var DEFAULTS = {
  enabled: true,
  debug: false,
  allowSubAgents: false,
  maxContextLimit: "60%",
  nudgeFrequency: 5,
  iterationNudgeThreshold: 0,
  protectedTools: [],
  protectedFilePatterns: [],
  tui: { enabled: true },
  strategies: {
    deduplication: { enabled: true, protectedTools: [] },
    purgeErrors: { enabled: true, turns: 4, protectedTools: [] }
  }
};
var ALWAYS_PROTECTED_TOOLS = ["question", "edit", "write", "patch", "prune"];
function isLimitShape(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 || // Accepts "70%", "70", and decimal forms like "70.5%"; a bare numeric
  // string is treated as absolute tokens, not a percentage.
  typeof value === "string" && /^\d+(\.\d+)?%?$/.test(value);
}
function mergeLimit(value, fallback) {
  return isLimitShape(value) ? value : fallback;
}
function mergeStringArray(value) {
  if (!Array.isArray(value)) return void 0;
  return value.filter((item) => typeof item === "string");
}
function resolveOptions(options, warn) {
  const input = options ?? {};
  const known = /* @__PURE__ */ new Set([
    "enabled",
    "debug",
    "allowSubAgents",
    "maxContextLimit",
    "nudgeFrequency",
    "iterationNudgeThreshold",
    "protectedTools",
    "protectedFilePatterns",
    "tui",
    "strategies"
  ]);
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warn(`unknown option "${key}" will be ignored`);
  }
  const strategiesInput = input.strategies ?? {};
  const dedupeInput = strategiesInput.deduplication ?? {};
  const purgeInput = strategiesInput.purgeErrors ?? {};
  if (input.tui !== void 0 && (typeof input.tui !== "object" || input.tui === null)) {
    warn(`option "tui" must be an object like { "enabled": false }; invalid value ignored`);
  }
  if (input.maxContextLimit !== void 0 && !isLimitShape(input.maxContextLimit)) {
    warn(
      `option "maxContextLimit" must be a positive number, a numeric string (e.g. 70000 or "70000"), or a "NN%" string (e.g. "70%"); invalid value ${JSON.stringify(input.maxContextLimit)} ignored, default ${JSON.stringify(DEFAULTS.maxContextLimit)} used`
    );
  }
  const tuiInput = typeof input.tui === "object" && input.tui !== null ? input.tui : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULTS.enabled,
    debug: typeof input.debug === "boolean" ? input.debug : DEFAULTS.debug,
    allowSubAgents: typeof input.allowSubAgents === "boolean" ? input.allowSubAgents : DEFAULTS.allowSubAgents,
    maxContextLimit: mergeLimit(input.maxContextLimit, DEFAULTS.maxContextLimit),
    nudgeFrequency: typeof input.nudgeFrequency === "number" && input.nudgeFrequency >= 1 ? Math.floor(input.nudgeFrequency) : DEFAULTS.nudgeFrequency,
    iterationNudgeThreshold: typeof input.iterationNudgeThreshold === "number" && input.iterationNudgeThreshold >= 0 ? Math.floor(input.iterationNudgeThreshold) : DEFAULTS.iterationNudgeThreshold,
    protectedTools: mergeStringArray(input.protectedTools) ?? DEFAULTS.protectedTools,
    protectedFilePatterns: mergeStringArray(input.protectedFilePatterns) ?? DEFAULTS.protectedFilePatterns,
    tui: {
      enabled: typeof tuiInput.enabled === "boolean" ? tuiInput.enabled : DEFAULTS.tui.enabled
    },
    strategies: {
      deduplication: {
        enabled: typeof dedupeInput.enabled === "boolean" ? dedupeInput.enabled : true,
        protectedTools: mergeStringArray(dedupeInput.protectedTools) ?? []
      },
      purgeErrors: {
        enabled: typeof purgeInput.enabled === "boolean" ? purgeInput.enabled : true,
        turns: typeof purgeInput.turns === "number" && purgeInput.turns >= 1 ? Math.floor(purgeInput.turns) : 4,
        protectedTools: mergeStringArray(purgeInput.protectedTools) ?? []
      }
    }
  };
}
function resolveLimit(value, contextWindow) {
  if (typeof value === "number") return Math.round(value);
  if (value.endsWith("%")) {
    const pct = Number.parseFloat(value);
    if (Number.isFinite(pct)) return Math.round(pct / 100 * contextWindow);
    return contextWindow;
  }
  const tokens = Number.parseFloat(value);
  return Number.isFinite(tokens) ? Math.round(tokens) : contextWindow;
}

// lib/constants.ts
var FALLBACK_CONTEXT_WINDOW = 2e5;
function effectiveContextLimit(limit) {
  const values = [limit?.context, limit?.input].filter(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0
  );
  return values.length ? Math.min(...values) : void 0;
}
var NUDGE_ANCHOR_CAP = 8;
var ZERO_GAIN_MIN_TOKENS = 128;
var ZERO_GAIN_STANDING_SUMMARY_FRACTION = 0.5;
function tokenLabel(tokens) {
  return Math.max(0, Math.round(tokens)).toLocaleString();
}
function percentOf(tokens, base) {
  return Math.min(999, Math.max(0, Math.round(tokens / Math.max(1, base) * 100)));
}
function contextUsage(tokens, window) {
  if (window <= 0) return `~${tokenLabel(tokens)} tokens (model window size unknown)`;
  return `~${tokenLabel(tokens)} tokens: ${windowShare(tokens, window)}`;
}
function budgetClause(tokens, budget) {
  return tokens >= budget ? ` and above the ${tokenLabel(budget)}-token pruning budget` : `. The ${tokenLabel(budget)}-token pruning budget is not reached`;
}
function windowShare(tokens, window) {
  if (tokens > window) {
    return `this is over the ${tokenLabel(window)}-token model window (an over-estimate - the window is full)`;
  }
  return `${percentOf(tokens, window)}% of the ${tokenLabel(window)}-token model window`;
}

// lib/prompts.ts
var SYSTEM = `
You manage your own context window. Your only context-management tool is \`prune\`: it replaces older conversation ranges with summaries you write, freeing tokens.

Prune completed work that is no longer relevant to the current task: finished research, verified implementations, exhausted explorations, and dead ends. Prefer messages not yet inside a compressed section - re-summarizing an already-compressed section frees nothing unless the replacement summary is substantially shorter, and dropping a dead section outright is the rare case that does help. Keep everything still relevant to the current task - especially exact code, error messages, file contents, and user requirements - verbatim.

Judging what to prune is a scan, not a task in itself: read the topic and age of each range once, decide with the checklist in the reminder, batch what qualifies, and move on. A summary you write is the work - pruning is the cheap default, deliberating over it is not.

Context pressure notes arrive as \`<dcp-system-reminder>\` messages re-measured on every dispatch: only the newest note's numbers are current. Never prune again over a figure from an older note - a completed prune is confirmed by its tool result and by the next reminder. Every note reports occupancy against your context window, the only size you can check yourself; a note that says the window is exceeded is reporting an over-estimate, not a larger window.

\`<dcp-message-id>\` and \`<dcp-system-reminder>\` tags are environment-injected metadata. Do not output them.
`;
var PRUNE_RANGE = `Replace one or more conversation ranges with your own dense summaries.

SUMMARIES
Keep decisions, file paths, signatures, constraints, findings, and current task state, including the latest mode/agent transition, preview URL, verification status, and unfinished work. Keep observed facts and their sources; never invent details or turn guesses into findings. Quote short user messages verbatim; never alter user intent, scope, constraints, priorities, or acceptance criteria. Drop noise: failed attempts, verbose tool output, back-and-forth exploration.

BOUNDARY IDS
Each range is { startId, endId, summary }; both endpoints are required, even for one block: { startId: "b10", endId: "b10", summary: "Obsolete research dropped." }. Copy IDs from currently visible <dcp-message-id> tags: mNNNN = raw messages, bN = previously pruned blocks. IDs must exist in context; startId must come before or equal endId. Batch independent non-overlapping ranges in one call, not parallel prune calls.
mNNNN IDs are renumbered every dispatch and strictly ascending in transcript order, so a lower number is ALWAYS an earlier message. Visible tags may have gaps: never infer missing IDs or reuse endpoints from earlier calls. After an unknown-ID error, use currently visible tags, not guessed increments or decrements. A range spanning the whole transcript is fine - m0001 to the last ID, when both tags are visible - if its summary preserves all still-needed information.

PREVIOUSLY PRUNED BLOCKS
A range may cover pruned block summaries (marked [Compressed conversation section] with a bN ID):
- Include \`(bN)\` exactly once in the summary to carry that block's full content forward; write surrounding text so it still reads after expansion.
- Omit \`(bN)\` to permanently drop that block's content. Do this when the work it describes no longer matters to the current task.
- Never emit \`(bN)\` text outside a placeholder; mention blocks in prose as plain text like \`pruned bN\`.
- A range covering ONLY already-compressed messages is rejected unless the replacement summary is at most ${(ZERO_GAIN_STANDING_SUMMARY_FRACTION * 100).toFixed(0)}% the size of the standing summary AND frees at least ${ZERO_GAIN_MIN_TOKENS} tokens. Placeholder-free drops of dead content may free less than ${ZERO_GAIN_MIN_TOKENS} tokens but must still halve the standing summary and save tokens. A same-size re-summarization is a no-op that costs a whole model turn.
- After a low-gain rejection, leave that block alone unless you can substantially shorten it. Continue the task if nothing else qualifies; the pruning budget is a housekeeping threshold, not proof the model window is full.

OUTPUT FORMAT
Call with topic (3-5 word label) and content: [{ startId, endId, summary }, ...].
`;
var CONTEXT_LIMIT_NUDGE = (usageTokens, budget, window) => `<dcp-system-reminder>
Context is ${contextUsage(usageTokens, window)}${budgetClause(usageTokens, budget)}${usageTokens >= budget ? " - prune now." : " - no pruning needed."} Re-measured on this dispatch, so it supersedes any earlier reminder - do not prune again over a stale number.

Decide in one pass over the boundary IDs, oldest first - do not deliberate. Prefer messages not yet inside a compressed section; a range qualifies when BOTH are true:
- its work is finished (research concluded, code verified, dead end, or its outcome is already stated in later messages), and
- the current task needs nothing from it verbatim (code, errors, file contents or requirements still referenced must stay).
An active compressed section (bN) qualifies only when its whole content is dead - drop it in a one-liner - or when you can replace its summary with a substantially shorter one; re-summarizing a section you already summarized frees nothing and is rejected.
When only one candidate exists, prune it; when in doubt between two, prune the older one. Batch every qualifier into a single \`prune\` call - one entry per range, 3-5 word topic, summary keeping decisions/paths/findings/constraints and dropping back-and-forth noise. If nothing qualifies, continue working: no fragments, no further analysis.
</dcp-system-reminder>`;
var POST_PRUNE_ACK = (usageTokens, budget, window, blockRef, stillOverBudget, messagesCovered) => `<dcp-system-reminder>
Prune applied${blockRef ? ` (${blockRef})` : ""}: the earlier context reminder is resolved - that number predates the prune, and this dispatch re-measures ${contextUsage(usageTokens, window)}${budgetClause(usageTokens, budget)}.
${stillOverBudget ? messagesCovered === 0 ? "That pass covered no new messages - it only re-summarized an already-compressed section, so it must not be repeated: prune messages outside the active compressed sections." : "Still above the pruning budget: prune again only if another meaningfully sized closed section has appeared outside the active compressed sections; otherwise continue working." : "No further pruning needed - continue with the current task."}
</dcp-system-reminder>`;
var ITERATION_NUDGE = (messages) => `<dcp-system-reminder>
${messages} messages since the last user turn. If any completed work is no longer relevant to the current task, \`prune\` it.
</dcp-system-reminder>`;
var PRUNE_REQUEST_PREFIX = "Prune this conversation now.";
var MANUAL_PRUNE_REMINDER = (escapedFocus) => `<dcp-system-reminder>
Manual prune requested by the user: immediately call the \`prune\` tool on the largest CLOSED section of this conversation, dropping completed work irrelevant to the current task. User focus (may be empty): ${escapedFocus}
This is an explicit request, not a pressure estimate - no occupancy figure is attached and none is needed. Decide in one pass over the boundary IDs, oldest first; batch every qualifying range into a single \`prune\` call (3-5 word topic, summaries as usual). If nothing qualifies, say so in one line and continue with the current task.
</dcp-system-reminder>`;

// lib/refs.ts
var MESSAGE_REF_REGEX = /^m(\d{4})$/;
var BLOCK_REF_REGEX = /^b([1-9]\d*)$/;
var MESSAGE_ID_TAG_NAME = "dcp-message-id";
var MESSAGE_REF_WIDTH = 4;
var MESSAGE_REF_MIN_INDEX = 1;
var MESSAGE_REF_MAX_INDEX = 9999;
function formatMessageRef(index) {
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX) {
    throw new Error(
      `Message ref index out of bounds: ${index}. Supported range is 1-${MESSAGE_REF_MAX_INDEX}.`
    );
  }
  return `m${index.toString().padStart(MESSAGE_REF_WIDTH, "0")}`;
}
function formatBlockRef(blockId) {
  if (!Number.isInteger(blockId) || blockId < 1) throw new Error(`Invalid block ID: ${blockId}`);
  return `b${blockId}`;
}
function parseMessageRef(ref) {
  const match = ref.trim().toLowerCase().match(MESSAGE_REF_REGEX);
  if (!match) return null;
  const index = Number.parseInt(match[1], 10);
  if (!Number.isInteger(index) || index < MESSAGE_REF_MIN_INDEX || index > MESSAGE_REF_MAX_INDEX)
    return null;
  return index;
}
function parseBlockRef(ref) {
  const match = ref.trim().toLowerCase().match(BLOCK_REF_REGEX);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  return Number.isInteger(id) ? id : null;
}
function formatMessageIdTag(ref) {
  return `
<${MESSAGE_ID_TAG_NAME}>${ref}</${MESSAGE_ID_TAG_NAME}>`;
}
var RefRegistry = class _RefRegistry {
  byKey = /* @__PURE__ */ new Map();
  byRef = /* @__PURE__ */ new Map();
  /** One past the highest index currently allocated (informational). */
  next = MESSAGE_REF_MIN_INDEX;
  /**
   * Rebuilds the alias table from the visible transcript keys **in transcript
   * order**: the first key becomes `m0001`, the second `m0002`, and so on.
   *
   * This is the only sound way to number a transcript, and the one the
   * context hook uses on every dispatch. Duplicate keys keep their first
   * position. Keys past `MESSAGE_REF_MAX_INDEX` are left unaliased (they get
   * no boundary tag, so the model cannot address them) instead of throwing:
   * a >9 999 message transcript must degrade, not fail the dispatch.
   *
   * @returns how many keys were left unaliased (0 in normal operation).
   */
  project(keys) {
    this.byKey.clear();
    this.byRef.clear();
    let index = MESSAGE_REF_MIN_INDEX;
    let overflow = 0;
    for (const key of keys) {
      if (this.byKey.has(key)) continue;
      if (index > MESSAGE_REF_MAX_INDEX) {
        overflow += 1;
        continue;
      }
      const ref = formatMessageRef(index);
      this.byKey.set(key, ref);
      this.byRef.set(ref, key);
      index += 1;
    }
    this.next = index;
    return overflow;
  }
  /**
   * Drops the alias of each given key (unknown keys are a no-op). Pure map
   * surgery: it deliberately has NO effect on how the next alias is chosen.
   * Compression calls this for every covered key, and the next dispatch
   * re-projects the surviving transcript anyway, so the freed slots are only
   * ever reused by an explicit `project`.
   */
  release(keys) {
    for (const key of keys) {
      const ref = this.byKey.get(key);
      if (!ref) continue;
      this.byKey.delete(key);
      this.byRef.delete(ref);
    }
  }
  keyOf(ref) {
    return this.byRef.get(ref);
  }
  /**
   * Restores a persisted table. Tolerant by design: the blob comes from
   * plugin storage and may be absent, pre-`project` (session-long allocator
   * that could have produced inverted refs), or structurally partial. Nothing
   * here throws — unusable entries are dropped, and the first dispatch's
   * `project` overwrites the table with an ordered one regardless.
   */
  static from(json) {
    const registry = new _RefRegistry();
    if (!json || typeof json !== "object") return registry;
    for (const [ref, key] of entries(json.byRef)) {
      if (!isMessageRef(ref) || !key || registry.byRef.has(ref)) continue;
      registry.byRef.set(ref, key);
      if (!registry.byKey.has(key)) registry.byKey.set(key, ref);
    }
    for (const [key, ref] of entries(json.byKey)) {
      if (!key || !isMessageRef(ref) || registry.byKey.has(key)) continue;
      registry.byKey.set(key, ref);
      if (!registry.byRef.has(ref)) registry.byRef.set(ref, key);
    }
    registry.next = onePastHighest(registry.byRef.keys());
    return registry;
  }
  toJSON() {
    return {
      byKey: Object.fromEntries(this.byKey),
      byRef: Object.fromEntries(this.byRef),
      next: this.next
    };
  }
};
function entries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out.push([key, entry]);
  }
  return out;
}
function isMessageRef(ref) {
  return parseMessageRef(ref) !== null;
}
function onePastHighest(refs) {
  let highest = 0;
  for (const ref of refs) {
    const index = parseMessageRef(ref);
    if (index !== null && index > highest) highest = index;
  }
  return Math.min(highest + 1, MESSAGE_REF_MAX_INDEX + 1);
}

// lib/tokens.ts
function countTokens(text) {
  return text ? Math.round(text.length / 4) : 0;
}

// lib/tui-bridge.ts
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
var TUI_STATS_KEY = "plugin.opencode.dcp.tui.stats";
var MAX_RECENT_COMPRESSIONS = 10;
var CHARS_PER_TOKEN = 4;
var MEDIA_TOKEN_ALLOWANCE = {
  image: 1600,
  audio: 25e3,
  video: 1e5,
  pdf: 8e3,
  text: 0,
  other: 4e3
};
function mediaKindOf(mediaType) {
  if (typeof mediaType !== "string") return "other";
  const lower = mediaType.toLowerCase();
  if (lower.startsWith("image/")) return "image";
  if (lower.startsWith("video/")) return "video";
  if (lower.startsWith("audio/")) return "audio";
  if (lower === "application/pdf") return "pdf";
  if (lower.startsWith("text/")) return "text";
  return "other";
}
function mediaAllowanceChars(kind) {
  return MEDIA_TOKEN_ALLOWANCE[kind] * CHARS_PER_TOKEN;
}
var DATA_URI_PREFIX = "data:";
var DATA_URI_MIME_SCAN = 128;
function dataUriAllowanceChars(value) {
  if (value.length <= DATA_URI_PREFIX.length) return -1;
  if (value.charCodeAt(0) !== 100 || !value.startsWith(DATA_URI_PREFIX)) return -1;
  const start = DATA_URI_PREFIX.length;
  const limit = Math.min(value.length, start + DATA_URI_MIME_SCAN);
  let end = start;
  while (end < limit) {
    const code = value.charCodeAt(end);
    if (code === 59 || code === 44) break;
    end += 1;
  }
  if (end === limit) return -1;
  const mediaType = value.slice(start, end);
  if (!isMediaType(mediaType)) return -1;
  const kind = mediaKindOf(mediaType);
  return kind === "text" ? -1 : mediaAllowanceChars(kind);
}
function isMediaType(value) {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return false;
  if (value.indexOf("/", slash + 1) !== -1) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isTokenChar(value.charCodeAt(index))) return false;
  }
  return true;
}
function isTokenChar(code) {
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  if (code === 47) return true;
  return code === 33 || code === 35 || code === 36 || code === 37 || code === 38 || code === 39 || code === 42 || code === 43 || code === 45 || code === 46 || code === 94 || code === 95 || code === 96 || code === 124 || code === 126;
}
function estimateTokens(chars) {
  return Math.max(0, Math.round(chars / CHARS_PER_TOKEN));
}
function measureMessagesChars(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message;
    total += measurePartChars(record);
  }
  return total;
}
function measurePartChars(value) {
  if (typeof value === "string") {
    const media = dataUriAllowanceChars(value);
    return media < 0 ? value.length : media;
  }
  if (typeof value !== "object" || value === null) return 0;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += measurePartChars(item);
    return total;
  }
  if (ArrayBuffer.isView(value)) return 0;
  return measureObjectChars(value);
}
function measureFields(record, skipKey) {
  const keys = Object.keys(record);
  let total = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === void 0 || key === skipKey) continue;
    total += measurePartChars(record[key]);
  }
  return total;
}
function measureMediaItemChars(kind, record, payloadKey) {
  if (kind === "text") {
    const payload = record[payloadKey];
    if (ArrayBuffer.isView(payload)) {
      return measureFields(record, payloadKey) + payload.byteLength;
    }
    return measureFields(record, void 0);
  }
  return mediaAllowanceChars(kind) + measureFields(record, payloadKey);
}
function measureObjectChars(record) {
  if (record["type"] !== "media") return measureFields(record, void 0);
  const asset = asRecord(record["media"]);
  if (asset) {
    const source = asRecord(asset["source"]);
    return (source ? measureMediaSourceChars(source, mediaKindOf(asString(asset["mediaType"]))) : 0) + measureFields(record, "media");
  }
  if (record["data"] !== void 0) {
    return measureMediaItemChars(mediaKindOf(asString(record["mediaType"])), record, "data");
  }
  return measureFields(record, void 0);
}
function measureMediaSourceChars(source, inheritedKind) {
  const own = mediaKindOf(asString(source["mediaType"]));
  const kind = own === "other" ? inheritedKind : own;
  const type = source["type"];
  if ((type === "bytes" || type === "base64") && source["data"] !== void 0) {
    return measureMediaItemChars(kind, source, "data");
  }
  const handleKind = kind === "text" ? "pdf" : kind;
  if (type === "url" && typeof source["url"] === "string") {
    return mediaAllowanceChars(handleKind) + measureFields(source, void 0);
  }
  if (type === "ref" && typeof source["id"] === "string" && typeof source["provider"] === "string") {
    return mediaAllowanceChars(handleKind) + measureFields(source, void 0);
  }
  return measureFields(source, void 0);
}
function asString(value) {
  return typeof value === "string" ? value : void 0;
}
function asRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
  return value;
}
function buildStatsSnapshot(previous, input) {
  const sessions = {};
  for (const [id, entry] of Object.entries(previous?.sessions ?? {})) {
    if (id === input.sessionId) continue;
    sessions[id] = entry;
  }
  const prior = previous?.sessions[input.sessionId];
  const recentCompressions = input.recentCompressions ? [...input.recentCompressions] : [...prior?.recentCompressions ?? []];
  if (input.compression && !recentCompressions.includes(input.compression)) {
    recentCompressions.push(input.compression);
  }
  while (recentCompressions.length > MAX_RECENT_COMPRESSIONS) recentCompressions.shift();
  const lastDispatch = input.dispatch === void 0 ? prior?.lastDispatch : {
    ...input.dispatch,
    savedTokens: Math.max(0, input.dispatch.tokensBefore - input.dispatch.tokensAfter),
    savedPercent: input.dispatch.tokensBefore > 0 ? Math.round(
      (input.dispatch.tokensBefore - input.dispatch.tokensAfter) / input.dispatch.tokensBefore * 100
    ) : 0
  };
  sessions[input.sessionId] = {
    sessionId: input.sessionId,
    updatedAt: Date.now(),
    model: input.model ?? prior?.model,
    lastDispatch,
    totals: input.totals,
    recentCompressions
  };
  return { version: 1, generatedAt: Date.now(), sessions };
}
function resolveTuiStateDirs(stateRoot) {
  const root = stateRoot ?? process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state");
  const appDir = path.join(root, "opencode");
  let channels;
  try {
    channels = readdirSync(appDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
  const targets = [];
  for (const channel of channels) {
    const tuiDir = path.join(appDir, channel, "tui");
    try {
      mkdirSync(tuiDir, { recursive: true });
      targets.push(tuiDir);
    } catch {
    }
  }
  return targets;
}
function writeTuiStats(snapshot, stateRoot) {
  const payload = JSON.stringify(snapshot);
  for (const dir of resolveTuiStateDirs(stateRoot)) {
    const finalPath = path.join(dir, `${TUI_STATS_KEY}.json`);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, payload, "utf8");
      renameSync(tmpPath, finalPath);
    } catch {
    }
  }
}

// lib/state/types.ts
function createSessionState(sessionId) {
  return {
    sessionId,
    refs: { byKey: {}, byRef: {}, next: 1 },
    prunedTools: {},
    blocks: {},
    activeBlockIds: [],
    nextBlockId: 1,
    nudgeAnchors: [],
    pruneSeq: 0,
    pruneAckSeq: 0,
    stats: { totalPrunedTokens: 0, compressRuns: 0, dispatches: 0, recentCompressions: [] },
    updatedAt: Date.now()
  };
}
function hydrateSessionState(json, sessionId) {
  const base = createSessionState(sessionId);
  if (typeof json !== "object" || json === null) return base;
  const raw = json;
  if (raw.refs && typeof raw.refs === "object") base.refs = raw.refs;
  if (raw.prunedTools && typeof raw.prunedTools === "object") {
    for (const [key, value] of Object.entries(raw.prunedTools)) {
      if (typeof value === "number" && Number.isFinite(value)) base.prunedTools[key] = value;
    }
  }
  if (raw.blocks && typeof raw.blocks === "object") {
    for (const [key, value] of Object.entries(raw.blocks)) {
      const block = coerceBlock(value);
      if (block) base.blocks[key] = block;
    }
  }
  if (Array.isArray(raw.activeBlockIds)) {
    base.activeBlockIds = raw.activeBlockIds.filter((id) => typeof id === "number");
  }
  if (typeof raw.nextBlockId === "number") base.nextBlockId = Math.max(1, Math.floor(raw.nextBlockId));
  if (Array.isArray(raw.nudgeAnchors)) {
    base.nudgeAnchors = raw.nudgeAnchors.filter((id) => typeof id === "number");
  }
  if (typeof raw.pruneSeq === "number" && Number.isFinite(raw.pruneSeq)) {
    base.pruneSeq = Math.max(0, Math.floor(raw.pruneSeq));
  }
  if (typeof raw.pruneAckSeq === "number" && Number.isFinite(raw.pruneAckSeq)) {
    base.pruneAckSeq = Math.max(0, Math.floor(raw.pruneAckSeq));
  }
  if (raw.stats && typeof raw.stats === "object") {
    const stats = raw.stats;
    if (typeof stats.totalPrunedTokens === "number") base.stats.totalPrunedTokens = stats.totalPrunedTokens;
    if (typeof stats.compressRuns === "number") base.stats.compressRuns = stats.compressRuns;
    if (typeof stats.dispatches === "number") base.stats.dispatches = stats.dispatches;
    if (Array.isArray(stats.recentCompressions)) {
      for (const item of stats.recentCompressions) {
        const record = coerceCompressionRecord(item);
        if (record) base.stats.recentCompressions.push(record);
      }
      while (base.stats.recentCompressions.length > MAX_RECENT_COMPRESSIONS) {
        base.stats.recentCompressions.shift();
      }
    }
  }
  const knownBlocks = new Set(Object.keys(base.blocks));
  base.activeBlockIds = base.activeBlockIds.filter(
    (id) => knownBlocks.has(String(id)) && base.blocks[String(id)]?.active === true
  );
  return base;
}
function coerceCompressionRecord(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  if (typeof raw.at !== "number" || typeof raw.blockId !== "number" || typeof raw.topic !== "string" || typeof raw.ranges !== "number" || typeof raw.messagesCovered !== "number" || typeof raw.tokensBefore !== "number" || typeof raw.tokensAfter !== "number" || typeof raw.tokensSaved !== "number") {
    return void 0;
  }
  return {
    at: raw.at,
    blockId: raw.blockId,
    topic: raw.topic,
    ranges: raw.ranges,
    messagesCovered: raw.messagesCovered,
    toolsCovered: typeof raw.toolsCovered === "number" ? raw.toolsCovered : void 0,
    tokensBefore: raw.tokensBefore,
    tokensAfter: raw.tokensAfter,
    tokensSaved: raw.tokensSaved,
    usageAfter: typeof raw.usageAfter === "number" ? raw.usageAfter : void 0
  };
}
function coerceBlock(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const raw = value;
  if (typeof raw.blockId !== "number" || typeof raw.topic !== "string" || typeof raw.summary !== "string" || typeof raw.anchorKey !== "string" || !Array.isArray(raw.coveredKeys)) {
    return void 0;
  }
  return {
    blockId: raw.blockId,
    active: raw.active === true,
    topic: raw.topic,
    summary: raw.summary,
    summaryTokens: typeof raw.summaryTokens === "number" ? raw.summaryTokens : 0,
    compressedTokens: typeof raw.compressedTokens === "number" ? raw.compressedTokens : 0,
    coveredKeys: raw.coveredKeys.filter((key) => typeof key === "string"),
    coveredToolIds: Array.isArray(raw.coveredToolIds) ? raw.coveredToolIds.filter((id) => typeof id === "string") : [],
    anchorKey: raw.anchorKey,
    consumedBlockIds: Array.isArray(raw.consumedBlockIds) ? raw.consumedBlockIds.filter((id) => typeof id === "number") : [],
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0
  };
}

// lib/state/store.ts
var StateStore = class {
  constructor(storage) {
    this.storage = storage;
  }
  storage;
  memory = /* @__PURE__ */ new Map();
  pending = /* @__PURE__ */ new Map();
  /** Cached runtime without loading from storage (may be undefined). */
  peek(sessionId) {
    return this.memory.get(sessionId);
  }
  /** Detached read for auxiliary requests; never initialize or persist a runtime. */
  async snapshot(sessionId) {
    const cached = this.peek(sessionId);
    if (cached) return structuredClone(cached.state);
    if (!this.storage) return;
    const stored = await this.storage.get(`session/${sessionId}`);
    if (stored === void 0) return;
    return hydrateSessionState(structuredClone(stored), sessionId);
  }
  async ensure(sessionId) {
    const cached = this.memory.get(sessionId);
    if (cached) return cached;
    const inflight = this.pending.get(sessionId);
    if (inflight) return inflight;
    const load = (async () => {
      let state = createSessionState(sessionId);
      if (this.storage) {
        try {
          const stored = await this.storage.get(`session/${sessionId}`);
          state = hydrateSessionState(stored, sessionId);
        } catch {
        }
      }
      const runtime = {
        sessionId,
        state,
        refs: RefRegistry.from(state.refs)
      };
      this.memory.set(sessionId, runtime);
      return runtime;
    })();
    this.pending.set(sessionId, load);
    try {
      return await load;
    } finally {
      this.pending.delete(sessionId);
    }
  }
  async persist(sessionId) {
    const runtime = this.memory.get(sessionId);
    if (!runtime || !this.storage) return;
    runtime.state.refs = runtime.refs.toJSON();
    runtime.state.updatedAt = Date.now();
    try {
      await this.storage.set(`session/${sessionId}`, runtime.state);
    } catch {
    }
  }
  /** Keep only whole summaries whose original messages still exist. */
  async reconcile(sessionId, keys) {
    const runtime = await this.ensure(sessionId);
    const present = new Set(keys);
    const retained = [];
    const seen = /* @__PURE__ */ new Set();
    const visit = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const block = runtime.state.blocks[String(id)];
      if (!block) return;
      if (block.coveredKeys.length > 0 && block.coveredKeys.every((key) => present.has(key))) {
        retained.push(id);
      } else {
        for (const child of block.consumedBlockIds) visit(child);
      }
    };
    for (const id of runtime.state.activeBlockIds) visit(id);
    let removed = false;
    for (const [id, block] of Object.entries(runtime.state.blocks)) {
      if (block.coveredKeys.length === 0 || !block.coveredKeys.every((key) => present.has(key))) {
        delete runtime.state.blocks[id];
        removed = true;
      }
    }
    if (!removed && retained.length === runtime.state.activeBlockIds.length && retained.every((id, i) => id === runtime.state.activeBlockIds[i])) return;
    const active = new Set(retained);
    for (const block of Object.values(runtime.state.blocks)) block.active = active.has(block.blockId);
    runtime.state.activeBlockIds = retained;
    runtime.state.nudgeAnchors = [];
    runtime.state.pruneAckSeq = runtime.state.pruneSeq;
    await this.persist(sessionId);
  }
  /** Drops all DCP edits for a session (native compaction / deletion). */
  reset(sessionId) {
    this.memory.delete(sessionId);
    void this.storage?.remove(`session/${sessionId}`)?.catch(() => {
    });
  }
};
var TAIL_ANCHOR = "tail";
function compressionAnchorIndex(block, positions, length) {
  const successor = block.anchorKey === TAIL_ANCHOR ? void 0 : positions.get(block.anchorKey);
  if (successor !== void 0) return successor;
  let last = -1;
  for (const key of block.coveredKeys) last = Math.max(last, positions.get(key) ?? -1);
  return last < 0 ? length : last + 1;
}
function allocateBlockId(state) {
  const blockId = state.nextBlockId++;
  return blockId;
}
function wrapCompressedSummary(blockId, summary) {
  const ref = formatBlockRef(blockId);
  return `[Compressed conversation section]
${summary.trim()}
<dcp-message-id>${ref}</dcp-message-id>`;
}
function applyCompression(input) {
  const { state } = input;
  const blockId = allocateBlockId(state);
  const wrapped = wrapCompressedSummary(blockId, input.summary);
  const block = {
    blockId,
    active: true,
    topic: input.topic,
    summary: wrapped,
    summaryTokens: countTokens(wrapped),
    compressedTokens: Math.max(0, input.coveredTokens),
    coveredKeys: [...input.coveredKeys],
    coveredToolIds: [...input.coveredToolIds],
    anchorKey: input.anchorKey,
    consumedBlockIds: [...input.consumedBlockIds],
    createdAt: Date.now()
  };
  state.blocks[String(blockId)] = block;
  const replacementIndex = state.activeBlockIds.findIndex((id) => input.consumedBlockIds.includes(id));
  for (const consumedId of input.consumedBlockIds) {
    const consumed = state.blocks[String(consumedId)];
    if (consumed && consumed.active) {
      consumed.active = false;
      state.activeBlockIds = state.activeBlockIds.filter((id) => id !== consumedId);
    }
  }
  const releasedKeys = [
    ...input.coveredKeys,
    ...input.consumedBlockIds.flatMap((id) => {
      const consumed = state.blocks[String(id)];
      return consumed ? consumed.coveredKeys : [];
    })
  ];
  input.refs.release(releasedKeys);
  for (const id of state.activeBlockIds) {
    const other = state.blocks[String(id)];
    if (!other) continue;
    other.coveredKeys = other.coveredKeys.filter((key) => !input.coveredKeys.includes(key));
  }
  state.activeBlockIds.splice(replacementIndex < 0 ? state.activeBlockIds.length : replacementIndex, 0, blockId);
  state.stats.compressRuns += 1;
  state.nudgeAnchors = [];
  state.pruneSeq += 1;
  return block;
}
function activeBlocks(state) {
  return state.activeBlockIds.map((id) => state.blocks[String(id)]).filter((block) => block !== void 0 && block.active);
}

// lib/protected.ts
function matchesGlob(pattern, value) {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedPattern.length === 0) return false;
  if (normalizedPattern === "*") return true;
  const regex = new RegExp(
    `^${normalizedPattern.split("*").map((segment) => segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`
  );
  return regex.test(normalizedValue);
}
function isToolNameProtected(toolName, patterns) {
  if (ALWAYS_PROTECTED_TOOLS.includes(toolName.toLowerCase())) return true;
  return patterns.some((pattern) => matchesGlob(pattern, toolName));
}
var FILE_PATH_KEYS = ["filePath", "file_path", "file", "path", "filename", "notebookPath"];
function getFilePathsFromInput(input) {
  const found = [];
  collect(input, found, 0);
  return found;
}
function collect(value, found, depth) {
  if (depth > 2 || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 20)) collect(item, found, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FILE_PATH_KEYS.includes(key) && typeof item === "string") {
      found.push(item);
    } else if (typeof item === "object" && item !== null) {
      collect(item, found, depth + 1);
    }
  }
}
function isFilePathProtected(paths, patterns) {
  if (patterns.length === 0 || paths.length === 0) return false;
  return paths.some(
    (path3) => patterns.some((pattern) => matchesPathGlob(pattern, path3))
  );
}
function matchesPathGlob(pattern, path3) {
  const normalizedPattern = pattern.trim().replace(/^\.\//, "");
  const normalizedPath = path3.trim();
  const regex = new RegExp(
    `^${normalizedPattern.split("**").map(
      (segment) => segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")
    ).join(".*")}$`
  );
  return regex.test(normalizedPath);
}
function isToolAutoPrunable(info, protection, kind) {
  const namePatterns = kind === "dedupe" ? protection.dedupePatterns : protection.purgePatterns;
  if (!info.isError && isToolNameProtected(info.name, namePatterns)) return false;
  const paths = getFilePathsFromInput(info.input);
  if (isFilePathProtected(paths, protection.filePatterns)) return false;
  return true;
}

// lib/transcript/edit.ts
function mapTextParts(message, transform) {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "text") return part;
    const next = transform(part.text);
    if (next === part.text) return part;
    changed = true;
    return { ...part, text: next };
  });
  if (!changed) return message;
  return { ...message, content };
}
function withToolResultReplaced(message, callId, replacement) {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "tool-result" || part.id !== callId) return part;
    changed = true;
    return { ...part, result: replacement };
  });
  if (!changed) return message;
  return { ...message, content };
}
function withToolInputReplaced(message, callId, replacement) {
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "tool-call" || part.id !== callId) return part;
    changed = true;
    return { ...part, input: replacement };
  });
  if (!changed) return message;
  return { ...message, content };
}
function createSyntheticBlockMessage(summary) {
  return {
    role: "user",
    content: [{ type: "text", text: summary }]
  };
}
var HALLUCINATED_TAG_REGEX = /[ \t]*<\/?dcp-(?:message-id|system-reminder)(?:\s[^>]*)?>[ \t]*\n?/g;
function stripHallucinatedTags(text) {
  if (!text.includes("dcp-")) return text;
  return text.replace(HALLUCINATED_TAG_REGEX, "").replace(/\n{3,}/g, "\n\n");
}

// lib/types.ts
function qualifiedToolName(name, namespace) {
  return namespace === void 0 || namespace === "" ? name : `${namespace}_${name}`;
}
function toolResultToText(value) {
  switch (value.type) {
    case "text":
      return typeof value.value === "string" ? value.value : JSON.stringify(value.value) ?? String(value.value);
    case "json":
      try {
        return JSON.stringify(value.value) ?? String(value.value);
      } catch {
        return String(value.value);
      }
    case "error":
      try {
        return JSON.stringify(value.value) ?? String(value.value);
      } catch {
        return String(value.value);
      }
    case "content":
      return value.value.map((item) => item.type === "text" ? item.text : `[file:${item.mime}]`).join("\n");
  }
}
function makeToolResultReplacement(text) {
  return { type: "text", value: text };
}

// lib/prune.ts
var PRUNED_TOOL_OUTPUT_REPLACEMENT = "[Output removed to save context - information superseded or no longer needed]";
var PRUNED_TOOL_ERROR_INPUT_REPLACEMENT = "[input removed due to failed tool call]";
function pruneToolOutputs(state, messages, config) {
  const prunedIds = Object.keys(state.prunedTools);
  if (prunedIds.length === 0) return;
  const prunedSet = new Set(prunedIds);
  const alwaysProtected = /* @__PURE__ */ new Set([...ALWAYS_PROTECTED_TOOLS]);
  const isProtectedName = (part) => {
    const leaf = (part?.name ?? "").toLowerCase();
    const qualified = qualifiedToolName(part?.name ?? "", part?.namespace).toLowerCase();
    if (alwaysProtected.has(qualified) || alwaysProtected.has(leaf)) return true;
    return config.protectedTools.some((pattern) => matchesGlob(pattern, qualified));
  };
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      if (!prunedSet.has(part.id)) continue;
      if (part.result.type !== "error") continue;
      if (isProtectedName(part)) continue;
      for (let j = i - 1; j >= 0; j--) {
        const candidate = messages[j];
        if (!candidate) continue;
        if (candidate.role === "user") break;
        if (candidate.role !== "assistant") continue;
        const hasCall = candidate.content.some(
          (inner) => inner.type === "tool-call" && inner.id === part.id
        );
        if (!hasCall) continue;
        const input = candidate.content.find(
          (inner) => inner.type === "tool-call" && inner.id === part.id
        );
        if (input && input.type === "tool-call" && typeof input.input === "object" && input.input !== null) {
          const scrubbed = {};
          for (const [key, value] of Object.entries(input.input)) {
            scrubbed[key] = typeof value === "string" ? PRUNED_TOOL_ERROR_INPUT_REPLACEMENT : value;
          }
          messages[j] = withToolInputReplaced(candidate, part.id, scrubbed);
        }
        break;
      }
    }
    let next = message;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      if (!prunedSet.has(part.id)) continue;
      if (isProtectedName(part)) continue;
      next = withToolResultReplaced(next, part.id, makeToolResultReplacement(PRUNED_TOOL_OUTPUT_REPLACEMENT));
    }
    if (next !== message) messages[i] = next;
  }
}
function applyCompressionBlocks(state, messages, keys) {
  const blocks = activeBlocks(state);
  if (blocks.length === 0) return;
  const keyToIndex = /* @__PURE__ */ new Map();
  for (let i = 0; i < keys.length; i++) keyToIndex.set(keys[i], i);
  const splices = [];
  const covered = /* @__PURE__ */ new Set();
  for (const block of blocks) {
    for (const key of block.coveredKeys) covered.add(key);
    const anchorIndex = compressionAnchorIndex(block, keyToIndex, messages.length);
    splices.push({ at: anchorIndex, summary: block.summary });
  }
  const kept = [];
  for (let i = 0; i < messages.length; i++) {
    for (const splice of splices.filter((entry) => entry.at === i)) {
      kept.push(createSyntheticBlockMessage(splice.summary));
    }
    const key = keys[i];
    if (key !== void 0 && covered.has(key)) continue;
    kept.push(messages[i]);
  }
  for (const splice of splices.filter((entry) => entry.at === messages.length)) {
    kept.push(createSyntheticBlockMessage(splice.summary));
  }
  messages.length = 0;
  messages.push(...kept);
}
function normalizeLegacyBlockKeys(state, keys, messages) {
  for (const block of activeBlocks(state)) {
    if (!block.coveredKeys.some((key) => /^tool#\d+$/.test(key))) continue;
    block.coveredKeys = block.coveredKeys.map((key) => {
      const match = /^tool#(\d+)$/.exec(key);
      if (!match) return key;
      const index = Number(match[1]);
      if (index < 0 || index >= keys.length) return key;
      if (messages[index]?.role !== "tool") return key;
      return keys[index];
    });
  }
}
function injectBoundaryTags(refsByKey, messages, keys) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant") {
      const hasText = message.content.some(
        (part) => part.type === "text" && part.text.includes("dcp-")
      );
      if (hasText) {
        messages[i] = mapTextParts(message, stripHallucinatedTags);
      }
      continue;
    }
    const key = keys[i];
    if (key === void 0) continue;
    const ref = refsByKey.get(key);
    if (!ref) continue;
    const tag = formatMessageIdTag(ref);
    if (message.role === "user") {
      const next = appendToLastTextPartSafe(message, tag);
      if (next !== message) messages[i] = next;
      continue;
    }
    if (message.role === "tool") {
      let next = message;
      for (const part of message.content) {
        if (part.type !== "tool-result" || part.result.type !== "text") continue;
        if (typeof part.result.value !== "string") continue;
        if (part.result.value.includes("dcp-message-id")) continue;
        const updated = { ...part, result: { type: "text", value: part.result.value + tag } };
        next = {
          ...next,
          content: next.content.map((inner) => inner === part ? updated : inner)
        };
      }
      if (next !== message) messages[i] = next;
    }
  }
}
function appendToLastTextPartSafe(message, suffix) {
  for (let i = message.content.length - 1; i >= 0; i--) {
    const part = message.content[i];
    if (part && part.type === "text" && !part.text.includes("dcp-message-id")) {
      const content = [...message.content];
      content[i] = { ...part, text: part.text + suffix };
      return { ...message, content };
    }
    if (part && part.type === "text") return message;
  }
  return message;
}

// lib/strategies.ts
function deduplicate(state, index, config) {
  if (!config.strategies.deduplication.enabled) return empty();
  const groups = /* @__PURE__ */ new Map();
  for (const callId of index.toolOrder) {
    const info = index.tools.get(callId);
    if (!info || !info.hasResult || info.isError) continue;
    if (state.prunedTools[callId] !== void 0) continue;
    if (!isToolAutoPrunable(
      info,
      {
        dedupePatterns: config.strategies.deduplication.protectedTools,
        purgePatterns: [],
        filePatterns: config.protectedFilePatterns
      },
      "dedupe"
    )) {
      continue;
    }
    const signature = `${info.name}::${stableStringify(sortKeys(normalizeInput(info.input)))}`;
    const group = groups.get(signature);
    if (group) group.push(callId);
    else groups.set(signature, [callId]);
  }
  const added = [];
  for (const ids of groups.values()) {
    if (ids.length > 1) added.push(...ids.slice(0, -1));
  }
  return commit(state, index, added);
}
function purgeErrors(state, index, config) {
  const turns = config.strategies.purgeErrors.turns;
  if (!config.strategies.purgeErrors.enabled || index.turnCount <= turns) return empty();
  const currentTurn = index.turnCount + 1;
  const added = [];
  for (const callId of index.toolOrder) {
    const info = index.tools.get(callId);
    if (!info || !info.hasResult || !info.isError) continue;
    if (state.prunedTools[callId] !== void 0) continue;
    if (currentTurn - info.turn < turns + 1) continue;
    if (!isToolAutoPrunable(
      info,
      {
        dedupePatterns: [],
        purgePatterns: config.strategies.purgeErrors.protectedTools,
        filePatterns: config.protectedFilePatterns
      },
      "purge"
    )) {
      continue;
    }
    added.push(callId);
  }
  return commit(state, index, added);
}
function commit(state, index, callIds) {
  let tokensSaved = 0;
  for (const callId of callIds) {
    const info = index.tools.get(callId);
    const tokens = countTokens(info?.outputText ?? "");
    state.prunedTools[callId] = tokens;
    tokensSaved += tokens;
  }
  state.stats.totalPrunedTokens += tokensSaved;
  return { added: callIds, tokensSaved };
}
var empty = () => ({ added: [], tokensSaved: 0 });
function normalizeInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const normalized = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== void 0 && value !== null) normalized[key] = value;
  }
  return normalized;
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortKeys(value[key]);
  }
  return sorted;
}
function stableStringify(value) {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

// lib/prune-tool.ts
var PRUNE_TOOL_NAME = "prune";
function pruneToolRegistered(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { name, id } = entry;
    return name === PRUNE_TOOL_NAME || id === PRUNE_TOOL_NAME;
  });
}
function addPruneTool(editor, definition) {
  if (typeof editor.add !== "function") {
    return {
      ok: false,
      reason: "the tool editor exposes no `add()`; the `prune` tool was never registered while the system prompt still advertises it"
    };
  }
  editor.add(definition);
  if (typeof editor.list !== "function") return { ok: true };
  if (pruneToolRegistered(editor.list())) return { ok: true };
  return {
    ok: false,
    reason: "the runtime rejected the `prune` definition and dropped it from the tool registry (invalid name, reserved `execute` id, or an unusable input schema); the system prompt still advertises a tool that can never be called"
  };
}
var INPUT_SCHEMA = {
  type: "object",
  properties: {
    topic: {
      type: "string",
      description: "Short label (3-5 words) for display - e.g., 'Auth System Exploration'"
    },
    content: {
      type: "array",
      description: "One or more ranges to prune, each with start/end boundaries and a summary",
      items: {
        type: "object",
        properties: {
          startId: {
            type: "string",
            description: "Message or block ID marking the beginning of range (e.g. m0001, b2)"
          },
          endId: {
            type: "string",
            description: "Message or block ID marking the end of range (e.g. m0012, b5)"
          },
          summary: {
            type: "string",
            description: "Complete technical summary replacing all content in range"
          }
        },
        required: ["startId", "endId", "summary"],
        additionalProperties: false
      }
    }
  },
  required: ["topic", "content"],
  additionalProperties: false
};
var pruneQueues = /* @__PURE__ */ new WeakMap();
function pruneToolDefinition(deps) {
  let queue = pruneQueues.get(deps.store);
  if (!queue) pruneQueues.set(deps.store, queue = /* @__PURE__ */ new Map());
  const pending = queue;
  return {
    name: PRUNE_TOOL_NAME,
    description: PRUNE_RANGE,
    input: INPUT_SCHEMA,
    // Direct registration: core tool.ts advertises `codemode === false` tools
    // as native tool definitions (full description ships every request), while
    // `codemode: true`/unset hides the tool inside the Code Mode `execute`
    // catalog, whose descriptions are truncated to 120 chars - too short for
    // the PRUNE_RANGE boundary rules every piece of DCP model copy tells the
    // model to follow. The split is `codemode === false` vs `!== false`, not
    // "explicit true", so leaving it unset is as bad as setting it true
    // (packages/core/src/tool.ts:234-235; the definitions list at :257-261).
    // The permission is pinned to the tool's own name (core's whollyDisabled
    // falls back to `tool.options?.permission ?? name`, packages/core/src/
    // tool.ts:231), so the action stays stable regardless of the platform
    // default; permission actions are free-form strings matched by wildcard,
    // so "prune" is a valid action and needs no registration of its own.
    //
    // This satisfies `Tool.Options` (packages/schema/src/tool.ts:32-42): the
    // `codemode: boolean` arm, which forbids `pinned`. `prune` is not
    // reserved - `registrationError` reserves only the `execute` id, and only
    // for `codemode === false` registrations (packages/core/src/tool.ts:
    // 311-314). `name` also passes the `/^[A-Za-z0-9_-]+$/` check on the same
    // path, which is what `addPruneTool`'s post-add verification proves.
    options: { codemode: false, permission: PRUNE_TOOL_NAME },
    execute: async (input, context) => {
      const sessionId = context.sessionID;
      const run = (pending.get(sessionId) ?? Promise.resolve()).then(
        () => runPrune(deps, input, context)
      );
      const tail = run.then(() => {
      }, () => {
      });
      pending.set(sessionId, tail);
      try {
        return await run;
      } catch (error) {
        deps.logger.warn("prune tool failed", {
          sessionID: context.sessionID,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      } finally {
        if (pending.get(sessionId) === tail) pending.delete(sessionId);
      }
    }
  };
}
async function runPrune(deps, input, context) {
  const args = validateArgs(input);
  const sessionId = context.sessionID;
  const index = deps.mirror.get(sessionId);
  if (!index || index.messages.length === 0) {
    throw new Error("no conversation context is available yet. Send a message first.");
  }
  const runtime = await deps.store.ensure(sessionId);
  normalizeLegacyBlockKeys(runtime.state, index.keys, index.messages);
  const plans = resolvePlans(args, index, runtime);
  await context.progress?.({ title: `DCP: pruning "${args.topic}"` });
  let totalNewMessages = 0;
  let toolsCovered = 0;
  let tokensCovered = 0;
  let tokensSummaries = 0;
  let lastBlockId = 0;
  const blockLabels = [];
  const expandedSummaries = plans.map(
    (plan) => expandPlaceholders(plan.entry.summary, runtime.state)
  );
  const zeroGainRanges = [];
  for (let planIndex = 0; planIndex < plans.length; planIndex++) {
    const plan = plans[planIndex];
    let consumedCoverage = 0;
    let consumedSummaryTokens2 = 0;
    let consumedOriginalTokens2 = 0;
    for (const id of plan.consumedBlockIds) {
      const consumed = runtime.state.blocks[String(id)];
      consumedCoverage += consumed?.coveredKeys.length ?? 0;
      consumedSummaryTokens2 += Math.max(0, consumed?.summaryTokens ?? 0);
      consumedOriginalTokens2 += Math.max(0, consumed?.compressedTokens ?? 0);
    }
    if (Math.max(0, plan.coveredKeys.length - consumedCoverage) > 0) continue;
    const newSummaryTokens = countTokens(
      wrapCompressedSummary(runtime.state.nextBlockId + planIndex, expandedSummaries[planIndex])
    );
    const freshOriginalTokens = Math.max(0, plan.coveredTokens - consumedOriginalTokens2);
    const reclaim = freshOriginalTokens + consumedSummaryTokens2 - newSummaryTokens;
    const dropsContent = plan.consumedBlockIds.length > 0 && plan.entry.summary.match(BLOCK_PLACEHOLDER_REGEX) === null && reclaim > 0;
    const floor = Math.max(
      dropsContent ? 1 : ZERO_GAIN_MIN_TOKENS,
      Math.ceil(consumedSummaryTokens2 * ZERO_GAIN_STANDING_SUMMARY_FRACTION)
    );
    if (reclaim < floor) {
      const blocks = plan.consumedBlockIds.map((id) => formatBlockRef(id)).join(", ");
      zeroGainRanges.push(
        `${plan.entry.startId}..${plan.entry.endId}${blocks ? ` (already compressed as ${blocks}, standing summary ${consumedSummaryTokens2} tokens)` : ""} frees ${Math.max(0, reclaim)} of the ${floor}-token minimum`
      );
    }
  }
  if (zeroGainRanges.length > 0) {
    throw new Error(
      `these ranges add no messages outside active compressed sections and would free too few tokens: ${zeroGainRanges.join("; ")}. Prune messages not yet inside a compressed section, or fold a block only when the replacement summary is at most half the standing summary and frees at least ${ZERO_GAIN_MIN_TOKENS} tokens. Placeholder-free drops may free less than ${ZERO_GAIN_MIN_TOKENS} tokens but must still halve the standing summary and save tokens - a re-summarize of the same size is a no-op that costs a whole model turn.`
    );
  }
  deduplicate(runtime.state, index, deps.config);
  purgeErrors(runtime.state, index, deps.config);
  for (let planIndex = 0; planIndex < plans.length; planIndex++) {
    const plan = plans[planIndex];
    const block = applyCompression({
      state: runtime.state,
      refs: runtime.refs,
      topic: args.topic,
      summary: expandedSummaries[planIndex],
      coveredKeys: plan.coveredKeys,
      coveredToolIds: plan.coveredToolIds,
      coveredTokens: plan.coveredTokens,
      consumedBlockIds: plan.consumedBlockIds,
      anchorKey: plan.anchorKey
    });
    const consumedCoverage = plan.consumedBlockIds.reduce(
      (sum, id) => sum + (runtime.state.blocks[String(id)]?.coveredKeys.length ?? 0),
      0
    );
    totalNewMessages += Math.max(0, plan.coveredKeys.length - consumedCoverage);
    toolsCovered += plan.coveredToolIds.length;
    tokensCovered += Math.max(0, plan.coveredTokens);
    tokensSummaries += Math.max(0, block.summaryTokens);
    lastBlockId = block.blockId;
    blockLabels.push(formatBlockRef(block.blockId));
  }
  const consumedSummaryTokens = sumConsumedBlocks(plans, runtime, "summaryTokens");
  const consumedOriginalTokens = sumConsumedBlocks(plans, runtime, "compressedTokens");
  const tokensBefore = Math.max(0, tokensCovered - consumedOriginalTokens) + consumedSummaryTokens;
  const tokensSaved = Math.max(0, tokensBefore - tokensSummaries);
  const usageTokens = deps.getUsageTokens(sessionId);
  const previousUsage = usageTokens > 0 ? usageTokens : runtime.state.stats.recentCompressions.at(-1)?.usageAfter ?? 0;
  const postPruneUsage = Math.max(0, previousUsage - tokensSaved);
  const record = {
    at: Date.now(),
    blockId: lastBlockId,
    topic: args.topic,
    ranges: plans.length,
    messagesCovered: totalNewMessages,
    toolsCovered,
    tokensBefore,
    tokensAfter: tokensSummaries,
    tokensSaved,
    // Persisted with the record so the ack on the next dispatch repeats the
    // figure the usage note prints instead of re-measuring the wire transcript
    // alone (which omits the system prompt and tool definitions and read ~3K
    // against this note's ~20K for the same prune).
    usageAfter: postPruneUsage > 0 ? postPruneUsage : void 0
  };
  runtime.state.stats.recentCompressions.push(record);
  while (runtime.state.stats.recentCompressions.length > MAX_RECENT_COMPRESSIONS) {
    runtime.state.stats.recentCompressions.shift();
  }
  deps.markPruned?.(sessionId);
  await deps.store.persist(sessionId);
  try {
    deps.recordCompression?.({ sessionId, record });
  } catch {
  }
  deps.logger.debug("compression applied", {
    sessionId,
    topic: args.topic,
    blocks: blockLabels,
    activeBlocks: activeBlocks(runtime.state).length,
    totalPrunedTokens: runtime.state.stats.totalPrunedTokens
  });
  const window = deps.getModelContextLimit(sessionId) ?? FALLBACK_CONTEXT_WINDOW;
  const budget = resolveLimit(deps.config.maxContextLimit, window);
  const usageNote = postPruneUsage > 0 && budget > 0 ? ` Context is now ${contextUsage(postPruneUsage, window)}${budgetClause(postPruneUsage, budget)}. ${postPruneUsage < budget ? "No further pruning needed - continue with the current task." : "Prune again only if another meaningfully sized closed section has appeared outside the active compressed sections; otherwise continue working."}` : "";
  const outcome = totalNewMessages > 0 ? `Pruned ${totalNewMessages} message(s) into ${blockLabels.length} pruned section(s) (${blockLabels.join(", ")}).` : `Re-summarized already-compressed content into ${blockLabels.length} pruned section(s) (${blockLabels.join(", ")}), freeing ~${tokenLabel(tokensSaved)} tokens of standing summary. No new messages were covered - do not repeat this pass.`;
  return {
    content: `${outcome}${usageNote}`,
    metadata: { topic: args.topic, blocks: blockLabels }
  };
}
function sumConsumedBlocks(plans, runtime, field) {
  let total = 0;
  for (const plan of plans) {
    for (const id of plan.consumedBlockIds) {
      total += Math.max(0, runtime.state.blocks[String(id)]?.[field] ?? 0);
    }
  }
  return total;
}
function validateArgs(input) {
  if (typeof input !== "object" || input === null) throw new Error("arguments must be an object");
  const raw = input;
  const topic = typeof raw.topic === "string" && raw.topic.trim().length > 0 ? raw.topic.trim() : "Context pruning";
  const content = Array.isArray(raw.content) ? raw.content : [];
  if (content.length === 0) throw new Error("content must be a non-empty array of ranges");
  const entries2 = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null)
      throw new Error("each range entry must be an object");
    const entry = item;
    const startId = typeof entry.startId === "string" ? entry.startId : "";
    const endId = typeof entry.endId === "string" ? entry.endId : "";
    const summary = typeof entry.summary === "string" ? entry.summary : "";
    if (!startId || !endId) throw new Error("each range needs string startId and endId");
    if (summary.trim().length === 0) throw new Error("each range needs a non-empty summary");
    entries2.push({ startId, endId, summary });
  }
  return { topic, content: entries2 };
}
function resolvePlans(args, index, runtime) {
  const keyToIndex = /* @__PURE__ */ new Map();
  index.keys.forEach((key, i) => keyToIndex.set(key, i));
  const blocks = activeBlocks(runtime.state);
  const anchors = new Map(blocks.map((block) => [
    block.blockId,
    compressionAnchorIndex(block, keyToIndex, index.keys.length)
  ]));
  const hidden = new Set(blocks.flatMap((block) => block.coveredKeys));
  const visible = [];
  for (const [i, key] of index.keys.entries()) {
    for (const block of blocks) {
      if (anchors.get(block.blockId) === i) visible.push({ block });
    }
    if (!hidden.has(key)) visible.push({ key });
  }
  for (const block of blocks) {
    if (anchors.get(block.blockId) === index.keys.length) visible.push({ block });
  }
  const keyToPosition = /* @__PURE__ */ new Map();
  const blockToPosition = /* @__PURE__ */ new Map();
  visible.forEach((entry, position) => {
    if ("key" in entry) keyToPosition.set(entry.key, position);
    else blockToPosition.set(entry.block.blockId, position);
  });
  const claimedKeys = /* @__PURE__ */ new Set();
  const claimedBlocks = /* @__PURE__ */ new Set();
  const plans = [];
  for (const entry of args.content) {
    const startIndex = boundaryToIndex(entry.startId, keyToPosition, blockToPosition, runtime, "startId");
    const endIndex = boundaryToIndex(entry.endId, keyToPosition, blockToPosition, runtime, "endId");
    if (startIndex === void 0 || endIndex === void 0) continue;
    if (startIndex > endIndex) {
      throw boundaryRecoveryError(`startId ${entry.startId} appears after endId ${entry.endId}; their visible positions are ${startIndex + 1} and ${endIndex + 1}. A range must run forward: start position <= end position`, entry.startId, keyToPosition, blockToPosition, runtime);
    }
    const covered = /* @__PURE__ */ new Set();
    const consumedBlockIds = [];
    for (let i = startIndex; i <= endIndex; i++) {
      const selected = visible[i];
      if ("block" in selected) {
        consumedBlockIds.push(selected.block.blockId);
        for (const key of selected.block.coveredKeys) covered.add(key);
        continue;
      }
      if (covered.has(selected.key)) continue;
      const rawIndex = keyToIndex.get(selected.key);
      let first = rawIndex;
      if (index.messages[first]?.role === "tool") {
        while (first > 0 && index.messages[first - 1]?.role === "tool") first--;
        if (index.messages[first - 1]?.role === "assistant") first--;
      }
      let last2 = rawIndex;
      while (index.messages[last2 + 1]?.role === "tool") last2++;
      for (let j = first; j <= last2; j++) covered.add(index.keys[j]);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const block of blocks) {
        if (consumedBlockIds.includes(block.blockId)) continue;
        if (!block.coveredKeys.some((key) => covered.has(key))) continue;
        consumedBlockIds.push(block.blockId);
        for (const key of block.coveredKeys) covered.add(key);
        changed = true;
      }
    }
    const finalCoveredKeys = [...covered].filter((key) => keyToIndex.has(key)).sort((left, right) => (keyToIndex.get(left) ?? 0) - (keyToIndex.get(right) ?? 0));
    if (finalCoveredKeys.some((key) => claimedKeys.has(key)) || consumedBlockIds.some((id) => claimedBlocks.has(id))) {
      throw new Error(`ranges overlap: ${entry.startId}..${entry.endId} intersects another range`);
    }
    for (const key of finalCoveredKeys) claimedKeys.add(key);
    for (const id of consumedBlockIds) claimedBlocks.add(id);
    const last = visible[endIndex];
    let anchorKey;
    if ("block" in last) {
      anchorKey = last.block.anchorKey;
    } else {
      let rawEnd = keyToIndex.get(last.key);
      while (index.messages[rawEnd + 1]?.role === "tool") rawEnd++;
      anchorKey = index.keys[rawEnd + 1] ?? TAIL_ANCHOR;
    }
    const finalCoveredToolIds = index.toolOrder.filter(
      (callId) => index.tools.get(callId)?.hasResult && covered.has(index.tools.get(callId).key)
    );
    plans.push({
      entry,
      coveredKeys: finalCoveredKeys,
      coveredToolIds: finalCoveredToolIds,
      coveredTokens: estimateCoveredTokens(index, finalCoveredKeys),
      anchorKey,
      consumedBlockIds
    });
  }
  if (plans.length === 0) {
    throw new Error("none of the provided IDs exist in the current context");
  }
  return plans;
}
function boundaryToIndex(id, keyToPosition, blockToPosition, runtime, field) {
  const parsed = parseBoundaryChecked(id, field);
  if (parsed.kind === "message") {
    const refKey = runtime.refs.keyOf(parsed.ref);
    const idx = refKey !== void 0 ? keyToPosition.get(refKey) : void 0;
    if (idx !== void 0) return idx;
    throw boundaryRecoveryError(`${field} ${id} does not exist in the current context`, id, keyToPosition, blockToPosition, runtime);
  }
  const block = runtime.state.blocks[String(parsed.blockId)];
  if (!block) throw boundaryRecoveryError(`${field} ${id} references an unknown compressed block`, id, keyToPosition, blockToPosition, runtime);
  if (!block.active) throw boundaryRecoveryError(`${field} ${id} references an inactive compressed block`, id, keyToPosition, blockToPosition, runtime);
  const position = blockToPosition.get(parsed.blockId);
  if (position === void 0) throw boundaryRecoveryError(`${field} ${id} references a block with no visible summary`, id, keyToPosition, blockToPosition, runtime);
  return position;
}
// Recovery information is computed from the same current view as validation.
// Never turn a stale range into an automatic prune of its (possibly wider) parent.
function boundaryRecoveryError(message, id, keyToPosition, blockToPosition, runtime) {
  const orderedBlocks = [...blockToPosition.entries()].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  const rawRefs = [...keyToPosition.entries()].sort((a, b) => a[1] - b[1]).map(([key]) => runtime.refs.byKey.get(key)).filter(Boolean);
  const failed = parseBlockRef(id);
  const old = failed === null ? void 0 : runtime.state.blocks[String(failed)];
  const parents = old?.coveredKeys.length ? orderedBlocks.filter((n) => {
    const current = runtime.state.blocks[String(n)];
    return n !== failed && current?.active && old.coveredKeys.every((key) => current.coveredKeys.includes(key));
  }).map(formatBlockRef) : [];
  const replacement = parents.length ? `\n${id}'s old span is now covered by ${parents.join(", ")}. This is navigation, NOT permission to substitute: a parent can include additional content. Read its current summary before selecting a new range.` : "";
  return new Error(`${message}.\nNo compression was performed by this failed call. Do not retry or guess obsolete IDs.${replacement}\nCURRENT VALID BOUNDARIES (transcript order, not numerical order):\nActive compressed blocks: ${orderedBlocks.map(formatBlockRef).join(", ") || "none"}.\nRaw messages: ${rawRefs.join(", ") || "none"}.\nChoose both endpoints from this current view. IDs in earlier tool arguments/results are historical, not a boundary catalogue. Re-evaluate after each successful prune; never infer missing b-numbers.`);
}
function parseBoundaryChecked(id, field) {
  const messageIndex = parseMessageRef(id);
  if (messageIndex !== null)
    return { kind: "message", ref: `m${String(messageIndex).padStart(4, "0")}` };
  const blockId = parseBlockRef(id);
  if (blockId !== null) return { kind: "block", blockId };
  throw new Error(`${field} "${id}" is not a valid mNNNN or bN ID`);
}
var BLOCK_PLACEHOLDER_REGEX = /\(\s*b(\d+)\s*\)/g;
function expandPlaceholders(summary, state) {
  return summary.replace(BLOCK_PLACEHOLDER_REGEX, (_match, digits) => {
    const blockId = Number.parseInt(digits, 10);
    const block = state.blocks[String(blockId)];
    if (!block) throw new Error(`summary references unknown compressed block b${blockId}`);
    return stripBlockWrapper(block);
  });
}
function stripBlockWrapper(block) {
  return block.summary.replace(/^\[Compressed conversation section\]\n/, "").replace(/<dcp-message-id>b\d+<\/dcp-message-id>\n?$/, "").trim();
}
function estimateCoveredTokens(index, coveredKeys) {
  const coveredSet = new Set(coveredKeys);
  let total = 0;
  for (let i = 0; i < index.messages.length; i++) {
    if (!coveredSet.has(index.keys[i])) continue;
    const message = index.messages[i];
    for (const part of message.content) {
      if (part.type === "text" || part.type === "reasoning") total += countTokens(part.text);
      else if (part.type === "tool-result")
        total += countTokens(index.tools.get(part.id)?.outputText ?? "");
      else if (part.type === "tool-call") total += countTokens(safeJson(part.input));
      else total += estimateTokens(measurePartChars(part));
    }
  }
  return total;
}
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

// lib/nudges.ts
function usageTotal(usage) {
  if (!usage) return 0;
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
}
var UsageTracker = class {
  baseline = /* @__PURE__ */ new Map();
  current = /* @__PURE__ */ new Map();
  /** Prune counter per session; bumped by `markPruned`. */
  epoch = /* @__PURE__ */ new Map();
  /** Epoch at which `current` was recorded (delta or measurement). */
  currentEpoch = /* @__PURE__ */ new Map();
  record(sessionId, tokens) {
    const base = this.baseline.get(sessionId);
    this.baseline.set(sessionId, { ...tokens });
    if (!base) {
      return;
    }
    const delta = usageTotal(tokens) - usageTotal(base);
    this.current.set(sessionId, Math.max(0, delta));
    this.currentEpoch.set(sessionId, this.epoch.get(sessionId) ?? 0);
  }
  /**
   * Seeds the occupancy estimate from a dispatch-time transcript measurement
   * while the tracker is blind (no baseline yet: fresh process, or a reset
   * after a revert/compaction/deletion). Overwrites on every blind dispatch
   * so the estimate tracks the transcript down (post-prune) as well as up.
   * No-op once the tracker is warm - provider-reported deltas are the better
   * estimate - and dropped by `reset` along with the baseline.
   */
  seed(sessionId, tokens) {
    if (tokens <= 0 || this.baseline.has(sessionId)) return;
    this.current.set(sessionId, tokens);
    this.currentEpoch.set(sessionId, this.epoch.get(sessionId) ?? 0);
  }
  /** Estimated current context size in tokens for the session. */
  totalFor(sessionId) {
    return this.current.get(sessionId) ?? 0;
  }
  /**
   * Marks a prune as having happened: any estimate on hand describes the
   * PRE-prune prompt. The estimate is zeroed outright (nothing may re-report
   * the number the model just acted on) and the baseline is dropped, so the
   * usage event that lands next - whose totals still include the pre-prune
   * step - only re-arms the delta instead of publishing it; the first honest
   * post-prune delta arrives one event after that. Until a real delta or a
   * fresh measurement records against the new epoch, `isStale` tells consumers
   * to trust the transcript measurement instead.
   */
  markPruned(sessionId) {
    this.epoch.set(sessionId, (this.epoch.get(sessionId) ?? 0) + 1);
    this.current.set(sessionId, 0);
    this.baseline.delete(sessionId);
  }
  /**
   * True while `current` predates the newest prune - i.e. `totalFor` would
   * report the pre-prune occupancy, which is exactly the stale number that
   * makes a model re-prune work it already pruned.
   */
  isStale(sessionId) {
    return (this.currentEpoch.get(sessionId) ?? 0) < (this.epoch.get(sessionId) ?? 0);
  }
  reset(sessionId) {
    this.baseline.delete(sessionId);
    this.current.delete(sessionId);
    this.epoch.delete(sessionId);
    this.currentEpoch.delete(sessionId);
  }
};
function pushAnchor(state, messageCount) {
  state.nudgeAnchors.push(messageCount);
  if (state.nudgeAnchors.length > NUDGE_ANCHOR_CAP) state.nudgeAnchors.shift();
}
function maybeContextNudge(input) {
  const { state, config, messageCount } = input;
  const budget = resolveLimit(config.maxContextLimit, input.modelContextLimit);
  if (budget <= 0 || input.usageTokens <= 0) return void 0;
  const lastAnchor = state.nudgeAnchors.at(-1) ?? Number.NEGATIVE_INFINITY;
  if (state.nudgeAnchors.length > 0 && messageCount - lastAnchor < config.nudgeFrequency) {
    return void 0;
  }
  if (input.usageTokens < budget) return void 0;
  pushAnchor(state, messageCount);
  return CONTEXT_LIMIT_NUDGE(input.usageTokens, budget, input.modelContextLimit);
}
function maybePruneAck(input) {
  const { state, config } = input;
  if (state.pruneSeq <= state.pruneAckSeq) return void 0;
  state.pruneAckSeq = state.pruneSeq;
  pushAnchor(state, input.messageCount);
  const budget = resolveLimit(config.maxContextLimit, input.modelContextLimit);
  if (budget <= 0) return void 0;
  return POST_PRUNE_ACK(
    input.usageTokens,
    budget,
    input.modelContextLimit,
    input.blockRef,
    input.usageTokens >= budget,
    input.messagesCovered
  );
}
function maybeIterationNudge(input) {
  const threshold = input.config.iterationNudgeThreshold;
  if (threshold <= 0) return void 0;
  if (input.messagesSinceUserTurn < threshold) return void 0;
  return ITERATION_NUDGE(input.messagesSinceUserTurn);
}
var pendingManualPrune = /* @__PURE__ */ new Map();
function armManualPruneReminder(sessionId, reminder, marker = PRUNE_REQUEST_PREFIX) {
  pendingManualPrune.set(sessionId, { reminder, marker });
}
function disarmManualPruneReminder(sessionId) {
  pendingManualPrune.delete(sessionId);
}
function carriesPruneRequest(messages, marker = PRUNE_REQUEST_PREFIX) {
  return messages.some(
    (message) => message.role === "user" && message.content.some(
      (part) => part.type === "text" && part.text.startsWith(marker)
    )
  );
}
function takeManualPruneReminder(sessionId, messages) {
  const entry = pendingManualPrune.get(sessionId);
  if (entry === void 0) return void 0;
  if (!carriesPruneRequest(messages, entry.marker)) return void 0;
  pendingManualPrune.delete(sessionId);
  return entry.reminder;
}

// lib/commands.ts
var DCP_PRUNE_DESCRIPTION = "Trigger DCP manual pruning with: /dcp-prune [focus]";
function storedPruneMessage(focus) {
  const safe = stripHallucinatedTags(focus).trim();
  return safe ? `${PRUNE_REQUEST_PREFIX} Focus: ${safe}` : PRUNE_REQUEST_PREFIX;
}
function registerCommands(editor, ctx) {
  editor.add({
    name: "dcp-prune",
    description: DCP_PRUNE_DESCRIPTION,
    execute: async (input) => {
      const focus = typeof input.prompt.text === "string" ? input.prompt.text.trim() : "";
      const stored = storedPruneMessage(focus);
      armManualPruneReminder(input.sessionID, MANUAL_PRUNE_REMINDER(JSON.stringify(focus)), stored);
      try {
        await ctx.session.prompt({
          ...input.prompt,
          sessionID: input.sessionID,
          text: stored,
          delivery: input.delivery
        });
      } catch (error) {
        disarmManualPruneReminder(input.sessionID);
        throw error;
      }
    }
  });
}

// lib/events.ts
function startEventPump(input) {
  const { store, mirror, usage, logger, signal } = input;
  return (async () => {
    let backoff = 1e3;
    while (!signal.aborted) {
      const connectedAt = Date.now();
      try {
        for await (const raw of input.subscribe()) {
          if (signal.aborted) return;
          const event = raw;
          if (!event || typeof event.type !== "string") continue;
          const data = event.data ?? {};
          const sessionId = typeof data.sessionID === "string" ? data.sessionID : void 0;
          switch (event.type) {
            case "session.usage.updated": {
              if (!sessionId) break;
              const tokens = data.tokens;
              if (!tokens) break;
              usage.record(sessionId, {
                input: numberOr(tokens.input),
                output: numberOr(tokens.output),
                reasoning: numberOr(tokens.reasoning),
                cacheRead: numberOr(tokens.cache?.read),
                cacheWrite: numberOr(tokens.cache?.write)
              });
              break;
            }
            case "session.revert.committed": {
              if (!sessionId) break;
              const index = mirror.get(sessionId);
              const boundary = index?.messages.findIndex((message) => message.id === data.to) ?? -1;
              mirror.drop(sessionId);
              usage.reset(sessionId);
              disarmManualPruneReminder(sessionId);
              if (index && boundary >= 0) {
                await store.reconcile(sessionId, index.keys.slice(0, boundary));
              }
              break;
            }
            case "session.compaction.started":
            case "session.compaction.ended":
            case "session.compaction.failed":
            case "session.forked":
            case "session.deleted": {
              if (!sessionId) break;
              store.reset(sessionId);
              mirror.drop(sessionId);
              usage.reset(sessionId);
              disarmManualPruneReminder(sessionId);
              logger.debug("session event; DCP state reset", {
                sessionId,
                reason: event.type
              });
              break;
            }
            default:
              break;
          }
        }
        if (signal.aborted) return;
        logger.warn("event stream ended; reconnecting", { reason: "stream closed" });
      } catch (error) {
        if (signal.aborted) return;
        logger.warn("event stream failed; reconnecting", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
      if (signal.aborted) return;
      if (Date.now() - connectedAt >= 3e4) backoff = 1e3;
      await delay(backoff, signal);
      backoff = Math.min(backoff * 2, 15e3);
    }
  })();
}
function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
function numberOr(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// lib/logger.ts
import fs from "fs";
import os2 from "os";
import path2 from "path";
function opencodeLogDir() {
  const data = process.env.XDG_DATA_HOME ?? path2.join(os2.homedir(), ".local/share");
  return path2.join(data, "opencode", "log");
}
function format(value) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return /^[^\s="\\]+$/.test(str) ? str : JSON.stringify(str);
}
function line(level, message, data) {
  const parts = [
    `timestamp=${(/* @__PURE__ */ new Date()).toISOString()}`,
    `level=${level}`,
    "component=dcp",
    `message=${format(message)}`
  ];
  if (data) for (const [key, value] of Object.entries(data)) parts.push(`${key}=${format(value)}`);
  return `${parts.join(" ")}
`;
}
function createLogger(debug) {
  const write = (level, message, data) => {
    const text = line(level, message, data);
    try {
      fs.mkdirSync(opencodeLogDir(), { recursive: true });
      fs.appendFileSync(path2.join(opencodeLogDir(), "opencode.log"), text);
    } catch {
      try {
        process.stderr.write(text);
      } catch {
      }
    }
  };
  return {
    warn: (message, data) => write("WARN", message, data),
    debug: (message, data) => {
      if (debug) write("DEBUG", message, data);
    }
  };
}

// lib/transcript/scan.ts
function scanTranscript(messages) {
  const keys = assignKeys(messages);
  const inputs = /* @__PURE__ */ new Map();
  const embeddedResults = /* @__PURE__ */ new Map();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && typeof part.id === "string" && !inputs.has(part.id)) {
        inputs.set(part.id, {
          name: qualifiedToolName(part.name, part.namespace),
          input: part.input,
          index,
          providerExecuted: part.providerExecuted === true
        });
        continue;
      }
      if (part.type === "tool-result" && typeof part.id === "string" && !embeddedResults.has(part.id)) {
        embeddedResults.set(part.id, part.result);
      }
    }
  }
  const tools = /* @__PURE__ */ new Map();
  const toolOrder = [];
  const users = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "user") {
      const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      users.push({ key: keys[index], index, text });
      continue;
    }
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const declared = inputs.get(part.id);
      if (!declared || tools.has(part.id)) continue;
      const providerExecuted = declared.providerExecuted || part.providerExecuted === true;
      tools.set(part.id, {
        callId: part.id,
        name: declared.name,
        input: declared.input,
        // A provider-executed result is replayed from provider state, not from
        // this text, so it stays unprunable even in a `role:"tool"` message.
        hasResult: !providerExecuted,
        isError: part.result.type === "error",
        outputText: toolResultToText(part.result),
        key: keys[index],
        index,
        turn: 0,
        providerExecuted
      });
      toolOrder.push(part.id);
    }
  }
  for (const [callId, declared] of inputs) {
    if (!tools.has(callId)) {
      const embedded = embeddedResults.get(callId);
      tools.set(callId, {
        callId,
        name: declared.name,
        input: declared.input,
        hasResult: false,
        isError: embedded?.type === "error",
        outputText: embedded === void 0 ? "" : toolResultToText(embedded),
        key: "",
        index: -1,
        turn: 0,
        providerExecuted: declared.providerExecuted || embedded !== void 0
      });
      toolOrder.push(callId);
    }
  }
  const turnCount = users.length;
  for (const info of tools.values()) {
    if (info.index < 0) {
      info.turn = turnCount + 1;
      continue;
    }
    info.turn = users.filter((user) => user.index <= info.index).length;
  }
  return { messages: [...messages], keys, tools, toolOrder, users, turnCount };
}
function assignKeys(messages) {
  const keys = new Array(messages.length);
  const seenIds = /* @__PURE__ */ new Map();
  const seenToolKeys = /* @__PURE__ */ new Map();
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    const id = message.id;
    if (typeof id === "string" && id.length > 0) {
      seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
    }
    const toolKey = toolResultKey(message);
    if (toolKey) {
      seenToolKeys.set(toolKey, (seenToolKeys.get(toolKey) ?? 0) + 1);
    }
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    const id = message.id;
    if (typeof id === "string" && id.length > 0 && seenIds.get(id) === 1) {
      keys[index] = `id:${id}`;
      continue;
    }
    const toolKey = toolResultKey(message);
    if (toolKey && seenToolKeys.get(toolKey) === 1) {
      keys[index] = toolKey;
      continue;
    }
    keys[index] = `${message.role}#${index}`;
  }
  return keys;
}
function toolResultKey(message) {
  if (!message || message.role !== "tool") return void 0;
  for (const part of message.content) {
    if (part.type !== "tool-result") {
      continue;
    }
    if (typeof part.id === "string" && part.id.length > 0) return `tool:${part.id}`;
    return void 0;
  }
  return void 0;
}

// lib/transform.ts
var INTERNAL_AGENTS = /* @__PURE__ */ new Set(["title", "compaction", "summary"]);
var SYSTEM_PROMPT_MARKER = "You operate in a context-constrained environment.";
function sessionTotals(state) {
  const active = state.activeBlockIds.map((id) => state.blocks[String(id)]).filter((block) => block !== void 0);
  return {
    dispatches: state.stats.dispatches,
    compressRuns: state.stats.compressRuns,
    blocksActive: active.length,
    blocksTotal: Object.keys(state.blocks).length,
    blockTokensCovered: active.reduce((sum, block) => sum + Math.max(0, block.compressedTokens), 0),
    blockTokensSummaries: active.reduce((sum, block) => sum + Math.max(0, block.summaryTokens), 0),
    prunedTokensTotal: Math.max(0, state.stats.totalPrunedTokens),
    messagesCompressedActive: new Set(active.flatMap((block) => block.coveredKeys)).size
  };
}
function createGenerateHook(deps) {
  return async function handleGenerate(event) {
    try {
      if (INTERNAL_AGENTS.has(event.agent)) return;
      if (!Array.isArray(event.messages) || event.messages.length === 0) return;
      if (!deps.config.allowSubAgents && await deps.isSubAgent(event.sessionID)) return;
      const state = await deps.store.snapshot(event.sessionID);
      if (!state) return;
      const messages = [...event.messages];
      const index = scanTranscript(messages);
      normalizeLegacyBlockKeys(state, index.keys, messages);
      const present = new Set(index.keys);
      const retained = new Set();
      const seen = new Set();
      const visit = (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        const block = state.blocks[String(id)];
        if (!block) return;
        if (block.coveredKeys.length > 0 && block.coveredKeys.every((key) => present.has(key))) {
          retained.add(id);
        } else {
          for (const child of block.consumedBlockIds) visit(child);
        }
      };
      for (const id of state.activeBlockIds) visit(id);
      state.activeBlockIds = [...retained];
      for (const block of Object.values(state.blocks)) block.active = retained.has(block.blockId);
      applyCompressionBlocks(state, messages, index.keys);
      pruneToolOutputs(state, messages, deps.config);
      event.messages.splice(0, event.messages.length, ...messages);
    } catch (error) {
      deps.logger.warn("generate transform failed; passing unmodified context", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}
function createContextHook(deps) {
  return async function handleContext(event) {
    try {
      if (INTERNAL_AGENTS.has(event.agent)) return;
      const messages = event.messages;
      if (!Array.isArray(messages) || messages.length === 0) return;
      const sessionId = event.sessionID;
      if (!deps.config.allowSubAgents && await deps.isSubAgent(sessionId)) {
        deps.logger.debug("skipping sub-agent session", { sessionId });
        return;
      }
      const runtime = await deps.store.ensure(sessionId);
      const index = scanTranscript(messages);
      deps.mirror.update(sessionId, index);
      normalizeLegacyBlockKeys(runtime.state, index.keys, index.messages);
      await deps.store.reconcile(sessionId, index.keys);
      const charsBefore = measureMessagesChars(messages);
      injectSystemPrompt(event);
      const coveredKeys = new Set(
        activeBlocks(runtime.state).flatMap((block) => block.coveredKeys)
      );
      const unaliased = projectRefs(runtime.refs, index.keys, coveredKeys);
      if (unaliased > 0) {
        deps.logger.warn("transcript exceeds message ref capacity; tail is unaddressable", {
          sessionId,
          unaliased
        });
      }
      applyCompressionBlocks(runtime.state, messages, index.keys);
      pruneToolOutputs(runtime.state, messages, deps.config);
      const postIndex = scanTranscript(messages);
      injectBoundaryTags(runtime.refs.byKey, messages, postIndex.keys);
      const modelContextLimit = await deps.catalogContextLimit(
        event.model.providerID,
        event.model.id
      );
      await injectNudges(deps, event, postIndex.keys.length, runtime.state, modelContextLimit);
      publishDispatchStats(deps, {
        sessionId,
        model: `${event.model.providerID}/${event.model.id}`,
        agent: event.agent,
        messagesIn: messages.length,
        charsBefore,
        charsAfter: measureMessagesChars(messages),
        contextLimit: modelContextLimit
      });
    } catch (error) {
      deps.logger.warn("context transform failed; passing unmodified context", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}
function injectSystemPrompt(event) {
  const alreadyPresent = event.system.some(
    (part) => part.type === "text" && part.text.includes(SYSTEM_PROMPT_MARKER)
  );
  if (alreadyPresent) return;
  event.system.push({ type: "text", text: SYSTEM.trimStart() });
}
function projectRefs(refs, keys, coveredKeys) {
  return refs.project(keys.filter((key) => !coveredKeys.has(key)));
}
function publishDispatchStats(deps, input) {
  if (!deps.publishStats) return;
  const runtime = deps.store.peek(input.sessionId);
  if (!runtime) return;
  runtime.state.stats.dispatches += 1;
  try {
    deps.publishStats({
      sessionId: input.sessionId,
      model: input.model,
      dispatch: {
        at: Date.now(),
        agent: input.agent,
        model: input.model,
        messagesIn: input.messagesIn,
        tokensBefore: estimateTokens(input.charsBefore),
        tokensAfter: estimateTokens(input.charsAfter),
        contextLimit: input.contextLimit
      },
      totals: sessionTotals(runtime.state)
    });
  } catch {
  }
}
async function injectNudges(deps, event, messageCount, state, modelContextLimit) {
  const reminders = [];
  const canPrune = !event.tools || Object.hasOwn(event.tools, PRUNE_TOOL_NAME);
  const manualPrune = takeManualPruneReminder(event.sessionID, event.messages);
  if (manualPrune && canPrune) reminders.push(manualPrune);
  const measuredTokens = estimateTokens(measureMessagesChars(event.messages));
  deps.usage.seed(event.sessionID, measuredTokens);
  const ackPending = state.pruneSeq > state.pruneAckSeq;
  const lastCompression = state.stats.recentCompressions.at(-1);
  const usageTokens = ackPending ? Math.max(measuredTokens, lastCompression?.usageAfter ?? 0) : Math.max(deps.usage.totalFor(event.sessionID), measuredTokens);
  const window = modelContextLimit ?? FALLBACK_CONTEXT_WINDOW;
  const ack = maybePruneAck({
    state,
    config: deps.config,
    usageTokens,
    modelContextLimit: window,
    messageCount,
    blockRef: lastCompression ? formatBlockRef(lastCompression.blockId) : void 0,
    messagesCovered: lastCompression?.messagesCovered
  });
  if (ack) {
    reminders.push(ack);
  } else {
    if (canPrune && usageTokens > 0) {
      const nudge = maybeContextNudge({
        state,
        config: deps.config,
        usageTokens,
        modelContextLimit: window,
        messageCount
      });
      if (nudge) reminders.push(nudge);
    }
  }
  const iterationNudge = maybeIterationNudge({
    config: deps.config,
    messagesSinceUserTurn: countMessagesSinceLastUserTurn(event.messages)
  });
  if (iterationNudge) reminders.push(iterationNudge);
  if (reminders.length > 0 && event.messages.length > 0) {
    if (canPrune && state.activeBlockIds.length) {
      const active = new Set(state.activeBlockIds.map(formatBlockRef));
      const ordered = [];
      for (const message of event.messages) {
        if (message.role !== "user") continue;
        for (const part of message.content) {
          if (part.type !== "text") continue;
          for (const match of part.text.matchAll(/<dcp-message-id>(b\d+)<\/dcp-message-id>/g)) {
            if (active.has(match[1]) && !ordered.includes(match[1])) ordered.push(match[1]);
          }
        }
      }
      if (ordered.length) reminders.push(`CURRENT ACTIVE COMPRESSED BLOCKS (earliest to latest):\n${ordered.map((id, i) => `${i + 1}. ${id}`).join("\n")}\nOnly these b-IDs are valid now. The list numbers are chronological positions, not IDs: send bare b-IDs. Use start position <= end position; for one block use the same ID twice. Do not sort b-IDs numerically or infer missing b-numbers. Earlier tool calls/results contain historical IDs. For raw messages copy current mNNNN tags. This catalogue is not an instruction to prune again.`);
    }
    event.messages.push(createSyntheticBlockMessage(reminders.join("\n\n")));
  }
}
function countMessagesSinceLastUserTurn(messages) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "user") break;
    count++;
  }
  return count;
}

// lib/transcript/mirror.ts
var TranscriptMirror = class {
  latest = /* @__PURE__ */ new Map();
  update(sessionId, index) {
    this.latest.set(sessionId, index);
  }
  get(sessionId) {
    return this.latest.get(sessionId);
  }
  drop(sessionId) {
    this.latest.delete(sessionId);
  }
};

// index.ts
var PLUGIN_ID = "opencode.dcp";
var index_default = Plugin.define({
  id: PLUGIN_ID,
  // Ships a TUI companion module ("./tui" export). The runtime detects it
  // itself (package `./tui` export or sibling tui.* file) — it is not part of
  // the `Plugin` type, and passing `tui: true` here is a type error.
  setup: async (ctx) => {
    const configWarning = createLogger(false);
    const config = resolveOptions(
      ctx.options,
      (message) => configWarning.warn(`config warning: ${message}`)
    );
    const logger = createLogger(config.debug);
    if (!config.enabled) {
      logger.debug("disabled by configuration");
      return;
    }
    const store = new StateStore(ctx.storage);
    const mirror = new TranscriptMirror();
    const usage = new UsageTracker();
    const contextLimits = /* @__PURE__ */ new Map();
    let catalogRetryAt = 0;
    const CATALOG_RETRY_MS = 6e4;
    let catalogInflight;
    const catalogContextLimit = async (providerID, modelId) => {
      const key = `${providerID}/${modelId}`;
      if (contextLimits.has(key)) return contextLimits.get(key);
      if (Date.now() < catalogRetryAt) return void 0;
      if (catalogInflight) {
        await catalogInflight.catch(() => {
        });
        return contextLimits.get(key);
      }
      const flight = (async () => {
        try {
          const modelApi = ctx.model;
          if (!modelApi) throw new Error("plugin context exposes no model domain");
          const response = await modelApi.list();
          const models = unwrapList(response);
          if (!models) throw new Error("model catalog response had no data array");
          for (const model of models) {
            if (typeof model?.providerID === "string" && typeof model?.id === "string") {
              contextLimits.set(
                `${model.providerID}/${model.id}`,
                effectiveContextLimit(model.limit)
              );
            }
          }
          catalogRetryAt = Date.now() + CATALOG_RETRY_MS;
        } catch (error) {
          logger.warn("failed to list model catalog for context limits; retrying later", {
            error: error instanceof Error ? error.message : String(error)
          });
          catalogRetryAt = Date.now() + CATALOG_RETRY_MS;
        }
      })();
      catalogInflight = flight;
      try {
        await flight;
      } finally {
        if (catalogInflight === flight) catalogInflight = void 0;
      }
      return contextLimits.get(key);
    };
    const lastModel = /* @__PURE__ */ new Map();
    let statsSnapshot;
    const publishStats = config.tui.enabled ? (input) => {
      const runtime = store.peek(input.sessionId);
      const next = buildStatsSnapshot(statsSnapshot, {
        ...input,
        recentCompressions: runtime?.state.stats.recentCompressions
      });
      statsSnapshot = next;
      writeTuiStats(next);
    } : void 0;
    const recordCompression = publishStats ? (input) => {
      const runtime = store.peek(input.sessionId);
      if (!runtime) return;
      publishStats({
        sessionId: input.sessionId,
        compression: input.record,
        totals: sessionTotals(runtime.state)
      });
    } : void 0;
    const subAgentCache = /* @__PURE__ */ new Map();
    const isSubAgent = async (sessionId) => {
      const cached = subAgentCache.get(sessionId);
      if (cached !== void 0) return cached;
      let result = false;
      try {
        const response = await ctx.session.get({ sessionID: sessionId });
        const parentID = unwrapData(response)?.parentID;
        result = typeof parentID === "string" && parentID.length > 0;
      } catch {
        result = false;
      }
      subAgentCache.set(sessionId, result);
      return result;
    };
    const handleContext = createContextHook({
      config,
      logger,
      store,
      mirror,
      usage,
      isSubAgent,
      catalogContextLimit,
      publishStats: (input) => {
        if (!publishStats) return;
        publishStats({
          sessionId: input.sessionId,
          model: input.model,
          dispatch: input.dispatch,
          totals: input.totals
        });
      }
    });
    await ctx.session.hook("context", async (event) => {
      const typed = event;
      if (typed.model)
        lastModel.set(typed.sessionID, { providerID: typed.model.providerID, id: typed.model.id });
      await handleContext(typed);
    });
    await ctx.session.hook("generate", createGenerateHook({ config, logger, store, isSubAgent }));
    let registrationWarned = false;
    const warnRegistration = (message) => {
      if (registrationWarned) return;
      registrationWarned = true;
      logger.warn(`prune tool NOT registered: ${message}`);
    };
    await ctx.tool.hook("execute.after", (event) => {
      if (event.tool !== PRUNE_TOOL_NAME) return;
      try {
        if (event.status === "error") {
          logger.warn("prune tool call failed", {
            messageID: event.messageID,
            sessionID: event.sessionID,
            agent: event.agent,
            id: event.id,
            // `Tool.Error` is an Effect TaggedError extending Error, so
            // String() renders `Tool.Error: <message>`; the runner wraps any
            // foreign throw into exactly that shape before the hook fires
            // (packages/core/src/tool/runtime.ts:37-45).
            error: String(event.error)
          });
        } else {
          logger.debug("prune tool call completed", {
            messageID: event.messageID,
            sessionID: event.sessionID,
            id: event.id
          });
        }
      } catch {
      }
    });
    await ctx.tool.transform((tools) => {
      const registration = addPruneTool(
        tools,
        pruneToolDefinition({
          store,
          mirror,
          logger,
          config,
          getModelContextLimit: (sessionId) => {
            const model = lastModel.get(sessionId);
            if (!model) return void 0;
            const key = `${model.providerID}/${model.id}`;
            const cached = contextLimits.get(key);
            if (cached !== void 0) return cached;
            if (Date.now() < catalogRetryAt) return void 0;
            void catalogContextLimit(model.providerID, model.id).catch(() => {
            });
            return void 0;
          },
          getUsageTokens: (sessionId) => usage.totalFor(sessionId),
          markPruned: (sessionId) => usage.markPruned(sessionId),
          recordCompression
        })
      );
      if (!registration.ok) warnRegistration(registration.reason);
    });
    if (typeof ctx.tool.list === "function") {
      void ctx.tool.list().then((registered) => {
        if (!pruneToolRegistered(registered)) {
          warnRegistration(
            "`prune` is missing from the committed tool registry; a tool transform registered during plugin setup may have removed or overridden it - a transform registered after this plugin's setup is not visible to this check"
          );
        }
      }).catch((error) => {
        logger.debug("tool registry check unavailable", {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    await ctx.command.transform((draft) => {
      registerCommands(draft, ctx);
    });
    const controller = new AbortController();
    void startEventPump({
      subscribe: () => ctx.event.subscribe({ signal: controller.signal }),
      store,
      mirror,
      usage,
      logger,
      signal: controller.signal
    });
    const isSessionNotFoundError = (error) => {
      if (!error || typeof error !== "object") return false;
      const e = error;
      if (e._tag === "SessionNotFoundError" || e.name === "SessionNotFoundError") return true;
      if (e.message === "Session not found") return true;
      const cause = e.cause;
      return e.name === "ClientError" && e.reason === "UnexpectedStatus" && cause?.status === 404;
    };
    void (async () => {
      try {
        const prefix = "session/";
        let after;
        for (; ; ) {
          const page = await ctx.storage.scan(
            after === void 0 ? { prefix } : { prefix, after }
          );
          for (const entry of page.entries) {
            const sessionId = entry.key.slice(prefix.length);
            if (!sessionId) continue;
            try {
              await ctx.session.get({ sessionID: sessionId });
            } catch (error) {
              if (!isSessionNotFoundError(error)) continue;
              await ctx.storage.remove(entry.key);
              logger.debug("storage GC; removed orphaned session state", {
                key: entry.key
              });
            }
          }
          if (!page.next) break;
          after = page.next;
        }
      } catch (error) {
        logger.warn("startup reconcile failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    })();
    logger.debug("initialized", {
      maxContextLimit: config.maxContextLimit,
      strategies: {
        deduplication: config.strategies.deduplication.enabled,
        purgeErrors: config.strategies.purgeErrors.enabled
      },
      allowSubAgents: config.allowSubAgents
    });
    return () => {
      controller.abort();
    };
  }
});
function unwrapData(response) {
  if (typeof response === "object" && response !== null && "data" in response) {
    return response.data;
  }
  return response;
}
function unwrapList(response) {
  const data = unwrapData(response);
  return Array.isArray(data) ? data : Array.isArray(response) ? response : void 0;
}
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
