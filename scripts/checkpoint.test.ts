import assert from 'node:assert'
import { buildRevision, nodeFingerprint, planResume } from '../src/utils/checkpoint'
import type { FrozenNode, FrozenRevision, NodeResultRecord, RunSession } from '../src/types/workflow'
import { createWorkflowNode } from '../src/utils/workflow'
import type { WorkflowEdge, WorkflowNode } from '../src/types/workflow'

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}

function edge(id: string, source: string, target: string, handle = 0): WorkflowEdge {
  return {
    id,
    source,
    target,
    sourceHandle: `out-${handle}`,
    targetHandle: 'in-0',
    type: 'smoothstep',
    data: { portType: 'dataset' },
  }
}

function makeGraph() {
  const source = createWorkflowNode('source', { x: 0, y: 0 }, 'src')
  const branchA = createWorkflowNode('filter', { x: 0, y: 0 }, 'a')
  const branchB = createWorkflowNode('filter', { x: 0, y: 0 }, 'b')
  const sinkA = createWorkflowNode('sink', { x: 0, y: 0 }, 'sa')
  const sinkB = createWorkflowNode('sink', { x: 0, y: 0 }, 'sb')
  const nodes = [source, branchA, branchB, sinkA, sinkB]
  const edges: WorkflowEdge[] = [
    edge('e1', 'src', 'a'),
    edge('e2', 'src', 'b'),
    edge('e3', 'a', 'sa'),
    edge('e4', 'b', 'sb'),
  ]
  return { nodes, edges }
}

function cloneNodes(nodes: WorkflowNode[]): WorkflowNode[] {
  return JSON.parse(JSON.stringify(nodes)) as WorkflowNode[]
}
function cloneEdges(edges: WorkflowEdge[]): WorkflowEdge[] {
  return JSON.parse(JSON.stringify(edges)) as WorkflowEdge[]
}

function fakeSession(revision: FrozenRevision, failedId?: string): RunSession {
  const results: NodeResultRecord[] = revision.nodes.map((node) => ({
    nodeId: node.id,
    status: node.id === failedId ? 'error' : 'success',
    revisionId: revision.id,
    signature: revision.signatures[node.id],
    duration: 100,
    rows: 10,
    ...(node.id === failedId ? { error: 'boom' } : {}),
  }))
  return {
    id: 'run-1',
    name: 'run1',
    createdAt: '2026-10-06T00:00:00.000Z',
    startedAt: '2026-10-06T00:00:00.000Z',
    finishedAt: '2026-10-06T00:00:01.000Z',
    status: failedId ? 'failed' : 'success',
    revision,
    revisionHistory: [],
    order: revision.order.slice(),
    results,
    retiredResults: [],
    errorNodeId: failedId ?? null,
  }
}

// 1. 冻结稳定性：同样内容 => 同样修订 ID；名称不影响修订
{
  const g1 = makeGraph()
  const r1 = buildRevision('n1', g1.nodes, g1.edges)
  const g2 = makeGraph()
  const r2 = buildRevision('n2', g2.nodes, g2.edges)
  check('相同画布内容冻结出相同修订 ID（流程名不影响）', () => {
    assert.strictEqual(r1.id, r2.id)
    assert.deepStrictEqual(r1.order, ['src', 'a', 'b', 'sa', 'sb'].sort((x, y) => r1.order.indexOf(x) - r1.order.indexOf(y)).filter((v) => r1.order.includes(v)))
  })
}

// 2. 参数变化只失效自身与下游，旁支不动
{
  const g = makeGraph()
  const rev = buildRevision('n', g.nodes, g.edges)
  const session = fakeSession(rev)

  const nodes = cloneNodes(g.nodes)
  const changed = nodes.find((n) => n.id === 'a')!
  changed.data.config.expression = 'changed'
  const rev2 = buildRevision('n', nodes, g.edges)
  const plan = planResume(session, rev2, true)

  check('修改旁支 A 参数：A 与 sa 失效，src/b/sb 保留', () => {
    assert.ok(plan.upstreamChanged)
    assert.deepStrictEqual(plan.invalidated.sort(), ['a', 'sa'])
    assert.deepStrictEqual(plan.rerun.sort(), ['a', 'sa'])
    assert.deepStrictEqual(plan.reusable.sort(), ['b', 'sb', 'src'])
    assert.ok(plan.reason)
  })

  check('仅自身指纹变化的节点被识别为参数变更', () => {
    const oldNode = rev.nodes.find((n) => n.id === 'a') as FrozenNode
    const newNode = rev2.nodes.find((n) => n.id === 'a') as FrozenNode
    assert.notStrictEqual(nodeFingerprint(oldNode), nodeFingerprint(newNode))
    const srcOld = rev.nodes.find((n) => n.id === 'src') as FrozenNode
    const srcNew = rev2.nodes.find((n) => n.id === 'src') as FrozenNode
    assert.strictEqual(nodeFingerprint(srcOld), nodeFingerprint(srcNew))
  })
}

// 3. 拓扑变化：增删连线 => topologyChanged
{
  const g = makeGraph()
  const rev = buildRevision('n', g.nodes, g.edges)
  const session = fakeSession(rev)

  const nodes = cloneNodes(g.nodes)
  const edges = cloneEdges(g.edges)
  edges.push(edge('e5', 'a', 'sb'))
  const rev2 = buildRevision('n', nodes, edges)
  const plan = planResume(session, rev2, true)
  check('新增连线 => 拓扑变化，sb 因新增上游重算，sa 保留', () => {
    assert.ok(plan.topologyChanged)
    assert.deepStrictEqual(plan.rerun.sort(), ['sb'])
    assert.deepStrictEqual(plan.reusable.sort(), ['a', 'b', 'sa', 'src'])
  })

  const edges3 = cloneEdges(g.edges).filter((e) => e.id !== 'e3')
  const rev3 = buildRevision('n', cloneNodes(g.nodes), edges3)
  const plan3 = planResume(session, rev3, true)
  check('删除连线 => 拓扑变化，sa 失去上游结果需重算', () => {
    assert.ok(plan3.topologyChanged)
    assert.deepStrictEqual(plan3.rerun.sort(), ['sa'])
  })
}

// 4. 节点增删
{
  const g = makeGraph()
  const rev = buildRevision('n', g.nodes, g.edges)
  const session = fakeSession(rev)

  const nodes = cloneNodes(g.nodes)
  const newNode = createWorkflowNode('transform', { x: 0, y: 0 }, 'new')
  nodes.push(newNode)
  const edges = cloneEdges(g.edges)
  edges.push(edge('e9', 'src', 'new'))
  const rev2 = buildRevision('n', nodes, edges)
  const plan = planResume(session, rev2, true)
  check('新增独立旁支节点 => 仅新节点需执行，旧结果全部保留', () => {
    assert.deepStrictEqual(plan.added, ['new'])
    assert.deepStrictEqual(plan.rerun, ['new'])
    assert.strictEqual(plan.reusable.length, 5)
  })

  const nodes2 = cloneNodes(g.nodes).filter((n) => n.id !== 'b')
  const edges2 = cloneEdges(g.edges).filter((e) => e.target !== 'b' && e.source !== 'b')
  const rev3 = buildRevision('n', nodes2, edges2)
  const plan3 = planResume(session, rev3, true)
  check('删除节点 => removed 列出；失连的 sb 因输入拓扑变化失效，其余旁支保留', () => {
    assert.deepStrictEqual(plan3.removed, ['b'])
    assert.deepStrictEqual(plan3.rerun, ['sb'])
    assert.deepStrictEqual(plan3.reusable.sort(), ['a', 'sa', 'src'])
  })
}

// 5. 失败后续跑：修好失败节点，只跑失败节点及其下游；上游旁支保留
{
  const g = makeGraph()
  const rev = buildRevision('n', g.nodes, g.edges)
  const session = fakeSession(rev, 'a') // a 失败

  const nodes = cloneNodes(g.nodes)
  nodes.find((n) => n.id === 'a')!.data.config.expression = 'fixed'
  const rev2 = buildRevision('n', nodes, g.edges)
  const plan = planResume(session, rev2, true)
  check('修复失败节点 A => 拒绝直接续跑且范围为 a、sa（跳过传播的下游），其余复用', () => {
    assert.ok(plan.reason)
    assert.deepStrictEqual(plan.rerun.sort(), ['a', 'sa'])
    assert.deepStrictEqual(plan.reusable.sort(), ['b', 'sb', 'src'])
  })
}

// 6. 失败但画布未改动直接续跑
{
  const g = makeGraph()
  const rev = buildRevision('n', g.nodes, g.edges)
  const session = fakeSession(rev, 'a')
  const plan = planResume(session, rev, false)
  check('失败节点未改动直接续跑 => 无拒绝原因，范围含 a 与被跳过的 sa', () => {
    assert.strictEqual(plan.reason, null)
    assert.deepStrictEqual(plan.rerun.sort(), ['a', 'sa'])
  })
}

// 7. 有环图拒绝
{
  const g = makeGraph()
  const rev = buildRevision('n', g.nodes, g.edges)
  const session = fakeSession(rev)
  const nodes = cloneNodes(g.nodes)
  const edges = cloneEdges(g.edges)
  edges.push({ ...edge('ex', 'sb', 'src'), targetHandle: 'in-0' })
  const rev2 = buildRevision('n', nodes, edges)
  const hasCycle = rev2.order.length !== nodes.length
  const plan = planResume(session, rev2, hasCycle)
  check('当前画布成环 => invalidGraph 拒绝', () => {
    assert.ok(plan.invalidGraph)
    assert.ok(plan.reason?.includes('环'))
  })
}

console.log(`\n全部 ${passed} 项检查通过`)
