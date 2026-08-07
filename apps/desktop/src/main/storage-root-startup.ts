import {
  prepareStorageRootIdentityRepair,
  repairStorageRootIdentity,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import {
  migrateOperationalStateDatabaseForOwner,
  operationalStateRequiresExclusiveMigration,
} from '@maka/storage';

export interface DesktopStorageRootRecovery {
  confirmRepair(): Promise<boolean>;
}

export async function resolveDesktopStorageRoot(
  path: string,
  recovery: DesktopStorageRootRecovery,
): Promise<StorageRootCapability<'interactive'> | undefined> {
  let capability: StorageRootCapability<'interactive'>;
  try {
    capability = await resolveStorageRoot({ path, kind: 'interactive' });
  } catch (error) {
    if (
      !(error instanceof StorageRootAuthorityError) ||
      error.code !== 'root_identity_collision'
    ) {
      throw error;
    }
    const candidate = await prepareStorageRootIdentityRepair({
      path,
      kind: 'interactive',
    });
    if (!candidate) capability = await resolveStorageRoot({ path, kind: 'interactive' });
    else {
      if (!(await recovery.confirmRepair())) return undefined;
      capability = await repairStorageRootIdentity(candidate);
    }
  }
  await migrateDesktopOperationalStateIfRequired(capability);
  return capability;
}

async function migrateDesktopOperationalStateIfRequired(
  capability: StorageRootCapability<'interactive'>,
): Promise<void> {
  if (!operationalStateRequiresExclusiveMigration(capability.canonicalPath)) return;
  const owner = await tryAcquireInteractiveRootOwner(capability);
  if (!owner) {
    throw new StorageRootAuthorityError(
      'lock_failed',
      'Desktop storage requires an operational schema migration; close older processes before retrying',
    );
  }
  try {
    if (!operationalStateRequiresExclusiveMigration(capability.canonicalPath)) return;
    await migrateOperationalStateDatabaseForOwner(owner);
  } finally {
    await owner.close();
  }
}
