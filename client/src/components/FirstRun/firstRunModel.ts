import type { ProviderSnapshotEntry, ProviderStatus } from '../../../../shared/types';

// The owner is born with this name (migration 084): while it stands, the installation is on its first opening.
export const OWNER_PLACEHOLDER_NAME = 'Proprietario';

export function shouldShowFirstRun(firstRunDoneAt: string | null, ownerName: string | null): boolean {
  return !firstRunDoneAt && ownerName === OWNER_PLACEHOLDER_NAME;
}

export function firstRunProviderView(
  providers: ProviderSnapshotEntry[],
  configuredProvider: string | null,
): {
  provider: ProviderSnapshotEntry | null;
  providerName: string | null;
  status: ProviderStatus | 'missing';
  ready: boolean;
  showAnthropicKey: boolean;
  requirements: ProviderSnapshotEntry['requirements'];
} {
  const provider = providers.find((entry) => entry.isDefault)
    ?? providers.find((entry) => entry.name === configuredProvider)
    ?? null;
  return {
    provider,
    providerName: provider?.label ?? provider?.name ?? configuredProvider,
    status: provider?.status ?? 'missing',
    ready: provider?.status === 'ready',
    showAnthropicKey: !providers.some((entry) => entry.status === 'ready'),
    requirements: provider?.requirements.filter((requirement) => !requirement.present) ?? [],
  };
}
