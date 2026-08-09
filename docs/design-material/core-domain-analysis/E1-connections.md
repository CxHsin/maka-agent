# Connections Domain · Maka Code Analysis and Architecture Design

> Analysis target: this repository (`maka-agent`), focusing on connection*/web-search*/mcp* files in `packages/core`, `packages/storage`, `packages/runtime`, `packages/runtime-host`, and `apps/desktop`. This domain is currently "has-code-but-no-docs"; the following is reverse-engineered from the code.

---

## 1. Code Map (file list + responsibility + key exported symbols)

### 1.1 Core domain (packages/core/src) — pure types / codecs / decision logic, no I/O

| File | Responsibility | Key exported symbols |
|---|---|---|
| `llm-connections.ts` | **The domain's core data model**: LLM provider connection metadata, auth types, model-selection rules, baseUrl validation, migration | `LlmConnection`, `RuntimeExecutionConnection`, `ConnectionAuth` (`api_key`/`optional_api_key`/`oauth_token`/`none`), `ModelInfo`, `ModelDiscoveryResult`, `connectionEnabledModelIds`, `reconcileConnectionAfterEnabledModelsChange`, `reconcileConnectionAfterModelFetch`, `validateSlug`, `deriveConnectionSlug`, `validateConnectionBaseUrl`, `normalizeConnectionBaseUrl`, `persistedBaseUrl`, `migrateConnectionV1ToV2`, `CreateConnectionInput`/`UpdateConnectionInput`, `providerAuthRequiresSecret` |
| `provider-registry.ts` | Provider registry: per-provider auth/backend/model-discovery contracts | `ProviderDefaults` (`authKind`, `backendKind`, `modelDiscovery`), `PROVIDER_DEFAULTS`, `ProviderType` |
| `runtime-policy.ts` | **Type-definition bucket** for the connection catalog and runtime policy (catalog + credential vault + policy mixed together) | `ConnectionCatalogEntry` (extends `ConnectionConfiguration`: `connectionId`/`revision`/`models`/`modelSource`/`modelsFetchedAt`/`lastTest`), `ConnectionTarget` (`{connectionId, modelId}`), `ConnectionVersionBasis`, `ConnectionCatalogSnapshot`, `ConnectionCatalogMutationResult`, `CredentialLocator` (`scope: 'connection'\|'web_search'`) |
| `runtime-policy/connection-catalog-codec.ts` | **The single gate for input normalization**: runtime decoding, caps, and invariants for all create/update/remove | `CONNECTION_CATALOG_MAX_CONNECTIONS=1024`, `CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION=2048`, `CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS=512`, `normalizeCreateCatalogConnectionInput`, `decodeCanonicalConnectionCatalogEntry`, `decodeRelayModelProfilesTable`, `normalizeCatalogConnectionBaseUrl` |
| `connection-readiness.ts` | **Readiness determination**: the single source of truth for whether a connection can send a message right now; pure function, synchronous, decision order is the contract | `ChatConfigurationReason` (10 reasons), `isConnectionReady`, `isRealConnection`, `normalizeOpenAiCodexConnection`, `normalizeRequestedModelForReadiness` |
| `connection-error-copy.ts` | Non-ready connections' **Chinese fix copy table** + `NO_REAL_CONNECTION` error parser (shared by CLI/desktop) | `NO_REAL_CONNECTION_CODE`, `describeChatConfigurationReason`, `parseNoRealConnectionError`, `REASON_FIX_COPY` |
| `connections.ts` | Connection-settings events/commands (**desktop-bridge-only channel `connections.*`**, separated from `sessions.*`) | `ConnectionEvent` (`connection_credential_request`/`connection_test_result`/`connection_list_changed`), `ConnectionCommand` (`credential_response`/`oauth_start`/`test`/`save`/`delete`) |
| `web-search.ts` | WebSearch pure contract: query normalization, credential state machine, mask sentinel | `WebSearchResponse`, `WebSearchResultRow`, `WEB_SEARCH_PROVIDERS=['model','tavily']`, `WebSearchSettings`, `MASKED_TOKEN_SENTINEL='••••••'`, `normalizeWebSearchQuery` |
| `model-web-search.ts` | Model-native (provider-hosted) web-search capability resolution | `resolveHostedWebSearchCapability`, `HostedWebSearchAdapter` |
| `mcp.ts` | MCP config/status/call types | `McpConfigFile`, `McpServerConfig` (stdio/remote), `McpToolDescriptor`, `McpServerStatus`, `McpCallResult`, `MCP_CONFIG_VERSION=1` |
| `provider-auth.ts` | Provider auth contract state machine | `ProviderAuthContract`, `ProviderAuthState`, `deriveProviderAuthContract` |
| `oauth-subscription.ts` | Claude subscription OAuth: PKCE, authorization URL, ticket parsing | `buildClaudeAuthorizationUrl`, `pkceCodeChallenge`, `parsePastedAuthorization`, `TOKEN_REFRESH_SKEW_MS` |

### 1.2 Storage layer (packages/storage/src)

| File | Responsibility | Key symbols |
|---|---|---|
| `connection-store.ts` | **Legacy** LLM connection file store (`llm-connections.json`), serialized-queue writes | `ConnectionStore` interface (`list/get/create/update/updateIfUnchanged/save/remove/getDefault/getDefaultConnection`), `FileConnectionStore`, `claimVacantWorkspaceDefault` |
| `runtime-policy/connection-catalog-document.ts` | **New** connection-catalog document owner (`connection-catalog.json`, schemaVersion 1): create/update/remove/set-default/model-discovery write/test write, with revision conflicts and invariants | `ConnectionCatalogDocumentOwner` (`create/update/remove/setDefaultTarget/writeModelFetchResult/prepareOnboardingUpsert/commitPreparedOnboarding/writeConnectionTestResult/clearConnectionLastTest`), `catalogSnapshot`, `connectionBasis` |
| `runtime-policy/credential-vault-document.ts` | **Credential vault** (`credential-vault.json`): stores secrets by `CredentialLocator`, separated from the connection catalog | `CredentialVaultDocumentOwner`, `CredentialVaultEntry`, `MAX_VAULT_ENTRIES=2048`, `MAX_SECRET_LENGTH=64KB` |
| `runtime-policy/coordinator.ts` | Coordinator: the real implementation behind the read/write facade, ticket optimistic concurrency | `RuntimePolicyCoordinator` (`beginModelFetch`→`issueTicket`, `completeModelFetch`→`claimTicket`+`checkSemanticConnectionBasis`→`committed\|superseded`, `commitConnectionOnboarding` (incl. persisted intent + recovery), `exportCredentialMaterial`, `resolveExecutionConnection`, `resolveNetworkProxyExecution`, `resolveWebSearchExecution`) |
| `runtime-policy/operations.ts` | Operation contracts: tickets, begin/complete results, credential material | `ModelFetchTicket`, `ConnectionTestTicket`, `BeginModelFetchResult`, `ConnectionEffectCompletionResult`, `RuntimePolicyOperationSecretMaterial` |
| `runtime-policy-stores.ts` | Read/write facade with **branded authorization** (brand-token runtime validation) | `RuntimePolicyStoresReader/Writer`, `authenticateRuntimePolicyStoresWriter` |
| `mcp-config-store.ts` | MCP server config storage (independent of the connection catalog) | `McpConfigStore` |

### 1.3 Runtime effect execution (packages/runtime/src)

| File | Responsibility | Key symbols |
|---|---|---|
| `connection-effect-fetch.ts` | Network execution of connection effects: **bounded fetch** (timeout/abort/response-body cap) | `fetchForConnectionEffect`, `ConnectionEffectFetchError` (`timeout\|network`), `CONNECTION_EFFECT_JSON_BODY_MAX_BYTES=4MB`, `CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES=16KB`, `readBoundedBody` |
| `connection-effect-outcome.ts` | Effect-result classification and error types | `ConnectionModelDiscoveryEffectOutcome`, `ConnectionTestEffectOutcome`, `classifyConnectionEffectStatus` (401/403→auth, 408→timeout, 429/5xx→provider_unavailable) |
| `test-connection.ts` | Connection-test execution | `runConnectionTestEffect` etc. |
| `mcp-tools.ts` | Adapts MCP tools into model tools: proxy naming, conflict detection, **network permission gate**, content truncation | `buildMcpTools`, `McpToolProvider`, `mcpProxyToolName` (64 chars + SHA-256 hash), `categoryHint` default `network_send`, `requestSandboxBoundary` approval gate |
| `web-search-tool.ts` | WebSearch model tool | `buildWebSearchTool` |
| `connection-effect-coordinator.ts` | Effect coordinator: ticket lifecycle, per-connection serialization, activation gate, drain | `ConnectionEffectCoordinator`, `RuntimePolicyActivationGate`, `#enqueue` per-connection serialization |

### 1.4 Runtime-host orchestration (packages/runtime-host/src)

| File | Responsibility | Key symbols |
|---|---|---|
| `server/connection-session.ts` | **Transport-layer** connection session (framed transport, request dispatch) — note: same name as "LLM connection" but different meaning | `RuntimeHostConnectionSession`, `MAX_IN_FLIGHT_REQUESTS=64` |
| `client/connection.ts` | Client connection (runtime-host election, handshake, requests) | `ConnectRuntimeHostInput`, `RuntimeHostConnection` |
| `server/connection-bound-chunk-uploads.ts` | Connection-bound **chunked upload staging** (owner=hostEpoch+connectionId, TTL, capacity cap) | `ConnectionBoundChunkUploads` |
| `protocol/connection-effects.ts` | **Protocol operation spec** for connection effects (IPC/command words) | `CONNECTION_EFFECT_OPERATION_SPECS`, `ConnectionEffectChangedDomain` (`connection\|credential\|network_proxy`), `ConnectionEffectRejectionReason`, `ConnectionEffectFailureClass` |
| `server/web-search-tool.ts` + `web-search-coordinator.ts` + `protocol/web-search.ts` | WebSearch execution service + `web-search.execute` protocol | `createHostWebSearchService`, `HostWebSearchCoordinator` |

### 1.5 Desktop integration (apps/desktop/src/main)

| File | Responsibility |
|---|---|
| `runtime-host-connections-ipc-main.ts` | `connections:*` IPC handlers (list/getDefault/setDefault/create/test…), projecting the catalog into a renderer-safe shape |
| `connections-ipc-validation.ts` | IPC-boundary baseUrl/slug/secret normalization |
| `runtime-host-account-connection.ts`, `oauth-connection-identities.ts` | OAuth subscription account connections and identities |

---

## 2. Core Data Model and Flows

### 2.1 What a Connection is

"Connection" in this domain means an **LLM provider connection**: a **secret-free** configuration document describing "who I connect to, what credential type, which models, and whether it is currently healthy." Two implementations coexist:
- **Legacy**: `LlmConnection` (`llm-connections.json`, identified by slug, has an `apiKey` field but the docs promise it is never written to disk) — `storage/connection-store.ts`
- **New spec**: `ConnectionCatalogEntry` (`connection-catalog.json`, identified by `connectionId`+`revision`, secrets never enter the catalog) — `storage/runtime-policy/connection-catalog-document.ts`

Key invariants (enforced across codec/store/coordinator):
- `defaultModel ∈ enabledModelIds` (`reconcileConnectionAfterEnabledModelsChange`, `llm-connections.ts`)
- `relayModelProfiles` only exists for `openai-compatible`, only covers enabled models, and is invalidated on endpoint change (`pruneRelayModelProfiles`)
- default target = `{connectionId, modelId}` pair; automatically invalidated when a connection is deleted/disabled (`defaultTarget` cleanup in `remove`/`update`)
- baseUrl normalization: http/https, no credentials, no query/fragment, omitted when equal to default, **OAuth provider endpoints cannot be overridden** (`normalizeCatalogConnectionBaseUrl`)

### 2.2 Connection lifecycle (discover → auth → use → isolate → invalidate)

```
discover   onboarding.verify → runModelDiscoveryEffect (with secret) → models
persist    onboarding.save  → commitConnectionOnboarding (catalog+vault two writes in one transaction, persisted intent + recovery)
auth       credentials stored separately in credential-vault.json; OAuth subscription via PKCE + ticket + HostOAuthExecutionAuthority.bind
use        send-path: isConnectionReady decides → resolveExecutionConnection(slug) → fetch secret + proxy
health     connection.test.run → beginConnectionTest(ticket) → effect runs outside the storage lane → completeConnectionTest
invalidate endpoint/selection change → lastTest invalidated, default target invalidated, profile pruned
```

**Concurrency model (the most impressive design in this domain)**: the storage lane only does "prepare/commit"; network effects **execute outside the lane**:
1. `beginModelFetch/beginConnectionTest` issue a **ticket** inside the storage lane (semantic basis = the connection's current revision);
2. after the effect runs, call `completeModelFetch`, `claimTicket`, then **re-read the catalog and compare the semantic basis**;
3. basis unchanged → `committed`; changed → `superseded` (fresh state is never overwritten). See `coordinator.ts` + `connection-effect-coordinator.ts`.

**Isolation mechanisms**:
- network execution goes through `connection-effect-fetch.ts`'s **bounded fetch** (15s timeout, 4MB/16KB response-body caps, abortable);
- credentials never enter the catalog/snapshot/effect results, only short-lived inside an effect via `exportCredentialMaterial`;
- effects are serialized per `connectionId` (`#enqueue`); on host close, `beginDrain` refuses new effects;
- all renderer-returned values go through the projection layer (`projectHostConnections`), masking raw provider errors and plaintext.

---

## 3. Mapping to the Book's Key Points (Deep Understanding of AI Agents)

| Book concept | How the Maka connections domain manifests / exceeds it |
|---|---|
| **Observation-space / action-space expansion** | A connection is the only legitimate exit for the agent's action/perception space beyond the local sandbox: LLM providers = reasoning capability access; MCP = tool-ecosystem action space; WebSearch = real-time observation space. Every exit has a gate (readiness, permission, incognito, sandbox-boundary). **Beyond**: Maka models "expansion" itself as a **versioned, auditable configuration document**, not a one-time authorization |
| **Connection = the agent's perception interface** | `Connection` is the **configuration state** of the perception/reasoning interface: `ConnectionTarget{connectionId, modelId}` is the session's "perception-channel selection". Readiness determination (`isConnectionReady`) is the formal answer to "is this perception channel open right now". **Beyond**: the determination is converged into a single pure function + unified fix copy (`connection-error-copy.ts`), shared by the send-path and onboarding, eliminating drift across multiple implementations |
| **Tool ecosystem MCP** | `mcp-tools.ts` converts MCP servers/tools into unified `MakaTool`s: proxy naming (collision-safe/hashed), schema conversion, result-content truncation (text 200k chars, images 4/20MB), **annotations are only hints, not a security boundary**. **Beyond**: MCP tools default to the `network_send` category, entering the managed network-permission system, and can trigger sandbox-boundary approval before a call |
| **Permission boundary** | Connection operations have **two-layer boundaries**: ① configuration layer — IPC-side baseUrl scheme allowlist, slug validation, OAuth endpoints pinned (`llm-connections.ts`/codec), preventing credential leakage; ② execution layer — `RuntimePolicyActivationGate` (read/write separated from backend activation window, poison), managed network permission (`executionBoundary`), incognito gate. **Beyond**: Maka concretizes "permission" as the **physical separation of the storage lane and the effect lane**, not just a pre-call check |

---

## 4. Current Implementation Analysis

### 4.1 Strengths
1. **Clear and correctly-directed layering**: core (pure functions/codecs) → storage (document owners + normalization) → runtime (bounded effect execution) → runtime-host (coordination + protocol) → desktop (projection). Each layer has a single responsibility.
2. **Secrets separated from configuration**: catalog and credential-vault are physically separate files, credentials are indexed by `CredentialLocator`, snapshots never carry secrets. This is rare discipline in a local-first setting.
3. **Optimistic concurrency + semantic basis**: the ticket/claim/superseded pattern is significantly better than "last-writer-wins" in the multi-process (desktop ↔ runtime-host) architecture.
4. **Defensive input handling**: `exactRecord` strict decoding, caps (1024 connections/2048 models/512 enabled), `Object.fromEntries` against prototype pollution, schemaVersion + v1→v2 migration, document-size caps.
5. **Boundary safety**: baseUrl allowlist + non-overridable OAuth endpoints + MCP network approval gate + mask-sentinel round-trip + error classification (auth/timeout/provider_unavailable/network).
6. **Single source of truth for error copy**: `connection-error-copy.ts`'s `Record<ChatConfigurationReason, string>` type turns "every new reason must ship copy" into a compile-time constraint.

### 4.2 Deficiencies / Risks
1. **The word "Connection" is severely overloaded** (three different things mixed across this domain's 42 files):
   - (a) LLM provider connections (catalog) — the real "connections domain";
   - (b) transport-layer connection sessions (`connection-session.ts`, `client/connection.ts`, `connection-bound-chunk-uploads.ts`) — runtime-host channels;
   - (c) desktop-bridge connection events (`core/connections.ts`).
   All three share the name "connection"; docs and directories are misleading.
2. **Dual stores coexist**: `llm-connections.json` (legacy) and `connection-catalog.json` (new) are both sources of truth for "connection"; the migration period has dual-write/drift risk; `mcp-config-store` and web-search credentials are each scattered separately, not merged into the unified catalog.
3. **Inconsistent credential hygiene**: `web-search.ts` explicitly notes that the Tavily `apiKey` is stored **in cleartext in `settings.json`**, contradicting the credential-vault isolation discipline (`core/web-search.ts` comment: "stored in cleartext on disk").
4. **Readiness determination is split**: `isConnectionReady` is a pure function, but `hasSecret` is resolved asynchronously by the caller first, so the determination is not atomic; the read boolean can be stale.
5. **Incomplete OAuth coverage**: `oauth_subscription_not_wired` means most OAuth providers are in a "modeled but runtime not wired" state — domain breadth exceeds implementation depth.
6. **Two IPC channels**: `connections:*` (desktop handler) and runtime-host's `connection.*` operation protocol coexist and can drift in the future.
7. **Credentials written to disk as plaintext JSON** (`credential-vault.json`), not connected to the OS keychain; a weak point for "local-first + sensitive credentials" (though bounded in size and strictly decoded).

### 4.3 Fit with "local-first + permission isolation"
**Overall fit is high**: everything lives in workspace-local files with no cloud dependency; all network exits converge into the "effect lane" and are gated (activation gate + managed network + incognito); the catalog/vault separation guarantees minimal exposure. **But** there are four discounts: plaintext web-search keys, dual stores, half-finished OAuth, and plaintext JSON vault. These are "compliance" problems rather than "architecture direction" problems.

---

## 5. Target Architecture

### 5.1 Target layering
```
[UI/IPC projection layer]  renderer-safe projection, masking, fix copy
[Protocol layer]           connection.* / web-search.* / mcp.* operation specs (unified namespace)
[Orchestration layer]      ConnectionEffectCoordinator: tickets + activation gate + per-connection serialization
[Effect layer]             bounded fetch / provider adapter / MCP transport / search adapter
[Storage layer]            unified catalog + vault (single source of truth; all secrets go through the vault)
[Core layer]               types / codecs / readiness / pure decisions (zero I/O)
```
Recommendation: split `runtime-policy.ts` into an independent `connections/*` barrel to formally establish the "connections domain" boundary.

### 5.2 Target data model
One `Connection` uniformly models all external access, distinguished by `kind`:
```ts
Connection {
  connectionId, revision, slug, name,
  kind: 'llm-provider' | 'mcp-server' | 'search-provider' | 'proxy',
  provider: { providerType, authKind, endpoint(canonical), oauthNonOverridable },
  selection: { enabledModelIds, defaultModel, relayModelProfiles },
  inventory: { models, modelSource, fetchedAt },      // llm-specific
  health: { lastTest },
  permissionProfileRef,                               // authorization required to use this connection
  credentialLocator: CredentialLocator,               // always points to the vault, never inlined
}
```
Migration path: `llm-connections.json` → `connection-catalog.json` (schemaVersion 1→2); MCP servers and web-search credentials merge into the unified `CredentialLocator` system.

### 5.3 Security model (target state)
1. **All secrets go into the vault**: including web-search keys, MCP remote headers, proxy credentials; the renderer only ever sees masks.
2. **Plaintext JSON → optional OS keychain** (macOS Keychain / libsecret), keeping the vault as a pure-JSON-compatible fallback.
3. **Per-connection authorization**: attach "using a connection" to the permission profile (`permission.ts`'s ToolCategory system); an agent must be approved before reaching the tools/capabilities that connection exposes.
4. **Endpoint security hardening**: keep the http/https allowlist + pinned OAuth endpoints + credential-free URLs; add per-connection network **allowlist/denylist**.
5. **Audit**: credential usage and effect execution enter the usage/tool ledger, replayable as "who accessed what via which connection, when".

### 5.4 Evolution path
1. **P0 unify the source of truth**: finish the catalog migration, retire the `llm-connections.json` write path; unify IPC onto the runtime-host operation protocol.
2. **P1 consolidate credentials**: migrate web-search/MCP/proxy credentials into the vault; integrate the keychain.
3. **P2 domain boundary**: split the "connections domain" barrel, peel the transport sessions out of this domain (rename to a `RuntimeHostSession` class), eliminating the same-name overload.
4. **P3 capability-ization**: attach connections to permission profiles + audit ledger; complete OAuth runtime-path coverage.
5. **P4 observability**: connection health/usage statistics panels, credential lifecycle management (rotation/expiry hints).

---

## 6. Open Questions
1. **MCP ownership**: does MCP belong to the "connections domain" (external access) or the "tools domain" (tool ecosystem)? Types currently live in `core/mcp.ts`, tool adaptation in `runtime/mcp-tools.ts`, and permissions in `permission.ts` — the boundary needs clarifying.
2. **Network-proxy ownership**: `networkProxy` is currently a global policy in `runtime-policy.ts`, but it is essentially "part of a connection (the egress)"; should it merge into the connection model?
3. **WebSearch positioning**: is it "one connection" or a "policy switch"? It is currently both (provider credentials in settings, switch in runtime-policy); should they be unified?
4. **Dual-store migration cutoff**: when should `llm-connections.json` read-compat and `migrateConnectionV1ToV2` be removed?
5. **"Connection" terminology governance**: should transport-layer sessions be renamed `RuntimeHostSession`, so `Connection` refers exclusively to external access?
6. **Credential-at-rest security baseline**: under local-first, is the OS keychain mandatory, or is "strict decoding + boundary isolation" with plaintext JSON acceptable?
7. **OAuth completeness**: when does `oauth_subscription_not_wired` converge to all providers runnable? This is the largest "breadth > depth" gap in the current domain.
