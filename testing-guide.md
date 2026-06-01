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
6. 右键 tray → Show Last Hotkey Result → 弹窗显示上次 hotkey 的 host/cwd/command/agent/result
7. 右键 tray → Open Logs Folder → 系统打开 ~/Library/Logs/VibeSync/，里面有 vibesync.log
8. IDE 场景（VS Code/Cursor）首次按 hotkey，调试面板出现 "Grant Accessibility Access" 按钮 → 点击触发系统授权弹窗

---
自动化测试（必须在每次发布前过一遍）：
cd frontend && npm run lint && npm run test && npm run build
python3 -m unittest discover backend/tests

期望：60 个测试全过（40 frontend + 20 backend），lint 0 警告，build 成功。

---
剪贴板安全手测（pre-release-checklist §3 必过）：
1. echo -n "VIBESYNC_SENTINEL" | pbcopy
2. 切到 Finder（不支持的 host），按 Cmd+Shift+C
3. pbpaste → 应该仍然输出 "VIBESYNC_SENTINEL"
4. 重复：unsupported command（zsh）、缺 cwd 的场景、backend 404、backend 409
   每一种失败都不应该覆盖剪贴板