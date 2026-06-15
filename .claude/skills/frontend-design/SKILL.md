---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when building or restyling ANY UI in this project — pages, panels, dashboards, components, modals, artifacts — or when beautifying any existing screen. Generates creative, polished UI that avoids generic AI aesthetics, rendered with this project's mandatory Arco Design + UnoCSS stack.
license: Complete terms in LICENSE.txt
---

> **Source & license:** Adapted from the upstream Anthropic `frontend-design` skill
> ([anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design), Apache-2.0 — see `LICENSE.txt`).
> The aesthetic guidance below is the upstream content; the **Project Stack Binding** section
> has been added/edited so the skill fits this codebase. Where they conflict, the binding wins.

This skill guides creation of distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Implement real working code with exceptional attention to aesthetic details and creative choices.

The user provides frontend requirements: a component, page, application, or interface to build. They may include context about the purpose, audience, or technical constraints.

**Announce at start:** "I'm using the frontend-design skill for this UI work."

## Project Stack Binding (THIS PROJECT — overrides any conflicting advice below)

This is an Electron + React 19 app with a NON-NEGOTIABLE UI stack. Keep every aesthetic
_principle_ from this skill, but realize it through the project stack — never with Tailwind,
shadcn, or raw HTML.

- Components: **`@arco-design/web-react`** only. NO raw interactive HTML (`<button>`, `<input>`, `<select>`, `<textarea>`...). Use Arco `Button`/`Input`/`Select`/`Layout`/`Grid`/`Space`/`Card`.
- Icons: **`@icon-park/react`** only.
- Styling: **UnoCSS utilities** first; complex styles → CSS Modules (`ComponentName.module.css`).
- Colors: **semantic tokens** from `uno.config.ts` / CSS variables. NEVER hardcode hex/rgb (this also rules out the purple-gradient-on-white cliché warned about below).
- Custom fonts: apply via CSS variables / global styles in `packages/desktop/src/renderer/styles/` — do NOT swap the component library or inline font names per component.
- Arco theme overrides → `renderer/styles/arco-override.css`; component-scoped → CSS Module with `:global()`. Global styles only in `renderer/styles/`.
- All user-facing text → `t('key')` (i18n). Register/extend the feature's i18n module.
- Renderer process only — NO Node.js APIs in UI code.
- Verify BOTH light and dark themes. Respect `prefers-reduced-motion`. Keep directories ≤ 10 direct children.

**Idea → stack cheatsheet:** distinctive fonts → font CSS variables in `renderer/styles/`; CSS variables for color → existing semantic tokens (add to `uno.config.ts` if new); bold layout/spacing → Arco `Layout`/`Grid`/`Space`/`Card` + UnoCSS gap/padding tokens; motion → CSS transitions / Arco animation props (Motion lib only if already a dependency); raw `<button>`/`<input>` → Arco equivalents; inline hex → semantic token.

## Design Thinking

Before coding, understand the context and commit to a clear aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an intentional direction (refined/utilitarian, editorial, soft/pastel, industrial, etc.). For a desktop AI workspace like this, refined minimalism with confident accents usually beats decorative chaos — but commit fully to whatever direction you choose.
- **Constraints**: Arco + UnoCSS, dark/light theme parity, i18n, accessibility, performance.
- **Differentiation**: What makes this memorable? What's the one detail someone will remember?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and refined minimalism both work - the key is intentionality, not intensity.

Then implement working code (React + Arco + UnoCSS, per the binding above) that is:

- Production-grade and functional
- Visually striking and memorable
- Cohesive with a clear aesthetic point-of-view
- Meticulously refined in every detail

## Frontend Aesthetics Guidelines

Focus on:

- **Typography**: Choose fonts that are beautiful, unique, and interesting. Avoid generic fonts like Arial and Inter; opt instead for distinctive choices that elevate the frontend's aesthetics; unexpected, characterful font choices. Pair a distinctive display font with a refined body font. (Apply via font CSS variables in `renderer/styles/`.)
- **Color & Theme**: Commit to a cohesive aesthetic. Use CSS variables / semantic tokens for consistency. Dominant colors with sharp accents outperform timid, evenly-distributed palettes.
- **Motion**: Use animations for effects and micro-interactions. Prioritize CSS-based solutions; use the Motion library only if it's already a project dependency. Focus on high-impact moments: one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions. Use hover/focus states that surprise. Respect reduced-motion.
- **Spatial Composition**: Unexpected layouts. Asymmetry. Overlap. Diagonal flow. Grid-breaking elements. Generous negative space OR controlled density — realized with Arco layout primitives + UnoCSS spacing tokens.
- **Backgrounds & Visual Details**: Create atmosphere and depth rather than defaulting to solid colors. Add contextual effects and textures that match the overall aesthetic (gradient meshes, noise, geometric patterns, layered transparencies, tokenized shadows, decorative borders) — built from semantic tokens, not random hardcoded colors.

NEVER use generic AI-generated aesthetics like overused font families (Inter, Roboto, Arial, system fonts), cliched color schemes (particularly purple gradients on white backgrounds), predictable layouts and component patterns, and cookie-cutter design that lacks context-specific character.

Interpret creatively and make unexpected choices that feel genuinely designed for the context. No design should be the same. Vary between light and dark themes, different fonts, different aesthetics. NEVER converge on common choices (Space Grotesk, for example) across generations.

**IMPORTANT**: Match implementation complexity to the aesthetic vision. Maximalist designs need elaborate code with extensive animations and effects. Minimalist or refined designs need restraint, precision, and careful attention to spacing, typography, and subtle details. Elegance comes from executing the vision well.

Remember: Claude is capable of extraordinary creative work. Don't hold back, show what can truly be created when thinking outside the box and committing fully to a distinctive vision — within the project stack binding.

> Inspiration libraries (principles only, never copy Tailwind code): VoltAgent/awesome-claude-design DESIGN.md files.
