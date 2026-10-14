# PlanBridge 本地 ChatGPT API

连接你自己的 ChatGPT 账号，生成仅在本机使用的 API Key，通过 `/v1/responses` 或本地兼容的 `/v1/chat/completions` 发起模型请求。使用官方 **Sign in with ChatGPT 的 ChatGPT plan usage OAuth 流程**，直接请求 `https://api.openai.com/v1/responses`，不启动 Codex agent。

## 下载与安装

在 [Releases 下载页面](https://github.com/rhotov/PlanBridge/releases/latest)下载 `PlanBridge-macOS-arm64.zip`。解压后，把 `PlanBridge.app` 拖入「应用程序」文件夹，再打开 App。

- 适用于 **Apple Silicon（M 系列芯片）、macOS 13 或更新版本**；当前发布包不支持 Intel Mac。
- App 已包含 Node.js，无需安装额外运行环境。
- 点击顶部电源图标，勾选「运行服务器」启动，取消勾选停止；「打开控制台」进入本地网页。
- 退出 App 时停止服务器，账号授权与本地 Key 会保留。App 不显示 Dock 图标，也不会设置开机自启动。
- API 地址是 `http://127.0.0.1:4317/v1`。首次使用在控制台登录自己的 ChatGPT 账号并创建本地 Key。

发布包使用本地 ad hoc 签名，**没有 Apple Developer ID 签名或公证**。macOS 可能阻止首次打开；仅在确认下载来自本仓库后，通过「系统设置 → 隐私与安全性」中的「仍要打开」批准此 App。请在移动或替换 App 前先退出，避免后台仍使用旧版本。

这是独立的开源客户端，与 OpenAI 没有隶属关系；能否使用 ChatGPT 计划额度取决于 OpenAI 当前规则和你的账号资格。安装 App 不会赠送额度，也不会创建 OpenAI 平台 API Key。

## 从源码构建 App

需要 Apple Silicon Mac、Xcode 命令行工具（`xcode-select --install`）和 macOS arm64 Node.js 24.5 或更新版本。

```sh
./macos/build-app.command
```

脚本优先使用 `PLANBRIDGE_NODE_BIN`，未设置时使用 PATH 中的 `node`。构建前检查运行时架构和 `--use-env-proxy` 支持，输出位于仓库上一级目录的 `PlanBridge-macOS-arm64.zip`。可以显式指定运行时：

```sh
PLANBRIDGE_NODE_BIN='/absolute/path/to/node' ./macos/build-app.command
```

构建仅包含程序、MIT 许可及 Node.js 许可，不包含账号、Key、OAuth 凭证、日志或调用记录。公开发布包的 `installation.json` 默认为 `{}`，不会嵌入开发者机器路径，也不会自动寻找旧账号数据。

仅当你需要在自己的电脑上迁移旧版源码服务数据时，可构建专供本机使用的包：

```sh
PLANBRIDGE_LEGACY_DATA_DIR='/absolute/path/to/old/project/.data' ./macos/build-app.command
```

该选项只将迁移路径写入 App，不打包目录内容。包含个人路径的迁移包不应作为公开 Release；公开发布时不要设置此变量。

仓库的 `Release macOS app` GitHub Actions 工作流使用免费标准 macOS runner 构建并发布 App 和 SHA-256 校验文件。首次提交、`main` 上版本号或发布工作流变更时会检查 `package.json` 中的版本；已有对应 Release 时跳过，不覆盖已发布资产。也可在 Actions 页面手动运行。普通源码更新不会触发新版本发布。发布新版本前需同步 `package.json`、构建脚本里的 App 版本和 `macos/RELEASE-NOTES.md`；工作流使用 GitHub 提供的临时 `GITHUB_TOKEN`，无需设置个人访问令牌。

## 从源码启动服务器

Mac 上双击 `start.command`，在浏览器打开 **http://127.0.0.1:4317**。服务会独立在后台运行，关闭启动窗口或当前聊天不会停止服务。再次打开启动文件会复用已经运行的服务。停止时双击 `stop.command`。电脑重启后需要再次手动启动。

源码启动需要 Node.js 24.5 或更新版本，无需安装项目依赖。Mac 上的启动文件会从 PATH 中寻找 Node.js，也可通过 `PLANBRIDGE_NODE_BIN` 指定绝对路径。

也可在项目目录运行：

```sh
node server.mjs
```

1. 点击 **Continue with ChatGPT**，在 OpenAI 官方页面登录并同意计划额度权限。
2. 返回控制台，确认账号连接成功并加载可用模型。
3. 在「API 密钥」创建本地 Key，复制并保存；完整 Key 只显示一次。
4. 使用页面里的调用示例，或在「试运行」发送请求。

默认只监听 `127.0.0.1`，不提供公网或局域网访问。请使用 `127.0.0.1`，OAuth 回调不能换成 `localhost`。更换后台服务端口：`PLANBRIDGE_PORT=4320 ./start.command`，停止时也需要使用同一端口：`PLANBRIDGE_PORT=4320 ./stop.command`。直接运行 `node server.mjs` 时仍以前台方式运行，按 Ctrl+C 停止。

若浏览器显示「拒绝建立连接」，请重新打开 `start.command`；通常说明本地进程未运行，而不是 ChatGPT 登录错误。启动异常的运行日志保存在 `.data/server.log`。

## 接口

Base URL：`http://127.0.0.1:4317/v1`

认证：`Authorization: Bearer pb_local_...`（控制台生成的本地 Key）。它并非 OpenAI 官方 API Key，也不能直接用于 OpenAI 官网接口。Key 固定绑定生成时的 ChatGPT 账号；切换控制台账号不会改变已有 Key 的归属。

### 查询可用模型

```sh
export PLANBRIDGE_API_KEY='填写你保存的本地 Key'
curl http://127.0.0.1:4317/v1/models \
  -H "Authorization: Bearer $PLANBRIDGE_API_KEY"
```

响应提供 `data[].id` 以及 `models[].slug`。选择账号实际返回的模型，避免写死模型名称。

### 流式请求

```sh
export PLANBRIDGE_MODEL='填写 /v1/models 返回的模型 ID'
curl -N http://127.0.0.1:4317/v1/responses \
  -H "Authorization: Bearer $PLANBRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$PLANBRIDGE_MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"用一句话介绍你自己\"}],\"stream\":true,\"store\":false}"
```

成功必须收到 `response.completed`；`response.failed`、`response.incomplete` 和流中断均不是成功。即使 HTTP 状态为 200，流中的失败事件仍可能表示额度或资格限制。

### Python / OpenAI SDK

在你自己的 Python 环境安装 `openai` 后：

```python
import os
from openai import OpenAI

client = OpenAI(
    api_key=os.environ['PLANBRIDGE_API_KEY'],
    base_url='http://127.0.0.1:4317/v1',
    max_retries=0,
)
completed = False
with client.responses.create(
    model=os.environ['PLANBRIDGE_MODEL'],
    input=[{'role': 'user', 'content': '用一句话介绍你自己'}],
    store=False,
    stream=True,
) as stream:
    for event in stream:
        if event.type == 'response.output_text.delta':
            print(event.delta, end='', flush=True)
        elif event.type == 'response.completed':
            completed = True
        elif event.type in ('response.failed', 'response.incomplete', 'error'):
            raise RuntimeError(str(event))
if not completed:
    raise RuntimeError('流中断，未收到完成事件')
```

本地接口也接受 `stream:false`（或省略 `stream`），在服务器读取上游事件流后返回完整 JSON。它始终向 OpenAI 发送 `stream:true` 和 `store:false`。这种聚合只是本地适配，不代表官方订阅接口支持非流式调用。

目前提供 Responses、模型目录和本地 Chat Completions 兼容接口；未实现文件上传、语音、Embedding 或 Batch 接口。Responses 多轮上下文请随每次请求完整放入 `input`；不能使用 `previous_response_id`。系统提示使用 `instructions` 或 `developer` 消息。

### Cherry Studio 等聊天客户端

普通 OpenAI 兼容服务配置可保持原样：Base URL 为 `http://127.0.0.1:4317/v1`，密钥使用本站生成的本地 Key，模型使用同步列表中的原始模型 ID。客户端的 `/v1/chat/completions` 请求会在本地转换为官方 `/v1/responses`，并将结果转换回 Chat Completions 的 JSON 或事件流。

支持文本、符合模型要求的图片、消息历史、思考摘要、JSON 格式，以及客户端执行的 function 工具；系统消息转换为 developer 消息。工具放入 `functions` 命名空间，`tool_choice` 暂支持 `auto`、`none`、`required`。音频、旧版 functions/function_call、多个候选结果和指定某个工具的 tool_choice 暂不支持，返回明确错误。

订阅路线不支持的采样与长度参数（如 temperature、top_p、max_tokens、max_completion_tokens、stop、frequency_penalty、presence_penalty、seed、logprobs）会在兼容层移除；这些选项不会影响上游生成。被移除的参数名列在响应头 `x-planbridge-ignored-parameters`。上游始终使用 `store:false` 与 `stream:true`；客户端可接收本地聚合的非流式结果。

## 额度与可用性

官方文档说明符合条件的 ChatGPT Plus / Pro 用户可授权应用使用其 ChatGPT 计划；是否实际可用由账号、授权范围、地区、模型及 OpenAI 当前规则决定。订阅不是无限额度，也不会生成官方平台的付费 API Key。页面统计仅记录通过本站产生的请求和 token，不是账户剩余额度。出现额度耗尽时应停止并按 OpenAI 返回的错误处理；本站不会切换到付费 API 进行兜底。

首次登录使用官方公开客户端动态注册流程 `dynamic_agent_client`，回调取得正式 `client_id`，之后按账号复用。应用源码采用 MIT 许可；此本地客户端没有商业托管服务。商业网站的接入资格和流程请另查官方文档。

## 本地数据

`.data/state.json` 保存主机标识、账号映射、OAuth 凭证、本地 Key 的 SHA-256 摘要、调用统计及最近 40 条调用状态。文件权限为 `0600`，目录为 `0700`，原子替换；`.data` 已排除版本控制。它并未进行磁盘加密，依赖操作系统的用户文件权限；不要分享或打包 `.data`。本站不记录提示词和模型输出，不向前端返回 OAuth 凭证。

macOS 菜单栏应用把数据保存在 `~/Library/Application Support/PlanBridge`，应用包只包含程序与 Node.js。公开下载包首次运行使用这个目录；没有旧数据时需要本人登录。开关关闭或退出应用只停止服务，不断开账号授权。

为本机显式设置 `PLANBRIDGE_LEGACY_DATA_DIR` 构建的迁移包，会先停止经身份验证的旧服务，将原有 `state.json` 迁移到该目录，再在旧 `.data/storage-location.json` 写入存储位置。旧版启动脚本也会使用同一份数据，避免刷新令牌被两份后台重复使用；账号和本地 Key 保留，迁移前正在运行的服务会在迁移后恢复。

需要自定义存储位置时，设置绝对路径 `PLANBRIDGE_DATA_DIR`。显式设置优先于旧目录的存储位置记录；同一账号数据只能运行一个后台，不要通过这个选项启动历史凭证副本。`PLANBRIDGE_NODE_BIN` 可以指定 Node.js 可执行文件。菜单栏应用使用内置 Node.js，因此不需要另外安装运行环境。菜单栏状态按实际服务器健康检查更新；遇到其他程序占用端口时，不会终止其他程序。

断开账号时先清除本地令牌并尝试撤销 OpenAI 刷新令牌。页面会显示远程撤销是否确认；若网络不可达，请在 ChatGPT 设置中移除此应用的授权。断开保留账号映射，便于用原 client ID 重连；撤销本地 Key 后立即不能继续新请求。

## 网络问题

浏览器和本地后台都需要能访问 `auth.openai.com` 和 `api.openai.com`。若登录提示无法连接或 HTTP 403，请检查网络连接、账号资格和 OpenAI 当前服务限制。

启动文件默认读取 macOS 当前启用的 HTTP/HTTPS 代理；没有系统代理时使用现有 HTTP_PROXY / HTTPS_PROXY 环境变量。发布包内置的 Node.js 支持所需的 `--use-env-proxy`；从源码运行时需自行安装兼容版本。本地 `127.0.0.1` 请求会绕过代理。

修改代理设置后，请先打开 `stop.command`，再打开 `start.command`，让后台重新读取配置。只重复启动会复用已有后台，不会改变它的网络配置。需要强制直连时使用 `PLANBRIDGE_USE_ENV_PROXY=0 ./start.command`。

也可指定可用的 HTTP 代理（需要 Node.js 支持 `--use-env-proxy`，如 24.5 或以上）：

```sh
HTTPS_PROXY='http://127.0.0.1:实际代理端口' \
HTTP_PROXY='http://127.0.0.1:实际代理端口' \
NO_PROXY='127.0.0.1,localhost' \
PLANBRIDGE_USE_ENV_PROXY=1 ./start.command
```

示例端口是占位符，需要替换为你自己的有效配置。请勿通过改变鉴权、盗用客户端身份或绕过服务端限制解决资格问题。

## 验证

```sh
node --test test/*.test.mjs
```

测试通过模拟的 OpenAI 端点和真实签名测试凭证验证 OAuth 校验、权限、Key 撤销、流结束状态和令牌轮换，不消耗订阅额度。真实登录需要账号本人在浏览器完成；模拟测试不能证明特定账号的额度可用。

## 官方资料

- [Sign in with ChatGPT 快速开始](https://developers.openai.com/siwc/quickstart)
- [公开客户端注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [模型与 Responses 请求](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [账号、刷新与断开](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [预览功能限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [错误处理](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)

登录和计划额度功能依据上述官方文档实现。OpenAI 的预览功能、可用模型和账号资格可能变化，请以当前官方规则和服务端返回结果为准。

## 许可

项目源码使用 [MIT License](LICENSE)。发布包包含的 Node.js 及其第三方依赖许可见 [macos/Node-LICENSE.txt](macos/Node-LICENSE.txt)。
