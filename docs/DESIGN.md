# Product design direction

## Visual thesis

A quiet evidence room: paper-white and ink-black surfaces, one electric-lime verification signal, humanist typography for decisions, and monospace details for provenance. The interface should feel closer to a precise editorial review desk than a generic SaaS dashboard.

## Content plan

### Application

1. **Review inbox** — answer what needs attention and why.
2. **Selected work** — establish repository state, scope, and current readiness.
3. **Evidence rail** — map each criterion from claim through proof to verdict.
4. **Decision dock** — expose the one next human action without hiding blockers.

The app opens directly on the operational surface. No marketing hero appears inside the product.

### Public landing page

1. **Hero** — VeriDone, the “Don't trust done” promise, and a dominant acceptance-packet visual.
2. **Proof** — one concrete stale-evidence example before and after a commit changes.
3. **Workflow** — claim, evidence, verdict as a single horizontal story.
4. **CTA** — run locally or explore the synthetic demo.

## Interaction thesis

- Selecting a work item uses a shared-layout transition so the inbox and inspector feel like one desk, not separate pages.
- The evidence rail reveals in sequence from claim to check to human verdict; stale state interrupts the line rather than merely changing a badge.
- When repository state changes, affected evidence visibly “unseals” and explains why. The motion is brief and disabled under reduced-motion preference.

## Interface rules

- Use lines, spacing, typographic weight, and alignment before containers or shadows.
- A row becomes a card only when the whole surface is interactive.
- Reserve lime for current, verified action; failures use text, icon, and shape in addition to color.
- Keep status language literal: Blocked, Stale, Needs review, Ready to decide.
- Monospace content is selectable and never smaller than 12 px.
- The selected item, current snapshot, and next action remain understandable at 360 px.
