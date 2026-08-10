# Playing-card artwork (vendored)

The 52 face SVGs and `card-back.png` are generated from the `mylibs` repo and
copied here verbatim, the same way `gamecore.js`/`gamecore.wasm` are:

```sh
python3 tools/prepare_card_assets.py <raw-artwork-dir>
```

That script writes `bitpoker/assets/cards/` (used by the Qt and Android
clients through a qrc) and mirrors the result into this directory. Do not edit
the files here — regenerate instead, or the clients drift apart.

`src/poker/ui/cards.tsx` pulls them in with a template-literal `require`, so
webpack emits the whole directory through the existing `asset/resource` rule;
nothing needs registering per card.

Faces and back share one geometry (a 238.111 x 332.599 box with rounded
transparent corners baked in), so a single CSS height drives both and neither
needs masking.

## Licence

The **face** artwork is *Vector Playing Cards 3.2*, Copyright 2011, 2020
Chris Aguilar <conjurenation@gmail.com>, licensed under
[LGPL-3.0](https://opensource.org/licenses/lgpl-3.0.html). Each SVG carries the
notice as a comment, and the attribution is shown on the poker page.

`card-back.png` is original artwork for this project.
