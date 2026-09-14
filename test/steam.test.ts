import test from "node:test";
import assert from "node:assert/strict";
import { MockClientPluginContext } from "@droposs/plugin-sdk";
import Plugin, {
  SteamScanner,
  collectSteamCandidates,
  joinSteamCommon,
  parseAppManifestAcf,
  parseLibraryEntries,
  parseLibraryFoldersVdf,
  parseVdf,
} from "../src/index.js";
import {
  appManifest400Acf,
  appManifest570Acf,
  legacyLibraryFoldersVdf,
  libraryFoldersVdf,
} from "./fixtures/steam.js";

test("drop-store-steam registers a store scanner", async () => {
  const ctx = new MockClientPluginContext("drop-store-steam", ["client:library-scan"]);
  await new Plugin().init(ctx);
  assert.equal(ctx.storeScanners.length, 1);
  assert.equal(ctx.storeScanners[0].store, "steam");
});

test("drop-store-steam parses library entries", () => {
  const entries = parseLibraryEntries([{ appid: 570, name: "Dota 2", installdir: "/games/dota" }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].externalId, "570");
});

test("drop-store-steam scanner maps candidates", async () => {
  const scanner = new SteamScanner(async () => [
    { externalId: "1", title: "Game", installPath: "/games/game" },
  ]);
  const games = await scanner.scan();
  assert.equal(games.length, 1);
  assert.equal(games[0].store, "steam");
});

test("parseVdf handles quoting, escapes and comments", () => {
  const parsed = parseVdf(`// comment\n"root" { "key" "va\\\\lue" }`);
  assert.deepEqual(parsed, { root: { key: "va\\lue" } });
});

test("parseLibraryFoldersVdf reads modern fixture", () => {
  const libraries = parseLibraryFoldersVdf(libraryFoldersVdf);
  assert.equal(libraries.length, 2);
  assert.equal(libraries[0].path, "C:\\Program Files (x86)\\Steam");
  assert.deepEqual(libraries[0].apps, ["570", "730"]);
  assert.equal(libraries[1].path, "D:\\SteamLibrary");
  assert.deepEqual(libraries[1].apps, ["400"]);
});

test("parseLibraryFoldersVdf reads legacy fixture", () => {
  const libraries = parseLibraryFoldersVdf(legacyLibraryFoldersVdf);
  assert.deepEqual(libraries, [
    { path: "/home/john/.local/share/Steam", apps: [] },
    { path: "/mnt/games/SteamLibrary", apps: [] },
  ]);
});

test("parseAppManifestAcf resolves steamapps/common install path", () => {
  const candidate = parseAppManifestAcf(appManifest570Acf, "D:\\SteamLibrary");
  assert.deepEqual(candidate, {
    externalId: "570",
    title: "Dota 2",
    installPath: "D:\\SteamLibrary\\steamapps\\common\\dota 2 beta",
  });
});

test("parseAppManifestAcf keeps posix separators", () => {
  assert.equal(
    joinSteamCommon("/mnt/games/SteamLibrary", "Portal"),
    "/mnt/games/SteamLibrary/steamapps/common/Portal",
  );
  const candidate = parseAppManifestAcf(appManifest400Acf, "/mnt/games/SteamLibrary");
  assert.equal(candidate?.installPath, "/mnt/games/SteamLibrary/steamapps/common/Portal");
});

test("collectSteamCandidates joins manifests with library app maps", () => {
  const candidates = collectSteamCandidates({
    libraryFolders: libraryFoldersVdf,
    appManifests: [appManifest570Acf, appManifest400Acf],
  });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].externalId, "570");
  assert.equal(candidates[0].installPath, "C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta");
  assert.equal(candidates[1].externalId, "400");
  assert.equal(candidates[1].installPath, "D:\\SteamLibrary\\steamapps\\common\\Portal");
});

test("collectSteamCandidates falls back to pre-scanned entries", () => {
  const candidates = collectSteamCandidates({
    entries: [{ appid: 570, name: "Dota 2", installdir: "/games/dota" }],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].externalId, "570");
});

test("collectSteamCandidates returns empty when host supplied nothing", () => {
  assert.deepEqual(collectSteamCandidates({}), []);
  assert.deepEqual(collectSteamCandidates({ appManifests: [null, undefined] }), []);
});

test("scan returns empty until the host populates library data", async () => {
  const ctx = new MockClientPluginContext("drop-store-steam", ["client:library-scan"]);
  await new Plugin().init(ctx);
  const games = await ctx.storeScanners[0].scan();
  assert.deepEqual(games, []);
});

test("scanner consumes host-provided storage snapshot", async () => {
  const ctx = new MockClientPluginContext("drop-store-steam", ["client:library-scan"]);
  await ctx.storage.set("libraryfolders", libraryFoldersVdf);
  await ctx.storage.set("appManifests", [appManifest570Acf]);
  await new Plugin().init(ctx);
  const games = await ctx.storeScanners[0].scan();
  assert.equal(games.length, 1);
  assert.equal(games[0].externalId, "570");
  assert.equal(games[0].title, "Dota 2");
  assert.equal(
    games[0].installPath,
    "C:\\Program Files (x86)\\Steam\\steamapps\\common\\dota 2 beta",
  );
});
