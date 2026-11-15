# Local OpenCode V2 DCP plugin

Standalone maintenance copy of the installed `opencode.dcp` plugin, derived from
`arafays/opencode-dcp` 2.0.4 with the existing local cache-prefix and input-budget
fixes. No runtime imports from `opencode-fork`.

## Boundary recovery

DeepSeek in a long running session repeatedly selected inactive `bN` boundaries
from historical tool calls. A real-runtime fixture confirms that DCP does refresh
boundary tags between consecutive prunes; there is no reproduced stale-hook bug.

This patch makes current boundaries easier to select:

- Existing DCP tail reminders include active compressed IDs in transcript order.
- Invalid-boundary errors include the current valid view and covering-parent
  navigation when known. A parent is **not** an equivalent replacement range.
- Validation still rejects stale/unknown IDs. No range is automatically changed,
  no session is rewritten, and a rejected call performs no compression.

These are recovery improvements, not a guarantee that a model always chooses
correctly. A short real DeepSeek fixture succeeded before and after the patch;
it does not reproduce the user's long-context failure. Private long-context
replays and their limitations are recorded under ignored `.tmp/`.

## Auxiliary generation — installed 2026-11-15

OpenCode 2.2.5's native goal reviewer uses `session.generate`, not the primary
`context` hook. Without a separate hook it sends raw history even after a
successful DCP prune. A reviewer overflow can automatically admit a native
compaction marked `reason: "manual"`; that label does not imply a user click.

Version `2.0.5-fork.3` registers a read-only `generate` transform:

- Reuse saved summaries and tool-output removals on a detached snapshot.
- Do not initialize a primary runtime, update refs or the transcript mirror,
  seed usage, acknowledge pruning, add reminders, or write storage.
- Apply only blocks whose entire covered range is present. If a parent is
  incomplete, reuse complete child blocks on the snapshot, never the saved graph.
- Skip internal agents and respect `allowSubAgents`. Leave system instructions,
  tools, options and the goal review prompt unchanged.
- Leave native compaction available if the compressed request still overflows.

An isolated official 2.2.5 server, the built-in `/goal` command and a loopback
provider reproduce the failure without touching a working session. Before this
hook, a completed prune was followed by two reviewer overflows and an automatic
manual-labelled compaction request. With the hook, the reviewer receives the
saved summary, completes the goal, and admits no compaction. A separate forced
overflow case verifies that Core still admits its native fallback. It does not
test checkpoint quality or guarantee that every real model request will fit.

Installed `2.0.5-fork.3` after the owner authorized activation if safe. A fresh
five-group `snapshot-create` succeeded; the fingerprint-checked installer replaced
only the bundle, maintenance README and package version. The reviewed location
hot reload succeeded without a server restart. Eight preexisting long-lived
OpenCode processes retained their PIDs and start times, and five protected
configuration files remained byte-identical. Read-only inspection found two new
neighbouring-session messages and no new error finishes after activation; no
prompts, pruning, compaction or history/state edits were injected there.

Before deployment, private runtime fixtures verified real plugin replacement
while the old prune executor was awaiting persistence, and while the native goal
reviewer was awaiting its model response. The saved blocks survived and the goal
completed without compaction. These checks cover the tested concurrency paths,
not a promise that every future reload or model request is safe. Private
deployment evidence is under `~/.tmp/litellm-combos/generate-deploy-*.json`.

## Previous verified deployment — 2026-11-15

Installed `2.0.5-fork.2` on artem-laptop, preserving the existing registration
and options. A successful five-group `snapshot-create` preceded installation.
Only the DCP bundle, its package version and maintenance README were replaced.
Hot reload did not restart the original nine OpenCode processes; five protected
configuration files were unchanged. Read-only inspection found continued work
and one completed prune in the neighbouring session after installation. No
prompts, pruning, state edits or history edits were injected into that session.

Real DeepSeek V4.1 Flash Free, `max`, over the existing native LiteLLM route:

| Long-context replay variant | Accepted calls |
| --- | ---: |
| Original plugin | 6/10 |
| Initial active-ID catalogue | 9/10 |
| Final ranked chronological catalogue | 10/10 |

The reconstructed prompt was about 108,000 tokens with all active covered keys
present. Every proposal was checked by the actual `runPrune` on its own memory
copy, with no persistent storage. The first catalogue still allowed one reversed
range; the final version states chronological positions explicitly and improves
order-error recovery. Existing tool descriptions and cached prefixes remain
unchanged; live cache hits reached 108,672 of 108,673 input tokens.

This replay is not byte-identical to the original request: it reconstructs the
historical block graph, exposes only prune, and adds a housekeeping directive.
It establishes a reproduced failure and an improved sample, not a guarantee
against future model mistakes or an audit of summary quality. The short fixture
was 4/4 both before and after, so it was not used as evidence of improvement.
Private forensic files remain in `~/.tmp/litellm-combos/`, where the initial
home-directory investigation ran. Repository runtime fixtures use `.tmp/`.

The upstream `vendor/index.js.map` predates local bundle edits. Consult the
maintained JavaScript and tests for local behavior.

## Verification

```sh
bun install --frozen-lockfile
bun test
```

The suite preserves prior fixed-prefix/cache, input-aware-budget and official
2.2.5 runtime tests, and adds boundary recovery, auxiliary generation and
no-mutation checks. All
runtime fixtures use a private server and loopback mock, not production sessions.
The suite passed 34 tests with 162 assertions across eight files.
The sequence fixture also reloads its private location while a mock model request
is held, and verifies that the request finishes without cancelling the turn or
restarting the private server. Installer tests verify read-only planning,
idempotence, recognized-version upgrades and rejection of unrecognized target
edits. Auxiliary tests check cold storage reads, snapshot isolation, partial
range safety, exclusions, output removals and atomic failure handling.

Review `bun install.ts` before `bun install.ts --apply`. This updates only the
known local DCP files; it does not modify configuration, reload OpenCode, or
start/stop services. Do not reload or interrupt active sessions as part of a
future maintenance task without reviewing that operation separately.

See `dcp/README.md` for the inherited patch history and upstream provenance.
