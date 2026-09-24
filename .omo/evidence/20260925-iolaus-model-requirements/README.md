# Iolaus model requirements: config-driven lanes

## WHAT WAS TESTED

- `packages/model-core/` ported from oh-my-openagent `dev@ed0fb0601`
  (2026-09-24): `model-requirement-types`, `agent-model-requirements`,
  `category-model-requirements`, `model-requirements`, `model-resolution-pipeline`,
  `model-availability`, `provider-model-id-transform`, `model-normalization`,
  `provider-cache`, and `model-family-detectors` moved from `src/omo/`. Six files
  are byte-identical to the reference snapshot; the two tables, the availability
  matcher and the detectors carry the newer upstream content. All ten entries
  are in `reference/active-manifest.json`.
- `bun test` (30 tests; 8 new in `tests/models.test.ts`), `bun run typecheck`,
  `bun run build`, `bun run check:reference`, `bun run check:package`.
- Real OpenCode 2.0.16 isolated QA:
  `node script/qa-live.mjs .omo/evidence/20260925-iolaus-model-requirements`.
  A new `lanes` scenario passes a plugin `models` option pinning `oracle` to
  `openai/gpt-5.6-sol#xhigh` and the `quick` category to
  `openai/gpt-6-luna-fast#low`, then creates a two-node DAG whose nodes name
  `iolaus-quick` and `iolaus-oracle` with no `model`.

## WHAT WAS OBSERVED

- All 13 QA checks passed.
- `lanes-trace.ndjson`: `iolaus.models.loaded` with source `plugin options`;
  20 `iolaus.agent.model` events (11 agents + 9 category lanes), no
  `iolaus.agent.hidden` or `iolaus.category.hidden`. `iolaus-oracle` and
  `iolaus-quick` report `source: config`; `iolaus-sisyphus`
  (`anthropic/claude-opus-5-5#max`), `iolaus-deep-high`
  (`openai/gpt-6-astra#xhigh`) and `iolaus-explore`
  (`kimi-for-coding/kimi-for-coding-highspeed#off`) report
  `source: requirement`. No provider connectivity was consulted.
- `requests.ndjson`, scenario `lanes`, at the model boundary: the quick child
  sent `model: gpt-6-luna`, `reasoning.effort: low`, `service_tier: priority`
  (the host's mapping of the `gpt-6-luna-fast` catalog id); the oracle child sent
  `model: gpt-5.6-sol`, `reasoning.effort: xhigh`. Parent requests stayed on the
  explicit `--model openai/gpt-5.5`.
- The quick child rendered the category prompt
  (`iolaus.agent.rendered` with `kind: category`). The final DAG result carried
  `openai/gpt-6-luna-fast#low` in node provenance.
- Earlier scenarios (`native`, `agent`, `disabled`, `mode`, `dag`, `fanin`,
  `route`) are unchanged: their nodes pin `model` explicitly and explicit models
  still win. Host state isolation, process cleanup and mock protocol passed.

## WHY IT IS ENOUGH

Lane resolution is a pure function over the requirement tables and the layered
`models.json` config, covered by unit tests for chain-first choice, config
precedence, layer merge order, validation and lane hiding. The live scenario
proves the host path end to end: registration pins `agent.model` with variant,
a DAG node without `model` receives the lane model at create time, the child
session runs on that model with the variant applied, and provenance records it.
