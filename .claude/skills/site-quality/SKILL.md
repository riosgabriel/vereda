---
name: site-quality
description: Audit, fix, or review vereda.dev (the Astro + Starlight site in site/) for visual design, UX, accessibility, performance, SEO, and technical accuracy. Use when auditing site pages, implementing site changes, reviewing a site PR, fixing UI issues, or before a site release. Covers how readable every page is, docs prose included, and the Vereda Book's EPUB/PDF downloads. For keeping docs accurate after a code change use update-docs. Not for the generated API reference, which TypeDoc rebuilds on its own.
---

# site-quality: keep vereda.dev clear, accurate and accessible

Work as the site's frontend engineer, designer and QA reviewer together. The site has to earn
developer trust through restraint and accuracy. "Modern" does not mean gradients, glass, animated
backgrounds or rows of SaaS cards.

## Site facts (don't rediscover these)
- **Stack:** Astro 7 + Starlight, bun. Config is in `site/astro.config.ts`. `trailingSlash: "always"`, `site: https://vereda.dev`.
- **Content:** the hand-written docs are read in place from `../docs` (`site/src/content.config.ts`). The H1 becomes the title, and the remark plugins (`site/src/remark/`) rewrite GitHub links. To fix doc prose, edit `docs/`, not the site.
- **Generated, never hand-edit:** `site/src/content/docs/api/` (starlight-typedoc, gitignored) and `site/dist/`. To fix API pages, fix the TSDoc in `src/` or `site/src/api-overview.md`.
- **Theme:** `site/src/styles/theme.css`. It sets tokens and explains them in its header comment: one sans (Schibsted Grotesk) and one mono (JetBrains Mono), sizes from `--sl-text-*` only, and `--v-radius-sm` / `--v-radius`. The accent comes from the logo (ochre on dark, forest on light). `--v-first/retry/fail/ok` are data colors for charts and are never used as UI accent.
- **Overrides:** `site/src/components/Head.astro` loads Mermaid only on pages that have a diagram and redraws it when the theme changes.
- **Demos:** `site/demos/engine` + `site/demos/models`, wrapped by `site/src/components/demos/*.astro`, pages at `/patterns/<slug>/` (`site/src/patterns.ts`). `test/demos/*.parity.test.ts` checks each model against the real client.
- **Demo rules:** one Play click runs the whole scenario. Never auto-pause; slow down and caption the key moments. Respect `prefers-reduced-motion`.

## Principles
1. **Read before changing.** Read the page, its components and `theme.css` first. Keep established tokens and conventions.
2. **Separate fact from taste.** A reproducible defect is an *issue*. A design opinion is a *recommendation* and must say what the reader gains.
3. **Accuracy over polish.** Install commands, code samples and claims must match `package.json`, the types and the tests. No invented benchmarks, adopters or "production-ready" claims.
4. **Small, reversible diffs.** No new dependency unless it solves a demonstrated problem. No broad redesign when a targeted fix works.
5. **Never claim a check you didn't run.** Say what could not be verified.

## Brand
- Calm and editorial. Trail and terrain cues (the meaning of *vereda*) stay subtle, as on the landing page's valley (`site/src/components/Horizon.astro`).
- Use motion only when it explains something (the demos) or gives feedback on an action.
- Ochre/forest accent, warm neutrals, the small type scale. Treat these as decided. Propose alternatives instead of changing them.
- **Ask the maintainer first** before changing any of these:
  - the logo, favicon, or the landing page's Horizon valley and retry-storm chart
  - the book cover (`site/scripts/book-cover.html`)
  - the two typefaces or the accent hex values in `theme.css`
  - URLs: `/patterns/<slug>/`, `/api/` and the trailing slashes. Links to them already exist outside the site.
  - sidebar order and labels in `astro.config.ts`

## Reading (the first bar)
The whole site should be pleasant to read, like a good book. The reference is effect.website/docs.
- One idea per paragraph: median about 20–30 words, none over about 60.
- Each section goes concept → **Example** (short title) → code → one line of explanation.
- Caveats go in lists or H3 subsections; comparisons go in tables. Few em dashes and parentheses.
- Every example typechecks against `src/`. Keep H2 headings stable, since anchors are linked from elsewhere.
- Measure before and after (paragraph median and max, code blocks). `docs/operations.md` is the model page.

## Audit checklist
- **Design/UX:** hierarchy, an obvious first step (install, then a minimal example, then the guide), line length, spacing, and widths at 375 / 768 / 1280. Both themes. Overflow and wrapping in code blocks and tables.
- **Accessibility (WCAG 2.2 AA):** landmarks, heading order, link text, keyboard reach and visible focus (including the demo controls), contrast in **both** themes (ochre on light backgrounds is the usual risk), text alternatives for charts and the logo.
- **Performance:** font loading and fallback shift, image weights in `site/public` and `site/src/assets`, JavaScript loaded on pages that don't need it.
- **SEO/sharing:** a unique title and description per page, canonical URL, Open Graph image, 404 page, and the `/api/` → `/api/readme/` redirect.
- **Accuracy:** every snippet runs against the current `@vereda/http` exports. Repo, npm and changelog links resolve.

## Book downloads (EPUB and PDF)
`site/scripts/book-download.ts` builds `site/public/downloads/vereda-book.{epub,pdf}` from `docs/book/`.
It runs pandoc for both formats, and Playwright's Chromium for the Mermaid diagrams, the cover and the PDF print.
`book-print.css` styles the PDF, and `book-cover.html` is the cover. CI caches the files on a hash of their inputs.

Callouts (Crux, Aside, See it run) and the recurring sections (Design note, What must stay true, Try it) look the same in all three editions. `src/remark/callouts.ts` holds the rules for recognising them (`CALLOUTS`, `SECTIONS`); the site styles them in `theme.css`, and the downloads in `scripts/book-callouts.css`. A new kind goes in all three places. After changing the plugin, delete `node_modules/.astro` before `bun run build`: Astro reuses its cached render of unchanged Markdown.
- **Run it:** `bun run book:download` from `site/`. It needs pandoc 3.1+ on PATH (CI uses 3.1.3 from apt; on Arch use the static release binary, because `pandoc-cli` pulls in 100+ Haskell packages).
- **Already enforced (don't re-check by hand):** both fonts load before printing (the script throws if not), the EPUB passes `epubcheck --failonwarnings` in CI, and `check:links` covers the sidebar links.
- **Look at the pages:** render them with `pdftoppm -r 60 -png -f N -l M` and read the images. Check the cover, the contents page, a chapter opening, a long code listing, a wide table and the tallest diagram. Zoom to 200 dpi before calling text cramped, because low-resolution previews squeeze word spaces.
- **Measures:** body lines 65–80 characters (`pdftotext -layout`, longest lines). Every chapter starts a new page. No page more than half empty unless a diagram needs it. `pdffonts` lists Schibsted Grotesk and JetBrains Mono.
- **EPUB:** unzip it and check that there's no `foreignObject` in any file (Mermaid's HTML labels show as blank boxes on e-readers). Links between chapters stay inside the book, guide links go to vereda.dev, and repo links go to GitHub at the pinned commit.
- **Known traps:** Chromium paints no background in page margins (so the paper is white). Pandoc's `--embed-resources` downloads every URL in the CSS and loses the rules after one that fails (so Chromium loads the fonts). Starlight adds a trailing slash to sidebar paths (so the download links are absolute URLs).

## Severity
**P0** site or core path unusable, or a security/privacy risk · **P1** major journey broken, serious accessibility barrier, materially wrong content · **P2** meaningful issue with a workaround · **P3** polish.
Rank by user impact, never by effort. An unconfirmed suspicion is an *unverified risk*, not a finding.
For each finding, give: `P1-01` · title · evidence (`file:line`) · impact · fix · how to verify.

## Verify
Run what CI's `site` job runs, from `site/`:
```sh
bun run check && bun run build && bun run check:links
```
If you touched demos, also run `npx vitest run test/demos` from the repo root.
The only browser tooling is Playwright's Chromium, which the book build uses. There's no Lighthouse
or axe. Don't claim contrast or Lighthouse results: list them as manual steps (`bun run preview`,
then the widths and keyboard pass above).

## Report
- **Audit:** summary (current state and top risk) → findings by severity → design recommendations (kept separate) → what was and wasn't verified → 3–5 next steps.
- **Fix:** changes made and why → exact commands run and their results → remaining issues and manual checks.
