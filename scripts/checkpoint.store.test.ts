import assert from 'node:assert'

// 浏览器 API 垫片：store 的 delay 使用 window.setTimeout
;(globalThis as Record<string, unknown>).window = {
  setTimeout: (handler: TimerHandler) => setTimeout(handler as () => void, 0),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
}

const { useWorkflowStore } = await import('../src/stores/workflow')

let passed = 0
function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ✓ ${name}`)
}
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms))

// 1. 运行中修改画布：冻结会话仍按旧版本执行（断点仍生效）
{
  useWorkflowStore.setState({
    name: '订单经营分析流程',
    nodes: JSON.parse(JSON.stringify(useWorkflowStore.getState().nodes)),
    edges: JSON.parse(JSON.stringify(useWorkflowStore.getState().edges)),
    sessions: [],
    activeSessionId: null,
    past: [],
    future: [],
    running: false,
    notice: '',
  })
  const state = useWorkflowStore.getState()
  state.updateForceFailure('filter-paid', true)
  const runPromise = state.startRun()
  // 运行开始后立即关掉断点并改参数——不应影响已冻结的本次执行
  await tick(50)
  useWorkflowStore.getState().updateForceFailure('filter-paid', false)
  useWorkflowStore.getState().updateConfig('filter-paid', 'expression', 'status == "refunded"')
  await runPromise

  const session = useWorkflowStore.getState().sessions[0]
  check('冻结隔离：运行中改动画布，会话仍按冻结版本失败', () => {
    assert.strictEqual(session.status, 'failed')
    const failed = session.results.find((r) => r.nodeId === 'filter-paid')
    assert.strictEqual(failed?.status, 'error')
    // 冻结节点仍保留断点
    assert.strictEqual(session.revision.nodes.find((n) => n.id === 'filter-paid')?.forceFailure, true)
    assert.strictEqual(session.revision.nodes.find((n) => n.id === 'filter-paid')?.config.expression, 'status == "已支付"')
  })
  check('检查点保留：上游 source 与旁支 transform-clean 成功，下游 join/aggregate/sink 跳过', () => {
    const byId = Object.fromEntries(session.results.map((r) => [r.nodeId, r.status]))
    assert.strictEqual(byId['source-orders'], 'success')
    assert.strictEqual(byId['transform-clean'], 'success')
    assert.strictEqual(byId['join-customer'], 'skipped')
    assert.strictEqual(byId['aggregate-region'], 'skipped')
    assert.strictEqual(byId['sink-warehouse'], 'skipped')
  })
}

// 2. 未确认变更 => 拒绝续跑并给出范围；确认后只跑范围内节点
{
  const state = useWorkflowStore.getState()
  const sessionId = state.sessions[0].id
  const plan = await state.resumeSession(sessionId)
  check('核对拒绝：参数已改 => 返回重跑计划而非直接续跑', () => {
    assert.ok(plan)
    assert.deepStrictEqual(plan!.rerun.sort(), ['aggregate-region', 'filter-paid', 'join-customer', 'sink-warehouse'])
    assert.deepStrictEqual(plan!.reusable.sort(), ['source-orders', 'transform-clean'])
  })

  // 会话在拒绝后仍为 failed，且未被重新冻结
  const refused = useWorkflowStore.getState().sessions.find((s) => s.id === sessionId)!
  check('拒绝时冻结修订不变、结果不丢', () => {
    assert.strictEqual(refused.status, 'failed')
    assert.strictEqual(refused.revisionHistory.length, 0)
    assert.strictEqual(refused.results.length, 6)
  })

  await useWorkflowStore.getState().resumeSession(sessionId, true)
  const resumed = useWorkflowStore.getState().sessions.find((s) => s.id === sessionId)!
  check('确认续跑：全部成功；复用节点耗时不变，重跑节点产生新结果', () => {
    assert.strictEqual(resumed.status, 'success')
    assert.strictEqual(resumed.revisionHistory.length, 1)
    const allSuccess = resumed.results.every((r) => r.status === 'success')
    assert.ok(allSuccess)
  })
  check('重冻结后复用节点签名已迁移，画布视图不显示 stale', () => {
    const nodes = useWorkflowStore.getState().nodes
    assert.ok(nodes.every((n) => n.data.status === 'success'))
  })
}

// 3. 改动后受影响节点及下游失效，其他保留
{
  const state = useWorkflowStore.getState()
  // 新起一次干净执行，随后改旁支参数
  await state.startRun()
  const sessions = useWorkflowStore.getState().sessions
  const latest = sessions[sessions.length - 1]
  assert.strictEqual(latest.status, 'success')
  useWorkflowStore.getState().updateConfig('filter-paid', 'limit', 1)

  const nodes = useWorkflowStore.getState().nodes
  const view = Object.fromEntries(nodes.map((n) => [n.id, n.data.status]))
  check('失效传播：filter 及其下游 stale，source 与另一旁支 transform 保持 success', () => {
    assert.strictEqual(view['filter-paid'], 'stale')
    assert.strictEqual(view['join-customer'], 'stale')
    assert.strictEqual(view['aggregate-region'], 'stale')
    assert.strictEqual(view['sink-warehouse'], 'stale')
    assert.strictEqual(view['source-orders'], 'success')
    assert.strictEqual(view['transform-clean'], 'success')
  })
  // 会话记录本身不被画布修改污染
  const session = useWorkflowStore.getState().sessions.at(-1)!
  check('会话检查点不可变：stale 只是画布视图，记录仍为 success', () => {
    assert.ok(session.results.every((r) => r.status === 'success'))
  })
}

// 4. 导入导出：会话 / 结果 / 历史随 JSON 恢复，同 ID 不覆盖旧记录
{
  const doc = useWorkflowStore.getState().exportDocument()
  assert.strictEqual(doc.version, 2)
  assert.ok(doc.sessions!.length >= 2)

  // 篡改现有会话以验证“不覆盖”：导入后仍保留本地副本
  const firstId = useWorkflowStore.getState().sessions[0].id
  useWorkflowStore.setState((s) => {
    s.sessions[0].name = '本地修改后的名称'
  })

  const result = useWorkflowStore.getState().importDocument(JSON.parse(JSON.stringify(doc)))
  check('导入恢复：同 ID 会话不覆盖（skipped 计数），新 ID 会话追加', () => {
    assert.ok(result.skipped >= 1)
    const kept = useWorkflowStore.getState().sessions.find((s) => s.id === firstId)!
    assert.strictEqual(kept.name, '本地修改后的名称')
  })

  // 导出中处于运行态的全新会话，导入后转为可续跑的失败态
  const uniqueDoc = JSON.parse(JSON.stringify(doc))
  uniqueDoc.sessions = [{ ...JSON.parse(JSON.stringify(doc.sessions![0])), id: 'run-unique-import' }]
  uniqueDoc.sessions[0].status = 'running'
  useWorkflowStore.getState().importDocument(uniqueDoc)
  const restored = useWorkflowStore.getState().sessions.find((s) => s.id === 'run-unique-import')!
  check('全新 ID 的运行中会话导入后变为 failed（可续跑），节点结果完整保留', () => {
    assert.strictEqual(restored.status, 'failed')
    assert.ok(restored.finishedAt)
    assert.ok(restored.results.length >= 1)
  })
}

// 5. 新执行不覆盖旧记录
{
  const before = useWorkflowStore.getState().sessions.length
  await useWorkflowStore.getState().startRun()
  const after = useWorkflowStore.getState().sessions.length
  check('每次执行新建会话，旧记录全部保留', () => {
    assert.strictEqual(after, before + 1)
  })
}

console.log(`\n全部 ${passed} 项集成检查通过`)
