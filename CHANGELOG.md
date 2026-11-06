# Changelog

## Unreleased

### Fixes

- The settings panel and Limits list the features in order, ① to ⑨ (⑨ sat between ⑥ and ⑦).
- The measurement verdict: when the saving cannot be felt, the hint about SillyTavern's two settings is always shown, as 0.4.0 said. On a fast machine the saving's share of a tiny render could pass 10% from noise alone and hide it.
- Lint fix buttons ("Add g", "Unescape") stay on one line inside their row; SillyTavern's `.menu_button` (`width: min-content`, a 5px vertical margin) wrapped them.

### Wording

- Korean: the descriptions added in 0.4.0 (features, Limits hints, the verdict lines) use the panel's note style again instead of full sentences.
- READMEs: the screenshots come first again; the "when it makes a difference" part is a short list; ①, ③ and ⑥'s sub-options have rows of their own in the feature table; the Use section is split into Summary / Measuring / Table / Badges / Lint / Reports / Limits; the long paragraphs under How it works and Development are bullets.

### Tests

- The lint scenario measures each fix button's box against its row (81 cases).
- `measureVerdict` is exported; a case feeds it hand-made results.

## 0.4.0 — 2026-11-07

Why this release: in a small setup (few scripts, short messages) the regex stage is a few percent of a render, so shaving it cannot be felt. This release measures the whole render, says so when that is the case, and skips what lies beyond regex when it can.

### Measurements

- The whole display pipeline is timed per render: this extension's cache lookups / the regex scripts / markdown (SillyTavern's fix-ups, quotes, showdown) / DOMPurify.
  - From hooks at the stage boundaries and a wrapper around `DOMPurify.sanitize()` that recognizes the `MESSAGE_SANITIZE` config.
  - The summary and the text/JSON reports give the shares; a stacked bar under the summary draws them (`#rpk_pipe`, segments with `data-k="pipe-*"`).
- What a user feels, in the summary, the reports and the JSON (`felt`):
  - frames late (over two frame budgets) and freezes (over 100 ms) while a reply streams, from a frame sampler that runs only during a generation;
  - long tasks (over 50 ms, over 100 ms, total blocked, while streaming) from `PerformanceObserver` where the browser offers it;
  - how long opening the chat rendered.
- "Measure on this chat" gives a verdict: the stage shares with the features off; how many messages took more than a frame on their own, before and after; when the whole chat saves less than one frame, that nothing can be felt, with the two SillyTavern settings that help more. The JSON `measured` gains `over16` and `stages`.
- ① adaptive (sub-option, on): once regex is under 2% of the renders (checked every 64 full renders), 1 run in 64 is timed and the summary says the regex stage is not the cost here.

### Speed

- ⑨ HTML cache (on): an unchanged message rendered again is served the HTML made last time. Regex scripts and markdown are skipped, DOMPurify still runs.
  - Keyed by a 64-bit hash of the text, the display scripts' version, the name/persona/group values, the depth rules and the markdown-related settings.
  - A message a volatile script matched (`{{random}}`, `{{getvar}}`, a non-static macro in the find pattern) is not stored.
  - Memory only, LRU by count and size (Limits); with ⑤ on the HTML is stored in the chat too (`extra.regex_perf_cache.h`).
  - A wrapper around `showdown.Converter.prototype.makeHtml` passes the hit's placeholder through, since showdown's cost is mostly per call.
- ⑤ stores the finished HTML when ⑨ is on (older `v`/`same` entries are still served when ⑨ is off). It no longer stores a message a volatile script matched, so `{{random}}` display scripts re-roll as in plain SillyTavern.
- ④ incremental (sub-option of the compromise mode, on): a script whose matches cannot cross a line break runs on the lines added since its last run and reuses the rest. Line-local means no `\n`, `\s`, `[^…]`, dotAll, no `^$` without `m`, `g` required, no group reference the pattern cannot fill, no empty match (`isLineLocal`). The first three incremental runs are checked against a full run.
- ⑥ for static macros (sub-option, on): replacements and trim strings whose only macros are `{{user}}` `{{char}}` `{{persona}}` `{{group}}` get a template per name set in display renders, verified against the callback like any fast path. A `$` in a value stays text.
- The static-macro values (③'s keys, ⑥'s templates, ⑨'s key) are kept per fingerprint, so alternating authors do not resolve them again on every message.

### Not done, and why

- A single multi-pattern scan for ②'s literals (Aho-Corasick or one alternation) was benchmarked and dropped: on an 8 KB message with 50 literals, `includes` × 50 took 65 µs, one alternation 59 µs, Aho-Corasick 137 µs, and the answers are already cached per input.
- Pre-filtering the script list per message kind is SillyTavern's loop (`getRegexedString`), not reachable from the provider.
- Skipping DOMPurify on a ⑨ hit was designed and rejected: its output depends on state (external media allowances) as well as settings, so a stale result could change what it means for safety.

### Also

- The settings panel lists the features in order, ① to ⑧ (⑥ sat between ③ and ④).
- Narrow panels (phones) no longer hide the Avg, Replacer, Max, Matched and Changed columns: the table scrolls sideways and the Script column sticks to the left.
- ③'s name-macro option says that it needs the MessageFormatter hooks (its key is only resolved in a display render), and its checkbox is disabled with ⑤'s where they are missing.
- Wording:
  - the ∅ mark and the "never matched" line say 20 runs or more (the code counts `>=`);
  - the ⑧ count limit no longer reads as runs that are tolerated;
  - the Skips tooltip mentions the minimum-length skip;
  - the sampling default says "devices reporting 4 GB or less";
  - the browser-support lint names the version per feature (lookbehind 16.4, v flag and duplicate group names 17, d flag 15, on Safari and iOS);
  - the READMEs say "the browser's" template replace instead of V8's;
  - Korean particles after script names are 이(가) and are attached.
- `npm run screenshots` works on Windows (the output path is built with `fileURLToPath`).

### Tests and tooling

- The harness runs SillyTavern's whole `messageFormatting()`. The converter (identity, or showdown-like per-call cost with `setConverter('para')`) and DOMPurify are counted stand-ins. The server sends cross-origin isolation headers for 5 µs timers and exposes `SillyTavern.libs`, `powerUserSettings` and `window.__h` for ad-hoc debugging.
- New cases: ⑨ (hits, volatile misses, setting misses, reasoning, ⑤ `h` entries serving a fresh page, limits), the `isLineLocal` table, incremental streaming equivalence and run counts, the static fast path (names with `$`, `{{char}}` trim strings), adaptive mode, felt figures. 80 cases.
- The bench warms the JIT for four passes and uses the showdown-like converter. The gate allows 5% over the stored ratio and never more than 2% slower than no extension, re-measured up to twice. Stored baseline: warm ratio 0.668.

## 0.3.0 — 2026-11-06

### Measurements
- "Measure on this chat" runs in chunks of 10 messages and yields to the page in between, so it is usable on phones and long chats; the features are turned off only while a message is being formatted, so nothing temporary can ever be saved (feature list 1.4).
- The panel re-renders only when the stats changed, on an animation frame, at most twice a second; the 2 s timer is gone (1.3).
- Sampled profiling: past 1000 runs of a script, 1 run in 8 is timed and the totals are scaled; "time the replacer" is a toggle of its own. Sampling is on by default on devices reporting 4 GB or less (1.3).
- Spikes keep the 20 newest runs over 50 ms with the message they happened on; the ⚡ badge scrolls to that message, and a copy button puts a repro (pattern, input length and head) on the clipboard (2.2).
- Scripts whose pattern does not compile are listed with the engine's error in the summary, the report and the JSON, instead of silently doing nothing (2.2).
- A cost chip after each script's name in the Regex extension's own list, restored whenever SillyTavern re-renders the list (2.1).
- The JSON report gains `fastRuns`, `sampled`, `redos`, `fused`, `broken`, `tripped` and `spikes` per row, plus `invalidPatterns`, `lint`, `memo.persist` and `scripts.infoBuilds`.

### Speed
- ⑥ Replacer fast path: a script whose replacement has no macros runs as a native string template instead of SillyTavern's per-match callback. A script's first matching runs are compared, match by match, with the callback; one difference turns the fast path off for that script with a console warning (1.1).
- ③ also caches scripts whose only macros are `{{user}}`, `{{char}}`, `{{persona}}` or `{{group}}` (keyed by their values, in display passes), and messages that show macro syntax outside the matched text; an unchanged output is stored as a marker, not a copy (1.2).
- Parsed patterns, needles and templates survive a rebuild; the script info is rebuilt on events or when a cheap fingerprint of the script lists changes, not every 5 s (1.3, 3 row 5).
- ⑤ usage is a running total instead of a scan of the chat on every store, and the message depth for its key comes from one table per render burst (1.3).
- The memo's default size follows `navigator.deviceMemory` (16 / 32 / 64 MB) and the literal cache grows with the chat (1.2).

### Use
- Lint under the panel: missing `g`, group references the pattern cannot fill, JSON double escapes, browser support (lookbehind, the `v` and `d` flags, duplicate group names), duplicate patterns. "Add g" and "Unescape" show the change and save it through the regex engine once confirmed (2.3).
- Turning a script off (the row button, `/regexperf off`) saves through `engine.saveScriptsByType()` instead of clicking the Regex drawer; the drawer is only used to open the editor (3 row 9).
- Scripts whose find pattern holds a macro (`{{random}}`, `{{getvar}}`, ...) keep their name, ③ and ④: their runs are matched to the raw pattern (3 row 2).

### Safety
- A static ReDoS analyzer flags nested unbounded quantifiers, alternations whose branches overlap and adjacent overlapping quantifiers as exponential or polynomial, with the reason and a rewrite suggestion in the tooltip and the report; it replaces the `.*` heuristic and its false positives (1.5).
- ⑦ Input-length fuse (off by default): a flagged pattern is not run on inputs longer than 20,000 characters (1.5).
- ⑧ Circuit breaker (off by default): after 3 runs over 500 ms a script is skipped for the rest of the session, with Undo and Open script in the toast and in the table; the script itself is never changed (1.5).
- A ⑤ hit no longer leaves `bypass` set when something throws between the two hooks (3 row 3); editing a prompt-only script no longer invalidates every stored display result (3 row 4).
- Tests pin Chrome to en-US and `navigator.deviceMemory` to 8; `BASELINE_COMMIT` lets the bench compare the working tree with any commit; `node tests/run-one.mjs <scenario>` runs one scenario.

## 0.2.0 — 2026-11-06

### Measurements
- Per-row stopwatch: re-renders the chat without one script and shows the time it costs inline (#21).
- "Measure on this chat" lists the 5 slowest messages (index, length, ms) under the result and in the report (#20).
- ⚡ spikes keep the newest sample (input length, first 80 characters) in the tooltip and the report (#19).
- Matched is counted apart from Changed; ∅ and "candidates to disable" fire only for scripts that never matched (#18).
- The Literal column explains why a pattern has no literal (class-only, every literal optional, a branch without one, ...) (#16).
- Order conflicts: an earlier script removing what a later one would have matched is flagged (⇅, summary, report) (#22).

### Speed
- ② requires every mandatory literal and skips inputs shorter than the pattern's least possible match; the fuzzer covers both (#15).
- ② scans each literal once per input; displayed messages keep their answers for re-renders (#17).
- ⑤ has a per-chat budget (MB, under Limits); the oldest messages' results are dropped first; usage is shown against the cap (#23).
- ③ can be keyed by a 64-bit hash of the input instead of the input (Limits, off by default): about half the memory (#25).
- ⑤ keys use two independent 32-bit hashes of the text; old entries are recomputed (#24).

### Use
- Sortable table (click a header, again to flip) and a name filter; per session (#26).
- JSON and CSV copies of the report; `/regexperf json`, `/regexperf csv`, `/regexperf measure`, `/regexperf off <script name>` (#27).
- Optional automatic measurement when a chat opens; a one-time hint about "# Messages to Load" when the first render was slow (#28).
- "Reset settings"; the open sections are remembered (#29).
- Translations live in `locales/<locale>.json` (#14).

### Safety
- A warning when another extension replaced `RegexProvider.instance.get()` before or after this one (#30).
- CI runs against two pinned SillyTavern commits (release and staging) (#31) and gates the warm display render against a stored baseline (#32).
- `auto_update` is on and the manifest points at this repository.

## 0.1.0

First release: ① profiler, ② literal prefilter, ③ memory cache, ④ streaming skip with a compromise mode, ⑤ persistent cache, the panel, the report and `/regexperf`.
