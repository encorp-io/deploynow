# DeployNow landing page

A static site with no build step, hosted on Cloudflare Pages:

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `main.js` | The landing page |
| `terms.html` | Terms of Service (open source, as is, use at your own risk) |
| `404.html` | Not-found page (Cloudflare Pages serves it automatically) |
| `downloads/deploynow-ready.md`, `.zip` | Copies of the `deploynow-ready` skill from `skills/`, so it can be downloaded while the repository is private |
| `robots.txt`, `sitemap.xml`, `llms.txt` | Search and AI-crawler files |
| `_headers` | Security headers, caching, and content types for the downloads |

## Search, AI answers (SEO, GEO, AEO)

- The canonical address is `https://deploynow.encorp.ai/`. It appears in `index.html` (canonical, `og:*`, JSON-LD), `terms.html`, `robots.txt`, `sitemap.xml`, `llms.txt` and the AI prompt on the page. If the site lives elsewhere, replace it everywhere: `grep -rl deploynow.encorp.ai site | xargs sed -i 's#deploynow.encorp.ai#your.domain#g'`.
- `index.html` has JSON-LD for the organization, the website, the app (`SoftwareApplication`), the install steps (`HowTo`) and the FAQ (`FAQPage`). Keep the FAQ JSON-LD and the visible FAQ section in sync.
- `llms.txt` is a plain-text summary for AI answer engines. Update it when features change.
- `robots.txt` allows all crawlers, AI crawlers included.
- After the first deploy, add the site to Google Search Console and Bing Webmaster Tools and submit `sitemap.xml`.

## The deploynow-ready skill

The source is `skills/deploynow-ready/SKILL.md`. After changing it, refresh the copies here:

```bash
cp skills/deploynow-ready/SKILL.md site/downloads/deploynow-ready.md
cd skills && rm -f ../site/downloads/deploynow-ready.zip && zip -r ../site/downloads/deploynow-ready.zip deploynow-ready
```

## Cloudflare Pages setup

1. In Cloudflare, go to Workers & Pages → Create → Pages → Connect to Git, and pick `encorp-io/deploynow`.
2. Build settings:
   - Production branch: `main`
   - Framework preset: None
   - Build command: leave empty
   - Build output directory: `site`
3. Save and deploy. Pushes to `main` publish the site, and other branches and pull requests get preview URLs.
4. Optional: under Custom domains, add the domain you want, such as `deploynow.encorp.ai`.
5. Optional: under Settings → Builds → Build watch paths, include only `site/*` so app changes don't trigger a site deploy.

`_headers` sets security headers and caching for `assets/`.

## Preview locally

```bash
npx serve site    # or: python3 -m http.server -d site
```

## Brand

Brand files in `assets/` are copies from `brand/`. Colours are the tokens at the top of `styles.css`; keep them in sync with `brand/README.md`.

`assets/og.png` is the social preview (1200x630). Regenerate it by screenshotting the hero (without the install line and the product window) at that size after changing the hero.
