# Changelog

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
