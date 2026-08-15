# BitPoker Page Rules

The extension ships a poker page at `chrome-extension://<id>/poker.html`
(`apps/extension/src/poker.tsx` → `src/poker/`). Two directories, two rules.

## `apps/extension/src/poker/` — this extension's UI

- Edit freely. It is the extension's own page, not shared with anything.
- Deliberately plain. The standalone BitPoker web client is where the elaborate
  table UI lives; this page's value is that the key stays in the background
  realm behind the router boundary.
- Still on inline styles rather than the design system — a DS pass is a
  reasonable follow-up, not a requirement for touching it.

## `apps/extension/vendor/bitpoker-session/` — generated, do not edit

- A copy of `webapp/packages/poker-session` from the BitPoker monorepo: relay
  transport, the gamecore wasm worker, the hand state machine, bet bounds,
  chain queries. No UI in it.
- Refresh it from that repo with `tools/sync-poker-session.sh`; its CI runs the
  same script with `--check`, so an in-place edit here fails the build.
- Reached through the `@bitpoker/poker-session` alias, mirrored in
  `webpack.config.js`, `tsconfig.json`, `tsconfig.check.json` and
  `jest.config.js`. Change one, change all four.
- Its specs run in this workspace's jest (`vendor/**/src/*.spec.ts` matches
  `testMatch`), which is the cheapest signal that the copy still compiles under
  this repo's TypeScript.

## Key handling

`src/wallet-bridge-extension.ts` is the only thing the page gets for key
access, and it is a thin translation to background messages. Approval gating
and the raw-signer domain-prefix allowlist live in
`packages/background/src/bitpoker/service.ts`, across the process boundary —
never move a check into the page.
