import type { Connection } from '@xyflow/react'
import type {
  ExecutionSession,
  FlowRevision,
  NodeDefinition,
  NodeKind,
  PortType,
  RunStatus,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'

export const NODE_DEFINITIONS: NodeDefinition[] = [
  {
    kind: 'source',
    label: '数据源',
    description: '读取订单、用户或日志数据集',
    color: '#2563eb',
    inputs: [],
    outputs: ['dataset'],
  },
  {
    kind: 'transform',
    label: '字段变换',
    description: '清洗、映射与派生字段',
    color: '#0891b2',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'filter',
    label: '条件过滤',
    description: '按表达式筛选数据行',
    color: '#7c3aed',
    inputs: ['dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'aggregate',
    label: '聚合计算',
    description: '分组汇总并输出指标',
    color: '#ca8a04',
    inputs: ['dataset'],
    outputs: ['number'],
  },
  {
    kind: 'join',
    label: '双流关联',
    description: '按关联键合并两路数据',
    color: '#db2777',
    inputs: ['dataset', 'dataset'],
    outputs: ['dataset'],
  },
  {
    kind: 'sink',
    label: '结果输出',
    description: '写入数据仓库或消息队列',
    color: '#16a34a',
    inputs: ['dataset', 'number'],
    outputs: [],
  },
]

export function definitionFor(kind: WorkflowNode['data']['kind']) {
  return NODE_DEFINITIONS.find((item) => item.kind === kind) ?? NODE_DEFINITIONS[0]
}

export function defaultConfig(kind: WorkflowNode['data']['kind']) {
  const configs: Record<WorkflowNode['data']['kind'], Record<string, string | number | boolean>> = {
    source: { source: '订单主表', refresh: '实时', sampleRows: 125000 },
    transform: { expression: 'amount * 1.06', outputField: 'amount_with_tax', keepOriginal: true },
    filter: { expression: 'status == "已支付"', limit: 50000 },
    aggregate: { groupBy: 'region', metric: 'sum(amount)', outputField: 'region_total' },
    join: { joinType: 'left', leftKey: 'customer_id', rightKey: 'id' },
    sink: { target: '分析数据集市', mode: 'upsert', partition: 'dt' },
  }
  return configs[kind]
}

export function createWorkflowNode(
  kind: WorkflowNode['data']['kind'],
  position: { x: number; y: number },
  id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
): WorkflowNode {
  const definition = definitionFor(kind)
  return {
    id,
    type: 'workflow',
    position,
    data: {
      label: definition.label,
      kind,
      description: definition.description,
      config: defaultConfig(kind),
      status: 'idle',
    },
  }
}

export function portAt(node: WorkflowNode, handle: string | null | undefined): { direction: 'input' | 'output'; type: PortType; index: number } | null {
  if (!handle) return null
  const match = /^(in|out)-(\d+)$/.exec(handle)
  if (!match) return null
  const definition = definitionFor(node.data.kind)
  const index = Number(match[2])
  const direction = match[1] === 'in' ? 'input' : 'output'
  const type = direction === 'input' ? definition.inputs[index] : definition.outputs[index]
  return type ? { direction, type, index } : null
}

export function connectionError(connection: Connection, nodes: WorkflowNode[]): string | null {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) {
    return '连接缺少有效的源端口或目标端口'
  }
  if (connection.source === connection.target) return '节点不能连接到自身'

  const source = nodes.find((node) => node.id === connection.source)
  const target = nodes.find((node) => node.id === connection.target)
  if (!source || !target) return '连接节点不存在'

  const sourcePort = portAt(source, connection.sourceHandle)
  const targetPort = portAt(target, connection.targetHandle)
  if (!sourcePort || sourcePort.direction !== 'output') return '源端口类型无效'
  if (!targetPort || targetPort.direction !== 'input') return '目标端口类型无效'

  const compatible = sourcePort.type === 'any'
    || targetPort.type === 'any'
    || sourcePort.type === targetPort.type
  if (!compatible) return `端口类型不兼容：${sourcePort.type} → ${targetPort.type}`

  return null
}

export function createsCycle(connection: Connection, edges: WorkflowEdge[]): boolean {
  if (!connection.source || !connection.target) return false
  const adjacency = new Map<string, string[]>()
  edges.forEach((edge) => {
    const list = adjacency.get(edge.source) ?? []
    list.push(edge.target)
    adjacency.set(edge.source, list)
  })
  const sourceList = adjacency.get(connection.source) ?? []
  sourceList.push(connection.target)
  adjacency.set(connection.source, sourceList)

  const visiting = new Set<string>()
  const visited = new Set<string>()
  const hasCycle = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const next of adjacency.get(id) ?? []) {
      if (hasCycle(next)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  return [...adjacency.keys()].some(hasCycle)
}

export function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]) {
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const outgoing = new Map<string, string[]>()
  edges.forEach((edge) => {
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id)
  const result: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    result.push(id)
    for (const next of outgoing.get(id) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return result
}

export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  const order = topologicalOrder(nodes, edges)
  const depth = new Map<string, number>()
  order.forEach((id) => {
    const parents = edges.filter((edge) => edge.target === id)
    depth.set(id, parents.length ? Math.max(...parents.map((edge) => (depth.get(edge.source) ?? 0) + 1)) : 0)
  })
  const columns = new Map<number, WorkflowNode[]>()
  nodes.forEach((node) => {
    const column = depth.get(node.id) ?? 0
    columns.set(column, [...(columns.get(column) ?? []), node])
  })
  return nodes.map((node) => {
    const column = depth.get(node.id) ?? 0
    const index = (columns.get(column) ?? []).findIndex((item) => item.id === node.id)
    return { ...node, position: { x: 90 + column * 260, y: 90 + index * 150 } }
  })
}

export function sampleWorkflow(): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const source = createWorkflowNode('source', { x: 60, y: 150 }, 'source-orders')
  source.data.label = '订单实时流'
  const filter = createWorkflowNode('filter', { x: 330, y: 70 }, 'filter-paid')
  filter.data.label = '筛选已支付订单'
  const transform = createWorkflowNode('transform', { x: 330, y: 250 }, 'transform-clean')
  transform.data.label = '清洗收货信息'
  const join = createWorkflowNode('join', { x: 610, y: 160 }, 'join-customer')
  join.data.label = '关联客户画像'
  const aggregate = createWorkflowNode('aggregate', { x: 880, y: 160 }, 'aggregate-region')
  aggregate.data.label = '区域销售聚合'
  const sink = createWorkflowNode('sink', { x: 1150, y: 160 }, 'sink-warehouse')
  sink.data.label = '写入经营看板'
  return {
    nodes: [source, filter, transform, join, aggregate, sink],
    edges: [
      { id: 'e1', source: source.id, sourceHandle: 'out-0', target: filter.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' }, animated: true },
      { id: 'e2', source: source.id, sourceHandle: 'out-0', target: transform.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e3', source: filter.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e4', source: transform.id, sourceHandle: 'out-0', target: join.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e5', source: join.id, sourceHandle: 'out-0', target: aggregate.id, targetHandle: 'in-0', type: 'smoothstep', data: { portType: 'dataset' } },
      { id: 'e6', source: aggregate.id, sourceHandle: 'out-0', target: sink.id, targetHandle: 'in-1', type: 'smoothstep', data: { portType: 'number' } },
    ],
  }
}

/** 递归稳定序列化：对象按键名排序，保证哈希与键顺序无关 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** FNV-1a 32 位哈希，返回 8 位十六进制 */
function hashString(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 节点身份哈希：只认 kind + config（业务参数），位置/名称/说明不影响执行结果 */
export function nodeIdentityHash(node: WorkflowNode): string {
  return hashString(stableStringify({ kind: node.data.kind, config: node.data.config }))
}

/** 连线身份哈希：只认源/目标节点与端口句柄 */
export function edgeIdentityHash(edge: WorkflowEdge): string {
  return hashString(stableStringify({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }))
}

/** 冻结当前画布修订：深拷贝节点/连线身份并计算各级哈希 */
export function freezeRevision(nodes: WorkflowNode[], edges: WorkflowEdge[]): FlowRevision {
  const frozenNodes = nodes.map((node) => ({
    id: node.id,
    kind: node.data.kind,
    label: node.data.label,
    config: JSON.parse(JSON.stringify(node.data.config)) as WorkflowNode['data']['config'],
  }))
  const frozenEdges = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }))
  const nodeHash: Record<string, string> = {}
  nodes.forEach((node) => { nodeHash[node.id] = nodeIdentityHash(node) })
  const edgeHash: Record<string, string> = {}
  edges.forEach((edge) => { edgeHash[edge.id] = edgeIdentityHash(edge) })
  const revisionHash = hashString(stableStringify({
    nodes: Object.entries(nodeHash).sort(([a], [b]) => a.localeCompare(b)),
    edges: Object.entries(edgeHash).sort(([a], [b]) => a.localeCompare(b)),
  }))
  return {
    frozenAt: new Date().toISOString(),
    nodes: frozenNodes,
    edges: frozenEdges,
    nodeHash,
    edgeHash,
    revisionHash,
  }
}

export interface ResumePlan {
  /** 可复用缓存结果的节点（身份未变且所有上游一致） */
  reusable: string[]
  /** 失效必须重跑的节点（身份变更 / 上游变更或缺失 / 无成功结果） */
  stale: string[]
  /** 画布中已不存在的冻结节点 id */
  missing: string[]
  /** 当前画布存在环 */
  cycle: boolean
}

function incomingKey(source: string, sourceHandle: string | null | undefined, targetHandle: string | null | undefined) {
  return `${source}|${sourceHandle ?? ''}|${targetHandle ?? ''}`
}

/**
 * 续跑核对：以会话冻结修订为准，逐节点核对当前画布。
 * 节点可复用当且仅当：节点仍存在、kind+config 哈希一致、
 * 入边集合与冻结版本完全一致、所有上游节点均可复用、且会话中已有 success 结果。
 * 任一条件不满足则该节点失效，失效会沿依赖向下游传播，旁支不受影响。
 */
export function computeResumePlan(
  session: ExecutionSession,
  liveNodes: WorkflowNode[],
  liveEdges: WorkflowEdge[],
): ResumePlan {
  const liveById = new Map(liveNodes.map((node) => [node.id, node]))
  const nodeHashLive = new Map(liveNodes.map((node) => [node.id, nodeIdentityHash(node)]))
  const frozenIds = session.revision.nodes.map((node) => node.id)
  const missing = frozenIds.filter((id) => !liveById.has(id))
  const cycle = topologicalOrder(liveNodes, liveEdges).length !== liveNodes.length

  const liveIncoming = new Map<string, Set<string>>()
  liveEdges.forEach((edge) => {
    const set = liveIncoming.get(edge.target) ?? new Set<string>()
    set.add(incomingKey(edge.source, edge.sourceHandle, edge.targetHandle))
    liveIncoming.set(edge.target, set)
  })
  const frozenIncoming = new Map<string, Set<string>>()
  session.revision.edges.forEach((edge) => {
    const set = frozenIncoming.get(edge.target) ?? new Set<string>()
    set.add(incomingKey(edge.source, edge.sourceHandle, edge.targetHandle))
    frozenIncoming.set(edge.target, set)
  })

  const memo = new Map<string, boolean>()
  const reusable = (id: string): boolean => {
    if (memo.has(id)) return memo.get(id) as boolean
    memo.set(id, false) // 环保护
    const live = liveById.get(id)
    if (!live) return false
    if (nodeHashLive.get(id) !== session.revision.nodeHash[id]) return false
    if (session.results[id]?.status !== 'success') return false
    const liveKeys = liveIncoming.get(id) ?? new Set<string>()
    const frozenKeys = frozenIncoming.get(id) ?? new Set<string>()
    if (liveKeys.size !== frozenKeys.size) return false
    for (const key of liveKeys) {
      if (!frozenKeys.has(key)) return false
    }
    for (const edge of session.revision.edges.filter((item) => item.target === id)) {
      if (!reusable(edge.source)) return false
    }
    memo.set(id, true)
    return true
  }

  const reusableIds = frozenIds.filter(reusable)
  const reusableSet = new Set(reusableIds)
  return {
    reusable: reusableIds,
    stale: frozenIds.filter((id) => !reusableSet.has(id)),
    missing,
    cycle,
  }
}

export interface NodeViewState {
  status: RunStatus
  duration?: number
  rows?: number
  /** 会话中存在结果，但相对当前画布已过期（改动后待重跑） */
  stale: boolean
}

/**
 * 节点视图状态：把会话结果按 id+哈希匹配投影到画布节点。
 * 身份不匹配（运行中被改动）的节点不显示旧结果，避免新改动混入执行结果。
 */
export function nodeViewState(
  node: WorkflowNode,
  session: ExecutionSession | null,
  plan: ResumePlan | null,
): NodeViewState {
  if (!session) return { status: 'idle', stale: false }
  if (session.currentNodeId === node.id) return { status: 'running', stale: false }
  const result = session.results[node.id]
  const hashMatches = session.revision.nodeHash[node.id] === nodeIdentityHash(node)
  if (result && hashMatches) {
    return {
      status: result.status === 'running' ? 'running' : result.status,
      duration: result.duration,
      rows: result.rows,
      stale: false,
    }
  }
  const stale = !!plan?.stale.includes(node.id) && result?.status === 'success'
  return { status: 'idle', stale }
}

/** 会话展示时间：MM-DD HH:mm:ss */
export function sessionTimeLabel(iso: string): string {
  const date = new Date(iso)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}
