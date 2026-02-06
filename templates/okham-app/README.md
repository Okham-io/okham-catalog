# OKHAM App Package Template (v0)

This is a minimal template for designing an **OKHAM application** as a runtime-agnostic contract set.

## Goals

- Contracts are **technology/runtime independent**.
- Runtime-specific concerns live in `bindings/` or `deploy/`.

## Layout

- `manifest/` — app-level manifest (informative, JSON)
- `contracts/` — normative contract artifacts (canonical JSON)
  - `otc/types/`
  - `oec/events/`
  - `oic/intents/`
  - `opc/policies/`
  - `oucc/ui/`
  - `onc/navigation/`
  - `occ/capabilities/`
- `examples/` — informative examples
- `bindings/` — runtime mappings (informative)
- `deploy/` — deployment artifacts (mechanical)

## Lint

Use okham-tools:

```bash
okham-lint --ruleset rulesets/okham-app-agnostic.olr.yaml --target .
```
