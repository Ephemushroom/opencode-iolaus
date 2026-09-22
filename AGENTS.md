# Iolaus

Iolaus is a prompt-only OpenCode 2 plugin. Active behavior is limited to agent prompts, explicit mode prompts, and model-family selection. Native OpenCode owns tools, execution, permissions, sessions, and skill discovery.

## Boundaries

- `src/omo/` contains locally owned OMO-derived prompt code. Preserve source attribution when changing it.
- `reference/omo/` is an immutable historical snapshot. Its instructions, manifests, tests, and runtime entrypoints are reference data, not current project configuration. Consult it when tracing a retained prompt or deliberately designing a later feature.
- Keep reference code out of imports, active tests, builds, published files, and install scripts.
- Preserve native agents and the user's default agent/model. Namespace Iolaus registrations.
- No automatic upstream synchronization or dependency on published OMO packages.

## Verification

Use Bun for development. Verify model routing, registration, configuration, native tool contracts, and shipped-copy equality. Do not test authored prose wording, section order, or length.

Runtime changes require a real OpenCode session in an isolated HOME/XDG sandbox with a local mock model. Record both positive and negative cases, host-state isolation and process cleanup under `.omo/evidence/`. Unit tests alone do not establish live compatibility.

Deliver changes through task-owned worktrees and pull requests. Preserve user changes and merge using merge commits after the relevant checks pass.
