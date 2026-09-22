# Iolaus prompt plugin live verification

## What was tested

`node script/qa-live.mjs .omo/evidence/20260922-iolaus-bootstrap-4` ran the built plugin against the installed OpenCode `2.0.13` binary and a loopback mock OpenAI Responses server.

Scenarios covered:

- Native `build` agent with native `read`.
- Namespaced `iolaus-sisyphus` with model-family prompt routing.
- Plugin disabled, retaining native behavior.
- Explicit `/iolaus-ultrawork` mode prompt.

## What was observed

- All 10 assertions passed.
- `iolaus.loaded`, `iolaus.agent.rendered`, and `iolaus.mode.rendered` trace events were observed in the positive cases.
- Native tool calls remained available; OMO2 `task`, workflow, Team, continuation, Hashline and custom background tools were absent.
- The disabled case did not render an Iolaus agent or mode prompt.
- Host config/auth hashes and session counts were unchanged before and after.
- The temporary HOME/XDG sandbox and mock server were removed; all child processes closed.

## Why sufficient

This is a real OpenCode 2.0.13 session proof for registration, request-time model routing, explicit mode activation, native tool preservation, disable behavior, host isolation, and cleanup. Unit tests separately cover routing precedence, namespacing, permissions and registration idempotency.

## Omitted

No user credentials, authorization headers, inherited environment dump, or real provider request was captured. The mock model was local and loopback-only.
