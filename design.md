# Automa Design System

Adapted from the Together AI visual language, but tuned for Automa's desktop product UI.

This file is the UI source of truth for `apps/desktop` unless the user explicitly overrides it.

## 1. Visual Theme & Atmosphere

Automa should feel airy, technical, and precise without becoming decorative. The product should borrow the "light infrastructure cloud" feeling from Together AI, but the desktop UI must stay calmer and more product-like than marketing-like. Think clean desktop software with soft atmosphere, not landing page theatrics.

The overall experience should combine:
- soft pastel atmosphere in backgrounds or supporting surfaces
- crisp technical layout and typography
- compact, useful UI
- sharp-cornered geometry
- restrained contrast and spacing

The desktop app should present two moods:
- **Light product mode**: primary working environment, bright canvas, structured tables, compact controls, subtle section separation.
- **Dark technical mode**: optional deep midnight blue surfaces for special technical zones or research-style sections, never as noisy contrast blocks.

The desktop product must avoid overdesigned hero-style UI. Pastels belong in atmosphere and section tinting, not in primary controls or main productivity surfaces.

## 2. Color Palette & Roles

These colors intentionally alter the original Together AI palette to fit Automa better.

### Primary
- **Midnight Ink**: `#0b1020`
  Use for dark surfaces, dark actions, and high-contrast anchors. This replaces pure black.
- **Soft Violet**: `#bdbbff`
  Use as the main soft accent. Good for tints, separators, and atmospheric surfaces.
- **Dusty Coral**: `#e97b63`
  A warmer secondary accent for selective emphasis. Do not flood the UI with it.

### Secondary
- **Mist Blue**: `#dbe7ff`
  Soft supporting accent for light atmospheric gradients.
- **Cloud Pink**: `#f3d9ef`
  Supporting accent only, for ambient gradients and background blends.

### Surface & Background
- **Canvas**: `#fcfbf8`
  Primary page background.
- **Surface**: `#ffffff`
  Main cards, sections, tables, and contained panels.
- **Soft Surface Tint**: `rgba(11, 16, 32, 0.03)`
  Subtle alternate surface tint.
- **Dark Surface**: `#0b1020`
  Deep technical sections or dark containers.

### Text & Border
- **Primary Text**: `#171a24`
  Default body and heading color on light surfaces.
- **Secondary Text**: `rgba(23, 26, 36, 0.62)`
  Muted metadata, descriptions, labels.
- **Light Border**: `rgba(11, 16, 32, 0.08)`
  Standard border on light surfaces.
- **Dark Border**: `rgba(255, 255, 255, 0.12)`
  Border on dark surfaces.

### Accent Rules
- Do not use vivid magenta and orange as primary UI chrome.
- Use accent colors for atmosphere, selected highlights, data emphasis, and brand moments only.
- Keep accents slightly desaturated and elegant.

### Gradient System
- Use soft atmospheric gradients only in:
  - hero/background washes
  - onboarding side panels
  - empty states
  - decorative section backgrounds
- Preferred gradient family:
  - `Cloud Pink (#f3d9ef)` -> `Soft Violet (#bdbbff)` -> `Mist Blue (#dbe7ff)`

Never use these gradients for primary buttons, input fills, or table chrome.

## 3. Typography Rules

### Font Family
- **Primary UI Font**: `Satoshi`
- **Monospace / Technical Labels**: `Geist Mono`

Satoshi is the default typeface across the product UI.

### Hierarchy

| Role | Font | Size | Weight | Line Height | Letter Spacing | Notes |
|------|------|------|--------|-------------|----------------|-------|
| Page Title | Satoshi | 28px | 500 | 1.15 | -0.42px | Never oversized, never shouting |
| Section Title | Satoshi | 22px | 500 | 1.20 | -0.22px | Primary section heading |
| Card / Panel Title | Satoshi | 18px | 500 | 1.25 | -0.18px | Common panel headings |
| Large Body | Satoshi | 16px | 500 | 1.35 | -0.12px | Important summary text |
| Body | Satoshi | 15px | 400–500 | 1.45 | -0.08px | Default product copy |
| Caption | Satoshi | 13px | 400–500 | 1.45 | normal | Metadata and descriptions |
| Label | Geist Mono | 11px | 500 | 1.2 | 0.06em | Uppercase system labels |

### Principles
- Use weight `400` and `500`. Avoid heavy bold display treatment.
- Avoid very dark, thick, oversized headers.
- Do not rely on huge scale for hierarchy. Use structure, spacing, and tone.
- Use mono labels sparingly for structural metadata only.
- Keep heading color slightly softer than stark black where appropriate.

## 4. Component Stylings

### Buttons

**Primary**
- Background: `#0b1020`
- Text: `#ffffff`
- Radius: `0px` to `4px`
- Weight: `500`
- Hover: very subtle brightness or darkening

**Outline**
- Background: `#ffffff`
- Border: `1px solid rgba(11, 16, 32, 0.08)`
- Text: `#171a24`
- Radius: `0px` to `4px`

**Subtle**
- Background: `rgba(11, 16, 32, 0.04)`
- Text: `#171a24`
- Radius: `0px` to `4px`

### Cards & Containers
- Use containers only when they create real structure.
- Background: white or lightly tinted white.
- Border: `1px solid rgba(11, 16, 32, 0.08)`
- Radius:
  - small controls: `0px`
  - large panels: `4px` or `8px`
- Shadow:
  - subtle only
  - preferred: `rgba(11, 16, 32, 0.08) 0px 4px 10px`

### Tables
- Tables should feel like primary product surfaces.
- Use clear row separation and structured headers.
- Expanded rows should stay table-native, not become floating modal-like cards.
- Avoid oversized row heights and unnecessary chips everywhere.

### Badges / Tags
- Compact, sharp, quiet.
- Background: white or faint tint.
- Border: `1px solid rgba(11, 16, 32, 0.08)`
- Text: muted but readable.
- Radius: `0px` to `4px`

### Navigation
- Sidebar should feel like software navigation, not marketing navigation.
- Labels should be short, clear, and utilitarian.
- Footer quick links should use the same naming tone as main navigation.
- Collapsed state should preserve tooltips and icon clarity.

## 5. Layout Principles

### Spacing
- Base unit: `8px`
- Preferred scale: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`
- Keep content mathematically aligned and tightly composed.

### Width & Density
- Use the space available after the sidebar.
- Avoid leaving oversized gutters or floating centered panels unless the user explicitly wants editorial spacing.
- Dense productivity pages should feel neatly packed, not cramped.

### Shell
- Sidebar and content should feel integrated.
- Top headers should behave like application bars, not hero headers.
- Page sections should use the full working area with disciplined padding.

## 6. Depth & Elevation

| Level | Treatment | Use |
|-------|-----------|-----|
| Flat | No shadow, light border only | Tables, utility sections |
| Contained | 1px border + faint background tint | Cards, panels |
| Elevated | `rgba(11, 16, 32, 0.08) 0px 4px 10px` | Important but restrained surfaces |
| Dark Zone | `#0b1020` background with light border treatment | Technical/research sections only |

Rules:
- Never use glow effects.
- Never use inflated, blurry UI shadows.
- Prefer borders over shadow where possible.

## 7. UI State Rules

Every significant UI surface must include:
- **Loading states**: skeletons matching final geometry
- **Empty states**: clear next-step messaging
- **Error states**: inline and local
- **Pressed feedback**: subtle transform-based tactile response

Avoid spinner-first loading unless it is genuinely the right fit.

## 8. Performance Rules

- Animate only `transform` and `opacity`
- Never animate `top`, `left`, `width`, or `height`
- Apply noise/grain only to fixed non-scrolling layers
- Use z-index only where a real layer model exists

## 9. Do / Don't

### Do
- Use Satoshi throughout the product UI
- Keep corners sharp
- Use soft atmospheric pastels sparingly in the background system
- Keep the product calm, compact, and structured
- Favor lists, tables, inline detail, and dense utility layouts

### Don’t
- Don’t use pure black `#000000`
- Don’t use fat bold headers
- Don’t use pill-heavy UI everywhere
- Don’t use gradients as core UI chrome
- Don’t let sections float with unnecessary whitespace
- Don’t turn productivity screens into landing-page compositions

## 10. Responsive Rules

- Mobile: stack sections cleanly and keep padding tight
- Tablet: allow 2-column structure where helpful
- Desktop: use available width intelligently
- Dense tables and settings surfaces should collapse intentionally, not just shrink awkwardly

## 11. Implementation Notes for This Repo

- `apps/desktop` is the real product surface.
- This file is the source of truth for desktop UI decisions.
- If existing UI conflicts with this file, update the UI toward this file unless the user explicitly says otherwise.
- When adapting an external inspiration system, preserve its useful structure but fit it to:
  - Satoshi typography
  - sharp geometry
  - calm product density
  - Automa’s desktop workflow
