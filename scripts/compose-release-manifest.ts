#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";

type ReleaseAsset = { name: string; browser_download_url: string };
type Release = { tag_name?: string; body?: string | null; assets: readonly ReleaseAsset[] };
export type Platform = { signature: string; url: string };
export type Manifest = { version: string; notes: string; pub_date: string; platforms: Record<string, Platform> };

const versionFromTag = (tag: string): string => {
  const match = /^tauri-v(.+)$/.exec(tag);
  if (!match) throw new Error(`Expected a tauri-vX.Y.Z tag, got ${tag}`);
  return match[1];
};

const taggedUrl = (url: string, tag: string): string =>
  url.replace(/\/download\/untagged-[^/]+\//, `/download/${encodeURIComponent(tag)}/`);

export function composeManifest(
  release: Release,
  tag: string,
  signatures: Readonly<Record<string, string>>,
  existing?: Partial<Manifest> | null,
): Manifest {
  const version = versionFromTag(tag);
  if (release.tag_name && release.tag_name !== tag) throw new Error("Release tag disagrees with requested tag");
  const metadata = existing ?? {};
  if (existing && existing.version !== undefined && typeof existing.version !== "string") throw new Error("Existing manifest version is invalid");
  if (metadata.version && metadata.version !== version) throw new Error("Existing manifest version disagrees with tag");
  const assets = new Map<string, ReleaseAsset>();
  for (const asset of release.assets) {
    if (assets.has(asset.name)) throw new Error(`Duplicate release asset: ${asset.name}`);
    assets.set(asset.name, asset);
  }
  const entries: Array<[string, string, string]> = [
    ["darwin-aarch64", "darwin-aarch64-app", "_universal.app.tar.gz"],
    ["darwin-x86_64", "darwin-x86_64-app", "_universal.app.tar.gz"],
    ["windows-x86_64", "windows-x86_64-msi", "_x64_en-US.msi"],
    ["windows-x86_64-nsis", "windows-x86_64-nsis", "_x64-setup.exe"],
    ["linux-x86_64", "linux-x86_64-deb", "_amd64.deb"],
    ["linux-x86_64-rpm", "linux-x86_64-rpm", ".x86_64.rpm"],
  ];
  const platforms: Record<string, Platform> = {};
  for (const [primary, installer, suffix] of entries) {
    const matches = [...assets.values()].filter((candidate) => candidate.name.endsWith(suffix));
    if (matches.length > 1) throw new Error(`Conflicting release assets for ${primary}: *${suffix}`);
    const asset = matches[0];
    if (!asset) throw new Error(`Missing release asset for ${primary}: *${suffix}`);
    if (!asset.browser_download_url) throw new Error(`Missing download URL for ${asset.name}`);
    const signature = signatures[`${asset.name}.sig`]?.trim();
    if (!signature) throw new Error(`Missing signature content for ${asset.name}.sig`);
    const platform = { signature, url: taggedUrl(asset.browser_download_url, tag) };
    for (const key of primary === installer ? [primary] : [primary, installer]) platforms[key] = platform;
  }
  return {
    version,
    notes: typeof metadata.notes === "string" ? metadata.notes : release.body ?? "",
    pub_date: typeof metadata.pub_date === "string" && metadata.pub_date ? metadata.pub_date : new Date().toISOString(),
    platforms,
  };
}

if (import.meta.main) {
  const [output, tag, releasePath, signatureDir, existingPath] = process.argv.slice(2);
  if (!output || !tag || !releasePath || !signatureDir) throw new Error("Usage: bun run scripts/compose-release-manifest.ts <output> <tag> <release-json> <signature-dir> [existing-json]");
  const release = JSON.parse(readFileSync(releasePath, "utf8")) as Release;
  const signatures: Record<string, string> = {};
  for (const asset of release.assets.filter((candidate) => candidate.name.endsWith(".sig"))) signatures[asset.name] = readFileSync(`${signatureDir}/${asset.name}`, "utf8");
  const existing = existingPath ? JSON.parse(readFileSync(existingPath, "utf8")) as Partial<Manifest> : null;
  writeFileSync(output, `${JSON.stringify(composeManifest(release, tag, signatures, existing), null, 2)}\n`);
}
