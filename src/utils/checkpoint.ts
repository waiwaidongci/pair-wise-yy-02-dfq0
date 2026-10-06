import type {
  FrozenEdge,
  FrozenNode,
  FrozenRevision,
  NodeResultRecord,
  RunSession,
  WorkflowEdge,
  WorkflowNode,
} from '../types/workflow'
import { topologicalOrder } from './workflow'

/** 键序稳定的 JSON 序列化，保证相同内容得到相同签名 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
}

/** djb2 短哈希，用于签名 / 修订 ID 去重展示 */
export function hashContent(content: string): string {
  let hash = 5381
  for (let index = 0; index < content.length; index += 1) {
    hash = ((hash << 5) + hash + content.charCodeAt(index)) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

function freezeNode(node: WorkflowNode): FrozenNode {
  return {
    id: node.id,
    kind: node.data.kind,
    label: node.data.label,
    description: node.data.description,
    config: JSON.parse(JSON.stringify(node.data.config)) as FrozenNode['config'],
    forceFailure: node.data.forceFailure ?? false,
  }
}

function freezeEdge(edge: WorkflowEdge): FrozenEdge {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle ?? null,
    target: edge.target,
    targetHandle: edge.targetHandle ?? null,
    portType: edge.data?.portType ?? 'dataset',
  }
}

/** 节点自身指纹：仅覆盖影响执行结果的属性（参数 / 断点 / 类型），名称位置变化不触发失效 */
export function nodeFingerprint(node: FrozenNode): string {
  return hashContent(stableStringify({
    kind: node.kind,
    config: node.config,
    forceFailure: node.forceFailure,
  }))
}

/** 连线指纹：连接关系、端口与数据类型都会影响上游输入 */
function edgeFingerprint(edge: FrozenEdge): string {
  return hashContent(stableStringify({
    s: edge.source,
    sh: edge.sourceHandle,
    t: edge.target,
    th: edge.targetHandle,
    p: edge.portType,
  }))
}

/** 冻结当前画布为不可变流程修订，并计算每个节点的累积签名 */
export function buildRevision(
  name: string,
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  createdAt = new Date().toISOString(),
): FrozenRevision {
  const frozenNodes = nodes.map(freezeNode)
  const frozenEdges = edges.map(freezeEdge)
  const order = topologicalOrder(nodes, edges)

  const incoming = new Map<string, FrozenEdge[]>()
  frozenEdges.forEach((edge) => {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge])
  })

  const byId = new Map(frozenNodes.map((node) => [node.id, node]))
  const signatures: Record<string, string> = {}
  order.forEach((id) => {
    const node = byId.get(id)
    if (!node) return
    const own = nodeFingerprint(node)
    const upstream = (incoming.get(id) ?? [])
      .map((edge) => `${edgeFingerprint(edge)}<${signatures[edge.source] ?? '∅'}>`)
      .sort()
      .join('|')
    signatures[id] = hashContent(`${own}(${upstream})`)
  })

  const id = hashContent(stableStringify({
    nodes: frozenNodes.map((node) => [node.id, node.kind, node.config, node.forceFailure]),
    edges: frozenEdges.map((edge) => [edge.source, edge.sourceHandle, edge.target, edge.targetHandle, edge.portType]),
  }))

  return { id, name, createdAt, nodes: frozenNodes, edges: frozenEdges, signatures, order }
}

export function isAcyclic(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  return topologicalOrder(nodes, edges).length === nodes.length
}

/** 拓扑键，用于比较两个修订间的连接关系是否一致 */
function topologyKey(edges: FrozenEdge[]): string {
  return edges
    .map((edge) => `${edge.source}:${edge.sourceHandle ?? ''}->${edge.target}:${edge.targetHandle ?? ''}`)
    .sort()
    .join('|')
}

export interface ResumePlan {
  /** 拓扑存在环，无法执行 */
  invalidGraph: boolean
  /** 会话冻结修订与当前画布的拓扑不一致（连线增删 / 端口改接 / 节点增删） */
  topologyChanged: boolean
  /** 至少一个保留节点的上游参数签名不一致（自身或任一上游参数被修改） */
  upstreamChanged: boolean
  /** 当前画布新增的节点 */
  added: string[]
  /** 画布中已删除的节点（含已确认结果，结果会归档保留） */
  removed: string[]
  /** 自身或上游发生变化、结果必须失效的节点（变化节点 + 全部下游依赖） */
  invalidated: string[]
  /** 签名一致、无需重算的节点 */
  reusable: string[]
  /** 续跑实际需要执行的节点范围 */
  rerun: string[]
  /** 本次重跑范围中失败 / 跳过 / 未执行（含新增）的节点 */
  pending: string[]
  /** 拒绝原因；为空表示可直接续跑 */
  reason: string | null
}

/**
 * 续跑前核对会话修订与当前画布：
 * 拓扑或上游参数不符时拒绝直接续跑，并给出重跑范围供确认。
 */
export function planResume(session: RunSession, revision: FrozenRevision, invalidGraph: boolean): ResumePlan {
  const old = session.revision
  const oldById = new Map(old.nodes.map((node) => [node.id, node]))
  const newById = new Map(revision.nodes.map((node) => [node.id, node]))

  const common = revision.nodes
    .map((node) => node.id)
    .filter((id) => oldById.has(id))
  const added = revision.nodes.map((node) => node.id).filter((id) => !oldById.has(id))
  const removed = old.nodes.map((node) => node.id).filter((id) => !newById.has(id))

  const topologyChanged = topologyKey(old.edges) !== topologyKey(revision.edges)
  const changedOwn = new Set<string>()
  common.forEach((id) => {
    if (old.signatures[id] === revision.signatures[id]) return
    const oldNode = oldById.get(id)!
    const newNode = newById.get(id)!
    if (nodeFingerprint(oldNode) !== nodeFingerprint(newNode)) changedOwn.add(id)
  })
  // 累积签名不同即代表自身或某个传递上游参数变化
  const signatureMismatch = new Set(
    common.filter((id) => old.signatures[id] !== revision.signatures[id]),
  )

  // 变化节点 + 全部下游依赖（按当前修订的可达性）
  const outgoing = new Map<string, string[]>()
  revision.edges.forEach((edge) => {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  })
  const invalidated = new Set<string>(added)
  const walk = (id: string) => {
    if (invalidated.has(id)) return
    invalidated.add(id)
    ;(outgoing.get(id) ?? []).forEach(walk)
  }
  signatureMismatch.forEach(walk)

  const successByNode = new Map<string, NodeResultRecord>()
  session.results.forEach((record) => {
    if (record.status === 'success') successByNode.set(record.nodeId, record)
  })
  const pendingOrInvalid = new Set<string>(invalidated)
  session.results.forEach((record) => {
    if (record.status !== 'success') pendingOrInvalid.add(record.nodeId)
  })

  // 无成功结果的节点同样需要续跑；其下游如果依赖了未成功产物，一并纳入
  const rerun = new Set<string>()
  revision.order.forEach((id) => {
    const inputs = revision.edges.filter((edge) => edge.target === id)
    const upstreamBroken = inputs.some(
      (edge) => rerun.has(edge.source) || !successByNode.has(edge.source) || invalidated.has(edge.source),
    )
    const record = successByNode.get(id)
    if (!record || upstreamBroken || invalidated.has(id)) rerun.add(id)
  })

  const reusable = revision.nodes
    .map((node) => node.id)
    .filter((id) => !rerun.has(id) && successByNode.has(id))

  const upstreamChanged = signatureMismatch.size > 0
  const changedNodes = [...changedOwn, ...added, ...removed]
  let reason: string | null = null
  if (invalidGraph) {
    reason = '当前画布存在环或无效依赖，无法执行'
  } else if (topologyChanged || upstreamChanged) {
    const parts: string[] = []
    if (added.length) parts.push(`新增 ${added.length} 个节点`)
    if (removed.length) parts.push(`删除 ${removed.length} 个节点`)
    if (topologyChanged && !added.length && !removed.length) parts.push('连接关系或端口已改接')
    const paramChanged = [...changedOwn].filter((id) => !added.includes(id))
    if (paramChanged.length) parts.push(`${paramChanged.length} 个节点参数变更`)
    const downstreamOnly = [...invalidated].filter(
      (id) => !changedOwn.has(id) && !added.includes(id),
    )
    if (downstreamOnly.length) parts.push(`波及 ${downstreamOnly.length} 个下游节点`)
    reason = `冻结修订与当前画布不一致（${parts.join('、') || '拓扑变化'}）`
  }

  return {
    invalidGraph,
    topologyChanged,
    upstreamChanged,
    added,
    removed,
    invalidated: [...invalidated],
    reusable,
    rerun: revision.order.filter((id) => rerun.has(id)),
    pending: revision.order.filter((id) => pendingOrInvalid.has(id) && rerun.has(id)),
    reason,
  }
}

/** 已确认（成功）结果的节点 ID */
export function confirmedIds(session: RunSession): Set<string> {
  return new Set(
    session.results.filter((record) => record.status === 'success').map((record) => record.nodeId),
  )
}

export function sessionProgress(session: RunSession): { done: number; total: number } {
  const done = session.results.filter((record) => record.status === 'success').length
  return { done, total: session.order.length }
}

export function sessionDuration(session: RunSession): number {
  return session.results.reduce((sum, record) => sum + (record.duration ?? 0), 0)
}
