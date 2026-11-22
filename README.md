# csv-reader-speed-01

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/lkapi0819-cli/csv-reader-speed-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/lkapi0819-cli/csv-reader-speed-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A faster drop-in replacement for csv-reader 1.0.0: `solve.js` is a dependency-free ES module whose `run(input)` returns, for every case's input `{text, header}`, exactly the answer csv-reader 1.0.0 returns — `{columns, rows, errors}` under the same broken-row policy (stray CRs dropped, quote junk appended, unterminated quotes read again as unquoted, short rows padded, long rows cut, every breakage recorded as an error). Instead of building each field character by character, it keeps one forward cursor per special character (comma, LF, CR, quote) — each cursor is refreshed with a native indexOf scan only when the reading position passes it, so every character class is scanned once in total — and copies each untouched run of a field with a single slice. On the kit's practice set (6 cases, 10.2 MB of CSV) it answers in about a tenth of the reference reader's time, with byte-identical answers. `main.ts` is the program/v1 driver: it reads every case from /input/cases.json, answers each with `run`, and writes /output/answers.json.

## Run it

```sh
MAKEFUN_INPUT_DIR=<dir with cases.json> MAKEFUN_OUTPUT_DIR=<output dir> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=nhastfac&utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
