# AGENTS.md — drop-store-steam

Steam local library scanner and store aggregator client plugin for Drop (#21).

## Toolchain

- Node >= 22, npm 10+
- `npm ci`, `npm run build`, `npm test`, `npm run typecheck`

## Contract

Built on [`@droposs/plugin-sdk`](https://www.npmjs.com/package/@droposs/plugin-sdk)
(plugin API v2, `^0.4.0` from the npm registry).

## Boundaries

- Pure parsing only: VDF/ACF text in, `StoreCandidate[]` out.
- The plugin never touches the filesystem, never probes the OS, and returns
  `[]` when the host has not supplied a library snapshot.
- Host-side file access (`game:scan`) is documented in `README.md`.
