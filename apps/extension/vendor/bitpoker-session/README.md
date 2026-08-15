# Vendored `@bitpoker/poker-session`

**Generated — do not edit.** Every file under `src/`, `fixtures/` and
`assets/` is a copy of `webapp/packages/poker-session` in the BitPoker
monorepo, refreshed with `tools/sync-poker-session.sh` there. CI re-runs that
script with `--check`, so an edit made here fails the build instead of quietly
forking the wire protocol.

It is vendored rather than aliased so this submodule builds on its own.

What lives here is only the headless half of a client: relay transport, the
gamecore wasm worker, and the hand state machine. The extension's poker page
(`apps/extension/src/poker/`) is this extension's own UI and is *not* shared
with the web client — that is the point of the split.
