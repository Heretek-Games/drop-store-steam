# Steam

Steam local library scanner and store aggregator client plugin for Drop (#21).

## Build

```sh
npm ci
npm run build
npm test
npm run typecheck
```

## Host requirements

The Drop plugin API exposes no arbitrary filesystem access, so nothing in this
plugin touches the filesystem or probes the OS. Steam library discovery is a
host responsibility: the desktop host's `game:scan` service must read Steam's
artifacts and hand them to the plugin through plugin storage before `scan()`
can return games.

| Method | Requires host `game:scan`? | Input |
| :--- | :--- | :--- |
| `parseVdf`, `parseLibraryFoldersVdf`, `parseAppManifestAcf`, `joinSteamCommon`, `collectSteamCandidates`, `parseLibraryEntries` | No | Raw file contents or pre-scanned arrays |
| `detectFromStorage` | No (reads `ctx.storage` only) | Host-populated storage keys |
| `SteamScanner.scan` | Indirectly | Whatever the host supplied; `[]` otherwise |

Storage keys the host populates:

- `libraryfolders`: raw contents of `<steam>/steamapps/libraryfolders.vdf`
- `appManifests`: raw contents of each `steamapps/appmanifest_<appid>.acf`
- `library`: optional pre-normalized candidate array (legacy fallback)

Executable paths are never guessed: an ACF manifest does not contain a reliable
executable, so `executablePath` stays unset until the host supplies it.
