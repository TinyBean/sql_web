/**
 * Return whether a model-authored image URL is only a local/runtime placeholder.
 * HTTP(S) and already embedded data images remain untouched; everything else
 * cannot reliably survive a browser refresh and may be hydrated from the
 * persisted code-interpreter image payload.
 */
export function isRuntimeImagePlaceholder(source: string | null): boolean {
  const normalized = source?.trim().toLowerCase() ?? "";
  return !normalized || (
    !normalized.startsWith("https://") &&
    !normalized.startsWith("http://") &&
    !normalized.startsWith("data:image/")
  );
}
