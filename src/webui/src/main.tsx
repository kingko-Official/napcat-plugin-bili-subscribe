import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// React 根节点只负责挂载 App，真正的界面逻辑都在组件树里。
ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
