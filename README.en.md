# Regex Perf Kit (SillyTavern extension)

[한국어](README.md)

Speeds up SillyTavern's built-in Regex extension **without changing a single character of your regex scripts**.

<p align="center">
  <img src="docs/screenshot-desktop.png" alt="The panel on a desktop: summary, features, limits, measurement buttons and the per-script table" width="760">
</p>
<p align="center">
  <img src="docs/screenshot-mobile.png" alt="The panel on a phone: the narrow layout hides the Avg, Replacer and Literal columns" width="300">
</p>

| Feature | Default | What it does |
|---|---|---|
| ① Measure run time (profiler) | ON | Per script: runs, total / max ms, the part spent in the replacement (macros), and how often a run actually changed the text. Finds the slowest scripts and the ones that do nothing. |
| ② Skip runs that cannot match (literal prefilter) | ON | If the message does not even contain the fixed text a script looks for (e.g. both `<status>` and `</status>`, `abc` inside `(?:abc)`, either of `foo\|bar`), or is shorter than the pattern's least possible match, the regex is not run. Results are 100% identical; with the `i` flag the check folds case exactly like the regex engine. |
| ③ Reuse results (memory cache) | ON | When the same script runs on the same message again (swipes, re-renders, reloads), the previous result is reused. Scripts and text with `{{macros}}` are left out automatically. Oldest entries are evicted beyond 3000 entries or 64 MB. |
| ④ Rest display scripts while streaming | ON | While a reply is being generated, "Only Format Display" scripts are skipped and applied once when it finishes. |
| Compromise (an option of ④) | OFF | With ④ on: instead of skipping them, display scripts still format the lines that are already complete, at most once per interval (default 500 ms); the line being written stays raw, and the finished reply gets every script. Needs the MessageFormatter hooks, like ⑤. |
| ⑤ Save results in the chat file (persistent cache) | OFF | Stores the display result in the message's `extra` so reopening the chat skips the work. Beyond a per-chat cap (8 MB by default) the oldest messages' results are dropped first. Needs SillyTavern staging (MessageFormatter hooks). |

## Install

1. Put this folder (`st-regex-perf`) in one of:
   - `SillyTavern/data/<user>/extensions/st-regex-perf/` (recommended)
   - or `SillyTavern/public/scripts/extensions/third-party/st-regex-perf/`
2. Reload SillyTavern in the browser.
3. A **Regex Perf Kit** drawer appears at the bottom of the Extensions panel (🧩).

Requires SillyTavern 1.15.0 or later (a regex engine with `RegexProvider`). The UI is in Korean when SillyTavern's language is Korean, and in English otherwise; translations are one `locales/<locale>.json` file each, so another language is just another file.

## Use

- Reopen the chat or render a few messages to fill the table. The summary counts scripts as active/total per origin (global / preset / scoped). Each feature is described under its checkbox, and the table's columns and badges under **How to read the table**.
- The summary is a few sentences: how many regex runs really happened and how long they took, how many ②, ③, ④ (and ⑤) avoided, and the **time saved** (skipped runs × each script's average run time, so it can exceed the time spent: that is work that never ran). Until a run has been measured, no saving is shown.
- `/regexperf` shows the report in a popup, `/regexperf text` returns it as text, `/regexperf json` and `/regexperf csv` as data (JSON: the whole report, CSV: the table), `/regexperf reset` resets the stats, `/regexperf measure` runs "Measure on this chat", `/regexperf off <script name>` turns a script off (exact name, else the only one containing it). The panel's JSON and CSV buttons copy the same to the clipboard.
- When opening a chat took longer than the threshold under **Limits** (3 s by default), a toast suggests a lower "# Messages to Load", once per session. "Measure automatically when a chat opens" (off by default) runs the measurement below once each time a chat opens.
- **Measure on this chat** re-renders the current chat once with the features off and once on, and shows the time actually saved. It runs in small steps (10 messages at a time), so the page stays usable; the measurement does not show up in the stats. Under the result (and in the text report) it lists the 5 slowest messages with the features off (index, length, ms).
- The table is ordered by total time; click a column header to sort by that column, again to flip the direction (the # column keeps the rank by total time). The box above the table shows only scripts whose name contains what you type. Neither is saved.
- Scripts taking **50% or more of the total time** are highlighted: turning off or fixing those helps most.
  - **Replacer** is the part of the total spent in SillyTavern's replacer (group filling, trim strings, macros). If it is large, the replacement is slow, not the pattern.
  - **Matched** counts the runs where the pattern matched (even if the text came out the same); **Changed** those that actually changed the text.
- Badges next to a name:
  - `(a+)+` exponential backtracking: a nested quantifier or an alternation whose branches can start with the same character, as the static analyzer reads the pattern's shape (hover for the reason and a rewrite; the text report has a "Backtracking risks" section)
  - `a*a*` polynomial backtracking: adjacent quantifiers that can match the same characters
  - `fuse` inputs ⑦ skipped, `off` a script ⑧ turned off for the session (click to turn it back on)
  - `⚡` a single run took over 50 ms; hover the badge for the newest spike's input length and first 80 characters, also listed in the text report's "Spikes" section
  - `⇅` order conflict: an earlier script removed what this one looks for, so a match was lost (the summary and the report name the pair and the count; on inputs up to 4000 characters the match is verified by running the pattern)
  - `∅` ran 20+ times without ever matching (a candidate to disable, also listed in the summary); a script that matches but leaves the text as it is gets no mark
- Click a row to open the script in SillyTavern's regex editor; the power button at the end of the row turns the script off (same as its switch in the Regex extension's list). Patterns that are not scripts have neither. The stopwatch button re-renders this chat without that one script and shows the time it costs (ms) inline in the row (measured with ③ and ⑤ off; it does not show up in the stats).
- Scripts whose **Literal** column says "none" get no benefit from ② and always run (unless the minimum length alone rules a message out). `"a" & "b"` means both must be present, `"a" | "b"` any one of them; hover a cell for the shortest possible match and, when there is no literal, the reason (only classes, every literal optional, a branch without one, ...). The table lists only patterns that ran or were skipped at least once; in a narrow panel (phones) the Avg, Replacer and Literal columns are hidden and remain in the text report.
- **Reset settings** turns every feature and limit back to its default. Whether the Limits, legend and tips sections are open is remembered.
- **Limits** lets you change ③'s entry count, longest cached input and memory (MB), ⑤'s longest saved result and per-chat size (MB), and the compromise interval. "③ Key the cache by a hash of the input" (off by default) keeps a 64-bit hash instead of each input, about halving the memory; the cost is hashing every input, and two inputs of the same length and hash (once in billions with 64 bits) would share a result. The line above it shows ③'s usage and this chat's ⑤ storage against its cap.

## SillyTavern settings that help

- **User Settings → "# Messages to Load"**: how many messages are rendered when a chat opens. 0 = all. 50–100 makes loading much faster.
- **User Settings → "Streaming FPS"**: screen updates per second while streaming. Every update runs all display regexes, so 10–15 reduces lag.

## How it works

SillyTavern's regex engine compiles every pattern through `RegexProvider.instance.get()`. This extension wraps that method to
return a RegExp subclass with an instrumented `[Symbol.replace]`. `String.prototype.replace()` dispatches through that symbol, so
every script run passes through one place. The matching itself runs on a plain RegExp, keeping V8's fast path.
No SillyTavern core file is modified.

- Script info (replacement, display-only flag, ...) is re-read whenever it changes, so editing a script or switching presets takes
  effect without reloading the chat. When several scripts share a pattern, caching and the streaming skip apply only if they suit all of them.
- ②'s literal check runs once per input string: however many scripts look for the same literal, and however often a displayed message is re-rendered (the 256 most recent are remembered), each literal is scanned once.
- Streaming is only checked while a generation runs (`GENERATION_STARTED` until `GENERATION_ENDED`/`GENERATION_STOPPED`), so
  display scripts pay nothing for the check otherwise.

## Caveats

- This extension runs arbitrary JS. All of it is in `index.js`; read it before installing. Nothing is sent anywhere.
- ⑤ can make chat files larger. "Clear saved results (this chat)" removes its entries.
- ⑤ stores display results, so values such as `{{random}}`, `{{time}}` or `{{getvar}}` in display scripts show what they were
  when stored. Script changes, renames (`{{user}}`/`{{char}}`) and message depth (min/max depth) are picked up automatically.
- If a SillyTavern version has no `RegexProvider`, patching fails and the panel shows a warning (everything stays off, no side effects). If another extension had already replaced `RegexProvider.instance.get()`, or replaces it later, the panel and the console warn once.

## Development

```
npm install
npm test
```

`npm test` lints with SillyTavern's ESLint rules, fuzzes the literal extractor (`extractNeedle`; it fails if the regex matches
text the prefilter skipped), and compares no extension / the baseline commit (`BASELINE` in `tests/server.mjs`) / the working
tree in headless Chrome on SillyTavern's real regex engine (`RegexProvider`/`runRegexScript`). SillyTavern's files are downloaded
at test time from the commits pinned in `tests/st-version.json` (one release, one staging; they are AGPL, so they are not part of this
repository). `ST_REF=release npm test` picks the other one (default staging); set `CHROME_PATH` to choose the Chrome binary. `npm run screenshots` regenerates the README's panel
screenshots (`docs/`) from the harness. GitHub Actions
runs the same tests against both commits on every push and pull request, and `npm run bench -- --gate` fails when the warm re-render of a
long chat, relative to no extension, is more than 20% slower than the ratio stored in `tests/bench-baseline.json` (`npm run bench -- --update`
refreshes it; plain `npm run bench` only prints the comparison).
