# Local DCP: stable prefixes, boundary recovery and auxiliary context

## Current standalone maintenance

Source now lives in `opencode-dcp-plugin`, independently of the old
`opencode-fork/v2-plugins` workspace. From the standalone repository use
`bun test`, then `bun install.ts` to review and `bun install.ts --apply` to
install. The older commands and test counts below are historical evidence.

Boundary validation remains strict. Inactive/unknown IDs are rejected without
compression, with an ordered list of current boundaries and covering-parent
navigation where known. A parent may contain more context: the plugin never
substitutes it automatically. Existing outbound tail reminders list active
compressed IDs; historical tool calls are not a current boundary catalogue.

No changes to plugin ID, saved state, compression semantics, registration,
per-model limits, system-prefix caching, tool descriptions or TUI behavior.

Version `2.0.5-fork.3` also registers a separate `generate` hook. Transient
session generation, including the native goal reviewer, reuses saved summaries
and tool-output removals on a detached state snapshot. It does not create refs,
update the primary transcript mirror, acknowledge pruning, add reminders or
persist state. Only whole summaries matching the outgoing history are applied;
an incomplete parent can fall back to whole child summaries without changing
the saved block graph. Internal agents and excluded subagents are skipped.
Native compaction remains available if this smaller request still overflows.
See the standalone README for isolated runtime tests and installation status.

Local fix for `opencode-dcp@2.0.4`. The server bundle, TUI and license come
from [arafays/opencode-dcp](https://github.com/arafays/opencode-dcp).
Only `vendor/index.js` differs from the published implementation.

## Defect

When a prune range reaches the current transcript tail, upstream stores
`anchorKey: "tail"`. Every later dispatch moves that summary behind new turns.
Missing successor anchors have the same fallback. This rewrites the prefix
instead of extending it. Implicit cache writes that include the moving summary
cannot be reused, even though most of the text is unchanged.

On 2026-11-06, offline replay of the PyTorch session's first real prune produced
a tail-anchored block exactly when its cached input froze at 17,664 tokens.
Replay of the camera session also found an active tail block throughout the
affected night. The tablet control used a fixed successor and recovered cache.
Private transcripts and diagnostics remain outside this repository.

## Fix

For a tail or missing successor, recover the insertion position immediately
after the last covered raw message. Compression does not delete raw history,
so this boundary survives new turns and reloads. Both rendering and prune-range
resolution use it. Valid successor anchors retain their existing behavior.
Blocks with no remaining covered keys retain the end-of-context fallback.

No plugin ID, storage schema, saved summary, tool definition, or TUI change.
Existing blocks are repaired on dispatch without rewriting saved state. Expect
one cold request when the corrected ordering first replaces the broken prefix.

The original nightly problem was amplified by a large context and many
autonomous continuations; disabling automatic compaction was not the cause
of cache failure. The prefix fix does not change compaction or execution limits.

## Input-aware pruning budget

DCP now uses the smaller positive finite value of `limit.context` and
`limit.input` from the model catalog. A missing, zero, negative, or non-finite
limit is ignored; when neither limit is available, the existing 200,000-token
fallback remains. This effective ceiling drives reminders, prune feedback,
and TUI statistics. It does not change the model catalog or provider limits.

The default `maxContextLimit` is now `"60%"`. The installed V2 registration also
sets this explicitly in plugin `options`; the installer preserves those options.
For a model with a 200,000-token input ceiling, reminders start at an estimated
120,000 tokens even if its total context window is larger. The old V1
`~/.config/opencode/dcp.jsonc` is not read by this plugin.

This remains an advisory threshold, not forced compression. DCP does not
enable OpenCode automatic compaction or block normal generation at 70%.
Its transcript token estimate is approximate and is not full-request accounting.

## Verify and install

From `v2-plugins/`:

```sh
bun test test/dcp-cache.test.ts
bun test test/dcp-limits.test.ts
bun test test/dcp-runtime.test.ts
bun install-dcp.ts
bun install-dcp.ts --apply
```

The dedicated installer copies this directory to the isolated V2 local-plugin
directory and replaces only `opencode-dcp@2.0.4` in its plugin list. It preserves
registration options. Existing shared dependencies supply `@opencode/plugin`
2.2.5. The npm cache and V1 installation are not modified.

Rollback: replace that local-plugin path with `opencode-dcp@2.0.4` in the V2
configuration. This restores the defective behavior, so use it only to diagnose
an unrelated regression. Config reloads automatically; no service restart.

## Evidence, 2026-11-06

- Input-limit regressions: 17 tests / 99 assertions pass across the plugin suite.
  The official-runtime fixture uses a 400,000-token context and a 200,000-token
  input ceiling. Its reminder assertion fails with the previous installed plugin
  and passes with the input-aware build. TypeScript checking passes with the
  documented `nix-shell` fallback (installed Bun lacks `bun check`).

- Seven direct regression tests pass (29 assertions). Six failed before the fix.
- The official 2.2.5 runtime test passes (9 assertions) and fails with the
  unpatched npm package: the summary moves from message position 3 to 5.
- All local plugin tests pass: 15 tests, 75 assertions. TypeScript checking passes.
- On real `openai/gpt-6.1-sol#medium`, the final turn after a tail prune used
  10,596 uncached / 0 cached input tokens before the fix; after the fix it used
  224 uncached / 10,368 cached tokens (97.9% cache). These are small diagnostic
  sessions, not a replay of the full overnight workload or a quota calculation.
