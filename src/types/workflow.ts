import type { Edge, Node } from '@xyflow/react'

export type NodeKind = 'source' | 'transform' | 'filter' | 'aggregate' | 'join' | 'sink'
export type PortType = 'dataset' | 'number' | 'any'
export type RunStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'skipped'

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
  /** 视图字段：当前会话结果已过期，画布投影时注入 */
  stale?: boolean
}

export type WorkflowNode = Node<WorkflowNodeData, 'workflow'>
export type WorkflowEdge = Edge<{ portType: PortType }>

/** 冻结的节点身份：执行时只认 kind + config，位置/名称/说明不影响结果 */
export interface FrozenNode {
  id: string
  kind: NodeKind
  label: string
  config: NodeConfig
}

/** 冻结的连线身份：只认源/目标节点与端口句柄 */
export interface FrozenEdge {
  id: string
  source: string
  target: string
  sourceHandle: string | null
  targetHandle: string | null
}

/** 流程修订：一次执行启动时冻结的画布快照 */
export interface FlowRevision {
  frozenAt: string
  nodes: FrozenNode[]
  edges: FrozenEdge[]
  nodeHash: Record<string, string>
  edgeHash: Record<string, string>
  revisionHash: string
}

/** 节点执行结果：挂在会话下，不随画布编辑混入新结果 */
export interface NodeExecutionResult {
  nodeId: string
  status: 'success' | 'error' | 'running'
  duration?: number
  rows?: number
  error?: string
}

export interface ExecutionLogEntry {
  time: string
  level: 'info' | 'error'
  message: string
  nodeId?: string
}

/** 执行会话：一次冻结修订的完整运行记录，可续跑、可随 JSON 导入导出 */
export interface ExecutionSession {
  id: string
  startedAt: string
  updatedAt: string
  status: 'running' | 'success' | 'error'
  trigger: 'manual' | 'resume'
  revision: FlowRevision
  results: Record<string, NodeExecutionResult>
  log: ExecutionLogEntry[]
  currentNodeId?: string
}

export interface WorkflowDocument {
  version: 1
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  savedAt: string
  sessions?: ExecutionSession[]
}

export interface NodeDefinition {
  kind: NodeKind
  label: string
  description: string
  color: string
  inputs: PortType[]
  outputs: PortType[]
}
