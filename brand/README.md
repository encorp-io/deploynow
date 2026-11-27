# DeployNow brand kit

DeployNow is a product **by encorp.ai**. Use these files for the app, the landing page, the README and anything else that carries the brand.

## Logo

| File | Use |
| --- | --- |
| `deploynow-mark.svg` | The mark (Boost: three rising chevrons in the brand gradient on a dark tile). App icon, favicon, avatars. |
| `deploynow-logo-dark.svg` / `.png` | Full lockup "DeployNow by encorp.ai" for dark backgrounds. |
| `deploynow-logo-light.svg` / `.png` | Same lockup for light backgrounds. |
| `deploynow-wordmark-white.svg` / `-dark.svg` | Wordmark only, text outlined (no font needed). |
| `deploynow-icon-512.png`, `deploynow-icon-192.png` | PWA / store icons. |
| `apple-touch-icon.png` (180), `favicon.ico` (16/32/48) | Browser icons. |
| `encorp-logo.svg` | Official encorp.ai logo, taken unchanged from encorp.ai. For light backgrounds. |
| `encorp-logo-white.svg` | encorp.ai logo with the wordmark in white, for dark backgrounds. |

Keep clear space around the mark of at least a quarter of its width. Don't recolour, rotate or add effects to the mark.

## Colour

Brand gradient (from the encorp.ai mark): `#5FCEF9` → `#1D9CFF` → `#2E4FE0`, at 135°.

| Token | Dark | Light |
| --- | --- | --- |
| Background | `#05070D` | `#F5F7FB` |
| Surface (sidebar, inputs) | `#0A0D17` | `#FFFFFF` |
| Card | `#0E1220` | `#FFFFFF` |
| Border | `#1B2234` | `#E3E8F1` |
| Border, strong | `#2A3450` | `#C9D2E2` |
| Accent | `#1D9CFF` | `#0B6FE0` |
| Accent, soft | `#5FCEF9` | `#5FCEF9` |
| Accent, deep | `#2E4FE0` | `#2E4FE0` |
| Success | `#2FD59C` | `#0C8F63` |
| Warning | `#F5B544` | `#B26A00` |
| Danger | `#FF5C68` | `#D92D3A` |
| Text | `#EEF2F8` | `#0B1020` |
| Text, secondary | `#A6AFC4` | `#46506A` |
| Text, muted | `#6C7690` | `#6B7590` |

encorp.ai ink (logo wordmark): `#171A26`.

The app's tokens live in `src/app/globals.css`; keep this table in sync with them.

## Type

- **Geist** (sans) for everything, SemiBold with -2% tracking for headings and the wordmark.
- **Geist Mono** for code, logs, IDs and terminals.

Both ship with the app through the `geist` npm package, so nothing loads from a font CDN.
