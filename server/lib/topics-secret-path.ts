/** Reserved server credentials are never project files, including on
 * case-insensitive filesystems. Check both the requested and real paths. */
export function isTopicsSecretPath(filePath: string): boolean {
  return filePath.split(/[\\/]/).some((part) => part.toLowerCase() === ".topics-secrets");
}
