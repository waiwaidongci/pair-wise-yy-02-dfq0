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
import type { WritableDraft } from 'immer'
import type {
  ExecutionLogEntry,
  ExecutionSession,
  FlowRevision,
  NodeExecutionResult,
  NodeKind,
  RunStatus,
  WorkflowDocument,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
import {
  autoLayout,
  computeResumePlan,
  connectionError,
  createWorkflowNode,
  createsCycle,
  definitionFor,
  freezeRevision,
  NODE_DEFINITIONS,
  sampleWorkflow,
  topologicalOrder,
} from '../utils/workflow'

interface Snapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

interface PlanResumeResult {
  session: ExecutionSession
  plan: ReturnType<typeof computeResumePlan>
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
  running: boolean
  /** 全部执行会话（含历史），新执行只追加不覆盖 */
  sessions: ExecutionSession[]
  /** 当前展示/运行的会话 id；null 时展示最新会话 */
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
  deleteSelection: () => void
  copySelection: () => void
  pasteSelection: () => void
  layout: () => void
  undo: () => void
  redo: () => void
  clearNotice: () => void
  /** 冻结当前画布修订并发起一次全新执行 */
  startRun: () => Promise<void>
  /** 续跑核对：返回会话与重跑范围；硬拒绝（环/节点缺失/无需重跑）时返回 null 并写入 notice */
  planResume: () => PlanResumeResult | null
  /** 按核对结果续跑：只重跑失效节点，旁支与上游已确认结果不重算 */
  executeResume: (sessionId: string) => Promise<void>
  /** 选择要查看的会话（运行中不可切换） */
  selectSession: (sessionId: string | null) => void
  loadDocument: (document: WorkflowDocument) => void
  reset: () => void
}

const initial = sampleWorkflow()

/** 模拟执行的节点失败概率：失败后可续跑且保留上游结果 */
const FAIL_RATE = 0.1

function snapshot(state: Pick<WorkflowState, 'nodes' | 'edges'>): Snapshot {
  return {
    nodes: JSON.parse(JSON.stringify(state.nodes)) as WorkflowNode[],
    edges: JSON.parse(JSON.stringify(state.edges)) as WorkflowEdge[],
  }
}

function pushHistory(state: WritableDraft<WorkflowState>) {
  state.past.push(snapshot(state))
  if (state.past.length > 80) state.past.shift()
  state.future = []
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function nowIso() {
  return new Date().toISOString()
}

function appendLog(
  session: WritableDraft<ExecutionSession>,
  level: ExecutionLogEntry['level'],
  message: string,
  nodeId?: string,
) {
  session.log.push({ time: nowIso(), level, message, nodeId })
}

function summarize(results: Record<string, NodeExecutionResult>) {
  const list = Object.values(results)
  return {
    successCount: list.filter((result) => result.status === 'success').length,
    totalDuration: list.reduce((sum, result) => sum + (result.duration ?? 0), 0),
  }
}

function createSession(revision: FlowRevision, trigger: ExecutionSession['trigger']): ExecutionSession {
  return {
    id: `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    status: 'running',
    trigger,
    revision,
    results: {},
    log: [{
      time: nowIso(),
      level: 'info',
      message: `已冻结流程修订 ${revision.revisionHash}（${revision.nodes.length} 个节点，${revision.edges.length} 条连线）`,
    }],
  }
}

/**
 * 在指定会话内按给定节点顺序执行。
 * 执行全程只读冻结修订与会话记录，画布后续改动不会进入本次执行。
 * 返回 'success' | 'error'。
 */
async function executeNodes(
  get: () => WorkflowState,
  set: (partial: Partial<WorkflowState> | ((draft: WritableDraft<WorkflowState>) => void)) => void,
  sessionId: string,
  ids: string[],
): Promise<'success' | 'error'> {
  for (const id of ids) {
    const session = get().sessions.find((item) => item.id === sessionId)
    const frozen = session?.revision.nodes.find((item) => item.id === id)
    if (!session || !frozen) continue

    set((draft) => {
      const target = draft.sessions.find((item) => item.id === sessionId)
      if (!target) return
      target.currentNodeId = id
      target.status = 'running'
      target.updatedAt = nowIso()
      appendLog(target, 'info', `节点「${frozen.label}」开始执行`, id)
    })

    const duration = 240 + Math.round(Math.random() * 620)
    await delay(duration)
    const failed = Math.random() < FAIL_RATE

    set((draft) => {
      const target = draft.sessions.find((item) => item.id === sessionId)
      if (!target) return
      target.currentNodeId = undefined
      target.updatedAt = nowIso()
      if (failed) {
        target.results[id] = {
          nodeId: id,
          status: 'error',
          error: '节点参数异常，模拟执行失败',
        }
        target.status = 'error'
        appendLog(target, 'error', `节点「${frozen.label}」执行失败：节点参数异常，模拟执行失败`, id)
        appendLog(target, 'error', '会话在失败处暂停：上游已确认结果已保留，修正节点后续跑即可从断点继续')
      } else {
        const rows = 1200 + Math.round(Math.random() * 88000)
        target.results[id] = { nodeId: id, status: 'success', duration, rows }
        appendLog(target, 'info', `节点「${frozen.label}」执行成功：${rows.toLocaleString('zh-CN')} 行，耗时 ${duration} ms`, id)
      }
    })

    if (failed) {
      set((draft) => { draft.running = false })
      return 'error'
    }
  }

  set((draft) => {
    const target = draft.sessions.find((item) => item.id === sessionId)
    if (!target) return
    target.status = 'success'
    target.updatedAt = nowIso()
    const { successCount, totalDuration } = summarize(target.results)
    appendLog(target, 'info', `执行完成：成功 ${successCount} 个节点，累计耗时 ${totalDuration} ms`)
    draft.running = false
  })
  return 'success'
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

  setName: (name) => set((state) => { state.name = name }),

  onNodesChange: (changes) => set((state) => {
    state.nodes = applyNodeChanges(changes, state.nodes)
  }),

  onEdgesChange: (changes) => set((state) => {
    state.edges = applyEdgeChanges(changes, state.edges)
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
    pushHistory(draft)
    const node = draft.nodes.find((item) => item.id === id)
    if (node) node.data = { ...node.data, ...patch }
  }),

  updateConfig: (id, key, value) => set((draft) => {
    const node = draft.nodes.find((item) => item.id === id)
    if (node) node.data.config[key] = value
    draft.past.push(snapshot(draft))
    draft.future = []
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
  }),

  layout: () => set((draft) => {
    pushHistory(draft)
    draft.nodes = autoLayout(draft.nodes, draft.edges)
    draft.notice = '已按依赖层级自动布局'
  }),

  undo: () => set((draft) => {
    const previous = draft.past.pop()
    if (!previous) return
    draft.future.push(snapshot(draft))
    draft.nodes = previous.nodes
    draft.edges = previous.edges
    draft.notice = '已撤销上一步操作'
  }),

  redo: () => set((draft) => {
    const next = draft.future.pop()
    if (!next) return
    draft.past.push(snapshot(draft))
    draft.nodes = next.nodes
    draft.edges = next.edges
    draft.notice = '已恢复操作'
  }),

  clearNotice: () => set((draft) => { draft.notice = '' }),

  startRun: async () => {
    const state = get()
    if (state.running) return
    const order = topologicalOrder(state.nodes, state.edges)
    if (order.length !== state.nodes.length) {
      set((draft) => { draft.notice = '存在环或无效依赖，无法执行' })
      return
    }
    const revision = freezeRevision(state.nodes, state.edges)
    const session = createSession(revision, 'manual')
    set((draft) => {
      draft.running = true
      draft.sessions.push(session)
      draft.activeSessionId = session.id
      draft.notice = `已冻结流程修订 ${revision.revisionHash}，模拟执行开始`
    })
    const outcome = await executeNodes(get, set, session.id, revision.nodes.map((node) => node.id))
    set((draft) => {
      if (outcome === 'success') {
        const target = draft.sessions.find((item) => item.id === session.id)
        const { successCount, totalDuration } = summarize(target?.results ?? {})
        draft.notice = `执行完成：${successCount} 个节点成功，累计耗时 ${totalDuration} ms`
      } else {
        draft.notice = '会话在失败处暂停：已保留上游节点结果，修正后点击「续跑」即可从断点继续'
      }
    })
  },

  planResume: () => {
    const state = get()
    if (state.running) return null
    const session = state.sessions.find((item) => item.id === state.activeSessionId)
      ?? state.sessions[state.sessions.length - 1]
    if (!session) return null
    const plan = computeResumePlan(session, state.nodes, state.edges)
    if (plan.cycle) {
      set((draft) => { draft.notice = '当前画布存在环或无效依赖，无法续跑；请先修正拓扑' })
      return null
    }
    if (plan.missing.length) {
      const labels = plan.missing.map((id) => session.revision.nodes.find((node) => node.id === id)?.label ?? id)
      set((draft) => { draft.notice = `会话引用的节点已从画布删除：${labels.join('、')}；请基于当前画布发起新执行` })
      return null
    }
    if (!plan.stale.length) {
      set((draft) => { draft.notice = '所有节点结果均与当前画布一致，无需重跑' })
      return null
    }
    return { session, plan }
  },

  executeResume: async (sessionId) => {
    const state = get()
    if (state.running) return
    const session = state.sessions.find((item) => item.id === sessionId)
    if (!session) return
    const plan = computeResumePlan(session, state.nodes, state.edges)
    if (plan.cycle || plan.missing.length || !plan.stale.length) return
    // 按当前画布拓扑排序，仅重跑失效节点；未改动的旁支与上游成功结果直接复用
    const order = topologicalOrder(state.nodes, state.edges).filter((id) => plan.stale.includes(id))
    set((draft) => {
      draft.running = true
      draft.activeSessionId = sessionId
      const target = draft.sessions.find((item) => item.id === sessionId)
      if (!target) return
      target.status = 'running'
      target.updatedAt = nowIso()
      appendLog(target, 'info', `续跑核对完成：保留 ${plan.reusable.length} 个节点的成功结果，重跑 ${plan.stale.length} 个节点`)
      draft.notice = `续跑开始：重跑 ${plan.stale.length} 个节点，保留 ${plan.reusable.length} 个节点结果`
    })
    const outcome = await executeNodes(get, set, sessionId, order)
    set((draft) => {
      if (outcome === 'success') {
        const target = draft.sessions.find((item) => item.id === sessionId)
        const { successCount } = summarize(target?.results ?? {})
        draft.notice = `续跑完成：当前会话共 ${successCount} 个节点结果有效`
      } else {
        draft.notice = '续跑再次在失败处暂停：已保留此前结果，修正后可再次续跑'
      }
    })
  },

  selectSession: (sessionId) => set((draft) => {
    if (draft.running) return
    draft.activeSessionId = sessionId
  }),

  loadDocument: (document) => set((draft) => {
    draft.name = document.name
    draft.nodes = document.nodes
    draft.edges = document.edges
    draft.sessions = document.sessions ?? []
    draft.activeSessionId = null
    draft.past = []
    draft.future = []
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    draft.notice = '流程 JSON 已导入（含执行会话与历史）'
  }),

  reset: () => set((draft) => {
    pushHistory(draft)
    const fresh = sampleWorkflow()
    draft.name = '订单经营分析流程'
    draft.nodes = fresh.nodes
    draft.edges = fresh.edges
    draft.sessions = []
    draft.activeSessionId = null
    draft.selectedNodeId = null
    draft.selectedEdgeId = null
    draft.notice = '已恢复示例流程'
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
  }[status]
}
