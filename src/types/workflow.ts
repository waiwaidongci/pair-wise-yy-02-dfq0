import type { Edge, Node } from '@xyflow/react'

export type NodeKind = 'source' | 'transform' | 'filter' | 'aggregate' | 'join' | 'sink'
export type PortType = 'dataset' | 'number' | 'any'
export type RunStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'skipped' | 'stale'

export interface NodeConfig {
  [key: string]: string | number | boolean
}

export interface WorkflowNodeData extends Record<string, unknown> {
  label: string
  kind: NodeKind
  description: string
  config: NodeConfig
  status: RunStatus
  duration?: number
  rows?: number
  /** 演练用断点：冻结进修订，为 true 时该节点模拟失败 */
  forceFailure?: boolean
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
export type WorkflowEdge = Edge<{ portType: PortType }>

/** 冻结在执行会话中的节点快照（只含影响执行结果的字段，位置等视图信息不冻结） */
export interface FrozenNode {
  id: string
  kind: NodeKind
  label: string
  description: string
  config: NodeConfig
  forceFailure: boolean
}

export interface FrozenEdge {
  id: string
  source: string
  sourceHandle: string | null
  target: string
  targetHandle: string | null
  portType: PortType
}

/**
 * 流程修订：一次执行启动（或续跑重冻结）时的不可变快照。
 * signatures 为每个节点的累积签名（自身参数 + 全部上游签名），
 * 任一上游参数或拓扑变化都会沿依赖链失效后续节点，旁支不受影响。
 */
export interface FrozenRevision {
  id: string
  name: string
  createdAt: string
  nodes: FrozenNode[]
  edges: FrozenEdge[]
  /** nodeId -> 累积签名 */
  signatures: Record<string, string>
  /** 冻结时刻的拓扑执行顺序 */
  order: string[]
}

export type NodeResultStatus = 'running' | 'success' | 'error' | 'skipped'

/** 单个节点的检查点结果，随会话持久化 */
export interface NodeResultRecord {
  nodeId: string
  status: NodeResultStatus
  revisionId: string
  /** 产出该结果时节点的累积签名，用于续跑一致性核对 */
  signature: string
  startedAt?: string
  finishedAt?: string
  duration?: number
  rows?: number
  error?: string
}

export type SessionStatus = 'running' | 'success' | 'failed'

export interface RevisionHistoryEntry {
  id: string
  createdAt: string
  reason: string
}

/** 执行会话：冻结修订 + 逐节点落盘的结果检查点 */
export interface RunSession {
  id: string
  name: string
  createdAt: string
  startedAt: string
  finishedAt?: string
  status: SessionStatus
  revision: FrozenRevision
  revisionHistory: RevisionHistoryEntry[]
  order: string[]
  results: NodeResultRecord[]
  /** 重冻结时已从当前画布移除的节点，其历史结果保留不丢 */
  retiredResults: NodeResultRecord[]
  errorNodeId?: string | null
}

export interface CanvasSnapshot {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowDocument {
  version: 1 | 2
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  savedAt: string
  /** v2：执行会话（含冻结修订与节点结果） */
  sessions?: RunSession[]
  activeSessionId?: string | null
  /** v2：撤销 / 重做历史 */
  history?: { past: CanvasSnapshot[]; future: CanvasSnapshot[] }
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
