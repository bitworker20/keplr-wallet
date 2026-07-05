# BitPoker gamecore (vendored)

`gamecore.js` + `gamecore.wasm` are the transport-free BitPoker game core
(mental-poker crypto, Texas Hold'em rules, wire codec, matchmaking derivation,
dispute exports) built with emscripten from the `mylibs` repo:

```sh
source /path/to/emsdk/emsdk_env.sh
bitpoker/wasm/build_and_test.sh
cp bitpoker/wasm/build-wasm/gamecore.{js,wasm} \
   keplr-wallet/apps/extension/src/vendor/bitpoker/
```

They are copied verbatim to the extension build root by webpack
(CopyWebpackPlugin) and loaded at runtime by `src/poker.tsx` as a classic
script + wasm fetch — webpack never parses the emscripten glue. Requires the
`'wasm-unsafe-eval'` CSP entry in the manifests.

The embind API is documented in `bitpoker/wasm/README.md`.
