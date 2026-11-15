# DCP plugin maintenance

- Standalone source for the isolated OpenCode V2 local DCP plugin. Do not edit
  OpenCode V1 or `opencode-fork` to maintain this copy.
- Keep plugin ID `opencode.dcp`, storage schema, existing summaries, ref mapping,
  fixed cache-prefix behavior, input-aware limits, and advisory-only pruning.
- Never automatically substitute an inactive boundary with its parent: that
  could silently discard additional context. Failed validation must not mutate
  state. Recovery hints are navigation, not authorization.
- Active-ID catalogues belong in existing outbound tail reminders, not a
  per-session dynamic tool definition or system prefix. Preserve prefix caching.
- Auxiliary `generate` requests reuse saved edits through detached snapshots.
  Never run the primary context pipeline there: no ref projection, mirror or
  usage updates, acknowledgement, reminders, new pruning or storage writes.
  Apply only whole covered ranges, respecting internal-agent/subagent exclusions.
  Keep native compaction as an overflow fallback; test the built-in goal path
  on a private official-runtime fixture, not on a working user session.
- Run `bun test`, including official-runtime fixtures, before installation.
  Live-model checks must use isolated fixtures or read-only reconstruction;
  never inject prompts, prune, compact, or rewrite the user's working session.
- Keep private transcripts, payloads, and credentials under ignored `.tmp/`.
  Do not describe synthetic checks as reproduction of a long user session.
- `dcp/vendor/index.js` is the locally maintained bundle. The upstream source
  map is provenance, not authoritative source for local edits.
- Installation updates only the installed DCP files after matching its known
  fingerprint. Preserve registration, options, credentials, defaults and other
  plugins. Use a reviewed reload, not a server restart.
- The owner explicitly requires uninterrupted running sessions. Installation
  does not authorize a reload or restart; do not interrupt active sessions.
  Keep reload/concurrency experiments confined to private test servers.
