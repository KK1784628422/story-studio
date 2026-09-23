import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App.tsx'
import './styles/index.css'

/** 全局错误边界：React 渲染/effect 异常时不再整屏黑掉，显示错误信息与恢复操作。
 *  「尝试恢复」仅清错误状态（适合 effect cleanup 类瞬时崩溃，如组件销毁竞态）；
 *  状态已坏的场景用「重新加载」。 */
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error }
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error('[ErrorBoundary]', error, info)
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    const detail = String(this.state.error?.message ?? this.state.error)
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 14,
          padding: 24,
          background: '#141414',
          color: '#d8d3c8',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 600 }}>界面出现异常</div>
        <pre
          style={{
            maxWidth: 720,
            maxHeight: 200,
            overflow: 'auto',
            margin: 0,
            padding: '10px 14px',
            borderRadius: 8,
            background: 'rgba(224, 122, 106, 0.08)',
            border: '1px solid rgba(224, 122, 106, 0.35)',
            color: '#e07a6a',
            fontSize: 12.5,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {detail}
        </pre>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              border: '1px solid #6b6455',
              background: 'transparent',
              color: '#d8d3c8',
              cursor: 'pointer',
            }}
          >
            尝试恢复
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#c9973f',
              color: '#fff6ef',
              cursor: 'pointer',
            }}
          >
            重新加载
          </button>
        </div>
      </div>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
