/**
 * Subagent sessions — session presentation contract (design lock).
 *
 * - Sidebar lists only root/user sessions (no nested subagent tree).
 * - Multiple spawn_subagent calls in one turn render as one collapsible
 *   ToolTrow / ChatToolCalls group (product tool primitives).
 * - Opening a linked subagent switches the main chat column (option A);
 *   titlebar is project › parent › child.
 * - No composer drawer, strip, or parallel card system for subagents.
 *
 * Review scaffold for the layout target; not yet the shipped shell path.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { BreadcrumbItem, Breadcrumbs } from '@astryxdesign/core/Breadcrumbs';
import {
  ChatComposer,
  ChatComposerInput,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatMessageMetadata,
  ChatToolCalls,
  type ChatToolCallItem,
} from '@astryxdesign/core/Chat';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import type { ToolResultContent } from '@maka/core';
import { formatDuration } from '../../../packages/ui/src/tool-activity/preview-utils.js';
import { formatToolIntent } from '../../../packages/ui/src/tool-format.js';
import { resolveToolDisplayName } from '../../../packages/ui/src/tool-activity/display-name.js';
import { ToolCallDetail } from '../../../packages/ui/src/tool-activity.js';
import type { ToolActivityItem } from '../../../packages/ui/src/materialize.js';
import { useUiLocale } from '../../../packages/ui/src/locale-context.js';

// ---------------------------------------------------------------------------
// Fixtures — multi-subagent contiguous tool run
// ---------------------------------------------------------------------------

const NOW = 1_735_689_600_000;
const PARENT_NAME = '实现会话任务台账';
const PROJECT_NAME = 'maka-agent';

function subagentResult(
  partial: Partial<Extract<ToolResultContent, { kind: 'subagent' }>> &
    Pick<Extract<ToolResultContent, { kind: 'subagent' }>, 'agentName' | 'status'>,
): Extract<ToolResultContent, { kind: 'subagent' }> {
  return {
    kind: 'subagent',
    agentId: partial.agentId ?? `agent-${partial.agentName}`,
    agentName: partial.agentName,
    turnId: partial.turnId ?? `turn-${partial.agentName}`,
    runId: partial.runId ?? `run-${partial.agentName}`,
    // Linked child id is what product open wiring needs; stories seed it so
    // expanded tool detail shows the same Open control as the shell.
    childSessionId: partial.childSessionId ?? `session-${partial.agentName}`,
    status: partial.status,
    permissionMode: partial.permissionMode ?? 'ask',
    summary: partial.summary ?? '',
    artifactIds: partial.artifactIds ?? [],
    startedAt: partial.startedAt ?? NOW - 60_000,
    completedAt: partial.completedAt,
    durationMs: partial.durationMs ?? 12_000,
    eventCount: partial.eventCount ?? 8,
    ...(partial.failureClass ? { failureClass: partial.failureClass } : {}),
  };
}

const MULTI_SUBAGENT_ITEMS: ToolActivityItem[] = [
  {
    toolUseId: 'sa-explore-layout',
    toolName: 'spawn_subagent',
    displayName: 'explore · 读布局',
    intent: '扫 desktop session list 与 workbar 相关样式',
    status: 'running',
    args: { agentName: 'explore · 读布局', objective: '扫 desktop session list 与 workbar 相关样式' },
    result: subagentResult({
      agentName: 'explore · 读布局',
      status: 'running',
      permissionMode: 'explore',
      durationMs: 72_000,
      startedAt: NOW - 72_000,
    }),
    durationMs: 72_000,
  },
  {
    toolUseId: 'sa-coder-draft',
    toolName: 'spawn_subagent',
    displayName: 'coder · 写草案',
    intent: '起草 titlebar breadcrumb 扩展点',
    status: 'running',
    args: { agentName: 'coder · 写草案', objective: '起草 titlebar breadcrumb 扩展点' },
    result: subagentResult({
      agentName: 'coder · 写草案',
      status: 'running',
      durationMs: 48_000,
      startedAt: NOW - 48_000,
    }),
    durationMs: 48_000,
  },
  {
    toolUseId: 'sa-review-contract',
    toolName: 'spawn_subagent',
    displayName: 'review · 契约',
    intent: '核对侧栏不再渲染 data-subagent 嵌套行',
    status: 'completed',
    args: { agentName: 'review · 契约', objective: '核对侧栏不再渲染 data-subagent 嵌套行' },
    result: subagentResult({
      agentName: 'review · 契约',
      status: 'completed',
      summary: '侧栏无嵌套；入口仅在流内工具组。',
      durationMs: 125_000,
      startedAt: NOW - 200_000,
      completedAt: NOW - 75_000,
    }),
    durationMs: 125_000,
  },
  {
    toolUseId: 'sa-explore-fail',
    toolName: 'spawn_subagent',
    displayName: 'explore · 失败样例',
    intent: '演示失败态在分组工具行中的可读性',
    status: 'errored',
    args: { agentName: 'explore · 失败样例', objective: '演示失败态' },
    result: subagentResult({
      agentName: 'explore · 失败样例',
      status: 'failed',
      summary: '权限边界拒绝读取 .env。',
      failureClass: 'permission_denied',
      durationMs: 19_000,
      startedAt: NOW - 40_000,
      completedAt: NOW - 21_000,
    }),
    durationMs: 19_000,
  },
  {
    toolUseId: 'sa-waiting',
    toolName: 'spawn_subagent',
    displayName: 'explore · 等用户',
    intent: '等待批准后再读路径',
    status: 'running',
    args: { agentName: 'explore · 等用户', objective: '等待批准后再读路径', permissionMode: 'explore' },
    result: subagentResult({
      agentName: 'explore · 等用户',
      status: 'waiting_for_user',
      permissionMode: 'explore',
      summary: 'Waiting for approval before reading the requested path.',
      durationMs: 4_000,
      startedAt: NOW - 4_000,
    }),
    durationMs: 4_000,
  },
];

function childLabel(item: ToolActivityItem): string {
  if (item.result?.kind === 'subagent' && item.result.agentName) return item.result.agentName;
  return item.displayName || item.toolName;
}

function childObjective(item: ToolActivityItem): string {
  if (typeof item.intent === 'string' && item.intent.trim()) return item.intent;
  return childLabel(item);
}

function astryxToolStatus(item: ToolActivityItem): ChatToolCallItem['status'] {
  switch (item.status) {
    case 'completed':
      return 'complete';
    case 'errored':
    case 'interrupted':
      return 'error';
    case 'running':
      return 'running';
    default:
      return 'pending';
  }
}

/**
 * Same data mapping as product `ToolTrow`, with optional expand control for the
 * fold story. Hosted under `.maka-turn` so product hover paint applies:
 * `apps/desktop/src/renderer/styles/chat-message.css` scopes
 * `.astryx-chat-tool-calls [role="button"]:hover` to that turn root.
 * Bare ChatToolCalls outside a turn is the wrong frame, not a different component.
 */
function SubagentToolGroup(props: {
  items: ToolActivityItem[];
  defaultIsExpanded?: boolean;
  onOpenLinkedSession?(sessionId: string): void;
}) {
  const locale = useUiLocale();
  if (props.items.length === 0) return null;
  const calls: ChatToolCallItem[] = props.items.map((item) => ({
    key: item.toolUseId,
    name: resolveToolDisplayName(item, locale),
    status: astryxToolStatus(item),
    target: item.intent ? formatToolIntent(item.intent) : undefined,
    duration: formatDuration(item.durationMs) ?? undefined,
    resultDetail: (
      <div className="maka-tool-call-detail">
        <ToolCallDetail item={item} onOpenLinkedSession={props.onOpenLinkedSession} />
      </div>
    ),
  }));
  return (
    <div className="maka-turn">
      <ChatToolCalls
        calls={calls}
        defaultIsExpanded={props.defaultIsExpanded}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

const shell: Record<string, CSSProperties> = {
  root: {
    height: 720,
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-background-body, #f4f4f5)',
    color: 'var(--color-text-primary)',
    fontFamily: 'var(--font-sans, system-ui)',
  },
  titlebar: {
    height: 44,
    display: 'flex',
    alignItems: 'center',
    paddingInline: 16,
    gap: 12,
    borderBottom: '1px solid var(--color-border-muted, rgba(0,0,0,0.08))',
    flex: '0 0 auto',
  },
  body: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'row',
    gap: 12,
    padding: 12,
  },
  plate: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--color-background-surface, #fff)',
    borderRadius: 12,
    overflow: 'hidden',
  },
  stream: {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    padding: '16px 20px',
  },
  composerStack: {
    flex: '0 0 auto',
    padding: '0 16px 16px',
  },
  caption: {
    padding: '6px 12px',
    borderBottom: '1px solid var(--color-border-muted, rgba(0,0,0,0.06))',
    background: 'var(--color-background-muted, rgba(0,0,0,0.03))',
  },
  sideNav: {
    width: 220,
    flex: '0 0 auto',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: 10,
    background: 'var(--color-background-surface, #fff)',
    borderRadius: 12,
    overflow: 'auto',
  },
  sideNavLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.04em',
    textTransform: 'uppercase' as const,
    color: 'var(--color-text-secondary, #71717a)',
    padding: '4px 8px',
  },
  sideNavRow: {
    padding: '8px 10px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
  },
  sideNavRowActive: {
    background: 'var(--color-background-muted, rgba(0,0,0,0.06))',
  },
  compareRoot: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
    padding: 16,
    minHeight: 560,
    boxSizing: 'border-box' as const,
    background: 'var(--color-background-body, #f4f4f5)',
  },
  comparePane: {
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: 10,
    padding: 14,
    borderRadius: 12,
    background: 'var(--color-background-surface, #fff)',
    border: '1px solid var(--color-border-muted, rgba(0,0,0,0.1))',
  },
};

function Caption(props: { children: ReactNode }) {
  return (
    <div style={shell.caption}>
      <Text type="supporting" color="secondary">
        {props.children}
      </Text>
    </div>
  );
}

function TitlebarTrail(props: {
  project?: string;
  parent?: { name: string; onClick?: () => void };
  sessionName: string;
  sessionIsCurrent?: boolean;
}) {
  return (
    <Breadcrumbs
      label="会话位置"
      separator={<Icon icon="chevronRight" size="xsm" />}
    >
      {props.project ? (
        <BreadcrumbItem onClick={() => undefined}>{props.project}</BreadcrumbItem>
      ) : null}
      {props.parent ? (
        <BreadcrumbItem onClick={props.parent.onClick}>{props.parent.name}</BreadcrumbItem>
      ) : null}
      <BreadcrumbItem isCurrent={props.sessionIsCurrent ?? !props.parent}>
        {props.sessionName}
      </BreadcrumbItem>
    </Breadcrumbs>
  );
}

function RootSidebar() {
  return (
    <aside style={shell.sideNav} aria-label="会话列表">
      <div style={shell.sideNavLabel}>会话</div>
      <div style={{ ...shell.sideNavRow, ...shell.sideNavRowActive }}>{PARENT_NAME}</div>
      <div style={shell.sideNavRow}>修 CI 绿线</div>
      <div style={shell.sideNavRow}>文档润色</div>
      <div style={{ marginTop: 12, paddingInline: 8 }}>
        <Text type="supporting" color="secondary">
          仅 root 会话；无 data-subagent 嵌套。
        </Text>
      </div>
    </aside>
  );
}

function ParentShell() {
  return (
    <div style={shell.root} data-maka-contract="subagent-session-layout">
      <header style={shell.titlebar}>
        <TitlebarTrail project={PROJECT_NAME} sessionName={PARENT_NAME} />
      </header>
      <Caption>
        侧栏无嵌套。流内一组可折叠 spawn_subagent（仅工具原语）。产品在 linked
        工具行上挂打开；无第二套列表、无 ComposerDrawer / strip。
      </Caption>
      <div style={shell.body}>
        <RootSidebar />
        <div style={shell.plate}>
          <div style={shell.stream}>
            <ChatMessageList>
              <ChatMessage sender="user">
                <ChatMessageBubble>
                  并行派多个子代理做布局扫描、草案与契约核对。
                </ChatMessageBubble>
              </ChatMessage>
              <ChatMessage sender="assistant" name="Maka">
                <ChatMessageBubble>
                  当轮连续 spawn_subagent 合成一个工具组（与其它连续 tool run 相同）。点某行进对应子会话（产品接线，非下方平行列表）。
                </ChatMessageBubble>
                <ChatMessageMetadata timestamp="刚刚" />
                <div style={{ marginTop: 10, width: '100%' }}>
                  <SubagentToolGroup
                    items={MULTI_SUBAGENT_ITEMS}
                    defaultIsExpanded
                    onOpenLinkedSession={() => undefined}
                  />
                </div>
              </ChatMessage>
            </ChatMessageList>
          </div>
          <div style={shell.composerStack}>
            <ChatComposer
              onSubmit={() => undefined}
              placeholder="继续编排父会话…"
              input={<ChatComposerInput aria-label="消息输入" />}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stories — three locks, nothing else
// ---------------------------------------------------------------------------

const meta = {
  title: 'Product/Subagent Sessions',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Session presentation for subagents: flat sidebar, collapsible multi-spawn tool group, ' +
          'main-column open with parent › child titlebar. No composer drawer.',
      },
    },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

// Real path: Review scaffold — parent session with multi-subagent tool group, flat sidebar, open child in main column; design lock, not yet shipped shell path.
export const ParentSession: Story = {
  name: '父会话 · 工具组 + 打开子会话',
  render: () => <ParentShell />,
};

// Real path: Review scaffold — multi spawn_subagent group collapsed vs expanded using ChatToolCalls; side-by-side review aid, not a product screen.
export const ToolGroupFold: Story = {
  name: '工具组 · 折叠 vs 展开',
  render: () => (
    <div style={shell.compareRoot}>
      <div style={shell.comparePane}>
        <Text type="body" style={{ fontWeight: 600 }}>
          折叠
        </Text>
        <Text type="supporting" color="secondary">
          {MULTI_SUBAGENT_ITEMS.length} 个 spawn_subagent 一组；头上数量 + 最近行（同 ContiguousGroup）。
        </Text>
        <SubagentToolGroup
          items={MULTI_SUBAGENT_ITEMS}
          defaultIsExpanded={false}
          onOpenLinkedSession={() => undefined}
        />
      </div>
      <div style={shell.comparePane}>
        <Text type="body" style={{ fontWeight: 600 }}>
          展开
        </Text>
        <Text type="supporting" color="secondary">
          每行 + resultDetail = 现有 ToolCallDetail / SubagentPreview（含打开会话）。
        </Text>
        <SubagentToolGroup
          items={MULTI_SUBAGENT_ITEMS}
          defaultIsExpanded
          onOpenLinkedSession={() => undefined}
        />
      </div>
    </div>
  ),
};

// Real path: Review scaffold — child session main column with project › parent › child breadcrumbs after open from tool group; design lock, not yet shipped.
export const ChildSession: Story = {
  name: '子会话 · 面包屑回父',
  render: () => {
    const item = MULTI_SUBAGENT_ITEMS[0]!;
    return (
      <div style={shell.root}>
        <header style={shell.titlebar}>
          <TitlebarTrail
            project={PROJECT_NAME}
            parent={{ name: PARENT_NAME }}
            sessionName={childLabel(item)}
            sessionIsCurrent
          />
        </header>
        <Caption>
          从工具组打开后的主区。侧栏仍是 root 列表，不嵌套该子代理。
        </Caption>
        <div style={shell.body}>
          <RootSidebar />
          <div style={shell.plate}>
            <div style={shell.stream}>
              <ChatMessageList>
                <ChatMessage sender="user">
                  <ChatMessageBubble>{childObjective(item)}</ChatMessageBubble>
                </ChatMessage>
                <ChatMessage sender="assistant" name={childLabel(item)}>
                  <ChatMessageBubble>子代理完整会话流。</ChatMessageBubble>
                  <ChatMessageMetadata timestamp="运行中" />
                </ChatMessage>
              </ChatMessageList>
            </div>
            <div style={shell.composerStack}>
              <ChatComposer
                onSubmit={() => undefined}
                placeholder="向该子代理追问…"
                input={<ChatComposerInput aria-label="子会话消息输入" />}
              />
            </div>
          </div>
        </div>
      </div>
    );
  },
};

