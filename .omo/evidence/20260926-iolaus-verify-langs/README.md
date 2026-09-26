# Verify hook: multi-language detection and diagnostic formats

## WHAT WAS TESTED

- `detectCheckers` now recognises `tsconfig.json` (tsc), `biome.json[c]`
  (biome github reporter) else eslint configs (unix format), Python markers
  (ruff concise, `--no-fix`), `Cargo.toml` (cargo check short), `go.mod`
  (go vet). All read-only.
- `filterDiagnostics` accepts `./path:line:col` (go/cargo) and GitHub-reporter
  `::error … file=…,line=…::msg` lines in addition to tsc/unix.
- `format: "json"` on a checker: `filterJsonDiagnostics` parses flat arrays,
  `diagnostics`/`results` wrappers, and ESLint's per-file `messages` groups.
  `verify.json` validation rejects other formats.
- `bun test` 76 pass (3 new), typecheck, build, check:reference,
  check:package. Live OpenCode 2.0.16 QA re-run for `native`, `verify-edit`
  (real tsc through host `patch`), `verify-off`: 8/8.

## WHAT WAS OBSERVED

- Unit tests pin detection order and read-only argv, parsing of all four
  line formats with other-file lines dropped, JSON parsing across the three
  shapes, and a real JSON checker run through `verify`.
- Live `verify-edit` unchanged: tsc `TS2322` and the comment finding reach
  the model's tool result.

## KNOWN LIMITS

- Only tsc is exercised against a real binary here; biome/eslint/ruff/cargo/go
  parsing is pinned on representative output lines, not live runs.
