# OKHAM App Package Template (v0)

This is a minimal template for designing an **OKHAM application** as a runtime-agnostic contract set.

## Goals

- Contracts are **technology/runtime independent**.
- Runtime-specific concerns live in `bindings/` or `deploy/`.

## Layout

- `manifest/` — app-level manifest (informative)
- `contracts/` — normative contract artifacts
  - `types/` (OTC)
  - `events/` (OEC)
  - `intents/` (OIC)
  - `policies/` (OPC)
  - `ui/` (OUCC)
  - `navigation/` (ONC)
  - `capabilities/` (OCC/OFR)
- `examples/` — informative examples
- `bindings/` — runtime mappings (informative)
- `deploy/` — deployment artifacts (mechanical)

## Lint

Use okham-tools:

```bash
okham-lint --ruleset rulesets/okham-app-agnostic.olr.yaml --target .
```
