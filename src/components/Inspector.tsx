import { Button, Divider, Form, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { useMemo } from 'react'
import { statusLabel, useWorkflowStore } from '../stores/workflow'
import { computeResumePlan, definitionFor, nodeViewState, sessionTimeLabel } from '../utils/workflow'
import type { ExecutionSession } from '../types/workflow'

function statusColor(status: ExecutionSession['status']) {
  return { running: 'processing', success: 'success', error: 'error' }[status]
}

function statusText(status: ExecutionSession['status']) {
  return { running: '执行中', success: '成功', error: '失败' }[status]
}

function ExecutionHistory() {
  const sessions = useWorkflowStore((state) => state.sessions)
  const activeSessionId = useWorkflowStore((state) => state.activeSessionId)
  const running = useWorkflowStore((state) => state.running)
  const selectSession = useWorkflowStore((state) => state.selectSession)

  if (!sessions.length) return null
  const latestId = sessions[sessions.length - 1].id

  return (
    <div className="execution-history">
      <Divider orientation="left">执行历史（{sessions.length}）</Divider>
      {[...sessions].reverse().map((session) => {
        const success = Object.values(session.results).filter((result) => result.status === 'success').length
        const failed = Object.values(session.results).filter((result) => result.status === 'error').length
        const isActive = session.id === (activeSessionId ?? latestId)
        return (
          <div
            key={session.id}
            className={`history-item ${isActive ? 'is-active' : ''} status-${session.status}`}
            onClick={() => { if (!running) selectSession(isActive ? null : session.id) }}
          >
            <div className="history-item-head">
              <Tag color={statusColor(session.status)}>{statusText(session.status)}</Tag>
              <Tag>{session.trigger === 'resume' ? '续跑' : '首次执行'}</Tag>
              <span className="history-time">{sessionTimeLabel(session.startedAt)}</span>
            </div>
            <div className="history-meta">
              修订 <code>{session.revision.revisionHash}</code> · 成功 {success} · 失败 {failed}
            </div>
            {isActive && (
              <div className="history-log">
                {session.log.slice(-4).map((entry, index) => (
                  <div key={index} className={`log-line log-${entry.level}`}>{entry.message}</div>
                ))}
              </div>
            )}
          </div>
        )
      })}
      <Typography.Text type="secondary" className="history-hint">
        点击会话可查看其冻结结果；新执行只追加记录，不覆盖历史。
      </Typography.Text>
    </div>
  )
}

export default function Inspector() {
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId)
  const selectedEdgeId = useWorkflowStore((state) => state.selectedEdgeId)
  const node = useWorkflowStore((state) => state.nodes.find((item) => item.id === state.selectedNodeId))
  const edge = useWorkflowStore((state) => state.edges.find((item) => item.id === state.selectedEdgeId))
  const nodes = useWorkflowStore((state) => state.nodes)
  const edges = useWorkflowStore((state) => state.edges)
  const sessions = useWorkflowStore((state) => state.sessions)
  const activeSessionId = useWorkflowStore((state) => state.activeSessionId)
  const updateNode = useWorkflowStore((state) => state.updateNode)
  const updateConfig = useWorkflowStore((state) => state.updateConfig)
  const deleteSelection = useWorkflowStore((state) => state.deleteSelection)

  const session = useMemo(() => {
    if (activeSessionId) return sessions.find((item) => item.id === activeSessionId) ?? null
    return sessions.length ? sessions[sessions.length - 1] : null
  }, [sessions, activeSessionId])
  const plan = useMemo(
    () => (session ? computeResumePlan(session, nodes, edges) : null),
    [session, nodes, edges],
  )
  const view = useMemo(
    () => (node ? nodeViewState(node, session, plan) : null),
    [node, session, plan],
  )

  if (!selectedNodeId && !selectedEdgeId) {
    return (
      <aside className="inspector-panel empty-inspector">
        <Typography.Title level={5}>属性配置</Typography.Title>
        <Typography.Text type="secondary">选择节点或连线后，可编辑业务参数。</Typography.Text>
        <ExecutionHistory />
      </aside>
    )
  }

  if (edge) {
    return (
      <aside className="inspector-panel">
        <div className="panel-heading"><Typography.Title level={5}>连线属性</Typography.Title></div>
        <Tag color="blue">{edge.data?.portType ?? 'dataset'}</Tag>
        <Form layout="vertical" className="inspector-form">
          <Form.Item label="源节点">
            <Input value={edge.source} disabled />
          </Form.Item>
          <Form.Item label="目标节点">
            <Input value={edge.target} disabled />
          </Form.Item>
        </Form>
        <Button danger block icon={<DeleteOutlined />} onClick={deleteSelection}>删除连线</Button>
      </aside>
    )
  }

  if (!node || !view) return null
  const definition = definitionFor(node.data.kind)
  return (
    <aside className="inspector-panel">
      <div className="panel-heading">
        <div>
          <Typography.Title level={5}>节点属性</Typography.Title>
          <Typography.Text type="secondary">ID: {node.id}</Typography.Text>
        </div>
        <Space>
          {view.stale && <Tag color="warning">结果已过期</Tag>}
          <Tag color={definition.color}>{statusLabel(view.status)}</Tag>
        </Space>
      </div>
      <Form layout="vertical" className="inspector-form">
        <Form.Item label="节点名称">
          <Input value={node.data.label} onChange={(event) => updateNode(node.id, { label: event.target.value })} />
        </Form.Item>
        <Form.Item label="说明">
          <Input.TextArea
            rows={2}
            value={node.data.description}
            onChange={(event) => updateNode(node.id, { description: event.target.value })}
          />
        </Form.Item>
        <Divider orientation="left">执行参数</Divider>
        {Object.entries(node.data.config).map(([key, value]) => (
          <Form.Item key={key} label={key}>
            {typeof value === 'boolean' ? (
              <Switch checked={value} onChange={(checked) => updateConfig(node.id, key, checked)} />
            ) : typeof value === 'number' ? (
              <InputNumber
                style={{ width: '100%' }}
                value={value}
                onChange={(next) => updateConfig(node.id, key, next ?? 0)}
              />
            ) : key.includes('Type') || key === 'mode' || key === 'refresh' ? (
              <Select
                value={value}
                options={[value, 'left', 'inner', 'upsert', 'append', '实时', '每小时']
                  .filter((item, index, list) => list.indexOf(item) === index)
                  .map((item) => ({ value: item, label: item }))}
                onChange={(next) => updateConfig(node.id, key, next)}
              />
            ) : (
              <Input value={String(value)} onChange={(event) => updateConfig(node.id, key, event.target.value)} />
            )}
          </Form.Item>
        ))}
      </Form>
      <Space direction="vertical" style={{ width: '100%' }}>
        <div className="run-facts">
          <span>输入端口：{definition.inputs.join(' / ') || '无'}</span>
          <span>输出端口：{definition.outputs.join(' / ') || '无'}</span>
          <span>最近耗时：{view.duration !== undefined ? `${view.duration} ms` : '--'}</span>
          <span>处理行数：{view.rows !== undefined ? view.rows.toLocaleString('zh-CN') : '--'}</span>
        </div>
        <Button danger block icon={<DeleteOutlined />} onClick={deleteSelection}>删除节点</Button>
      </Space>
    </aside>
  )
}
