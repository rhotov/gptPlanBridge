PlanBridge 首个公开 macOS 版本。

- 菜单栏电源图标控制本地服务器；关闭开关或退出 App 时停止服务。
- 使用自己的 ChatGPT 账号登录，在本机控制台生成 API Key。
- 提供 `/v1/models`、`/v1/responses` 和 `/v1/chat/completions`，可连接 Cherry Studio 等兼容客户端。
- 已内置 Node.js 24.19.0，不需要另外安装运行环境。

下载 `PlanBridge-macOS-arm64.zip`，解压后把 `PlanBridge.app` 拖入应用程序文件夹。适用于 **Apple Silicon（M 系列）、macOS 13+**；当前发布包不支持 Intel Mac。

App 使用 ad hoc 签名，**没有 Apple Developer ID 签名或公证**。macOS 可能阻止首次打开；确认下载来自本仓库后，可在「系统设置 → 隐私与安全性」选择「仍要打开」。

账号和本地 Key 保存在自己的 `~/Library/Application Support/PlanBridge`。发布包不含个人账号、OAuth 凭证、Key、调用日志或迁移路径。

这是独立开源客户端。计划额度、模型和地区可用性由 OpenAI 及账号资格决定；不是无限额度，也不会生成 OpenAI 平台 API Key。

首次打开后，在顶部菜单启动服务器并打开控制台。API 地址：`http://127.0.0.1:4317/v1`。

提供 `.sha256` 文件供下载后核对 ZIP 完整性。详细配置和功能边界见仓库 README。
