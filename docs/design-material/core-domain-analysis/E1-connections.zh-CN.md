# Connections 域 · Maka 代码分析与架构设计

> 分析对象：本仓库（`maka-agent`），聚焦 `packages/core`、`packages/storage`、`packages/runtime`、`packages/runtime-host`、`apps/desktop` 中的 connection*/web-search*/mcp* 相关文件。本域当前"有代码无文档"，以下基于代码反推。

---

## 1. 代码地图（文件清单 + 职责 + 关键导出符号）

### 1.1 核心域（packages/core/src）— 纯类型 / 编解码 / 判定逻辑，无 I/O

| 文件 | 职责 | 关键导出符号 |
|---|---|---|
| `llm-connections.ts` | **域的核心数据模型**：LLM 提供商连接的元数据、鉴权类型、模型选择规则、baseUrl 校验、迁移 | `LlmConnection`、`RuntimeExecutionConnection`、`ConnectionAuth`（`api_key`/`optional_api_key`/`oauth_token`/`none`）、`ModelInfo`、`ModelDiscoveryResult`、`connectionEnabledModelIds`、`reconcileConnectionAfterEnabledModelsChange`、`reconcileConnectionAfterModelFetch`、`validateSlug`、`deriveConnectionSlug`、`validateConnectionBaseUrl`、`normalizeConnectionBaseUrl`、`persistedBaseUrl`、`migrateConnectionV1ToV2`、`CreateConnectionInput`/`UpdateConnectionInput`、`providerAuthRequiresSecret` |
| `provider-registry.ts` | 提供商注册表：每个 provider 的 auth/backend/模型发现契约 | `ProviderDefaults`（`authKind`、`backendKind`、`modelDiscovery`）、`PROVIDER_DEFAULTS`、`ProviderType` |
| `runtime-policy.ts` | 连接目录（connection catalog）与运行时策略的**类型定义桶**（catalog + credential vault + policy 混在一起） | `ConnectionCatalogEntry`（extends `ConnectionConfiguration`：`connectionId`/`revision`/`models`/`modelSource`/`modelsFetchedAt`/`lastTest`）、`ConnectionTarget`（`{connectionId, modelId}`）、`ConnectionVersionBasis`、`ConnectionCatalogSnapshot`、`ConnectionCatalogMutationResult`、`CredentialLocator`（`scope: 'connection'|'web_search'`） |
| `runtime-policy/connection-catalog-codec.ts` | **输入规范化的唯一闸口**：所有 create/update/remove 的运行时解码、上限与不变量 | `CONNECTION_CATALOG_MAX_CONNECTIONS=1024`、`CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION=2048`、`CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS=512`、`normalizeCreateCatalogConnectionInput`、`decodeCanonicalConnectionCatalogEntry`、`decodeRelayModelProfilesTable`、`normalizeCatalogConnectionBaseUrl` |
| `connection-readiness.ts` | **就绪判定**：某连接此刻能否发消息的唯一事实源，纯函数、同步、判定顺序是契约 | `ChatConfigurationReason`（10 种原因）、`isConnectionReady`、`isRealConnection`、`normalizeOpenAiCodexConnection`、`normalizeRequestedModelForReadiness` |
| `connection-error-copy.ts` | 非就绪连接的**中文修复文案表** + `NO_REAL_CONNECTION` 错误解析器（CLI/桌面共用） | `NO_REAL_CONNECTION_CODE`、`describeChatConfigurationReason`、`parseNoRealConnectionError`、`REASON_FIX_COPY` |
| `connections.ts` | 连接设置事件/命令（**桌面 bridge 专用通道 `connections.*`**，与 `sessions.*` 分离） | `ConnectionEvent`（`connection_credential_request`/`connection_test_result`/`connection_list_changed`）、`ConnectionCommand`（`credential_response`/`oauth_start`/`test`/`save`/`delete`） |
| `web-search.ts` | WebSearch 纯契约：查询归一化、凭据状态机、掩码哨兵 | `WebSearchResponse`、`WebSearchResultRow`、`WEB_SEARCH_PROVIDERS=['model','tavily']`、`WebSearchSettings`、`MASKED_TOKEN_SENTINEL='••••••'`、`normalizeWebSearchQuery` |
| `model-web-search.ts` | 模型原生（provider-hosted）联网搜索能力解析 | `resolveHostedWebSearchCapability`、`HostedWebSearchAdapter` |
| `mcp.ts` | MCP 配置/状态/调用类型 | `McpConfigFile`、`McpServerConfig`（stdio/remote）、`McpToolDescriptor`、`McpServerStatus`、`McpCallResult`、`MCP_CONFIG_VERSION=1` |
| `provider-auth.ts` | 提供商鉴权契约状态机 | `ProviderAuthContract`、`ProviderAuthState`、`deriveProviderAuthContract` |
| `oauth-subscription.ts` | Claude 订阅 OAuth：PKCE、授权 URL、票据解析 | `buildClaudeAuthorizationUrl`、`pkceCodeChallenge`、`parsePastedAuthorization`、`TOKEN_REFRESH_SKEW_MS` |

### 1.2 存储层（packages/storage/src）

| 文件 | 职责 | 关键符号 |
|---|---|---|
| `connection-store.ts` | **遗留** LLM 连接文件存储（`llm-connections.json`），串行队列写 | `ConnectionStore` 接口（`list/get/create/update/updateIfUnchanged/save/remove/getDefault/getDefaultConnection`）、`FileConnectionStore`、`claimVacantWorkspaceDefault` |
| `runtime-policy/connection-catalog-document.ts` | **新**连接目录文档所有者（`connection-catalog.json`，schemaVersion 1）：创建/更新/删除/设默认/模型发现写入/测试写入，带 revision 冲突与不变量 | `ConnectionCatalogDocumentOwner`（`create/update/remove/setDefaultTarget/writeModelFetchResult/prepareOnboardingUpsert/commitPreparedOnboarding/writeConnectionTestResult/clearConnectionLastTest`）、`catalogSnapshot`、`connectionBasis` |
| `runtime-policy/credential-vault-document.ts` | **凭据库**（`credential-vault.json`）：按 `CredentialLocator` 存 secret，与连接目录分离 | `CredentialVaultDocumentOwner`、`CredentialVaultEntry`、`MAX_VAULT_ENTRIES=2048`、`MAX_SECRET_LENGTH=64KB` |
| `runtime-policy/coordinator.ts` | 协调器：读写 facade 背后的真实现，ticket 乐观并发 | `RuntimePolicyCoordinator`（`beginModelFetch`→`issueTicket`、`completeModelFetch`→`claimTicket`+`checkSemanticConnectionBasis`→`committed|superseded`、`commitConnectionOnboarding`（含持久化 intent + 恢复）、`exportCredentialMaterial`、`resolveExecutionConnection`、`resolveNetworkProxyExecution`、`resolveWebSearchExecution`） |
| `runtime-policy/operations.ts` | 操作契约：ticket、begin/complete 结果、凭据材料 | `ModelFetchTicket`、`ConnectionTestTicket`、`BeginModelFetchResult`、`ConnectionEffectCompletionResult`、`RuntimePolicyOperationSecretMaterial` |
| `runtime-policy-stores.ts` | 读写 facade 的**品牌化鉴权**（brand token 运行时校验） | `RuntimePolicyStoresReader/Writer`、`authenticateRuntimePolicyStoresWriter` |
| `mcp-config-store.ts` | MCP 服务器配置存储（独立于连接目录） | `McpConfigStore` |

### 1.3 运行时效果执行（packages/runtime/src）

| 文件 | 职责 | 关键符号 |
|---|---|---|
| `connection-effect-fetch.ts` | 连接效果的网络执行：**有界 fetch**（超时/中止/响应体上限） | `fetchForConnectionEffect`、`ConnectionEffectFetchError`（`timeout|network`）、`CONNECTION_EFFECT_JSON_BODY_MAX_BYTES=4MB`、`CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES=16KB`、`readBoundedBody` |
| `connection-effect-outcome.ts` | 效果结果分类与错误类型 | `ConnectionModelDiscoveryEffectOutcome`、`ConnectionTestEffectOutcome`、`classifyConnectionEffectStatus`（401/403→auth，408→timeout，429/5xx→provider_unavailable） |
| `test-connection.ts` | 连接测试执行 | `runConnectionTestEffect` 等 |
| `mcp-tools.ts` | MCP 工具适配为模型工具：代理命名、冲突检测、**网络权限门**、内容截断 | `buildMcpTools`、`McpToolProvider`、`mcpProxyToolName`（64 字符 + SHA-256 哈希）、categoryHint 默认 `network_send`、`requestSandboxBoundary` 审批门 |
| `web-search-tool.ts` | WebSearch 模型工具包装 | `buildWebSearchTool`（`WebSearch`，max 200 字符） |
| `native-web-search-tool.ts` | 模型原生联网搜索执行 | `queryTavily` 等 |

### 1.4 运行时宿主编排（packages/runtime-host/src）

| 文件 | 职责 | 关键符号 |
|---|---|---|
| `server/connection-effect-coordinator.ts` | 连接效果编排：**在存储 lane 之外跑 I/O**，经激活门条件提交 | `HostConnectionEffectCoordinator`（handlers：`connection.onboarding.save`/`verify`、`connection.models.fetch`、`connection.test.run`）、`#admit/#enqueue`（**按 connectionId 串行化**）、`#withTransport`、`#connectionSecret`（OAuth 订阅经 `HostOAuthExecutionAuthority.bind`）、`#complete`（经 `RuntimePolicyActivationGate.runMutation`） |
| `server/runtime-policy-activation-gate.ts` | 变更/读取与后端激活窗口的协调、中毒（poison） | `RuntimePolicyActivationGate`（`runMutation`/`runReadActivation`/`poison`） |
| `server/connection-session.ts` | **传输层**连接会话（framed transport、请求分发）——注意与"LLM 连接"概念同名不同义 | `RuntimeHostConnectionSession`、`MAX_IN_FLIGHT_REQUESTS=64` |
| `client/connection.ts` | 客户端连接（runtime-host 选举、握手、请求） | `ConnectRuntimeHostInput`、`RuntimeHostConnection` |
| `server/connection-bound-chunk-uploads.ts` | 绑定连接的**分块上传暂存**（owner=hostEpoch+connectionId、TTL、容量上限） | `ConnectionBoundChunkUploads` |
| `protocol/connection-effects.ts` | 连接效果的**协议操作规范**（IPC/命令字） | `CONNECTION_EFFECT_OPERATION_SPECS`、`ConnectionEffectChangedDomain`（`connection|credential|network_proxy`）、`ConnectionEffectRejectionReason`、`ConnectionEffectFailureClass` |
| `server/web-search-tool.ts` + `web-search-coordinator.ts` + `protocol/web-search.ts` | WebSearch 执行服务 + `web-search.execute` 协议 | `createHostWebSearchService`、`HostWebSearchCoordinator` |

### 1.5 桌面接入（apps/desktop/src/main）

| 文件 | 职责 |
|---|---|
| `runtime-host-connections-ipc-main.ts` | `connections:*` IPC 处理器（list/getDefault/setDefault/create/test…），把 catalog 投影成 renderer 安全形态 |
| `connections-ipc-validation.ts` | IPC 边界的 baseUrl/slug/secret 归一化 |
| `runtime-host-account-connection.ts`、`oauth-connection-identities.ts` | OAuth 订阅账号连接与身份 |

---

## 2. 核心数据模型与流程

### 2.1 Connection 是什么
"Connection"在本域指 **LLM 提供商连接**：一份**不含机密**的配置文档，描述"我连谁、用什么凭据类型、用哪些模型、当前是否健康"。两类实现并存：
- **遗留**：`LlmConnection`（`llm-connections.json`，按 slug 标识，含 `apiKey` 字段但文档承诺不入盘）— `storage/connection-store.ts`
- **新规范**：`ConnectionCatalogEntry`（`connection-catalog.json`，按 `connectionId`+`revision` 标识，secret 永不入 catalog）— `storage/runtime-policy/connection-catalog-document.ts`

关键不变量（分散在 codec/store/协调器中强制）：
- `defaultModel ∈ enabledModelIds`（`reconcileConnectionAfterEnabledModelsChange`，`llm-connections.ts`）
- `relayModelProfiles` 只对 `openai-compatible` 存在、只覆盖 enabled 模型、端点变更即作废（`pruneRelayModelProfiles`）
- 默认目标 = `{connectionId, modelId}` 二元组，删除/禁用连接时自动失效（`remove`/`update` 中的 `defaultTarget` 清理）
- baseUrl 规范化：http/https、无凭据、无 query/fragment、与默认值相同则省略、**OAuth provider 端点不可覆盖**（`normalizeCatalogConnectionBaseUrl`）

### 2.2 Connection 生命周期（发现 → 鉴权 → 使用 → 隔离 → 失效）

```
发现模型    onboarding.verify → runModelDiscoveryEffect（带 secret）→ models
写库(原子)  onboarding.save  → commitConnectionOnboarding（catalog+vault 两写一事务，持久化 intent + 恢复）
鉴权        凭据独立存 credential-vault.json；OAuth 订阅经 PKCE + 票据 + HostOAuthExecutionAuthority.bind
使用        send-path: isConnectionReady 判定 → resolveExecutionConnection(slug) → 取 secret + proxy
健康        connection.test.run → beginConnectionTest(ticket) → 效果跑在 storage lane 外 → completeConnectionTest
失效        端点/选择变更 → lastTest 作废、默认目标失效、profile 修剪
```

**并发模型（本域最亮眼的设计）**：存储 lane 只做"准备/提交"，网络效果**在 lane 外执行**：
1. `beginModelFetch/beginConnectionTest` 在存储 lane 内签发 **ticket**（语义基准 = 连接当前 revision）；
2. 效果执行完调用 `completeModelFetch`，`claimTicket` 后**重读 catalog 比对语义基准**；
3. 基准未变 → `committed`；已变 → `superseded`（不覆盖新鲜状态）。见 `coordinator.ts` + `connection-effect-coordinator.ts`。

**隔离机制**：
- 网络执行经 `connection-effect-fetch.ts` 的**有界 fetch**（15s 超时、4MB/16KB 响应体上限、可中止）；
- 凭据永不进 catalog/快照/效果结果，只经 `exportCredentialMaterial` 在 effect 内短命使用；
- 效果按 `connectionId` 串行化（`#enqueue`），host 关闭时 `beginDrain` 拒绝新效果；
- 所有渲染器返回值经投影层（`projectHostConnections`），屏蔽原始 provider 错误与明文。

---

## 3. 书中要点对照（《深入理解 AI Agent》）

| 书中概念 | Maka connections 域如何体现 / 超越 |
|---|---|
| **观察空间/动作空间扩展** | 连接是 Agent 动作/感知空间超出本地沙箱的唯一合法出口：LLM 提供商 = 推理能力接入；MCP = 工具生态动作空间；WebSearch = 实时观察空间。每条出口都有 gate（readiness、权限、incognito、sandbox-boundary）。**超越**：Maka 把"扩展"本身建模成**有版本、可审计的配置文档**，而非一次性授权。 |
| **连接 = Agent 的感知接口** | `Connection` 即感知/推理接口的**配置态**：`ConnectionTarget{connectionId, modelId}` 是会话的"感知通道选择"。readiness 判定（`isConnectionReady`）就是"这条感知通道现在通不通"的形式化回答。**超越**：判定被收敛为单一纯函数 + 统一修复文案（`connection-error-copy.ts`），send-path 与 onboarding 共用，杜绝多份实现漂移。 |
| **工具生态 MCP** | `mcp-tools.ts` 把 MCP server/tool 转成统一 `MakaTool`：代理命名（防冲突/哈希）、schema 转换、结果内容截断（文本 200k 字符、图片 4 张/20MB）、**注解仅作提示而非安全边界**。**超越**：MCP 工具默认 `network_send` 类别，进入受管网络权限体系，调用前可触发 sandbox 边界审批。 |
| **权限边界** | 连接操作有**两层边界**：① 配置层 —— IPC 侧 baseUrl scheme 白名单、slug 校验、OAuth 端点钉死（`llm-connections.ts`/codec），防凭据外泄；② 执行层 —— `RuntimePolicyActivationGate`（读写与后端激活窗口隔离、poison）、受管网络权限（`executionBoundary`）、incognito 门。**超越**：Maka 把"权限"具体化为存储 lane + 效果 lane 的**物理分离**，而非只停留在调用前检查。 |

---

## 4. 当前实现分析

### 4.1 优点
1. **分层清晰且方向正确**：core（纯函数/编解码）→ storage（文档所有者 + 规范化）→ runtime（有界效果执行）→ runtime-host（协调 + 协议）→ desktop（投影）。每个层职责单一。
2. **机密与配置分离**：catalog 与 credential-vault 物理分文件、凭据按 `CredentialLocator` 索引、快照永不携带 secret。这是 local-first 里难得的纪律。
3. **乐观并发 + 语义基准**：ticket/claim/superseded 模式在多进程（desktop ↔ runtime-host）架构下显著优于"最后写者胜"。
4. **防御式输入处理**：`exactRecord` 严格解码、上限（1024 连接/2048 模型/512 启用）、`Object.fromEntries` 防原型污染、schemaVersion + v1→v2 迁移、document size 上限。
5. **边界安全**：baseUrl 白名单 + OAuth 端点不可覆盖 + MCP 网络审批门 + 掩码哨兵回环 + 错误分类（auth/timeout/provider_unavailable/network）。
6. **错误文案单一事实源**：`connection-error-copy.ts` 的 `Record<ChatConfigurationReason, string>` 类型把"新增 reason 必须配文案"变成编译期约束。

### 4.2 缺陷 / 风险
1. **"Connection"一词严重重载**（本域 42 文件里混着三类东西）：
   - (a) LLM 提供商连接（catalog）——真正的"connections 域"；
   - (b) 传输层连接会话（`connection-session.ts`、`client/connection.ts`、`connection-bound-chunk-uploads.ts`）——运行时宿主通道；
   - (c) 桌面 bridge 连接事件（`core/connections.ts`）。
   三者同名为"connection"，文档与目录会误导。
2. **双存储并存**：`llm-connections.json`（遗留）与 `connection-catalog.json`（新）同时是"连接"的事实源，迁移期存在双写/漂移风险；`mcp-config-store`、web-search 凭据又各自散落，未并入统一 catalog。
3. **凭据卫生不一致**：`web-search.ts` 明确注释 Tavily `apiKey` **明文存于 `settings.json`**，与 credential-vault 的隔离纪律矛盾（`core/web-search.ts` 注释："stored in cleartext on disk"）。
4. **就绪判定被拆分**：`isConnectionReady` 是纯函数，但 `hasSecret` 由调用方先异步解析，判定非原子；读到的 boolean 可能过期。
5. **OAuth 覆盖不全**：`oauth_subscription_not_wired` 表示多数 OAuth provider 处于"模型已建模、运行时未接通"状态，域广度超过实现深度。
6. **两套 IPC 通道**：`connections:*`（桌面 handler）与 runtime-host 的 `connection.*` 操作协议并存，未来易漂移。
7. **凭据以明文 JSON 落盘**（`credential-vault.json`），未接 OS keychain；对"local-first + 敏感凭据"是弱项（虽有大小上限与严格解码）。

### 4.3 与 "local-first + 权限隔离" 契合度
**整体契合度高**：一切按 workspace 本地文件、无云依赖；网络出口全部收敛到"效果 lane"且被 gate（激活门 + 受管网络 + incognito）；catalog 与 vault 分离保证最小暴露面。**但**有四处打折：明文 web-search key、双存储、OAuth 半成品、明文 JSON vault。这些是"合规性"问题而非"架构方向"问题。

---

## 5. 架构设计（目标态）

### 5.1 目标分层
```
[UI/IPC 投影层]   renderer-safe 投影、掩码、fix 文案
[协议层]          connection.* / web-search.* / mcp.* 操作规范（统一命名空间）
[编排层]          ConnectionEffectCoordinator：ticket + 激活门 + 按连接串行
[效果层]          有界 fetch / provider adapter / MCP transport / search adapter
[存储层]          统一 catalog + vault（单一事实源，所有 secret 走 vault）
[核心层]          类型 / codec / readiness / 纯判定（零 I/O）
```
建议把 `runtime-policy.ts` 拆出独立的 `connections/*` barrel，正式确立"connections 域"边界。

### 5.2 目标数据模型
一个 `Connection` 统一建模所有外部接入，用 `kind` 区分：
```ts
Connection {
  connectionId, revision, slug, name,
  kind: 'llm-provider' | 'mcp-server' | 'search-provider' | 'proxy',
  provider: { providerType, authKind, endpoint(canonical), oauthNonOverridable },
  selection: { enabledModelIds, defaultModel, relayModelProfiles },
  inventory: { models, modelSource, fetchedAt },      // llm 专用
  health: { lastTest },
  permissionProfileRef,                               // 使用该连接所需的授权
  credentialLocator: CredentialLocator,               // 一律指 vault，绝不内联
}
```
迁移路径：`llm-connections.json` → `connection-catalog.json`（schemaVersion 1→2）；MCP server 与 web-search 凭据并入统一 `CredentialLocator` 体系。

### 5.3 安全模型（目标态）
1. **所有 secret 进 vault**：包括 web-search key、MCP remote header、代理凭据；renderer 永远只见掩码。
2. **明文 JSON → 可选 OS keychain**（macOS Keychain / libsecret），vault 保持纯 JSON 兼容回退。
3. **按连接授权**：把"使用某连接"挂到 permission-profile（`permission.ts` 的 ToolCategory 体系），agent 需获批才能触达该连接暴露的工具/能力。
4. **端点安全固化**：维持 http/https 白名单 + OAuth 端点钉死 + 无凭据 URL；新增每连接的**网络 allowlist/denylist**。
5. **审计**：凭据使用、效果执行入 usage/tool ledger，可回放"谁在何时用哪条连接访问了什么"。

### 5.4 演进路径
1. **P0 统一事实源**：完成 catalog 迁移，废弃 `llm-connections.json` 写路径；统一 IPC 为 runtime-host 操作协议。
2. **P1 凭据归拢**：web-search/MCP/代理凭据全部迁入 vault；接入 keychain。
3. **P2 域边界**：拆分"connections 域"barrel，把 transport 会话从本域剥离（更名 `RuntimeHostSession` 类），消除同名重载。
4. **P3 能力化**：connection 挂接权限 profile + 审计 ledger；补齐 OAuth 运行路径覆盖。
5. **P4 观察性**：连接健康/使用统计面板、credential 生命周期管理（轮换/过期提示）。

---

## 6. 待讨论问题
1. **MCP 归属**：MCP 属于"connections 域"（外部接入）还是"tools 域"（工具生态）？当前类型在 `core/mcp.ts`，但工具适配在 `runtime/mcp-tools.ts`、权限挂在 `permission.ts`——边界有待明确。
2. **网络代理归属**：`networkProxy` 目前是 `runtime-policy.ts` 里的全局策略，但它本质是"连接的一部分（出口）"；是否并入 connection 模型？
3. **WebSearch 定位**：它是"一条连接"还是一个"policy 开关"？当前二者兼有（provider 凭据在 settings、开关在 runtime-policy），是否统一？
4. **双存储的迁移截止点**：何时移除 `llm-connections.json` 读兼容与 `migrateConnectionV1ToV2`？
5. **"Connection"术语治理**：是否把传输层会话改名为 `RuntimeHostSession`，让 `Connection` 专指外部接入？
6. **凭据落盘安全基线**：local-first 下是否必须 OS keychain，还是接受"严格解码 + 边界隔离"的明文 JSON 方案？
7. **OAuth 完成度**：`oauth_subscription_not_wired` 何时收敛为全 provider 可运行？这是当前域"广度 > 深度"的最大缺口。
