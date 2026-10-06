import { App as AntApp, Button, Input, Space, Tooltip, Upload } from 'antd'
import {
  ApartmentOutlined,
  CloudDownloadOutlined,
  CloudUploadOutlined,
  CopyOutlined,
  DeleteOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  ReloadOutlined,
  SnippetsOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useRef } from 'react'
import type { UploadProps } from 'antd'
import NodePalette from '../components/NodePalette'
import Inspector from '../components/Inspector'
import WorkflowCanvas from '../components/WorkflowCanvas'
import { useWorkflowStore } from '../stores/workflow'
import type { WorkflowDocument } from '../types/workflow'

export default function EditorView() {
  const { message, modal } = AntApp.useApp()
  const uploadRef = useRef<HTMLInputElement>(null)
  const store = useWorkflowStore()

  function exportJson() {
    const document: WorkflowDocument = {
      version: 1,
      name: store.name,
      nodes: store.nodes,
      edges: store.edges,
      savedAt: new Date().toISOString(),
      sessions: store.sessions,
    }
    const blob = new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `${store.name.replace(/\s+/g, '-')}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    message.success('流程 JSON 已导出（含执行会话与历史）')
  }

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: async (file) => {
      try {
        const document = JSON.parse(await file.text()) as WorkflowDocument
        if (!Array.isArray(document.nodes) || !Array.isArray(document.edges)) throw new Error('JSON 缺少 nodes 或 edges')
        store.loadDocument(document)
        message.success('流程导入成功')
      } catch (error) {
        message.error(error instanceof Error ? error.message : '流程 JSON 无效')
      }
      return false
    },
  }

  async function run() {
    message.loading({ content: '正在模拟执行...', key: 'run' })
    await store.startRun()
    message.destroy('run')
  }

  function resume() {
    const result = store.planResume()
    if (!result) return
    const { session, plan } = result
    const labelOf = (id: string) => session.revision.nodes.find((node) => node.id === id)?.label ?? id
    modal.confirm({
      title: '续跑核对：重跑范围',
      width: 560,
      okText: `续跑（重跑 ${plan.stale.length} 个节点）`,
      cancelText: '取消',
      content: (
        <div className="resume-confirm">
          <p>
            已核对会话修订 <code>{session.revision.revisionHash}</code> 与当前画布：
          </p>
          <p>
            <span className="resume-tag rerun">重跑 {plan.stale.length} 个节点</span>
            <span className="resume-labels">{plan.stale.map(labelOf).join('、') || '无'}</span>
          </p>
          <p>
            <span className="resume-tag keep">保留 {plan.reusable.length} 个节点结果</span>
            <span className="resume-labels">{plan.reusable.map(labelOf).join('、') || '无'}</span>
          </p>
          <p className="resume-hint">
            仅重跑失效节点及其后续依赖；未改动的旁支节点不重算，已确认的上游结果直接复用。
          </p>
        </div>
      ),
      onOk: async () => {
        message.loading({ content: '正在续跑...', key: 'resume' })
        await store.executeResume(session.id)
        message.destroy('resume')
      },
    })
  }

  return (
    <div className="editor-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">FP</div>
          <div><strong>FlowPilot</strong><span>数据工作流编排平台</span></div>
        </div>
        <Input
          className="flow-name"
          value={store.name}
          onChange={(event) => store.setName(event.target.value)}
          prefix={<SnippetsOutlined />}
        />
        <Space wrap>
          <Tooltip title="撤销"><Button icon={<UndoOutlined />} disabled={!store.past.length} onClick={store.undo} /></Tooltip>
          <Tooltip title="重做"><Button icon={<RedoOutlined />} disabled={!store.future.length} onClick={store.redo} /></Tooltip>
          <Tooltip title="复制"><Button icon={<CopyOutlined />} onClick={store.copySelection} /></Tooltip>
          <Tooltip title="粘贴"><Button icon={<SnippetsOutlined />} onClick={store.pasteSelection} /></Tooltip>
          <Tooltip title="删除"><Button danger icon={<DeleteOutlined />} onClick={store.deleteSelection} /></Tooltip>
          <Button icon={<ApartmentOutlined />} onClick={store.layout}>自动布局</Button>
          <Upload {...uploadProps}><Button icon={<CloudUploadOutlined />}>导入</Button></Upload>
          <Button icon={<CloudDownloadOutlined />} onClick={exportJson}>导出</Button>
          <Button icon={<ReloadOutlined />} onClick={store.reset}>重置</Button>
          <Tooltip title="从失败/中断处继续：只重跑失效节点，保留已确认的上游结果">
            <Button
              icon={<HistoryOutlined />}
              onClick={resume}
              disabled={!store.sessions.length}
              loading={store.running}
            >
              续跑
            </Button>
          </Tooltip>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={store.running} onClick={run}>模拟执行</Button>
        </Space>
      </header>
      <main className="editor-grid">
        <NodePalette />
        <WorkflowCanvas />
        <Inspector />
      </main>
    </div>
  )
}
