import { Button, Divider, Form, Input, InputNumber, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { statusLabel, useWorkflowStore } from '../stores/workflow'
import { definitionFor } from '../utils/workflow'

export default function Inspector() {
  const selectedNodeId = useWorkflowStore((state) => state.selectedNodeId)
  const selectedEdgeId = useWorkflowStore((state) => state.selectedEdgeId)
  const node = useWorkflowStore((state) => state.nodes.find((item) => item.id === state.selectedNodeId))
  const edge = useWorkflowStore((state) => state.edges.find((item) => item.id === state.selectedEdgeId))
  const updateNode = useWorkflowStore((state) => state.updateNode)
  const updateConfig = useWorkflowStore((state) => state.updateConfig)
  const updateForceFailure = useWorkflowStore((state) => state.updateForceFailure)
  const deleteSelection = useWorkflowStore((state) => state.deleteSelection)
  const session = useWorkflowStore((state) =>
    state.sessions.find((item) => item.id === state.activeSessionId) ?? null,
  )
  const running = useWorkflowStore((state) => state.running)
  const record = node && session
    ? session.results.find((item) => item.nodeId === node.id)
    : undefined

  if (!selectedNodeId && !selectedEdgeId) {
    return (
      <aside className="inspector-panel empty-inspector">
        <Typography.Title level={5}>属性配置</Typography.Title>
        <Typography.Text type="secondary">选择节点或连线后，可编辑业务参数。</Typography.Text>
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

  if (!node) return null
  const definition = definitionFor(node.data.kind)
  const frozen = session?.revision.nodes.find((item) => item.id === node.id)
  const frozenInconsistent = !!session && !!frozen && JSON.stringify(frozen.config) !== JSON.stringify(node.data.config)
  return (
    <aside className="inspector-panel">
      <div className="panel-heading">
        <div>
          <Typography.Title level={5}>节点属性</Typography.Title>
          <Typography.Text type="secondary">ID: {node.id}</Typography.Text>
        </div>
        <Tag color={
          node.data.status === 'success' ? 'green'
            : node.data.status === 'error' ? 'red'
              : node.data.status === 'stale' ? 'orange'
                : node.data.status === 'skipped' ? 'default'
                  : 'blue'
        }>{statusLabel(node.data.status)}</Tag>
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
        <Form.Item
          label={<span><ThunderboltOutlined /> 模拟失败断点</span>}
          tooltip="开启后，下次执行到该节点将模拟失败；修复后可续跑（断点会冻结进执行修订）"
        >
          <Tooltip title={running ? '执行进行中：改动只影响画布，不影响本次冻结会话' : undefined}>
            <Switch
              checked={node.data.forceFailure ?? false}
              disabled={running}
              onChange={(checked) => updateForceFailure(node.id, checked)}
            />
          </Tooltip>
        </Form.Item>
      </Form>
      <Space direction="vertical" style={{ width: '100%' }}>
        {record?.error && (
          <div className="run-error-box">
            <Typography.Text type="danger" strong>失败原因</Typography.Text>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>{record.error}</Typography.Text>
          </div>
        )}
        {frozenInconsistent && (
          <div className="run-warn-box">
            <Typography.Text type="warning" strong>画布参数已偏离冻结修订</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              进行中的会话仍按冻结版本执行；结束后续跑需核对确认，受影响节点及下游将重算。
            </Typography.Text>
          </div>
        )}
        <div className="run-facts">
          <span>输入端口：{definition.inputs.join(' / ') || '无'}</span>
          <span>输出端口：{definition.outputs.join(' / ') || '无'}</span>
          <span>所属会话：{session ? `${session.name}（${session.revision.id.slice(0, 6)}）` : '无'}</span>
          <span>最近耗时：{node.data.duration ?? '--'} ms</span>
          <span>处理行数：{node.data.rows?.toLocaleString('zh-CN') ?? '--'}</span>
        </div>
        <Button danger block icon={<DeleteOutlined />} onClick={deleteSelection}>删除节点</Button>
      </Space>
    </aside>
  )
}
