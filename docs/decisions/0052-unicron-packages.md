# ADR-0052 · unicron as versioned packages, not a submodule

- **Status:** Accepted
- **Date:** 2026-10-16
- **Supersedes:** the submodule half of [ADR-0047](0047-unicron.md); its tokens, roles, and `dsa` ratchet stand
- **Upstream:** unicron's consuming guide (`docs/05-consuming.md` §7), releases `@unicron/ui@0.2.0` and `@unicron/tokens@0.1.0`

## Context

ADR-0047 brought unicron in as a git submodule at `vendor/unicron`. That was right while the system was being built out of this app: a change could land in both repos in one sitting. It had costs:

- **Every checkout needed a second step** (`--recurse-submodules`), and every CI job and the gateway's Docker build had to know about it.
- **The pin was a commit, not a version.** Nothing said whether a bump was a fix or a breaking change, and the app built unicron's packages itself before every `dev`, `build`, and `typecheck`.
- **It wasn't the path unicron sets for apps.** Its consuming guide has every app take the system as packages; the submodule was a bootstrap step.

unicron now publishes versioned releases (Changesets), and the ADR-0048 promotions shipped in `@unicron/ui` 0.2.0.

## Decision

Mailbird installs the two packages from unicron's GitHub release tarballs:

| Package | Version | Source |
|---|---|---|
| `@unicron/ui` | 0.2.0 | `unicron-ui-0.2.0.tgz` on the `@unicron/ui@0.2.0` release |
| `@unicron/tokens` | 0.1.0 | `unicron-tokens-0.1.0.tgz` on the `@unicron/tokens@0.1.0` release |

- **The lockfile pins each tarball by its hash,** so an install can't silently pick up different files.
- **One override.** `@unicron/ui` asks for `@unicron/tokens` by version (`0.1.0`), and there's no registry to answer. The override in `pnpm-workspace.yaml` points that request at the same tarball the app uses, so there's exactly one copy of the tokens.
- **Moving to a new release** is a two-URL change: the version in `apps/web/package.json`, and the tokens override if tokens moved too. Then `pnpm install`, and the screens and ratchet checks below.
- **The submodule is gone:** `vendor/unicron`, `.gitmodules`, the `submodules: true` on six CI checkouts, the `vendor` copies in the gateway's Dockerfile, and the `deps:build` step before `dev`, `build`, and `typecheck`. The packages arrive already built.
- **The shadcn transform moved to unicron.** `tools/shadcn-material` here was a copy of the tool that writes unicron's primitives; unicron owns it now (`pnpm regen`). With no unicron source in this repo, the copy had nothing to write to.
- **Unchanged:** `@import "@unicron/ui/styles"` in `index.css`, Mailbird's own roles in `styles/app-extension.css`, and the `dsa` ratchet. Its `vendor/**` exclude is dropped, because nothing lives there now.

### Tradeoffs

- **A fix in unicron reaches Mailbird a release later,** not a commit later. That's the point: the app moves when the system says a change is ready, and the version says how big it is.
- **Trying an unreleased unicron change** now means a local link (`pnpm link`) instead of checking out a branch in `vendor/`. That's a developer step, never committed.
- **Tarballs, not a registry.** GitHub releases need no account or token to install, which keeps the repo public-friendly. If unicron moves to a registry later, only the two URLs change.

## Verification

- **Screens:** the same 52 states as ADR-0048 (menus, dialogs, sheets, chips, and editors, in light and dark, on desktop and phone) plus the 16 main views, captured from a build before and after. All 68 are identical pixel for pixel.
- **Tokens:** all 133 custom properties resolve to identical values in light and dark.
- **Install:** `pnpm install --frozen-lockfile` passes; the gateway's web stage, replayed in a clean folder holding only the files its Dockerfile copies, installs and builds without the submodule. CI's Docker job builds the image itself.
- **Ratchet:** unchanged at 241 / 2 / 0 / 0 (`className` overrides, style overrides, spread props, look-alikes).
- **Regression:** all 39 browser suites pass. `tsc -b`, `oxlint`, and `vite build` are clean.
