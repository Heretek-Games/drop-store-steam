import type {
  ClientPlugin,
  ClientPluginContext,
  ScannedGame,
  StoreScanner,
} from "@droposs/plugin-sdk";

export interface StoreCandidate {
  externalId: string;
  title: string;
  installPath: string;
  executablePath?: string;
}

export interface SteamLibrary {
  path: string;
  apps: string[];
}

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

/**
 * Storage keys the desktop host (or a host-side collector) is expected to
 * populate. Reading the actual files from disk is a host responsibility: this
 * plugin has no arbitrary filesystem access and never probes the OS.
 *
 * - `libraryfolders`: raw contents of `<steam>/steamapps/libraryfolders.vdf`
 * - `appManifests`: raw contents of each `steamapps/appmanifest_<appid>.acf`
 * - `library`: optional pre-normalized candidate array (legacy fallback)
 */
export const STEAM_STORAGE_KEYS = {
  libraryFolders: "libraryfolders",
  appManifests: "appManifests",
  library: "library",
} as const;

function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

function tokenize(input: string): string[] {
  const source = stripBom(input);
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "{") {
      tokens.push("{");
      i += 1;
      continue;
    }
    if (ch === "}") {
      tokens.push("}");
      i += 1;
      continue;
    }
    if (ch === '"') {
      i += 1;
      let value = "";
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) {
          const escaped = source[i + 1];
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
          i += 2;
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) {
        throw new Error("Unterminated quoted string in VDF");
      }
      i += 1;
      tokens.push(value);
      continue;
    }
    const start = i;
    while (i < source.length && !/[\s{}"]/.test(source[i])) i += 1;
    if (i === start) {
      throw new Error(`Unexpected character in VDF: ${ch}`);
    }
    tokens.push(source.slice(start, i));
  }
  return tokens;
}

/**
 * Parse Valve KeyValues (VDF) text, as used by Steam's `libraryfolders.vdf`
 * and `appmanifest_*.acf` files. Returns the single top-level object.
 */
export function parseVdf(input: string): VdfObject {
  const tokens = tokenize(input);
  const cursor = { index: 0 };
  const root: VdfObject = {};
  while (cursor.index < tokens.length) {
    const key = tokens[cursor.index];
    cursor.index += 1;
    if (key === "}") {
      throw new Error("Unexpected closing brace in VDF");
    }
    root[key] = parseVdfValue(tokens, cursor);
  }
  return root;
}

function parseVdfValue(tokens: string[], cursor: { index: number }): VdfValue {
  const token = tokens[cursor.index];
  if (token === "{") {
    cursor.index += 1;
    const object: VdfObject = {};
    while (cursor.index < tokens.length && tokens[cursor.index] !== "}") {
      const key = tokens[cursor.index];
      cursor.index += 1;
      object[key] = parseVdfValue(tokens, cursor);
    }
    if (tokens[cursor.index] !== "}") {
      throw new Error("Unterminated VDF object");
    }
    cursor.index += 1;
    return object;
  }
  if (token === undefined || token === "}") {
    throw new Error("Missing VDF value");
  }
  cursor.index += 1;
  return token;
}

function asObject(value: VdfValue | undefined): VdfObject | undefined {
  return typeof value === "object" && value !== null ? value : undefined;
}

function readString(value: VdfValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse `libraryfolders.vdf` (both the modern per-library objects and the
 * legacy `"1" "/path"` shape) into library paths with their app ids.
 */
export function parseLibraryFoldersVdf(content: string): SteamLibrary[] {
  const root = parseVdf(content);
  const container =
    asObject(root["libraryfolders"]) ??
    asObject(root["LibraryFolders"]) ??
    asObject(root["libraryfoldersv2"]);
  if (!container) {
    return [];
  }
  const libraries: SteamLibrary[] = [];
  for (const [key, value] of Object.entries(container)) {
    if (typeof value === "string") {
      if (!/^\d+$/.test(key) || value.trim().length === 0) continue;
      libraries.push({ path: value, apps: [] });
      continue;
    }
    const path = readString(value["path"]);
    if (!path) continue;
    const appsObject = asObject(value["apps"]);
    libraries.push({ path, apps: appsObject ? Object.keys(appsObject) : [] });
  }
  return libraries;
}

function separatorFor(parts: string[]): string {
  return parts.some((part) => part.includes("\\")) ? "\\" : "/";
}

/** Join path segments using the separator style found in the inputs. */
export function joinPath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) return "";
  const separator = separatorFor(filtered);
  return filtered
    .map((part, index) => {
      let segment = part;
      if (index > 0) segment = segment.replace(/^[\\/]+/, "");
      if (index < filtered.length - 1) segment = segment.replace(/[\\/]+$/, "");
      return segment;
    })
    .join(separator);
}

export function joinSteamCommon(libraryPath: string, installDir: string): string {
  return joinPath(libraryPath, "steamapps", "common", installDir);
}

/**
 * Parse a `steamapps/appmanifest_<appid>.acf` file. `installPath` is the raw
 * `installdir` unless a library path is supplied, in which case the canonical
 * `steamapps/common/<installdir>` path is resolved.
 */
export function parseAppManifestAcf(
  content: string,
  libraryPath?: string,
): StoreCandidate | null {
  const root = parseVdf(content);
  const state = asObject(root["AppState"]) ?? root;
  const appId = readString(state["appid"]);
  if (!appId) return null;
  const installDir = readString(state["installdir"]) ?? "";
  const title = readString(state["name"]) ?? (installDir || "Unknown");
  const installPath =
    libraryPath && installDir ? joinSteamCommon(libraryPath, installDir) : installDir;
  return { externalId: appId, title, installPath };
}

/**
 * Normalize a pre-scanned candidate array (legacy/fallback source). Only
 * values explicitly present are copied; executable paths are never guessed.
 */
export function parseLibraryEntries(payload: unknown): StoreCandidate[] {
  const entries = (Array.isArray(payload) ? payload : []) as Array<
    Record<string, unknown>
  >;
  return entries
    .map((entry) => ({
      externalId: String(entry.appid ?? entry.id ?? entry.externalId ?? ""),
      title: String(entry.name ?? entry.title ?? "Unknown"),
      installPath: String(entry.installdir ?? entry.installPath ?? ""),
      executablePath: entry.executablePath
        ? String(entry.executablePath)
        : undefined,
    }))
    .filter((entry) => entry.externalId.length > 0);
}

export interface SteamSnapshot {
  libraryFolders?: string | null;
  appManifests?: Array<string | null | undefined> | null;
  entries?: unknown;
}

/**
 * Combine the raw Steam artifacts into candidates. Returns an empty array when
 * the host supplied nothing: library discovery itself requires host-side file
 * access (see README "Host requirements").
 */
export function collectSteamCandidates(snapshot: SteamSnapshot): StoreCandidate[] {
  const candidates: StoreCandidate[] = [];
  const libraries = snapshot.libraryFolders
    ? parseLibraryFoldersVdf(snapshot.libraryFolders)
    : [];
  const libraryByApp = new Map<string, string>();
  for (const library of libraries) {
    for (const appId of library.apps) {
      if (!libraryByApp.has(appId)) libraryByApp.set(appId, library.path);
    }
  }
  for (const manifest of snapshot.appManifests ?? []) {
    if (!manifest) continue;
    let candidate: StoreCandidate | null = null;
    try {
      candidate = parseAppManifestAcf(manifest);
    } catch {
      candidate = null;
    }
    if (!candidate) continue;
    const libraryPath = libraryByApp.get(candidate.externalId);
    if (libraryPath && candidate.installPath.length > 0) {
      candidate.installPath = joinSteamCommon(libraryPath, candidate.installPath);
    }
    candidates.push(candidate);
  }
  if (candidates.length === 0) {
    candidates.push(...parseLibraryEntries(snapshot.entries));
  }
  return candidates;
}

/**
 * Steam library scanner. Detection is injected so it can be unit-tested
 * without touching the filesystem; the desktop host provides real data by
 * reading `libraryfolders.vdf` and `appmanifest_*.acf` and exposing them via
 * plugin storage. `scan()` returns `[]` when the host has not populated that
 * data.
 */
export class SteamScanner implements StoreScanner {
  id = "steam";
  name = "Steam";
  store = "steam";

  constructor(
    private readonly detect: () => Promise<StoreCandidate[]>,
  ) {}

  async scan(): Promise<ScannedGame[]> {
    const candidates = await this.detect();
    return candidates.map((candidate) => ({
      externalId: candidate.externalId,
      store: "steam",
      title: candidate.title,
      installPath: candidate.installPath,
      executablePath: candidate.executablePath,
    }));
  }
}

export async function detectFromStorage(
  ctx: ClientPluginContext,
): Promise<StoreCandidate[]> {
  const [libraryFolders, appManifests, entries] = await Promise.all([
    ctx.storage.get<string>(STEAM_STORAGE_KEYS.libraryFolders),
    ctx.storage.get<Array<string>>(STEAM_STORAGE_KEYS.appManifests),
    ctx.storage.get<unknown>(STEAM_STORAGE_KEYS.library),
  ]);
  return collectSteamCandidates({ libraryFolders, appManifests, entries });
}

export default class SteamPlugin implements ClientPlugin {
  metadata = {
    apiVersion: 2,
    id: "drop-store-steam",
    name: "Steam",
    version: "0.1.0",
  };

  async init(ctx: ClientPluginContext): Promise<void> {
    const scanner = new SteamScanner(() => detectFromStorage(ctx));
    ctx.registerStoreScanner(scanner);
    ctx.logger.info("Steam store scanner registered");
  }
}
