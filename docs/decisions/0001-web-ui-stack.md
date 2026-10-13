# ADR-0001 · Web UI stack

- **Status:** Accepted
- **Date:** 2026-10-13

## Decision

React 19, Vite 8, TypeScript, and Tailwind CSS v4, with shadcn/ui components on **Base UI** primitives in the **Nova** style.

## Why

- **shadcn's copy-in model** means we own every component's source. That suits a product design system that will diverge from defaults: density modes, list-row anatomy, and vertical accents.
- **Base UI over Radix.** Base UI is shadcn's current default base and is actively developed. Radix still works but moves more slowly.
- **Tailwind v4's CSS-first config** puts tokens in plain CSS custom properties. Those map cleanly onto a global → semantic → component model and onto Figma variables.
- **The web UI is the UI for every shell**, so a web-native stack is the only one that gives a single source of truth for design.

## Tradeoffs

- One React tree for phone and desktop needs discipline. Postures are layout changes, not forks.
- Native feel on iOS (scroll physics, swipe-back) has to be earned in CSS and gestures. We will add a gesture layer later.

## Rejected

- **React Native / Expo:** a separate rendering model, so shadcn wouldn't apply and the web build would be second-class.
- **Flutter:** its own design language, with no shadcn and no Tailwind.
- **Vue / Nuxt:** a viable alternative, but shadcn's primary ecosystem and Base UI are React-first.
