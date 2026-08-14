import {
  installRuntimeHostLogCapture,
  runRuntimeHostProcessLifecycle,
  startExecutionRuntimeHostService,
  type ExecutionRuntimeHostServiceOptions,
} from '@maka/runtime-host/server';
import {
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import { readFile } from 'node:fs/promises';
import {
  createRuntimeHostServiceCatalog,
  runtimeHostServiceConfigRevision,
} from './runtime-host-service-catalog.js';

interface RuntimeHostServiceCliCommonOptions {
  readonly json?: boolean;
}

export type RuntimeHostServiceCliOptions = RuntimeHostServiceCliCommonOptions &
  (
    | {
        readonly rootPath: string;
        readonly managedConfigId?: never;
        readonly clientDataRoot?: never;
        readonly websocket?: RuntimeHostServiceWebSocketCliOptions;
      }
    | {
        readonly managedConfigId: string;
        readonly clientDataRoot: string;
        readonly rootPath?: never;
        readonly websocket?: never;
      }
  );

interface RuntimeHostServiceWebSocketCliOptions {
  readonly host: string;
  readonly port: number;
  readonly path?: string;
  readonly tlsCertificatePath?: string;
  readonly tlsPrivateKeyPath?: string;
  readonly allowInsecureRemote?: boolean;
  readonly allowedOrigins?: readonly string[];
}

export async function runRuntimeHostServiceCli(
  options: RuntimeHostServiceCliOptions,
): Promise<number> {
  installRuntimeHostLogCapture();
  const serviceOptions = await resolveRuntimeHostServiceOptions(options);
  const host = await startExecutionRuntimeHostService(serviceOptions);
  await runRuntimeHostProcessLifecycle(host, {
    onReady: () => {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(createRuntimeHostServiceReadyEvent(host))}\n`);
        return;
      }
      process.stdout.write(`Runtime Host service is ready at ${host.endpoint}\n`);
      for (const endpoint of host.websocketEndpoints) {
        process.stdout.write(`Runtime Host WebSocket is ready at ${endpoint}\n`);
      }
    },
  });
  return 0;
}

async function resolveRuntimeHostServiceOptions(
  options: RuntimeHostServiceCliOptions,
): Promise<ExecutionRuntimeHostServiceOptions> {
  if (options.managedConfigId !== undefined) {
    const catalog = await createRuntimeHostServiceCatalog(options.clientDataRoot).read();
    const config = catalog.configs.find(({ id }) => id === options.managedConfigId);
    if (!config) {
      throw new Error(`Runtime Host service config does not exist: ${options.managedConfigId}`);
    }
    const transport = config.transport;
    const websocket = {
      host: transport.bindHost,
      port: transport.port,
      path: transport.path,
      ...('allowedOrigins' in transport ? { allowedOrigins: transport.allowedOrigins } : {}),
      ...(transport.kind === 'plaintext' ? { allowInsecureRemote: true } : {}),
      ...(transport.kind === 'tls'
        ? {
            tls: {
              certificate: await readFile(transport.certificatePath),
              privateKey: await readFile(transport.privateKeyPath),
            },
          }
        : {}),
    };
    return {
      rootPath: config.rootPath,
      expectedRootId: config.expectedRootId,
      serviceIdentity: {
        configId: config.id,
        configRevision: runtimeHostServiceConfigRevision(config),
      },
      websocket,
    };
  }
  const websocket = options.websocket
    ? {
        host: options.websocket.host,
        port: options.websocket.port,
        ...(options.websocket.path ? { path: options.websocket.path } : {}),
        ...(options.websocket.allowedOrigins
          ? { allowedOrigins: options.websocket.allowedOrigins }
          : {}),
        ...(options.websocket.allowInsecureRemote ? { allowInsecureRemote: true } : {}),
        ...(options.websocket.tlsCertificatePath && options.websocket.tlsPrivateKeyPath
          ? {
              tls: {
                certificate: await readFile(options.websocket.tlsCertificatePath),
                privateKey: await readFile(options.websocket.tlsPrivateKeyPath),
              },
            }
          : {}),
      }
    : undefined;
  return {
    rootPath: options.rootPath,
    ...(websocket ? { websocket } : {}),
  };
}

export interface RuntimeHostServiceReadyEvent {
  readonly schemaVersion: 1;
  readonly event: 'runtime_host_ready';
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly protocol: {
    readonly version: number;
    readonly compatibilityEpoch: number;
  };
  readonly composition: {
    readonly id: string;
    readonly revision: string;
  };
  readonly listeners: readonly (
    | { readonly kind: 'local_ipc'; readonly endpoint: string }
    | {
        readonly kind: 'websocket';
        readonly tls: boolean;
        readonly host: string;
        readonly port: number;
        readonly path: string;
      }
  )[];
}

export function createRuntimeHostServiceReadyEvent(host: {
  readonly rootId: string;
  readonly hostEpoch: string;
  readonly endpoint: string;
  readonly websocketEndpoints: readonly string[];
  readonly compositionDescriptor: { readonly id: string; readonly revision: string };
}): RuntimeHostServiceReadyEvent {
  return {
    schemaVersion: 1,
    event: 'runtime_host_ready',
    rootId: host.rootId,
    hostEpoch: host.hostEpoch,
    protocol: {
      version: RUNTIME_HOST_PROTOCOL_VERSION,
      compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    },
    composition: host.compositionDescriptor,
    listeners: [
      { kind: 'local_ipc', endpoint: host.endpoint },
      ...host.websocketEndpoints.map((endpoint) => {
        const url = new URL(endpoint);
        return {
          kind: 'websocket' as const,
          tls: url.protocol === 'wss:',
          host: url.hostname,
          port: url.port === '' ? (url.protocol === 'wss:' ? 443 : 80) : Number(url.port),
          path: url.pathname,
        };
      }),
    ],
  };
}
