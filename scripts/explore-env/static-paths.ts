import path from "node:path";

/**
 * The file a request path names inside `root`, or undefined when it cannot be decoded or would
 * leave `root` (`..`, encoded or not). Pure, so the traversal guard is tested on its own
 * (`static-paths.test.ts`); `static-server.ts` then checks the file exists.
 */
export function resolveRequestPath(root: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) {
    return undefined;
  }
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, `.${path.posix.normalize(`/${decoded}`)}`);
  if (candidate !== absoluteRoot && !candidate.startsWith(`${absoluteRoot}${path.sep}`)) {
    return undefined;
  }
  return candidate;
}
