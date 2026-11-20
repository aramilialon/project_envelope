/**
 * Directories and files that hold a disposable environment's secrets (the run root with its
 * manifests, the instance's configuration directory with its passwords) must belong to the user
 * running this tool and be closed to everyone else (#536). A symlink is refused outright, so a
 * directory in a shared place like `$TMPDIR` cannot be redirected somewhere else by another user.
 */
import { lstat, mkdir } from "node:fs/promises";

function owner(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** Creates `dir` (mode 0700) if it is missing, then checks it is a private directory of ours. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await assertPrivate(dir, "directory");
}

/** Checks `target` is a directory or regular file (not a symlink), ours, with no group or other permission bits. */
export async function assertPrivate(target: string, kind: "directory" | "file"): Promise<void> {
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to use ${target}: it is a symbolic link`);
  }
  if (kind === "directory" ? !info.isDirectory() : !info.isFile()) {
    throw new Error(`Refusing to use ${target}: it is not a ${kind}`);
  }
  const uid = owner();
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`Refusing to use ${target}: it belongs to another user (uid ${info.uid})`);
  }
  if ((info.mode & 0o077) !== 0) {
    throw new Error(`Refusing to use ${target}: its mode ${(info.mode & 0o777).toString(8)} lets other users in (expected no group or other bits)`);
  }
}
