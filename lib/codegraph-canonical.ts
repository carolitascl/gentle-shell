import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The platform whose path rules apply; tests inject "win32" to exercise folding off Windows. */
export type CanonicalPlatform = typeof process.platform;

/** A backslash without a backslash literal, so this file never mangles in tool transport. */
const BS = String.fromCharCode(92);

/** One unfolded form per resolved spelling, win32 only: every realpathSync.native on a UNC path
 * is an SMB round-trip chain, so the daemon registry, the lease paths and the workspace guard pay
 * it once per spelling instead of per call. Each hit is revalidated with two metadata stats
 * before use, so a mapping can never outlive the alias it was recorded from. POSIX never
 * touches it. */
const unfoldedMemo = new Map<string, string>();

/** Tests reset the memo so a fixture rewritten between calls is read again; production never calls it. */
export function resetCanonicalMemo(): void {
	unfoldedMemo.clear();
}

/** A bare drive root (`C:` plus one separator): its separator IS the path, so folding keeps it. */
function isDriveRoot(path: string): boolean {
	return path.length === 3 && path.charCodeAt(1) === 58 && (path.endsWith(BS) || path.endsWith("/"));
}

/** Whether the spelling still resolves to the identity the memo recorded: the alias's own stat
 * follows today's link, so its dev/ino pair matching the recorded target's proves the mapping
 * survived (a retargeted junction or symlink compares unequal); any stat failure simply
 * re-walks, because validation must never throw. The stats are bigint ones: win32 ino is a
 * 64-bit file ID whose distinct values can round to the same Number, and the cache decision
 * must differ exactly when the identity does. */
function stillResolvesTo(alias: string, recorded: string): boolean {
	try {
		const aliasStat = statSync(alias, { bigint: true });
		const recordedStat = statSync(recorded, { bigint: true });
		return aliasStat.dev === recordedStat.dev && aliasStat.ino === recordedStat.ino;
	} catch {
		return false;
	}
}

/** The filesystem walk behind unfoldRoot, without the memo: the native realpath first (on Windows it
 * maps a mapped drive to its UNC target and returns the on-disk casing), the portable one next, and a
 * nearest-resolvable-parent walk last, so a missing or unreadable tail keeps the longest resolvable
 * prefix instead of failing the caller. */
function unfoldRootOnce(path: string): string {
	try {
		return realpathSync.native(path);
	} catch { /* try the portable resolver */ }
	try {
		return realpathSync(path);
	} catch { /* walk up to the nearest resolvable parent */ }
	const parent = dirname(path);
	if (parent === path) return path;
	return join(unfoldRootOnce(parent), basename(path));
}

/**
 * The true path on disk with fallbacks, never throwing. On Windows the unfolded form is remembered
 * per resolved spelling — one SMB round-trip chain per spelling instead of one per call, separator
 * variants sharing one entry — but a remembered mapping is honored only while the spelling still
 * resolves to the identity it was recorded from, so an alias retargeted to another checkout (a
 * junction or symlink flipped mid-session) re-walks instead of pinning lease and daemon identity
 * to the old target. Off Windows every call takes the filesystem walk unchanged and nothing is
 * remembered.
 */
export function unfoldRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	if (platform !== "win32") return unfoldRootOnce(path);
	const key = resolve(path);
	const memoized = unfoldedMemo.get(key);
	if (memoized !== undefined && stillResolvesTo(key, memoized)) return memoized;
	const unfolded = unfoldRootOnce(path);
	unfoldedMemo.set(key, unfolded);
	return unfolded;
}

/** Folds one real path into one comparison key: lowercased on Windows, trailing separators removed. */
export function foldRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	if (platform !== "win32") return path;
	let out = path.toLowerCase();
	while ((out.endsWith(BS) || out.endsWith("/")) && !isDriveRoot(out)) out = out.slice(0, -1);
	return out;
}

/** One directory in any spelling folds to one key: same directory, same daemon, same lock token.
 * On win32 the unfold behind the key comes from the spelling-keyed, revalidated memo. */
export function canonicalRoot(path: string, platform: CanonicalPlatform = process.platform): string {
	return foldRoot(unfoldRoot(resolve(path), platform), platform);
}
