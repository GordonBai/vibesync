开发模式（推荐，改代码热重载）：
cd frontend && npm run desktop
启动 Vite dev server + Electron 窗口。--dev 标志让 Electron 加载 localhost:5173，改 React 代码自动刷新。backend 自动 spawn。

生产模式（测试打包后的 .app）：
cd frontend && npm run build:desktop
open dist/mac-arm64/VibeSync.app
完整打包流程，等同于最终用户看到的。

---
功能测试重点：
1. 启动后观察 tray 图标是否出现，tooltip 显示 "backend running"
2. 左键点击 tray → 窗口弹出，确认新图标（agent PNG + app logo）正常渲染
3. 打开终端 cd ~/some-project && claude，按 Cmd+Shift+C → 托盘应显示 ✓
4. 在无 agent 终端按 Cmd+Shift+C → 应显示 ✗ 错误提示
5. 右键 tray → Quit，确认 backend 进程也退出