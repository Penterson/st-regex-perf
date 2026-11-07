# Changelog

## Unreleased

### Fixes

- ⑨ and the ④ paragraph cache wrap the converter SillyTavern uses. showdown sets `makeHtml` as an own property of each `Converter` (nothing on the prototype), so the prototype wrapper of 0.4.0 and 0.5.0 never installed in SillyTavern: a ⑨ hit paid the whole showdown call and the paragraph cache never ran. The instance (`converter` of script.js) is wrapped, and wrapped again before a markdown stage when SillyTavern remade it (`reloadMarkdownProcessor`). The JSON `pipeline.converterWrapped` says so; the harness converter has showdown's shape now.
- ⑤ reads a chat's rows as soon as the chat is known. SillyTavern prints a chat before it emits CHAT_CHANGED, so 0.5.0 read the rows after the first render, which stored its results under the previous chat's key. The chat key is now read at every display pass (the rows go to the right chat, a chat not read yet starts loading), and the rows are read when SillyTavern empties the chat view for the next chat, while the chat file is fetched; the first render after a switch is served when that read finished first, else the next one.
- "Reset stats" followed by "Measure on this chat" no longer breaks the next slow run: the stats the measurement created came back with `spikes = 0`, and the next run over 50 ms threw inside the regex stage, so the message was not rendered.
- A pass in which ⑦ (fuse) or ⑧ (breaker) skipped a script is not stored by ⑨ or ⑤ any more; before, the skipped result was served after the fuse was turned off or the breaker undone, and ⑤ kept it across sessions. Turning ⑧ off lets tripped scripts run again at once.
- ④ rests the display scripts of the streamed message only; another message rendered during a stream (scrolling up, an edit) gets them. A stream that ends in an error (no final render) has its message rendered once more.
- The ⑨/⑤ key includes the Regex extension's own switch (its scripts do nothing while it is off) and the message's placement (user, narrator, character), and the static-macro values follow a renamed group member (`{{group}}` is the members' names, the fingerprint compared their avatars).
- "Opening this chat rendered for" and the "# Messages to Load" hint come from the display passes, ⑨/⑤ hits included; before they came from the profiled regex calls alone (0 with the profiler off or a cached chat, sampled under adaptive mode).
- The measurement restores the felt figures and the long-task window, and renders what SillyTavern shows (`extra.display_text` when present).
- The Limits rows' tooltips are escaped (the "Measure automatically" tooltip broke on its double quotes). A closed IndexedDB connection (`versionchange`) is opened again on the next use instead of failing every later write. Lowering `⑤ Saved results, all chats (MB)` evicts at once. ⑤'s size estimate no longer counts a row twice when it is stored while the chat's rows are being read, counts the rows still waiting for the first write when the database is measured (they made the estimate 0 when a render came before the database had opened, so the size limit was not kept), and the pending rows of another chat survive "Clear saved results". The ④ incremental state is kept per stream (reasoning and body apart). ⑥ counts a match for a `{{match}}`-only replacement. The Regex list's chip shows every mark of the table.

### Wording

- ⑨: "with ⑤ on, the HTML is saved in IndexedDB too" (it said "in the chat"). The hooks-missing note names ⑥'s name-macro option too and no longer says "staging". The incremental option lists its anchor and `g` conditions. The stopwatch tooltip says ⑨ is off as well. The READMEs name the harness's stand-ins, the 60-row table cap and the first render after a chat switch.

### Tests

- Scenarios for each fix: a chat printed before its CHAT_CHANGED (rows, first and next render, the head start), fused and tripped passes against ⑨ and ⑤, reset then measure then a spike, the streaming skip's scope and an error-ended stream, the converter instance (and a remade one), a renamed group member, the Limits tooltips (92 cases). The stand-in converter has showdown's shape, `script.js` exports `converter`, `reloadMarkdownProcessor()` and `updateMessageBlock()`, the macro engine knows `{{persona}}` and `{{group}}`, the page has a `#chat`.
- Two assertions that compared an array with itself are gone; the long-task split test says when the browser gave it nothing to check; the allowed-keys list no longer names `persistMaxMB`. A test filter that matches nothing fails the run. The benchmark gate compares the working tree with the previous commit (the commit before the push, a pull request's base, `HEAD~1` locally) measured in the same run on the same machine, interleaved, within 10%, and with no extension within 2%; the ratio stored in `tests/bench-baseline.json` is printed for comparison only, since the same code measures 0.48 of no extension on a desktop and 0.53 on the GitHub runner (the stored 0.478 made the first CI run of these fixes fail at 0.51). The baseline file marks a dirty tree. CI jobs time out after 30 minutes.

### Code

- A lean pass with no change in behavior: ⑤'s three IndexedDB cursor loops share one helper (`eachKey`), the pipeline and felt counters are reset from their own keys instead of a second copy, the ④ per-generation caches are cleared through one function, `[Symbol.replace]` reads its meta once, the unused `builtAt` field and the never-styled `rpk-heavy`, `rpk-primary` and `rpk-legend` class names are gone, and the comments no longer point at the 0.3.0 planning document ("feature list N"). `text-overflow: clip` (the default) left the stylesheet.

## 0.5.0 — 2026-11-07

Why this release: 0.4.0 measured the whole render; this one acts on what the measurement showed. While a reply streams, markdown and sanitizing run on the paragraph being written only (④'s paragraph cache), ⑤ moves out of the chat file into IndexedDB and is on by default, and each long task says how much of it was display rendering, so the effect of the paragraph cache can be read off the same number before and after.

### Measurements

- Each long task (over 50 ms) is split into the display passes it held and the rest. The summary, the text report and the JSON (`felt.longTaskPipeMs`, `felt.lastLongTask`) give "display renders inside those tasks: X ms of Y ms" and the latest task's split, so a stutter can be blamed on the render pipeline (what this extension sees and partly saves) or on SillyTavern's DOM work, layout and other extensions. The passes of the last 10 s are kept as timestamps for this.

### Speed

- ④ paragraph cache (sub-option of the compromise mode, on): while a reply streams, the HTML of its finished paragraphs is kept, so showdown and DOMPurify run on the paragraph being written.
  - The split point is the last blank line after a plain paragraph, a heading or a closed code fence, outside fences, lists, quotes, tables and open raw HTML, with an even number of backticks before it; a message holding a reference-style link definition is never split. showdown converts the two parts as it would the whole, joined by one line break (checked against showdown 2 with SillyTavern's converter options on 20 samples, DOMPurify included).
  - Lives in the existing `makeHtml` and `DOMPurify.sanitize` wrappers. A marker between the two HTML parts is taken out again by this extension's own AFTER_MARKDOWN hook (the first one) and tells the sanitizer where to split; when another hook changed the finished part, the whole HTML is sanitized.
  - A message's first three split renders are compared with a whole conversion and a whole sanitizing; a difference sends that message back to whole renders, with a console warning (the self-check ⑥ and ④ incremental use). The cache is dropped when the generation ends; the final render goes through the whole pipeline.
  - The summary, the text report and the JSON (`pipeline.paragraph`: `passes`, `hits`, `fallbacks`) count the split renders.

### Storage

- ⑤ stores in the browser's IndexedDB instead of the chat file, and is on by default.
  - One row per displayed message, keyed by the chat (character avatar or group id + chat id) and the message's 64-bit hash and length; the row holds the whole ⑤/⑨ key, so the invalidation rules are unchanged (display scripts' version, names, depth rules, markdown settings). A changed message leaves its old row until it ages out.
  - The hooks stay synchronous: a chat's rows are read into memory when the chat opens (CHAT_CHANGED, and once at start) and the hooks look there only; stores go to the memory copy at once and to IndexedDB in one transaction 200 ms later (and on `pagehide`).
  - Limits: `⑤ Saved results, all chats (MB)` (`persistDbMaxMB`, 64 MB by default) replaces the per-chat cap; beyond it the rows stored longest ago are dropped first, whichever chat they belong to (a key cursor over an `[at, n]` index, so sizes are read without the rows). `persistMaxMB` is no longer read.
  - "Clear saved results (this chat)" deletes this chat's rows and, as before, what older versions wrote into the chat file; the chat is saved only when such entries were there.
  - Entries older versions wrote into chat files (`extra.regex_perf_cache`) are still served when their key matches, never written or trimmed again.
  - Where IndexedDB cannot be opened, the panel's ⑤ note says so and only the chat-file entries are read.
  - The usage line reads `⑤ saved results: N messages in this chat, X of 64 MB in all chats`; the JSON `memo.persist` gains `dbRows`, `dbBytes`, `maxMB`, `loaded`, `pending`, `available`.

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
- ④ paragraph cache: a streamed reply with paragraphs, a heading, a list, a code fence and a quote block renders like plain SillyTavern tick by tick while the converter and the sanitizer see the last paragraph only; a converter whose output depends on the whole text fails the first self-check and the message goes back to whole renders (84 cases). The stand-in converter's trailing-space pass is per line now (`\s+$` ate the blank line between paragraphs).
- ⑤ in IndexedDB: rows come back when a chat opens again (another chat in between drops the memory copy), two chats with the same messages keep rows of their own, clearing is per chat, the size limit drops the oldest rows first, the usage matches a scan of the database, and a chat-file entry of an older version is served when its key matches and left alone otherwise (85 cases). The harness page gets a chat id of its own (`chatId` / `groupId` in its `getContext()`), so rows never cross between tests; scenarios that need every re-render to do work turn ⑤ off as they turn ⑨ off.

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
