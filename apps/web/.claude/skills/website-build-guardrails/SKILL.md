# Website Build Guardrails
**For use with Claude Code and AI-assisted web development agents**

---

## Purpose

These guardrails exist to ensure every website produced through AI-assisted development meets a professional, production-grade standard. They are not suggestions. Every instruction here is a constraint. Deviation requires explicit justification. When in doubt, do less and do it better.

The goal is not to ship fast. The goal is to ship something that lasts, scales, and reflects the work of a mature product team -- not a vibe-coded MVP.

---

## 1. Project Architecture and Maintainability

### Component-Based Structure
- Build every website in discrete, self-contained sections and components. No section should have the ability to break another through shared state, leaked styles, or tightly coupled logic.
- Use a consistent folder structure. Group files by feature or section, not by type alone.
- Each component should do one thing well. If a component is handling layout, content, logic, AND styling all at once, break it up.
- Never embed hardcoded content deep inside a component when it could be extracted to a config file, props, or a data layer. This makes copy changes trivially easy without touching layout or logic.

### Before Adding Anything New
- Every new feature, section, or component must be evaluated against the existing system before being written. Ask: does this follow the existing spacing scale? Does it use the design tokens already defined? Does it belong in a shared component library or is it genuinely one-off?
- New additions should extend the system, not contradict it. A second button style should not appear unless there is a clear semantic reason for it to exist.
- Avoid "just this once" exceptions. One inconsistency becomes the precedent for the next.

### Code Formatting and Comments
- All code must be consistently formatted. Use a formatter (Prettier or equivalent) and apply it uniformly across every file in the project.
- Indentation, quote style, trailing commas, and line length must be uniform throughout. Never mix formatting conventions.
- Add comments wherever the intent is not immediately obvious. This includes: complex layout logic, non-obvious z-index decisions, media query breakpoint rationale, any workaround or hack, and anything a future developer would need to understand in 6 months without context.
- Section-level comments should mark the top of major layout areas (e.g., `/* === Hero Section === */`, `/* === Navigation === */`). This makes files scannable at a glance.
- Do not over-comment obvious code. Comments explain *why*, not *what*.

---

## 2. Spacing and Layout

### Spacing Rhythm
- Choose either a 4pt or 8pt spacing scale at the start of every project. Apply it everywhere: margins, padding, gaps, and component spacing.
- Never introduce ad-hoc spacing values that fall outside the scale (e.g., `margin: 13px` or `padding: 22px`). These are immediate signals of vibe-coded work.
- Define spacing as CSS custom properties or design tokens (e.g., `--space-4`, `--space-8`, `--space-16`). Reference those tokens everywhere rather than hardcoded pixel values.

### Grid and Alignment
- Content must align to a defined grid. Use CSS Grid or a container system with predictable max-widths and gutters.
- Nothing should drift, wobble, or appear accidentally off-center. Every alignment decision should be deliberate.
- Sections must have generous and consistent breathing room. Cramped sections signal low-quality work.
- Avoid overusing centered layouts. Left-aligned content with structured hierarchy is often cleaner and more readable. Center-align sparingly, for emphasis.
- Containers should have predictable, consistent widths. Define a `--container-max` variable and use it everywhere.

---

## 3. Typography

### Type System
- Select one heading font and one body font. Do not introduce a third unless there is a specific, justified brand reason.
- Define a complete type ramp with explicit `font-size` and `line-height` values for every level: display, h1, h2, h3, h4, body, small, caption. Store these as CSS variables or tokens.
- Apply the ramp without improvisation. Never override a heading level's size inline for layout reasons. If the visual size needs to change, create a utility class with clear intent.
- Body text line-height should sit between 1.5 and 1.7 for readability. Headlines should be tighter, typically 1.1 to 1.3.
- Text blocks must have consistent spacing between them across the entire site. A `<p>` after an `<h2>` should always breathe the same amount, everywhere.

### Font Selection
- Never default to system fonts (Arial, Helvetica, system-ui) unless the design intent is explicitly utilitarian or typographic minimalism.
- Avoid overused AI-default font choices (Inter, Roboto, Space Grotesk). Choose fonts that serve the brand.
- Always load fonts efficiently. Use `font-display: swap`, subset where possible, and preload critical font files to prevent layout shift.

---

## 4. Color and Branding

### Palette Discipline
- Define a small, named color palette at the start of every project. Store everything as CSS custom properties: `--color-primary`, `--color-surface`, `--color-text`, `--color-accent`, etc.
- Never introduce a color that does not exist in the defined palette. If a new color genuinely needs to exist, add it to the token system with a name -- do not use it inline.
- Every color must have a purpose. If an accent color is being used for novelty rather than hierarchy, remove it.
- Avoid purple gradients unless the brand identity explicitly calls for them. Avoid generic hero gradients as a default visual treatment.

### Branding Consistency
- Typography, color, spacing, border-radius, and shadow style are all part of the brand. Every component must use the same design language.
- Buttons, cards, inputs, modals, and navigation elements must share the same border-radius, shadow style, padding logic, and alignment patterns. Mixing styles creates an immediately vibe-coded feeling.
- Components should look like they belong together, even when seen in isolation.
- If working with an established brand, source or confirm brand guidelines before building. Do not invent brand decisions. Flag ambiguity.

### Accessibility and Contrast
- All text must meet WCAG AA contrast ratios at minimum: 4.5:1 for body text, 3:1 for large text and UI components.
- Never sacrifice contrast for aesthetics. A "softer" look does not justify illegible text.
- Use a contrast checker during development. Do not rely on visual approximation.

---

## 5. Components and Design System

### Consistency Rules
- All interactive components (buttons, links, inputs, checkboxes, selects) must share the same visual language. If the primary button has a 6px border-radius, every component in the system uses 6px.
- Define component states explicitly: default, hover, focus, active, disabled, loading. Every interactive element must have all relevant states implemented.
- Focus states must be visible and clearly styled. Never remove focus outlines without replacing them with an accessible custom style.
- Shadows must be intentional and consistent. Define one or two shadow levels as tokens and use them throughout. Avoid shadows that appear randomly at different opacities and spreads across components.

### No Generic Components
- Do not generate placeholder or template-looking components. Every component should feel like it was built for this specific product.
- Generic hero text ("Build your dreams", "Launch faster", "The future is here") is banned. Copy must speak clearly about what the product does and why it matters.
- Testimonials must either be real or clearly marked as representative examples during development. Fake, generic testimonials left in production are a signal of low-quality work.
- Footer content must be accurate, professional, and complete.

---

## 6. Performance and Lighthouse Scores

### Target Scores
- Every website should target a Lighthouse score of 90+ across all four categories: Performance, Accessibility, Best Practices, and SEO. Scores below 80 in any category require immediate attention before shipping.
- Run Lighthouse audits during development, not just at the end.

### Performance Practices
- Optimize all images before use. Use modern formats (WebP, AVIF). Always provide `width` and `height` attributes to prevent Cumulative Layout Shift (CLS).
- Use lazy loading (`loading="lazy"`) for images below the fold. Never lazy-load above-the-fold images.
- Minimize render-blocking resources. Critical CSS should be inlined or loaded with high priority. Non-critical scripts should be deferred or loaded asynchronously.
- Avoid large, unused CSS or JavaScript bundles. If a library is being loaded for one small use case, consider whether it can be replaced with native code.
- Font loading must be handled carefully (see Typography section). Font swap and preloading are mandatory, not optional.
- First Contentful Paint (FCP) and Largest Contentful Paint (LCP) are primary targets. Anything that delays these should be audited and justified.

### Loading States
- Every interaction that triggers a delay must have a visible loading state. Buttons must shift to a loading indicator when an action is pending. Data-heavy areas should use skeleton loaders that match the shape of the incoming content.
- Content must never appear suddenly with no transition. Smooth content entrances should be the default.
- A site that handles async states gracefully reads as significantly more premium than one that ignores them.

---

## 7. SEO and AI Citation Readiness

### Structural SEO
- Every page must have a unique, descriptive `<title>` tag. The format should be: `Page Name | Brand Name`. Never leave titles as the default framework placeholder.
- Every page must have a unique `meta description` between 150 and 160 characters. It must accurately describe the page content and contain a natural instance of the primary keyword.
- Use semantic HTML throughout. Headings must follow a logical hierarchy: one `<h1>` per page, followed by `<h2>` for primary sections, `<h3>` for subsections. Never skip heading levels for visual reasons.
- Use proper landmark elements: `<header>`, `<nav>`, `<main>`, `<footer>`, `<article>`, `<section>`, `<aside>`. These are critical for both accessibility and search crawler comprehension.
- All images must have descriptive `alt` attributes. Alt text should describe what is in the image in the context of the surrounding content. Never use generic alt text like "image" or "photo."

### Open Graph and Social Metadata
- Every page must include full Open Graph tags: `og:title`, `og:description`, `og:image`, `og:url`, `og:type`.
- OG images should be 1200x630px and include the brand logo or name. Never leave OG images as blank or placeholder.
- Twitter/X card meta tags must also be present: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`.

### AI Citation and Structured Data
- AI models increasingly cite and surface web content in response to queries. To maximize the chance of being cited accurately, content must be structured clearly: specific claims should be in their own paragraphs, key terms should be used consistently and correctly, and content should answer real questions directly rather than hedging everything.
- Implement JSON-LD structured data wherever appropriate. At minimum: `Organization` schema on the homepage, `WebPage` or `Article` schema on content pages, `FAQPage` schema where FAQ content exists, `Product` or `Service` schema on relevant pages.
- Use `<article>` and `<section>` elements with descriptive `aria-label` attributes to help both AI crawlers and assistive technologies understand content groupings.
- Canonical tags (`<link rel="canonical">`) must be present on every page to prevent duplicate content issues.
- Robots meta tags must be explicitly set on every page. Never rely on default crawler behavior.
- A well-structured `sitemap.xml` must be present and submitted. A `robots.txt` file must be correctly configured.

---

## 8. Accessibility

### Implementation Standards
- Target WCAG 2.1 AA compliance on every project.
- All interactive elements must be keyboard navigable. Tab order must follow the visual reading order.
- All form inputs must have associated `<label>` elements. Never use `placeholder` as a substitute for a label.
- Use ARIA roles and attributes only when semantic HTML is insufficient. Never add ARIA to cover up a structural problem. Fix the structure instead.
- Color must never be the only means of communicating information (e.g., form validation errors must have text, not just a red border).
- Motion and animation must respect `prefers-reduced-motion`. Wrap all non-essential animations in a media query and disable them when the user has expressed a preference for reduced motion.
- Test with a screen reader before shipping. At minimum, tab through every interactive element and verify everything is announced correctly.

---

## 9. Responsiveness

### Mobile-First Requirement
- Every layout must be built mobile-first. Start with the smallest viewport and layer complexity upward. Do not build desktop layouts and then attempt to compress them.
- Test at a minimum of four breakpoints: 375px (mobile), 768px (tablet), 1280px (desktop), 1600px (large desktop).
- No element should overflow its container at any breakpoint. Horizontal scrollbars at any size are a defect, not an aesthetic choice.
- Typography must scale appropriately. Use fluid type (`clamp()`) or explicit breakpoint overrides. Headlines that look correct at 1440px should not be overwhelming at 375px.
- Touch targets on mobile must be at least 44x44px. Buttons and links that are too small to tap accurately are an accessibility failure, not just a UX inconvenience.
- Navigation must be explicitly designed for mobile. A hamburger menu or equivalent mobile navigation must be implemented if the desktop nav does not collapse cleanly.
- Images and media must be fully responsive. Use `max-width: 100%` as a baseline and implement art direction with `<picture>` elements where different crops are needed at different sizes.

---

## 10. Interactions and Animations

### Principles
- Animations must be subtle and purposeful. Every animation must be tied to a user action or a meaningful state change. Animations that exist purely for visual interest are not acceptable.
- Hover effects must not distort layout or cause elements to jump. Use `transform` and `opacity` for hover effects. Never change layout-affecting properties (width, height, padding, margin) on hover.
- Animation timing must feel natural. Use ease-out for entrances (fast start, slow end feels responsive), ease-in for exits. Avoid linear animations for most UI elements -- they feel robotic.
- Duration should be short. UI transitions should be 150ms to 300ms. Page-level transitions can go up to 500ms. Anything longer requires explicit justification.
- Every interactive element must function correctly, completely, and predictably. Buttons must respond. Tabs must switch. Accordions must open and close fully. Carousels must actually slide. Forms must submit or show errors. If an element appears interactive, it must behave interactively.
- Wrap all non-essential animation in `@media (prefers-reduced-motion: reduce)` (see Accessibility).

---

## 11. Security

### Mandatory Practices
- Never expose API keys, secrets, tokens, or credentials in client-side code. All secrets belong in server-side environment variables. If a key is visible in the browser, it is compromised.
- Sanitize all user-generated input before rendering it to the DOM. Never use `innerHTML` with unsanitized data. This is the primary vector for XSS (Cross-Site Scripting) attacks.
- When making API calls from the frontend, apply the principle of least privilege. Request only the permissions the feature genuinely needs.
- If a form collects any personally identifiable information (PII), name, email, phone, address, payment details: the page must be served over HTTPS, and data must never be logged to the console or stored in `localStorage`.
- Set appropriate HTTP security headers: `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`. These should be configured at the server or CDN level but must be explicitly accounted for.
- Implement CSRF protection on any form that triggers a state change or data mutation.
- All third-party dependencies must be evaluated before inclusion. Do not add a package to solve a trivial problem. Check for known vulnerabilities and assess the maintenance status of any dependency before adding it.
- Keep dependencies up to date. Outdated packages with known vulnerabilities are a security liability.
- If the site includes authentication of any kind, do not build a custom auth flow unless the team has explicit security expertise. Use an established, maintained auth provider.

---

## 12. Technical Completeness Checklist

Every project must include the following before it is considered complete. These are not optional finishing touches. They are requirements.

**HTML and Meta**
- [ ] Unique `<title>` tag on every page
- [ ] Unique `meta description` on every page
- [ ] Full Open Graph tags on every page
- [ ] Twitter/X card meta tags on every page
- [ ] Canonical tag on every page
- [ ] Robots meta tag on every page
- [ ] Favicon (multiple sizes: 16x16, 32x32, 180x180 for Apple touch)
- [ ] Correct `lang` attribute on the `<html>` element

**Performance and SEO**
- [ ] Sitemap.xml present and correct
- [ ] Robots.txt present and correctly configured
- [ ] JSON-LD structured data implemented on relevant pages
- [ ] All images optimized, using modern formats, with width/height attributes
- [ ] No render-blocking resources without justification
- [ ] Lighthouse scores 90+ across all categories

**Accessibility**
- [ ] All images have descriptive alt text
- [ ] All form inputs have associated labels
- [ ] Keyboard navigation tested and functional
- [ ] Color contrast meets WCAG AA
- [ ] Focus states visible on all interactive elements
- [ ] Reduced motion media query respected

**Functionality**
- [ ] All links functional -- no 404s, no placeholder hrefs
- [ ] All forms functional with validation and error states
- [ ] All interactive components fully implemented with all states
- [ ] Loading states present on all async interactions
- [ ] Mobile navigation implemented and tested
- [ ] Site tested at 375px, 768px, 1280px, 1600px
- [ ] No console errors in production build

**Security**
- [ ] No secrets or keys in client-side code
- [ ] All user input sanitized
- [ ] HTTPS enforced
- [ ] Security headers configured
- [ ] Third-party dependencies reviewed

---

## 13. Anti-Vibe-Code Reference

The following is a list of specific signals that identify vibe-coded work. All of these must be actively identified and removed before any output is considered complete.

| Signal | Problem | Resolution |
|---|---|---|
| Random spacing values | No rhythm, no system | Enforce 4pt/8pt scale via tokens |
| Mismatched border radii | No design language | Define one radius value per tier and apply consistently |
| Generic hero text | No voice, no clarity | Write specific copy that describes the actual product |
| Purple gradients (unjustified) | AI default aesthetic | Use brand-appropriate color decisions only |
| Fake or template testimonials | Low trust signal | Use real testimonials or clearly placeholder-marked content only in dev |
| Sparkles and random emoji | No purpose, no intent | Remove unless explicitly part of the brand language |
| Unintentional shadows | No visual system | Use defined shadow tokens only |
| Broken responsiveness | Not mobile-first | Test all breakpoints before shipping |
| Missing loading states | Async not handled | Every delay must have a visible state |
| Chaotic animations | No intent | All animation must have a purpose and must feel calm |
| Inconsistent component styles | No shared language | Every component draws from the same token set |
| Placeholder or lorem ipsum in production | Unfinished work | All content must be real or explicitly marked for client review |
| Dead links or broken social icons | Incomplete implementation | Every link must be functional |
| Missing favicon | Overlooked detail | Always required |
| No meta tags | Invisible to search and AI | Always required |
| Console errors in production | Code quality issue | Zero tolerance |

---

## Final Standard

Every website produced under these guardrails should feel like it was built by a mature product team that cares about craft. Nothing should look rushed. Nothing should look improvised. Every spacing decision, every type choice, every color usage, every component state, every piece of copy should demonstrate intent.

If any element does not have a clear reason to exist, remove it. If any decision cannot be justified against the system established at the start of the project, revisit it. The measure of quality is not how complex the output is -- it is how intentional every part of it is.

Ship work you can stand behind.
