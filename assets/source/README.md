# Brand asset sources

The PNGs in `assets/` are rendered from these HTML files, in the cairn-kb.dev style
(Schibsted Grotesk, the mark from `assets/logo.svg` / `logo-dark.svg`, the example claim cards).

| Source | Output | Size |
|---|---|---|
| `banner-light.html` | `assets/banner-light.png` | 1280x420 at 2x |
| `banner-dark.html` | `assets/banner-dark.png` | 1280x420 at 2x |
| `social.html` | `assets/social.png` (GitHub social preview) | 1280x640 |
| `avatar.html` | `assets/avatar.png` (GitHub org avatar) | 512x512 |

Render with headless Chrome from the repo root, for example:

```sh
chrome --headless=new --hide-scrollbars --allow-file-access-from-files \
  --virtual-time-budget=4000 --force-device-scale-factor=2 --window-size=1280,420 \
  --screenshot=assets/banner-light.png "file://$PWD/assets/source/banner-light.html"
```

Drop `--force-device-scale-factor=2` for `social.html` and `avatar.html`, and set
`--window-size` to their size. The font loads from Google Fonts, so rendering needs a network
connection. The claim text on the cards is illustrative.
