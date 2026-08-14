import { fileURLToPath } from 'node:url';
import { createRuntimeHostServiceCatalog } from '../../runtime-host-service-catalog.js';
import { startManagedRuntimeHostService } from '../../runtime-host-service-manager.js';

const [clientDataRoot, ...configIds] = process.argv.slice(2);
if (!clientDataRoot || configIds.length === 0) {
  throw new Error('Managed Runtime Host fixture requires a client data root and config ids');
}
const catalog = await createRuntimeHostServiceCatalog(clientDataRoot).read();
const configs = configIds.map((configId) => {
  const config = catalog.configs.find(({ id }) => id === configId);
  if (!config) throw new Error(`Managed Runtime Host fixture config does not exist: ${configId}`);
  return config;
});
const entrypoint = fileURLToPath(new URL('../../cli.js', import.meta.url));
const results = await Promise.all(
  configs.map((config) => startManagedRuntimeHostService(config, { clientDataRoot, entrypoint })),
);
if (results.some((result) => result.kind !== 'started' && result.kind !== 'already_running')) {
  throw new Error(
    `Managed Runtime Host fixture could not start every config: ${JSON.stringify(results)}`,
  );
}
