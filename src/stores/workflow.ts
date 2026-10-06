import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type {
  FrozenRevision,
  NodeKind,
  NodeResultRecord,
  NodeResultStatus,
  RunSession,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
import {
  buildRevision,
  isAcyclic,
  planResume,
  type ResumePlan,
} from '../utils/checkpoint'
import {
  autoLayout,
  connectionError,
  createWorkflowNode,
  createsCycle,
  definitionFor,
  NODE_DEFINITIONS,
  sampleWorkflow,
} from '../utils/workflow'

interface Snapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

interface WorkflowState {
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  selectedNodeId: string | null
  selectedEdgeId: string | null
  past: Snapshot[]
  future: Snapshot[]
  clipboard: WorkflowNode[]
  notice: string
  /** 是否有执行循环正在运行（运行中画布仍可编辑） */
  running: boolean
  sessions: RunSession[]
  activeSessionId: string | null
  setName: (name: string) => void
  onNodesChange: (changes: NodeChange<WorkflowNode>[]) => void
  onEdgesChange: (changes: EdgeChange<WorkflowEdge>[]) => void
  connect: (connection: Connection) => boolean
  addNode: (kind: NodeKind, position?: { x: number; y: number }) => void
  selectNode: (id: string | null) => void
  selectEdge: (id: string | null) => void
  updateNode: (id: string, patch: Partial<WorkflowNode['data']>) => void
  updateConfig: (id: string, key: string, value: string | number | boolean) => void
  updateForceFailure: (id: string, value: boolean) => void
  deleteSelection: () => void
  copySelection: () => void
  pasteSelection: () => void
  layout: () => void
  undo: () => void
  redo: () => void
  clearNotice: () => void
  /** 新建执行：冻结当前流程修订与参数，逐节点写检查点 */
  startRun: () => Promise<void>
  /**
   * 续跑：核对会话修订与当前画布。
   * 拓扑或上游参数不符且未确认时，拒绝并返回重跑计划；
   * 确认（或完全一致）后仅执行计划范围，保留其余已确认结果。
   */
  resumeSession: (sessionId: string, acceptChanges?: boolean) => Promise<ResumePlan | null>
  activateSession: (sessionId: string | null) => void
  exportDocument: () => WorkflowDocument
  importDocument: (document: WorkflowDocument) => { imported: number; skipped: number }
  loadDocument: (document: WorkflowDocument) => void
  reset: () => void
}

const initial = sampleWorkflow()

function snapshot(state: Pick<WorkflowState, 'nodes' | 'edges'>): Snapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
  }
}

function pushHistory(state: WorkflowState) {
  state.past.push(snapshot(state))
  if (state.past.length > 80) state.past.shift()
  state.future = []
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function resultStatusToView(status: NodeResultStatus): RunStatus {
  if (status === 'success') return 'success'
  if (status === 'error') return 'error'
  if (status === 'skipped') return 'skipped'
  return 'running'
}

/**
 * 把会话检查点投影到画布视图：
 * - 运行中：严格按冻结修订的检查点展示，画布改动不混入
 * - 已结束：成功结果与当前签名核对，不一致（含其上游 / 拓扑变化）标记失效
 */
function syncView(state: WorkflowState) {
  const session = state.sessions.find((item) => item.id === state.activeSessionId) ?? null
  const live: FrozenRevision | null =
    session && !state.running ? buildRevision(state.name, state.nodes, state.edges) : null

  const resultByNode = new Map<string, NodeResultRecord>()
  session?.results.forEach((record) => resultByNode.set(record.nodeId, record))
  const frozenNodeIds = new Set(session?.revision.nodes.map((node) => node.id) ?? [])

  state.nodes.forEach((node) => {
    if (!session) {
      node.data.status = 'idle'
      node.data.duration = undefined
      node.data.rows = undefined
      return
    }

    const record = resultByNode.get(node.id)

    if (state.running && session.status === 'running') {
      if (record) {
        node.data.status = resultStatusToView(record.status)
        node.data.duration = record.duration
        node.data.rows = record.rows
      } else {
        // 冻结修订内但尚未执行的节点排队；运行中新增的画布节点不属本次执行
        node.data.status = frozenNodeIds.has(node.id) ? 'queued' : 'idle'
        node.data.duration = undefined
        node.data.rows = undefined
      }
      return
    }

    if (record?.status === 'success') {
      const currentSignature = live?.signatures[node.id]
      const stale = currentSignature !== undefined && currentSignature !== record.signature
      node.data.status = stale ? 'stale' : 'success'
      node.data.duration = record.duration
      node.data.rows = record.rows
    } else if (record) {
      node.data.status = record.status === 'error' || record.status === 'skipped'
        ? record.status
        : 'queued'
      node.data.duration = record.duration
      node.data.rows = record.rows
    } else {
      node.data.status = 'idle'
      node.data.duration = undefined
      node.data.rows = undefined
    }
  })
}

function upsertResult(session: RunSession, record: NodeResultRecord) {
  const index = session.results.findIndex((item) => item.nodeId === record.nodeId)
  if (index >= 0) session.results[index] = record
  else session.results.push(record)
}

/** 执行循环：只跑 rerunSet 中的节点，其余检查点原样保留；失败沿下游传播跳过，旁支继续 */
async function execute(
  set: (fn: (draft: WorkflowState) => void) => void,
  get: () => WorkflowState,
  sessionId: string,
  revision: FrozenRevision,
  rerunSet: Set<string>,
) {
  set((draft) => {
    draft.running = true
    syncView(draft)
  })

  const frozenById = new Map(revision.nodes.map((node) => [node.id, node]))
  let firstError: string | null = null

  for (const id of revision.order) {
    if (!rerunSet.has(id)) continue

    // 每轮从最新状态读取上游检查点（前序节点可能刚刚落盘）
    const session = get().sessions.find((item) => item.id === sessionId)
    if (!session) break

    const inputs = revision.edges.filter((edge) => edge.target === id)
    const upstream = inputs.map((edge) =>
      session.results.find((record) => record.nodeId === edge.source),
    )
    const brokenUpstream = upstream.find(
      (record) => record && (record.status === 'error' || record.status === 'skipped'),
    )

    if (brokenUpstream) {
      set((draft) => {
        const target = draft.sessions.find((item) => item.id === sessionId)
        if (!target) return
        upsertResult(target, {
          nodeId: id,
          status: 'skipped',
          revisionId: revision.id,
          signature: revision.signatures[id],
          finishedAt: new Date().toISOString(),
          error: `上游节点 ${brokenUpstream.nodeId} 未成功，已跳过`,
        })
        syncView(draft)
      })
      continue
    }

    const startedAt = new Date().toISOString()
    set((draft) => {
      const target = draft.sessions.find((item) => item.id === sessionId)
      if (!target) return
      upsertResult(target, {
        nodeId: id,
        status: 'running',
        revisionId: revision.id,
        signature: revision.signatures[id],
        startedAt,
      })
      syncView(draft)
    })

    const duration = 240 + Math.round(Math.random() * 620)
    await delay(duration)

    const frozen = frozenById.get(id)
    const now = new Date().toISOString()
    set((draft) => {
      const target = draft.sessions.find((item) => item.id === sessionId)
      if (!target) return
      if (frozen?.forceFailure) {
        upsertResult(target, {
          nodeId: id,
          status: 'error',
          revisionId: revision.id,
          signature: revision.signatures[id],
          startedAt,
          finishedAt: now,
          duration,
          error: `节点「${frozen.label}」模拟执行失败（断点触发）`,
        })
        firstError ??= id
      } else {
        upsertResult(target, {
          nodeId: id,
          status: 'success',
          revisionId: revision.id,
          signature: revision.signatures[id],
          startedAt,
          finishedAt: now,
          duration,
          rows: 1200 + Math.round(Math.random() * 88000),
        })
      }
      syncView(draft)
    })
  }

  set((draft) => {
    const session = draft.sessions.find((item) => item.id === sessionId)
    if (session) {
      const hasError = session.results.some((record) => record.status === 'error')
      session.status = hasError ? 'failed' : 'success'
      session.finishedAt = new Date().toISOString()
      session.errorNodeId = firstError
      const total = session.results.reduce((sum, record) => sum + (record.duration ?? 0), 0)
      if (hasError) {
        draft.notice = `执行在「${frozenById.get(firstError ?? '')?.label ?? '某节点'}」处失败，已确认结果已保留，可修复后续跑`
      } else {
        draft.notice = `执行完成：${rerunSet.size} 个节点参与本轮，累计耗时 ${total} ms`
      }
    }
    draft.running = false
    syncView(draft)
  })
}

export const useWorkflowStore = create<WorkflowState>()(immer((set, get) => ({
  name: '订单经营分析流程',
  nodes: initial.nodes,
  edges: initial.edges,
  selectedNodeId: null,
  selectedEdgeId: null,
  past: [],
  future: [],
  clipboard: [],
  notice: '端口与类型校验已开启',
  running: false,
  sessions: [],
  activeSessionId: null,

  setName: (name) => set((state) => {
    state.name = name
    syncView(state)
  }),

  onNodesChange: (changes) => set((state) => {
    state.nodes = applyNodeChanges(changes, state.nodes)
    syncView(state)
  }),

  onEdgesChange: (changes) => set((state) => {
    state.edges = applyEdgeChanges(changes, state.edges)
    syncView(state)
  }),

  connect: (connection) => {
    const state = get()
    const error = connectionError(connection, state.nodes)
    if (error) {
      set((draft) => { draft.notice = error })
      return false
    }
    if (createsCycle(connection, state.edges)) {
      set((draft) => { draft.notice = '连接被拒绝：检测到环形依赖' })
      return false
    }
    set((draft) => {
      pushHistory(draft)
      const source = draft.nodes.find((node) => node.id === connection.source)
      const sourceHandle = connection.sourceHandle ?? ''
      const type = sourceHandle.startsWith('out-1') ? 'number' : 'dataset'
      draft.edges = addEdge({
        ...connection,
        id: `edge-${Date.now().toString(36)}`,
        type: 'smoothstep',
        animated: true,
        data: { portType: type },
      }, draft.edges) as WorkflowEdge[]
      draft.notice = '连接成功，端口类型兼容'
      syncView(draft)
    })
    return true
  },

  addNode: (kind, position) => set((draft) => {
    pushHistory(draft)
    const node = createWorkflowNode(kind, position ?? { x: 120 + draft.nodes.length * 28, y: 120 + draft.nodes.length * 22 })
    draft.nodes.push(node)
    draft.selectedNodeId = node.id
    draft.selectedEdgeId = null
    draft.notice = `已添加${definitionFor(kind).label}`
    syncView(draft)
  }),

  selectNode: (id) => set((state) => {
    state.selectedNodeId = id
    state.selectedEdgeId = null
  }),

  selectEdge: (id) => set((state) => {
    state.selectedEdgeId = id
    state.selectedNodeId = null
  }),

  updateNode: (id, patch) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (!node) return
    pushHistory(draft)
    node.data = { ...node.data, ...patch }
    syncView(draft)
  }),

  updateConfig: (id, key, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (!node) return
    pushHistory(draft)
    node.data.config[key] = value
    syncView(draft)
  }),

  updateForceFailure: (id, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (!node) return
    pushHistory(draft)
    node.data.forceFailure = value
    draft.notice = value ? '已在该节点设置失败断点，下次执行将在此失败' : '已清除失败断点'
    syncView(draft)
  }),

  deleteSelection: () => set((draft) => {
    if (!draft.selectedNodeId && !draft.selectedEdgeId) return
    pushHistory(draft)
    if (draft.selectedNodeId) {
      const id = draft.selectedNodeId
      draft.nodes = draft.nodes.filter((node) => node.id !== id)
      draft.edges = draft.edges.filter((edge) => edge.source !== id && edge.target !== id)
      draft.selectedNodeId = null
    }
    if (draft.selectedEdgeId) {
      draft.edges = draft.edges.filter((edge) => edge.id !== draft.selectedEdgeId)
      draft.selectedEdgeId = null
    }
    syncView(draft)
  }),

  copySelection: () => set((draft) => {
    const selected = draft.nodes.filter((node) => node.id === draft.selectedNodeId)
    draft.clipboard = JSON.parse(JSON.stringify(selected)) as WorkflowNode[]
    if (selected.length) draft.notice = `已复制 ${selected.length} 个节点`
  }),

  pasteSelection: () => set((draft) => {
    if (!draft.clipboard.length) return
    pushHistory(draft)
    const copies = draft.clipboard.map((source) => {
      const copy = JSON.parse(JSON.stringify(source)) as WorkflowNode
      copy.id = `${source.data.kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      copy.position = { x: source.position.x + 36, y: source.position.y + 36 }
      copy.selected = false
      draft.nodes.push(copy)
      return copy
    })
    draft.selectedNodeId = copies[0]?.id ?? null
    draft.notice = `已粘贴 ${copies.length} 个节点`
    syncView(draft)
  }),

  layout: () => set((draft) => {
    pushHistory(draft)
    draft.nodes = autoLayout(draft.nodes, draft.edges)
    draft.notice = '已按依赖层级自动布局'
    syncView(draft)
  }),

  undo: () => set((draft) => {
    const previous = draft.past.pop()
    if (!previous) return
    draft.future.push(snapshot(draft))
    draft.nodes = previous.nodes
    draft.edges = previous.edges
    draft.notice = '已撤销上一步操作'
    syncView(draft)
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(snapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    draft.notice = '已恢复操作'
    syncView(draft)
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  startRun: async () => {
    const state = get()
    if (state.running) return
    if (!isAcyclic(state.nodes, state.edges)) {
      set((draft) => { draft.notice = '存在环或无效依赖，无法执行' })
      return
    }
    const revision = buildRevision(state.name, state.nodes, state.edges)
    const now = new Date().toISOString()
    const session: RunSession = {
      id: `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: `执行 #${state.sessions.length + 1}`,
      createdAt: now,
      startedAt: now,
      status: 'running',
      revision,
      revisionHistory: [],
      order: revision.order.slice(),
      results: [],
      retiredResults: [],
      errorNodeId: null,
    }
    set((draft) => {
      draft.sessions.push(session)
      draft.activeSessionId = session.id
      draft.notice = '已冻结流程修订与参数，开始执行'
    })
    await execute(set, get, session.id, revision, new Set(revision.order))
  },

  resumeSession: async (sessionId, acceptChanges = false) => {
    const state = get()
    if (state.running) return null
    const session = state.sessions.find((item) => item.id === sessionId)
    if (!session) return null
    if (session.status === 'success') {
      set((draft) => { draft.notice = '该会话已全部成功，无需续跑' })
      return null
    }

    const current = buildRevision(state.name, state.nodes, state.edges)
    const invalidGraph = !isAcyclic(state.nodes, state.edges)
    const plan = planResume(session, current, invalidGraph)

    // 拓扑或上游参数不符：拒绝直接续跑，列出重跑范围等待确认
    if (plan.reason && !acceptChanges) {
      set((draft) => {
        draft.activeSessionId = sessionId
        draft.notice = `续跑被拒绝：${plan.reason}。确认后将重跑 ${plan.rerun.length} 个节点，保留 ${plan.reusable.length} 个已确认结果`
        syncView(draft)
      })
      return plan
    }
    if (plan.invalidGraph) return plan

    set((draft) => {
      const target = draft.sessions.find((item) => item.id === sessionId)!
      draft.activeSessionId = sessionId
      if (current.id !== target.revision.id) {
        // 确认按当前画布重冻结：移除节点的历史结果归档保留，受影响结果随后续跑覆盖
        const currentIds = new Set(current.nodes.map((node) => node.id))
        const rerunIds = new Set(plan.rerun)
        const kept: NodeResultRecord[] = []
        target.results.forEach((record) => {
          if (!currentIds.has(record.nodeId)) {
            target.retiredResults.push(record)
            return
          }
          // 范围外复用的成功结果：产物一致，仅把签名 / 修订迁移到新版本
          if (record.status === 'success' && !rerunIds.has(record.nodeId)) {
            kept.push({
              ...record,
              revisionId: current.id,
              signature: current.signatures[record.nodeId] ?? record.signature,
            })
          } else {
            kept.push(record)
          }
        })
        target.results = kept
        target.revisionHistory.push({
          id: target.revision.id,
          createdAt: new Date().toISOString(),
          reason: plan.reason ?? '续跑前重新冻结',
        })
        target.revision = current
        target.order = current.order.slice()
      }
      target.status = 'running'
      target.startedAt = new Date().toISOString()
      target.finishedAt = undefined
      target.errorNodeId = null
      draft.notice = `续跑启动：${plan.rerun.length} 个节点待执行，${plan.reusable.length} 个已确认结果直接复用`
    })

    await execute(set, get, sessionId, current, new Set(plan.rerun))
    return null
  },

  activateSession: (sessionId) => set((draft) => {
    draft.activeSessionId = sessionId
    syncView(draft)
  }),

  exportDocument: () => {
    const state = get()
    return {
      version: 2 as const,
      name: state.name,
      nodes: state.nodes,
      edges: state.edges,
      savedAt: new Date().toISOString(),
      sessions: JSON.parse(JSON.stringify(state.sessions)) as RunSession[],
      activeSessionId: state.activeSessionId,
      history: {
        past: JSON.parse(JSON.stringify(state.past)) as Snapshot[],
        future: JSON.parse(JSON.stringify(state.future)) as Snapshot[],
      },
    }
  },

  importDocument: (document) => {
    const importedSessions = (document.sessions ?? []).map((session) => {
      const normalized: RunSession = JSON.parse(JSON.stringify(session)) as RunSession
      // 导出时仍在运行的会话，恢复后视为中断失败，避免永久卡在运行态
      if (normalized.status === 'running') {
        normalized.status = 'failed'
        normalized.finishedAt ??= new Date().toISOString()
      }
      normalized.revisionHistory ??= []
      normalized.retiredResults ??= []
      return normalized
    })
    let imported = 0
    let skipped = 0
    set((draft) => {
      const existing = new Set(draft.sessions.map((session) => session.id))
      importedSessions.forEach((session) => {
        // 新执行 / 新导入不覆盖旧记录：同 ID 会话保留原有副本
        if (existing.has(session.id)) {
          skipped += 1
          return
        }
        draft.sessions.push(session)
        existing.add(session.id)
        imported += 1
      })
      draft.name = document.name
      draft.nodes = document.nodes
      draft.edges = document.edges
      draft.past = (document.history?.past ?? []) as Snapshot[]
      draft.future = (document.history?.future ?? []) as Snapshot[]
      draft.selectedNodeId = null
      draft.selectedEdgeId = null
      const preferred = document.activeSessionId
      draft.activeSessionId = preferred && existing.has(preferred)
        ? preferred
        : importedSessions[0]?.id ?? null
      draft.notice = `已导入 ${imported} 个执行会话${skipped ? `，${skipped} 个同 ID 旧记录已保留` : ''}`
      syncView(draft)
    })
    return { imported, skipped }
  },

  loadDocument: (document) => set((draft) => {
    draft.name = document.name
    draft.nodes = document.nodes
    draft.edges = document.edges
    draft.past = []
    draft.future = []
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    draft.activeSessionId = null
    draft.notice = '流程 JSON 已导入（v1 文档不含执行会话）'
    syncView(draft)
  }),

  reset: () => set((draft) => {
    pushHistory(draft)
    const fresh = sampleWorkflow()
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    draft.activeSessionId = null
    draft.notice = '已恢复示例流程，历史执行会话仍可在会话列表查看'
    syncView(draft)
  }),
})))

export const nodeDefinitions = NODE_DEFINITIONS

export function statusLabel(status: RunStatus) {
  return {
    idle: '待执行',
    queued: '已排队',
    running: '运行中',
    success: '执行成功',
    error: '执行失败',
    skipped: '已跳过',
    stale: '结果已失效',
  }[status]
}

export function sessionStatusLabel(status: RunSession['status']) {
  return {
    running: '运行中',
    success: '成功',
    failed: '失败 / 可续跑',
  }[status]
}
