import {
  Input,
  Key,
  ProcessTerminal,
  SelectList,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type SelectItem,
  type Terminal,
} from '@earendil-works/pi-tui';
import { resolveStorageRoot } from '@maka/storage/root-authority';
import { isAbsolute } from 'node:path';
import {
  REMOTE_OWNER_OPERATION_GRANTS,
  type AccessCredentialMetadata,
  type OperationKey,
  type ProjectCatalogProjectDetails,
} from '@maka/runtime-host/protocol';
import {
  createManagedRuntimeHostServiceConfig,
  createRuntimeHostServiceCatalog,
  runtimeHostServiceClientTransport,
  updateManagedRuntimeHostServiceConfig,
  type ManagedRuntimeHostServiceConfig,
  type ManagedRuntimeHostTransport,
  type RuntimeHostServiceCatalog,
} from './runtime-host-service-catalog.js';
import {
  inspectManagedRuntimeHostService,
  startManagedRuntimeHostService,
  stopManagedRuntimeHostService,
  type ManagedRuntimeHostServiceState,
} from './runtime-host-service-manager.js';
import {
  addManagedRuntimeHostProject,
  issueManagedRuntimeHostCredential,
  listManagedRuntimeHostCredentials,
  listManagedRuntimeHostProjects,
  revokeManagedRuntimeHostCredential,
  RUNTIME_HOST_PERMISSION_PACKS,
  type RuntimeHostPermissionPackId,
} from './runtime-host-service-operations.js';
import { ansi, selectListTheme } from './tui-ansi.js';

export interface RunRuntimeHostManagerTuiInput {
  readonly clientDataRoot: string;
  readonly cliCommand: string;
  readonly terminal?: Terminal;
}

export async function runRuntimeHostManagerTui(
  input: RunRuntimeHostManagerTuiInput,
): Promise<number> {
  if (!input.terminal && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Runtime Host Manager requires an interactive terminal');
  }
  const terminal = input.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal, true);
  const catalog = createRuntimeHostServiceCatalog(input.clientDataRoot);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const manager = new RuntimeHostManagerComponent(
    tui,
    catalog,
    input.clientDataRoot,
    input.cliCommand,
    resolveClosed,
  );
  const close = () => manager.close(true);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  tui.addChild(manager);
  tui.setFocus(manager);
  terminal.setTitle('Maka — Runtime Host Manager');
  try {
    tui.start();
    manager.start();
    await closed;
    return 0;
  } finally {
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    tui.stop();
    await terminal.drainInput().catch(() => undefined);
  }
}

type ManagerMode = 'menu' | 'input' | 'permissions' | 'secret';

class RuntimeHostManagerComponent implements Component {
  focused = false;
  readonly #input = new Input();
  #mode: ManagerMode = 'menu';
  #list = new SelectList([], 14, selectListTheme());
  #title = 'Runtime Host Manager';
  #lines: string[] = [];
  #inputLabel = '';
  #busy: string | undefined;
  #notice: { readonly tone: 'info' | 'error'; readonly text: string } | undefined;
  #closed = false;
  #credentialIssuanceActive = false;
  #onBack: () => void = () => this.close();
  #permissions: OperationKey[] = [];
  #permissionSelection = new Set<OperationKey>();
  #permissionIndex = 0;
  #permissionConfig: ManagedRuntimeHostServiceConfig | undefined;
  #secret: { readonly credential: string; readonly details: readonly string[] } | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly catalog: RuntimeHostServiceCatalog,
    private readonly clientDataRoot: string,
    private readonly cliCommand: string,
    private readonly onClose: () => void,
  ) {}

  start(): void {
    void this.#refreshServices();
  }

  close(force = false): void {
    if (this.#closed) return;
    if (this.#credentialIssuanceActive && !force) {
      this.#notice = {
        tone: 'info',
        text: 'Wait for the one-time credential to be delivered before closing',
      };
      this.tui.requestRender();
      return;
    }
    this.#closed = true;
    this.#secret = undefined;
    this.onClose();
  }

  invalidate(): void {
    this.#list.invalidate();
    this.#input.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.close();
      return;
    }
    if (this.#busy) return;
    if (this.#mode === 'input') {
      this.#input.handleInput(data);
      return;
    }
    if (this.#mode === 'permissions') {
      this.#handlePermissionInput(data);
      return;
    }
    if (this.#mode === 'secret') {
      if (
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.return) ||
        matchesKey(data, Key.escape)
      ) {
        this.#secret = undefined;
        this.#onBack();
      }
      return;
    }
    this.#list.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const output = [
      line(ansi.bold(this.#title), safeWidth),
      line(
        ansi.dim('Persistent configs · local-owner control · Esc back · Ctrl-C exit'),
        safeWidth,
      ),
      line('', safeWidth),
      ...this.#lines.map((value) => line(value, safeWidth)),
    ];
    if (this.#notice) {
      output.push(
        line(
          this.#notice.tone === 'error'
            ? ansi.red(this.#notice.text)
            : ansi.green(this.#notice.text),
          safeWidth,
        ),
        line('', safeWidth),
      );
    }
    if (this.#busy) {
      output.push(line(ansi.accent(`● ${this.#busy}`), safeWidth));
    } else if (this.#mode === 'input') {
      this.#input.focused = this.focused;
      output.push(
        line(ansi.accent(this.#inputLabel), safeWidth),
        ...this.#input.render(safeWidth).map((value) => line(value, safeWidth)),
      );
    } else if (this.#mode === 'permissions') {
      output.push(...this.#renderPermissions(safeWidth));
    } else if (this.#mode === 'secret') {
      output.push(...this.#renderSecret(safeWidth));
    } else {
      output.push(...this.#list.render(safeWidth).map((value) => line(value, safeWidth)));
    }
    output.push(line(ansi.accent('─'.repeat(safeWidth)), safeWidth));
    return output;
  }

  async #refreshServices(): Promise<void> {
    this.#run(
      'Detecting configured Runtime Hosts…',
      async () => {
        const document = await this.catalog.read();
        const states = await Promise.all(
          document.configs.map(async (config) => ({
            config,
            state: await inspectManagedRuntimeHostService(config),
          })),
        );
        return states;
      },
      (states) => {
        const items: SelectItem[] = states.map(({ config, state }) => ({
          value: `config:${config.id}`,
          label: config.name,
          description: `${stateLabel(state)} · ${config.id} · ${transportLabel(config.transport)}`,
        }));
        items.push(
          {
            value: 'create',
            label: 'Create a Runtime Host',
            description: 'Add a persistent config',
          },
          { value: 'refresh', label: 'Refresh', description: 'Re-detect all configured Hosts' },
          { value: 'exit', label: 'Exit' },
        );
        this.#menu('Runtime Host Manager', ['Select a Host to manage it.'], items, (item) => {
          if (item.value === 'create') return this.#beginConfigWizard();
          if (item.value === 'refresh') return void this.#refreshServices();
          if (item.value === 'exit') return this.close();
          const id = item.value.slice('config:'.length);
          const selected = states.find(({ config }) => config.id === id);
          if (selected) void this.#showService(selected.config);
        });
      },
    );
  }

  async #showService(config: ManagedRuntimeHostServiceConfig): Promise<void> {
    this.#run(
      `Inspecting ${config.name}…`,
      () => inspectManagedRuntimeHostService(config),
      (state) => {
        const items: SelectItem[] = [];
        if (state.kind === 'stopped') {
          items.push({
            value: 'start',
            label: 'Start',
            description: 'Launch as a detached service',
          });
        }
        if (state.kind === 'running') {
          items.push(
            { value: 'stop', label: 'Stop', description: 'Ask this exact Host to drain and exit' },
            { value: 'restart', label: 'Restart', description: 'Stop, then launch current config' },
            {
              value: 'projects',
              label: 'Projects',
              description: 'Register and inspect Host projects',
            },
            {
              value: 'credentials',
              label: 'Credentials',
              description: 'Issue and revoke remote access',
            },
          );
        }
        if (state.kind === 'stopped') {
          items.push(
            { value: 'edit', label: 'Edit', description: 'Change name or listener settings' },
            {
              value: 'remove',
              label: 'Remove config',
              description: 'Keep State Root data untouched',
            },
          );
        }
        items.push(
          { value: 'connection', label: 'Connection details' },
          { value: 'back', label: 'Back' },
        );
        this.#menu(
          config.name,
          [
            `${ansi.dim('Status')}  ${stateLabel(state)}`,
            `${ansi.dim('Root')}    ${config.rootPath}`,
            `${ansi.dim('Root ID')} ${config.expectedRootId}`,
          ],
          items,
          (item) => {
            switch (item.value) {
              case 'start':
                this.#run(
                  'Starting detached Runtime Host…',
                  async () => {
                    const result = await startManagedRuntimeHostService(config, {
                      clientDataRoot: this.clientDataRoot,
                    });
                    if (result.kind !== 'started' && result.kind !== 'already_running') {
                      throw new Error(`Runtime Host could not be started (${result.kind})`);
                    }
                  },
                  () => this.#showService(config),
                  'Runtime Host started',
                );
                break;
              case 'stop':
                this.#run(
                  'Stopping Runtime Host…',
                  async () => {
                    const result = await stopManagedRuntimeHostService(config);
                    if (result.kind !== 'stopped' && result.kind !== 'already_stopped') {
                      throw new Error(`Runtime Host could not be stopped (${result.kind})`);
                    }
                  },
                  () => this.#showService(config),
                  'Runtime Host stopped',
                );
                break;
              case 'restart':
                this.#run(
                  'Restarting Runtime Host…',
                  async () => {
                    const stopped = await stopManagedRuntimeHostService(config);
                    if (stopped.kind !== 'stopped' && stopped.kind !== 'already_stopped') {
                      throw new Error(
                        `Runtime Host restart could not stop the service (${stopped.kind})`,
                      );
                    }
                    const started = await startManagedRuntimeHostService(config, {
                      clientDataRoot: this.clientDataRoot,
                    });
                    if (started.kind !== 'started' && started.kind !== 'already_running') {
                      throw new Error(
                        `Runtime Host restart could not start the service (${started.kind})`,
                      );
                    }
                  },
                  () => this.#showService(config),
                  'Runtime Host restarted',
                );
                break;
              case 'projects':
                void this.#showProjects(config);
                break;
              case 'credentials':
                void this.#showCredentials(config);
                break;
              case 'edit':
                this.#beginConfigWizard(config);
                break;
              case 'remove':
                this.#confirmRemove(config);
                break;
              case 'connection':
                this.#showConnectionDetails(config);
                break;
              default:
                void this.#refreshServices();
            }
          },
          () => void this.#refreshServices(),
        );
      },
    );
  }

  #beginConfigWizard(existing?: ManagedRuntimeHostServiceConfig): void {
    const draft: ConfigDraft = existing
      ? { id: existing.id, name: existing.name, rootPath: existing.rootPath }
      : { id: '', name: '', rootPath: '' };
    const askName = () =>
      this.#prompt(
        existing ? 'Edit Runtime Host' : 'Create Runtime Host',
        existing ? `Name (current: ${existing.name}; blank keeps it)` : 'Display name',
        (value) => {
          const name = value.trim() || existing?.name || '';
          if (!name) throw new Error('Display name is required');
          draft.name = name;
          if (existing) this.#chooseTransport(draft, existing);
          else askRoot();
        },
        () => void (existing ? this.#showService(existing) : this.#refreshServices()),
      );
    const askRoot = () =>
      this.#prompt(
        'Create Runtime Host',
        'State Root (absolute path)',
        (value) => {
          if (!isAbsolute(value.trim())) throw new Error('State Root must be an absolute path');
          draft.rootPath = value.trim();
          this.#chooseTransport(draft);
        },
        askName,
      );
    if (existing) askName();
    else {
      this.#prompt(
        'Create Runtime Host',
        'Config ID (letters, numbers, dot, underscore, dash)',
        (value) => {
          draft.id = value.trim();
          if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(draft.id)) {
            throw new Error('Config ID is invalid');
          }
          askName();
        },
        () => void this.#refreshServices(),
      );
    }
  }

  #chooseTransport(draft: ConfigDraft, existing?: ManagedRuntimeHostServiceConfig): void {
    this.#menu(
      existing ? 'Edit Runtime Host' : 'Create Runtime Host',
      ['Choose how remote Clients reach this Host.'],
      [
        {
          value: 'ssh',
          label: 'SSH tunnel',
          description: 'Recommended; listener stays on loopback',
        },
        { value: 'tls', label: 'TLS (WSS)', description: 'Direct authenticated TLS listener' },
        {
          value: 'plaintext',
          label: 'Plaintext (WS)',
          description: 'Explicitly acknowledge bearer-token risk',
        },
      ],
      (item) => {
        if (item.value === 'ssh') this.#configureSsh(draft, existing);
        if (item.value === 'tls') this.#configureTls(draft, existing);
        if (item.value === 'plaintext') this.#confirmPlaintext(draft, existing);
      },
      () => this.#beginConfigWizard(existing),
    );
  }

  #configureSsh(draft: ConfigDraft, existing?: ManagedRuntimeHostServiceConfig): void {
    this.#prompt(
      'SSH tunnel',
      'Listener port (default: 7443)',
      (portValue) => {
        const port = parsePort(portValue, 7443);
        this.#prompt(
          'SSH tunnel',
          'SSH destination (for example operator@host)',
          (destination) => {
            const sshDestination = destination.trim();
            if (!sshDestination) throw new Error('SSH destination is required');
            void this.#saveConfig(
              draft,
              {
                kind: 'ssh',
                bindHost: '127.0.0.1',
                port,
                path: '/runtime-host',
                sshDestination,
              },
              existing,
            );
          },
          () => this.#chooseTransport(draft, existing),
        );
      },
      () => this.#chooseTransport(draft, existing),
    );
  }

  #configureTls(draft: ConfigDraft, existing?: ManagedRuntimeHostServiceConfig): void {
    this.#prompt(
      'TLS listener',
      'Bind host (default: 0.0.0.0)',
      (bindValue) => {
        const bindHost = bindValue.trim() || '0.0.0.0';
        this.#prompt(
          'TLS listener',
          'Public hostname or IP',
          (publicValue) => {
            const publicHost = publicValue.trim();
            if (!publicHost) throw new Error('Public host is required');
            this.#prompt(
              'TLS listener',
              'Port (default: 7443)',
              (portValue) => {
                const port = parsePort(portValue, 7443);
                this.#prompt(
                  'TLS listener',
                  'TLS certificate path',
                  (certificateValue) => {
                    const certificatePath = certificateValue.trim();
                    if (!isAbsolute(certificatePath))
                      throw new Error('Certificate path must be absolute');
                    this.#prompt(
                      'TLS listener',
                      'TLS private key path',
                      (keyValue) => {
                        const privateKeyPath = keyValue.trim();
                        if (!isAbsolute(privateKeyPath))
                          throw new Error('Private key path must be absolute');
                        this.#prompt(
                          'TLS listener',
                          'Allowed browser Origins (comma-separated; blank for none)',
                          (originValue) => {
                            void this.#saveConfig(
                              draft,
                              {
                                kind: 'tls',
                                bindHost,
                                port,
                                path: '/runtime-host',
                                publicHost,
                                certificatePath,
                                privateKeyPath,
                                allowedOrigins: splitOrigins(originValue),
                              },
                              existing,
                            );
                          },
                          () => this.#chooseTransport(draft, existing),
                        );
                      },
                      () => this.#chooseTransport(draft, existing),
                    );
                  },
                  () => this.#chooseTransport(draft, existing),
                );
              },
              () => this.#chooseTransport(draft, existing),
            );
          },
          () => this.#chooseTransport(draft, existing),
        );
      },
      () => this.#chooseTransport(draft, existing),
    );
  }

  #confirmPlaintext(draft: ConfigDraft, existing?: ManagedRuntimeHostServiceConfig): void {
    this.#menu(
      'Plaintext listener',
      [ansi.yellow('Credentials and traffic are exposed without an external encrypted tunnel.')],
      [
        { value: 'continue', label: 'I understand; continue' },
        { value: 'back', label: 'Back' },
      ],
      (item) => {
        if (item.value === 'back') return this.#chooseTransport(draft, existing);
        this.#configurePlaintext(draft, existing);
      },
      () => this.#chooseTransport(draft, existing),
    );
  }

  #configurePlaintext(draft: ConfigDraft, existing?: ManagedRuntimeHostServiceConfig): void {
    this.#prompt(
      'Plaintext listener',
      'Bind host (default: 127.0.0.1)',
      (bindValue) => {
        const bindHost = bindValue.trim() || '127.0.0.1';
        this.#prompt(
          'Plaintext listener',
          'Public hostname or IP (default: bind host)',
          (publicValue) => {
            const publicHost = publicValue.trim() || bindHost;
            this.#prompt(
              'Plaintext listener',
              'Port (default: 7443)',
              (portValue) => {
                void this.#saveConfig(
                  draft,
                  {
                    kind: 'plaintext',
                    bindHost,
                    port: parsePort(portValue, 7443),
                    path: '/runtime-host',
                    publicHost,
                    allowedOrigins: [],
                    acknowledgement: 'plaintext-bearer-v1',
                  },
                  existing,
                );
              },
              () => this.#chooseTransport(draft, existing),
            );
          },
          () => this.#chooseTransport(draft, existing),
        );
      },
      () => this.#chooseTransport(draft, existing),
    );
  }

  async #saveConfig(
    draft: ConfigDraft,
    transport: ManagedRuntimeHostTransport,
    existing?: ManagedRuntimeHostServiceConfig,
  ): Promise<void> {
    this.#run(
      existing ? 'Saving Runtime Host config…' : 'Creating State Root and config…',
      async () => {
        if (existing) {
          const state = await inspectManagedRuntimeHostService(existing);
          if (state.kind !== 'stopped') {
            throw new Error(`Runtime Host config can only be edited while stopped (${state.kind})`);
          }
          const config = updateManagedRuntimeHostServiceConfig(existing, {
            name: draft.name,
            transport,
          });
          await this.catalog.save(config);
          return config;
        }
        const root = await resolveStorageRoot({ path: draft.rootPath, kind: 'interactive' });
        const config = createManagedRuntimeHostServiceConfig({
          id: draft.id,
          name: draft.name,
          rootPath: root.canonicalPath,
          expectedRootId: root.rootId,
          transport,
        });
        await this.catalog.create(config);
        return config;
      },
      (config) => this.#showService(config),
      existing ? 'Config updated' : 'Config created',
    );
  }

  #confirmRemove(config: ManagedRuntimeHostServiceConfig): void {
    this.#menu(
      `Remove ${config.name}?`,
      ['The config is removed. State Root data and credentials are not deleted.'],
      [
        { value: 'remove', label: 'Remove config' },
        { value: 'back', label: 'Cancel' },
      ],
      (item) => {
        if (item.value !== 'remove') return void this.#showService(config);
        this.#run(
          'Removing config…',
          async () => {
            const state = await inspectManagedRuntimeHostService(config);
            if (state.kind !== 'stopped') {
              throw new Error(
                `Runtime Host config can only be removed while stopped (${state.kind})`,
              );
            }
            return this.catalog.remove(config.id);
          },
          () => this.#refreshServices(),
          'Config removed',
        );
      },
      () => void this.#showService(config),
    );
  }

  #showConnectionDetails(config: ManagedRuntimeHostServiceConfig): void {
    const transport = runtimeHostServiceClientTransport(config);
    const details = [
      `${ansi.dim('Expected Root ID')} ${config.expectedRootId}`,
      `${ansi.dim('Transport')}        ${JSON.stringify(transport)}`,
      '',
      'Create a credential, then save a matching profile on the remote Client.',
    ];
    this.#menu(
      `${config.name} — connection details`,
      details,
      [{ value: 'back', label: 'Back' }],
      () => void this.#showService(config),
      () => void this.#showService(config),
    );
  }

  async #showProjects(config: ManagedRuntimeHostServiceConfig): Promise<void> {
    this.#run(
      'Loading Projects…',
      () => listManagedRuntimeHostProjects(config),
      (projects) => {
        const items: SelectItem[] = projects.map((project) => ({
          value: `project:${project.id}`,
          label: project.name,
          description: project.preferredPath ?? `${project.locationCount} locations`,
        }));
        items.push(
          { value: 'add', label: 'Add Project', description: 'Register an absolute Host path' },
          { value: 'back', label: 'Back' },
        );
        this.#menu(
          `${config.name} — Projects`,
          [`${projects.length} registered Project(s)`],
          items,
          (item) => {
            if (item.value === 'add') return this.#promptProjectPath(config);
            if (item.value === 'back') return void this.#showService(config);
            const project = projects.find(({ id }) => `project:${id}` === item.value);
            if (project) this.#showProject(config, project);
          },
          () => void this.#showService(config),
        );
      },
    );
  }

  #promptProjectPath(config: ManagedRuntimeHostServiceConfig): void {
    this.#prompt(
      `${config.name} — Add Project`,
      'Absolute path on the Host',
      (value) => {
        const path = value.trim();
        if (!isAbsolute(path)) throw new Error('Project path must be absolute');
        this.#run(
          'Registering Project…',
          () => addManagedRuntimeHostProject(config, path),
          () => this.#showProjects(config),
          'Project registered',
        );
      },
      () => void this.#showProjects(config),
    );
  }

  #showProject(
    config: ManagedRuntimeHostServiceConfig,
    project: ProjectCatalogProjectDetails,
  ): void {
    this.#menu(
      project.name,
      [
        `${ansi.dim('ID')}        ${project.id}`,
        `${ansi.dim('Preferred')} ${project.preferredPath ?? 'none'}`,
        ...project.locations.map(({ path }) => `  ${path}`),
      ],
      [{ value: 'back', label: 'Back' }],
      () => void this.#showProjects(config),
      () => void this.#showProjects(config),
    );
  }

  async #showCredentials(config: ManagedRuntimeHostServiceConfig): Promise<void> {
    this.#run(
      'Loading credential metadata…',
      () => listManagedRuntimeHostCredentials(config),
      (credentials) => {
        const items: SelectItem[] = [
          {
            value: 'issue',
            label: 'Issue credential',
            description: 'Choose a fail-closed permission pack or custom grants',
          },
          ...credentials.map((credential) => ({
            value: `credential:${credential.credentialId}`,
            label: credential.principalId,
            description: `${credential.status} · ${credential.principalKind} · ${credential.operationGrants.length} grants`,
          })),
          { value: 'back', label: 'Back' },
        ];
        this.#menu(
          `${config.name} — Credentials`,
          [`${credentials.length} credential(s); secrets are never listed.`],
          items,
          (item) => {
            if (item.value === 'issue') return this.#choosePermissionPack(config);
            if (item.value === 'back') return void this.#showService(config);
            const credential = credentials.find(
              ({ credentialId }) => `credential:${credentialId}` === item.value,
            );
            if (credential) this.#showCredential(config, credential);
          },
          () => void this.#showService(config),
        );
      },
    );
  }

  #showCredential(
    config: ManagedRuntimeHostServiceConfig,
    credential: AccessCredentialMetadata,
  ): void {
    const items: SelectItem[] = [];
    if (credential.status === 'active') items.push({ value: 'revoke', label: 'Revoke credential' });
    items.push({ value: 'back', label: 'Back' });
    this.#menu(
      credential.principalId,
      [
        `${ansi.dim('Credential ID')} ${credential.credentialId}`,
        `${ansi.dim('Kind')}          ${credential.principalKind}`,
        `${ansi.dim('Status')}        ${credential.status}`,
        `${ansi.dim('Host paths')}    ${credential.canUseHostPaths ? 'allowed' : 'denied'}`,
        `${ansi.dim('Operations')}    ${credential.operationGrants.join(', ')}`,
      ],
      items,
      (item) => {
        if (item.value !== 'revoke') return void this.#showCredentials(config);
        this.#run(
          'Revoking credential…',
          async () => {
            if (!(await revokeManagedRuntimeHostCredential(config, credential.credentialId))) {
              throw new Error('Credential was already revoked');
            }
          },
          () => this.#showCredentials(config),
          'Credential revoked',
        );
      },
      () => void this.#showCredentials(config),
    );
  }

  #choosePermissionPack(config: ManagedRuntimeHostServiceConfig): void {
    this.#menu(
      `${config.name} — Permission policy`,
      ['New protocol operations never enter a pack automatically.'],
      [
        ...RUNTIME_HOST_PERMISSION_PACKS.map((pack) => ({
          value: pack.id,
          label: pack.name,
          description: `${pack.operationGrants.length} grants · ${pack.description}`,
        })),
        {
          value: 'custom',
          label: 'Custom protocol grants',
          description: 'Select exact remote-owner operations',
        },
        { value: 'back', label: 'Back' },
      ],
      (item) => {
        if (item.value === 'back') return void this.#showCredentials(config);
        if (item.value === 'custom') return this.#customPermissions(config);
        this.#promptCredentialPrincipal(config, {
          packId: item.value as RuntimeHostPermissionPackId,
        });
      },
      () => void this.#showCredentials(config),
    );
  }

  #customPermissions(config: ManagedRuntimeHostServiceConfig): void {
    this.#mode = 'permissions';
    this.#title = `${config.name} — Custom permissions`;
    this.#lines = ['host.status is required for liveness · Space toggles · Enter continues'];
    this.#permissions = [...REMOTE_OWNER_OPERATION_GRANTS];
    this.#permissionConfig = config;
    this.#permissionSelection = new Set<OperationKey>(['host.status']);
    this.#permissionIndex = 0;
    this.#onBack = () => this.#choosePermissionPack(config);
    this.tui.requestRender();
  }

  #handlePermissionInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.#onBack();
    if (matchesKey(data, Key.up)) {
      this.#permissionIndex = Math.max(0, this.#permissionIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.#permissionIndex = Math.min(this.#permissions.length - 1, this.#permissionIndex + 1);
    } else if (matchesKey(data, Key.space)) {
      const operation = this.#permissions[this.#permissionIndex];
      if (operation) {
        if (operation === 'host.status') {
          this.#notice = { tone: 'info', text: 'host.status is required for every credential' };
        } else if (this.#permissionSelection.has(operation)) {
          this.#permissionSelection.delete(operation);
        } else {
          this.#permissionSelection.add(operation);
        }
      }
    } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      if (this.#permissionSelection.size === 0) {
        this.#notice = { tone: 'error', text: 'Select at least one protocol operation' };
      } else {
        const config = this.#permissionConfig;
        if (!config) throw new Error('Custom permission config is unavailable');
        const grants = [...this.#permissionSelection];
        const publishes = grants.some(
          (operation) =>
            operation === 'client.capability.replace' ||
            operation === 'client.capability.unregister',
        );
        this.#chooseHostPathAuthority(config, grants, publishes);
        return;
      }
    }
    this.tui.requestRender();
  }

  #renderPermissions(width: number): string[] {
    const visible = 15;
    const start = Math.max(
      0,
      Math.min(
        this.#permissionIndex - Math.floor(visible / 2),
        Math.max(0, this.#permissions.length - visible),
      ),
    );
    return this.#permissions.slice(start, start + visible).map((operation, offset) => {
      const index = start + offset;
      const selected = this.#permissionSelection.has(operation) ? '[x]' : '[ ]';
      const text = `${selected} ${operation}${operation === 'host.status' ? ' (required)' : ''}`;
      return line(index === this.#permissionIndex ? ansi.reverse(text) : text, width);
    });
  }

  #chooseHostPathAuthority(
    config: ManagedRuntimeHostServiceConfig,
    operationGrants: readonly OperationKey[],
    canPublishClientCapabilities: boolean,
  ): void {
    this.#menu(
      `${config.name} — Host path authority`,
      ['Most remote Clients should use registered Project IDs instead of Host paths.'],
      [
        { value: 'deny', label: 'Deny Host paths', description: 'Recommended' },
        {
          value: 'allow',
          label: 'Allow Host paths',
          description: 'Client may submit paths on this Host',
        },
      ],
      (item) =>
        this.#promptCredentialPrincipal(config, {
          operationGrants,
          canPublishClientCapabilities,
          canUseHostPaths: item.value === 'allow',
        }),
      () => this.#customPermissions(config),
    );
  }

  #promptCredentialPrincipal(
    config: ManagedRuntimeHostServiceConfig,
    authority:
      | { readonly packId: RuntimeHostPermissionPackId }
      | {
          readonly operationGrants: readonly OperationKey[];
          readonly canPublishClientCapabilities: boolean;
          readonly canUseHostPaths: boolean;
        },
  ): void {
    this.#prompt(
      `${config.name} — Issue credential`,
      'Principal ID (for example laptop-alice)',
      (value) => {
        const principalId = value.trim();
        if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) {
          throw new Error('Principal ID is invalid');
        }
        this.#credentialIssuanceActive = true;
        this.#run(
          'Issuing one-time credential…',
          () => issueManagedRuntimeHostCredential(config, { principalId, ...authority }),
          (issued) => {
            this.#showSecret(config, issued.metadata.credentialId, issued.credential);
          },
          undefined,
          () => {
            this.#credentialIssuanceActive = false;
          },
        );
      },
      () => this.#choosePermissionPack(config),
    );
  }

  #showSecret(
    config: ManagedRuntimeHostServiceConfig,
    credentialId: string,
    credential: string,
  ): void {
    this.#mode = 'secret';
    this.#title = `${config.name} — Credential created`;
    this.#lines = [];
    this.#secret = {
      credential,
      details: [
        `Credential ID: ${credentialId}`,
        `Expected Root ID: ${config.expectedRootId}`,
        `Profile transport: ${JSON.stringify(runtimeHostServiceClientTransport(config))}`,
        `Use ${this.cliCommand} runtime-host profile set … on the remote Client.`,
      ],
    };
    this.#onBack = () => void this.#showCredentials(config);
    this.tui.requestRender();
  }

  #renderSecret(width: number): string[] {
    const secret = this.#secret;
    if (!secret) return [];
    const credentialLine =
      visibleWidth(secret.credential) <= width
        ? [line(secret.credential, width)]
        : [
            line(
              ansi.yellow(
                `Widen the terminal to at least ${visibleWidth(secret.credential)} columns`,
              ),
              width,
            ),
          ];
    return [
      line(ansi.yellow('Copy this credential now. Maka will not show it again.'), width),
      line('', width),
      ...credentialLine,
      line('', width),
      ...secret.details.map((value) => line(value, width)),
      line('', width),
      line(ansi.dim('Enter/Esc clears this screen'), width),
    ];
  }

  #menu(
    title: string,
    lines: readonly string[],
    items: SelectItem[],
    onSelect: (item: SelectItem) => void,
    onBack: () => void = () => this.close(),
  ): void {
    this.#mode = 'menu';
    this.#title = title;
    this.#lines = [...lines];
    this.#onBack = onBack;
    this.#list = new SelectList(items, 14, selectListTheme(), {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 34,
    });
    this.#list.onSelect = onSelect;
    this.#list.onCancel = onBack;
    this.tui.requestRender();
  }

  #prompt(
    title: string,
    label: string,
    onSubmit: (value: string) => void,
    onBack: () => void,
  ): void {
    this.#mode = 'input';
    this.#title = title;
    this.#lines = [];
    this.#inputLabel = label;
    this.#input.setValue('');
    this.#input.onSubmit = (value) => {
      try {
        this.#notice = undefined;
        onSubmit(value);
      } catch (error) {
        this.#notice = { tone: 'error', text: errorMessage(error) };
        this.tui.requestRender();
      }
    };
    this.#input.onEscape = onBack;
    this.#onBack = onBack;
    this.tui.requestRender();
  }

  #run<T>(
    label: string,
    operation: () => Promise<T>,
    onSuccess: (value: T) => void | Promise<void>,
    successNotice?: string,
    onSettled?: () => void,
  ): void {
    if (this.#busy) return;
    this.#busy = label;
    this.#notice = undefined;
    this.tui.requestRender();
    void operation().then(
      async (value) => {
        this.#busy = undefined;
        onSettled?.();
        if (this.#closed) return;
        if (successNotice) this.#notice = { tone: 'info', text: successNotice };
        await onSuccess(value);
        this.tui.requestRender();
      },
      (error: unknown) => {
        this.#busy = undefined;
        onSettled?.();
        if (this.#closed) return;
        this.#notice = { tone: 'error', text: errorMessage(error) };
        this.tui.requestRender();
      },
    );
  }
}

interface ConfigDraft {
  id: string;
  name: string;
  rootPath: string;
}

function stateLabel(state: ManagedRuntimeHostServiceState): string {
  switch (state.kind) {
    case 'stopped':
      return 'stopped';
    case 'running':
      return `${state.lifecycleState} (pid ${state.pid})`;
    case 'stopping':
      return `stopping (pid ${state.pid})`;
    case 'root_drift':
      return 'Root drift — action required';
    case 'config_drift':
      return 'config drift — not managed';
    case 'external':
      return 'external Host — not managed';
    case 'unreachable':
      return `unreachable (${state.reason})`;
  }
}

function transportLabel(transport: ManagedRuntimeHostTransport): string {
  return `${transport.kind}://${transport.bindHost}:${transport.port}${transport.path}`;
}

function parsePort(value: string, fallback: number): number {
  const port = value.trim() === '' ? fallback : Number(value.trim());
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Port must be an integer between 1 and 65535');
  }
  return port;
}

function splitOrigins(value: string): readonly string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function line(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return `${truncated}${' '.repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
