import { App as AntApp, Button, Modal, Tag, Typography } from 'antd'
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  HistoryOutlined,
  LockOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons'
import { useState } from 'react'
import { sessionStatusLabel, useWorkflowStore } from '../stores/workflow'
import type { RunSession, WorkflowEdge, WorkflowNode } from '../types/workflow'
import { buildRevision, sessionDuration, sessionProgress, type ResumePlan } from '../utils/checkpoint'

function formatTime(value: string): string {
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export default function SessionPanel() {
  const { message } = AntApp.useApp()
  const sessions = useWorkflowStore((state) => state.sessions)
  const activeSessionId = useWorkflowStore((state) => state.activeSessionId)
  const activateSession = useWorkflowStore((state) => state.activateSession)
  const resumeSession = useWorkflowStore((state) => state.resumeSession)
  const running = useWorkflowStore((state) => state.running)
  const revisionId = useWorkflowStore((state) => buildLiveRevisionId(state.nodes, state.edges))
  const nodes = useWorkflowStore((state) => state.nodes)
  const [pendingPlan, setPendingPlan] = useState<{ session: RunSession; plan: ResumePlan } | null>(null)

  const active = sessions.find((session) => session.id === activeSessionId) ?? null

  async function handleResume(session: RunSession) {
    const plan = await resumeSession(session.id)
    if (!plan) {
      message.success(`会话「${session.name}」续跑完成`)
      return
    }
    setPendingPlan({ session, plan })
  }

  function nodeLabel(id: string): string {
    const inCanvas = nodes.find((node) => node.id === id)?.data.label
    const inSession = pendingPlan?.session.revision.nodes.find((node) => node.id === id)?.label
    return inCanvas ?? inSession ?? id
  }

  async function confirmResume() {
    if (!pendingPlan) return
    const { session } = pendingPlan
    setPendingPlan(null)
    await resumeSession(session.id, true)
    message.success(`已按确认范围续跑「${session.name}」`)
  }

  const plan = pendingPlan?.plan ?? null

  return (
    <div className="session-panel">
      <div className="session-panel-head">
        <span><HistoryOutlined /> 执行会话（检查点）</span>
        <span className="session-count">{sessions.length}</span>
      </div>
      {active && (
        <div className="session-active">
          <div className="session-active-row">
            {active.status === 'success'
              ? <CheckCircleFilled style={{ color: '#16a34a' }} />
              : active.status === 'failed'
                ? <CloseCircleFilled style={{ color: '#dc2626' }} />
                : <ClockCircleOutlined style={{ color: '#2563eb' }} />}
            <strong>{active.name}</strong>
            <Tag color={active.status === 'success' ? 'green' : active.status === 'failed' ? 'red' : 'blue'}>
              {sessionStatusLabel(active.status)}
            </Tag>
          </div>
          <div className="session-active-meta">
            <span><LockOutlined /> 冻结修订 {active.revision.id.slice(0, 8)}</span>
            <span>
              进度 {sessionProgress(active).done}/{sessionProgress(active).total} ·
              累计 {sessionDuration(active).toLocaleString('zh-CN')} ms
            </span>
            {active.revision.id !== revisionId && !running && (
              <Typography.Text type="warning" style={{ fontSize: 11 }}>
                画布已偏离冻结修订，续跑前将核对
              </Typography.Text>
            )}
          </div>
          {active.status === 'failed' && (
            <Button
              size="small"
              type="primary"
              icon={<PlayCircleOutlined />}
              disabled={running}
              onClick={() => handleResume(active)}
            >
              从检查点续跑
            </Button>
          )}
        </div>
      )}
      <div className="session-list">
        {sessions.length === 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            尚无执行记录，点击“模拟执行”会冻结当前修订并逐节点保存检查点。
          </Typography.Text>
        )}
        {[...sessions].reverse().map((session) => {
          const progress = sessionProgress(session)
          return (
            <button
              key={session.id}
              type="button"
              className={`session-item ${session.id === activeSessionId ? 'is-active' : ''}`}
              onClick={() => activateSession(session.id)}
            >
              <span className="session-item-main">
                <strong>{session.name}</strong>
                <small>
                  {formatTime(session.startedAt)} · {progress.done}/{progress.total} 节点
                  {session.revisionHistory.length > 0 && ` · 重冻结 ${session.revisionHistory.length} 次`}
                </small>
              </span>
              <Tag
                color={session.status === 'success' ? 'green' : session.status === 'failed' ? 'red' : 'blue'}
                style={{ marginInlineEnd: 0 }}
              >
                {sessionStatusLabel(session.status)}
              </Tag>
            </button>
          )
        })}
      </div>

      <Modal
        title="续跑核对：冻结修订与当前画布不一致"
        open={!!pendingPlan}
        onCancel={() => setPendingPlan(null)}
        onOk={confirmResume}
        okText={`确认重跑 ${plan?.rerun.length ?? 0} 个节点并续跑`}
        cancelText="取消"
        okButtonProps={{ danger: true }}
        width={560}
      >
        {plan && pendingPlan && (
          <div className="resume-plan">
            <Typography.Paragraph type="warning" strong>
              {plan.invalidGraph
                ? '当前画布存在环或无效依赖，无法续跑。'
                : '继续将以当前画布重新冻结修订；下列范围外的已确认结果原样保留，旁支不重算。'}
            </Typography.Paragraph>
            <div className="resume-plan-grid">
              <div>
                <Typography.Text strong>需重跑（{plan.rerun.length}）</Typography.Text>
                <ul className="resume-plan-list rerun">
                  {plan.rerun.map((id) => <li key={id}>{nodeLabel(id)}</li>)}
                  {plan.rerun.length === 0 && <li className="muted">无</li>}
                </ul>
              </div>
              <div>
                <Typography.Text strong>保留复用（{plan.reusable.length}）</Typography.Text>
                <ul className="resume-plan-list keep">
                  {plan.reusable.map((id) => <li key={id}>{nodeLabel(id)}</li>)}
                  {plan.reusable.length === 0 && <li className="muted">无</li>}
                </ul>
              </div>
            </div>
            {(plan.added.length > 0 || plan.removed.length > 0) && (
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                {plan.added.length > 0 && `新增节点：${plan.added.map(nodeLabel).join('、')}；`}
                {plan.removed.length > 0 && `已移除节点：${plan.removed.map(nodeLabel).join('、')}（历史结果归档保留，不删除）`}
              </Typography.Paragraph>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

// 与当前画布一致的实时修订指纹（视图层轻量比对）
function buildLiveRevisionId(nodes: WorkflowNode[], edges: WorkflowEdge[]): string {
  return buildRevision('', nodes, edges).id
}
