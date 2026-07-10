# Design System (DESIGN.md)

This document outlines the visual system, style guide, and components for the local-first Pharmacy POS & Inventory Manager.

## Color Palette

We employ a high-fidelity **Dark Mode & Clinical Neon** color scheme, using OKLCH for precise color definition and accessibility.

```css
:root {
  /* Architectural Surfaces */
  --bg: oklch(0.06 0.000 0);           /* Pure dark slate / near-black */
  --surface-solid: oklch(0.11 0.002 220);  /* Solid panel background */
  --surface: oklch(0.12 0.005 220 / 0.65); /* Glassmorphic background (with backdrop-filter blur) */
  --surface-hover: oklch(0.16 0.008 220 / 0.8);
  --border: oklch(0.22 0.010 220 / 0.5);   /* Thin glass border */
  --border-focus: oklch(0.72 0.150 200);   /* Focused ring outline (primary cyan) */

  /* Text & Ink (Contrast ratios >= 7:1) */
  --ink: oklch(0.96 0.002 220);        /* High contrast primary text */
  --muted: oklch(0.68 0.005 220);      /* Muted text (secondary labels, sub-info) */

  /* Brand & Interactive Colors */
  --primary: oklch(0.72 0.150 200);    /* Kinetic Cyan (Primary actions, barcode search, buttons) */
  --primary-hover: oklch(0.78 0.170 200);
  
  /* Semantic Status Indicators */
  --safe: oklch(0.75 0.160 150);       /* Clinical Neon Emerald (Active, In-Stock, Checkout success) */
  --danger: oklch(0.65 0.200 15);      /* Neon Rose (Warnings, Expired lock, Controlled substances) */
  --warning: oklch(0.82 0.150 91.3);    /* Honey Gold (Seed 063: Near-expiry alerts, dead stock) */
}
```

## Typography

- **Primary Font Family**: `Inter`, system-ui, -apple-system, sans-serif (Clean, highly legible for tables and numeric grids).
- **Line Length**: Paragraph container max width capped at `68ch`.
- **Text Wrap**: Heading tags employ `text-wrap: balance`; paragraphs use `text-wrap: pretty`.
- **Typographic Scale**:
  - `h1`: `clamp(1.8rem, 4vw, 2.5rem)` (Uppercase, tracked `0.02em` for header panels).
  - `h2`: `clamp(1.4rem, 3vw, 1.8rem)`.
  - `h3`: `1.2rem` (Section labels, table headers).
  - `body`: `0.95rem` (Line height `1.5`).
  - `code/kbd`: `0.85rem` (Monospace, raw identifiers, keys F1-F5).

## Spacing & Layout

- **Dynamic Layout**: A modular layout using CSS Grid for the primary 2-column POS workspace:
  - Left panel: Active Cart & Transactions.
  - Right panel: Quick Actions, Prescription validation, and scanner indicators.
- **Spacing Scale**: Base-8 spacing scale (8px, 16px, 24px, 32px, 48px, 64px).
- **Glassmorphism Spec**:
  - `backdrop-filter: blur(16px);`
  - `border: 1px solid var(--border);`
  - `box-shadow: 0 8px 32px 0 oklch(0 0 0 / 0.5);`

## Component Specifications

### 1. Primary Inputs (Barcode & Search)
- **Focused State**: Large kinetic border ring `box-shadow: 0 0 0 3px var(--border-focus);` with smooth transition (`transition: box-shadow 0.2s ease-out-quint`).
- **Placeholder**: High-contrast muted color (`var(--muted)`) to satisfy AA contrast rules.

### 2. Transaction Cart Row
- **Interactive States**: Hovering highlights the row with `--surface-hover` and updates text/icons subtly.
- **Color Coding**: Controlled substances show a subtle indicator with `--danger` (Neon Rose).

### 3. Keyboard Shortcut Badges (`kbd`)
- Rounded badges with monospace font, dark border, and subtle light backdrop. Shows `F1`, `F2`, `F5`, `ENTER` in POS view.

## Motion & Transitions

- **Exponential Transitions**: All interactive transforms and colors use `transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);` (ease-out-quart).
- **Reduced Motion**: Under `@media (prefers-reduced-motion: reduce)`, transitions are simplified to instant or short opacity crossfades.
- **Hover Restrictions**: No scale or rotation transforms are applied to images or action panels on hover. Hover feedback is carried strictly by changes in surface backgrounds and subtle borders.
