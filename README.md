# AE Chat Agent · Next.js 线上版

**用户只需安装 Chrome 扩展。** Agent、模型请求、AE CLI、HTTP/stdio MCP 均在 Next.js 服务器运行。无需本地执行器、Native Messaging、Node 或 macOS 安装包。

```text
Chrome 扩展 / 网页工作区
    │ HTTPS + 网页会话 / 扩展授权
    ▼
Next.js 16 App Router（常驻 Node.js 22 进程）
    ├─ 服务端 Agent、流式响应、会话与操作记录
    ├─ 每位用户的模型凭证与 AE 授权
    ├─ 对话安装 AE CLI → 用户专属服务器目录
    └─ HTTP MCP / 管理员批准的 stdio MCP
    ▼
AE 平台
```

## 开发与运行

需要 Node.js 22+。项目脚本会优先选用可用的 Node 22+；支持 `--node=/absolute/path/to/node`。最终使用扩展的用户不需要 Node。

```sh
npm install
cp .env.example .env
```

编辑 `.env`：

- `AE_CHAT_ENCRYPTION_KEY`：至少 32 字符的随机密钥，生产环境需要固定保存。可以用 `openssl rand -hex 32` 生成。更换密钥将导致已有凭证无法解密。
- `AE_CHAT_ALLOWED_ORIGINS`：管理员允许连接的 AE、模型和 HTTP MCP **完整 origin**，逗号分隔，不支持通配符。例如 `https://api.openai.com,https://ae.example.com`。
- `AE_CHAT_EXTENSION_IDS`：允许访问服务的 Chrome 扩展 ID，逗号分隔。开发者模式加载后可在 `chrome://extensions` 查看；生产发行使用固定扩展 ID。未配置时只开放同源网页工作区。
- `AE_CHAT_SERVER_DATA_DIR`：服务器数据目录，默认项目根目录的 `.server-data`。
- `AE_CHAT_PUBLIC_URL`：生产环境建议设置公网 HTTPS origin，确保反向代理后的同源检查与登录回调使用正确域名。

先创建个人工作区，再运行：

```sh
npm run server:user -- --id=ethan
npm run dev
```

创建命令显示账号和一次性的初始密码，服务端只保存带盐 scrypt 密码摘要。使用该账号在 `/login` 登录。再次使用同一 ID 会重置密码并撤销旧会话；`--revoke` 停用账号。也可通过 `--password-stdin` 从标准输入设置至少 10 字符的密码。旧版仅有访问令牌的账号需运行一次该命令设置网页登录密码。

默认地址 `http://localhost:3000`。未登录访问 `/workspace` 会跳转 `/login`；已登录则直接打开工作区。网页登录使用 HttpOnly、SameSite=Lax 的服务端会话 Cookie，HTTPS 下启用 Secure；密码和网页登录令牌不会写入 localStorage/sessionStorage。

生产构建与启动：

```sh
npm run build
npm start
```

构建输出为 `apps/server/.next/standalone`，包含所需依赖、静态资源和扩展下载。HTTP 服务需要通过反向代理配置公网 HTTPS。

## 安装扩展

1. 构建后，从服务首页下载扩展 ZIP，或使用 `apps/server/public/ae-chat-extension.zip`。
2. 解压，打开 `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序。开发阶段也可直接选择本项目 `dist/extension`。
3. 将扩展 ID 加入服务端 `AE_CHAT_EXTENSION_IDS` 并重启服务。本仓库内置公开的 manifest key，解压安装的固定 ID 为 `bhcepkllnlfooedkachnelhkdpnlageo`；该 key 不包含私钥。
4. 在扩展“线上服务”设置中仅填写服务地址，点击“保存服务地址”并允许访问该域名。已在服务网页登录时，扩展自动恢复身份；未登录则点击“前往网页登录”。扩展不再要求填写访问令牌。
5. 添加模型、API Key，运行连接和工具调用测试。通过工具测试后才会启用执行能力。
6. 对话中说 **“帮我安装 AE CLI”**。Agent 展示官方 npm 来源、精确版本和服务器目录，经确认后安装到当前账号的服务器工作区。不会安装到用户电脑。
7. 在“AE 工作区”绑定 AE 环境、项目与账号标识，保存 AE 签发的 CLI Token，再允许扩展访问该 AE 页面。

本项目的服务网页登录与 AE CLI Token 是两个独立授权。当前 CLI 不返回可靠的用户 ID，需手动确认 AE Token 与打开的 AE 业务页面对应同一账号、租户和项目。`auth status` 只能确认凭证已配置；AE 服务端在实际请求时验证其有效性。

## 网页登录与扩展接续

- 未登录时禁用消息输入和发送，显示“前往网页登录”；服务端也会拒绝未认证的对话请求。
- 网页登录后，扩展通过 Chrome Identity 非交互流程、一分钟有效的一次性授权码、state 和 PKCE S256 接续身份，不读取或复制网页 Cookie。
- 扩展自动取得 15 分钟有效的受限凭证，保存在仅扩展可信上下文可读的存储；过期后尝试从仍有效的网页登录自动恢复。
- 网页会话有效期为 8 小时。退出网页、重置密码或停用账号会使其关联的扩展凭证失效。扩展清除当前身份和可见私有历史，重新登录后从服务器恢复会话。
- 每个 API 请求及每次 SSE 状态推送前都验证服务端会话。Cookie 写操作检查同源；授权码不能重复使用，扩展回调必须匹配管理员批准的 ID。
- 默认不再接受旧版手填访问令牌登录。仅有旧 API 集成需要迁移时，可在服务端显式设置 `AE_CHAT_ALLOW_LEGACY_TOKENS=true`；浏览器扩展始终使用网页登录授权流程。
- 当前实现为本项目的服务账号登录，没有修改或接入 AE 的现有登录系统；AE Token 仍仅用于 AE 业务工具授权。

## Vercel 部署

采用 **Next.js 网关 + 同项目的持久化 Vercel Sandbox**。`apps/gateway` 部署为 Vercel Function，转发网页、API、静态资源和 SSE；原有 Next.js 执行服务在 Sandbox 内运行。网关只恢复管理员已创建的命名 Sandbox，匿名请求不会创建执行环境。Sandbox 入口额外校验随机共享密钥，用户登录、Cookie 和扩展 PKCE 授权仍由执行服务验证。

Vercel 项目设置：Root Directory 为 `apps/gateway`，Node.js 22，Install Command 为 `cd ../.. && npm ci --no-audit --no-fund`，Build Command 为 `cd ../.. && npm run build:gateway`。启用项目 OIDC，在 Production 配置 `.env.example` 的密钥、公网 URL、允许的来源和扩展 ID；`AE_CHAT_GATEWAY_SECRET` 需要独立生成至少 32 字符的随机值。

初始化执行服务（Node.js 22.18+）：

```sh
vercel link
npm run build
npm run server:provision
vercel deploy --prod
```

`vercel link` 将项目 OIDC 写入被忽略的 `.env.local`。初始化脚本还从被忽略的 `.env.production.local` 读取生产环境配置；首次运行需提供 `AE_CHAT_BOOTSTRAP_RECORD`（由 `scripts/server-user.mjs` 生成的用户记录 JSON，包含密码摘要，不应包含明文密码）。账号文件只在首次缺失时写入。实际发布的初始密码保存在部署机器的 `release/production-login.txt`，不会上传 GitHub 或放入公开构建产物。

每次更新执行层，需要先 `npm run build && npm run server:provision`，再部署网关。执行服务的数据位于独立的 `ae-chat/data`，更新代码保留用户和会话；更新期间应避免进行中的写操作。仅推送 GitHub 或重新部署网关不会更新 Sandbox 内的执行层代码。

Sandbox 使用一个 1 vCPU 实例，单次会话上限设为 30 分钟。会话结束后自动保存文件系统，下次请求恢复文件并重启服务，首次恢复可能较慢；正在执行的任务可能中断，系统按结果未知处理且不自动重放写操作。保留最新一个快照且设置不自动过期；快照不替代独立备份。Sandbox 计入 Vercel 账号配额，Hobby 配额耗尽后不可继续恢复，需要等待配额恢复或由管理员调整方案。

## Docker 部署

```sh
docker compose up -d --build
docker compose exec agent node scripts/server-user.mjs --id=ethan
```

Compose 从根目录 `.env` 读取加密密钥和允许的域名等设置，数据存于 `agent-data` volume。服务默认绑定 `127.0.0.1:3000`，在 Nginx/Caddy 等反向代理后发布 HTTPS。SSE 路由 `/api/events` 需要关闭代理缓冲，超时至少 60 秒。

Dockerfile 使用非 root 用户、Node.js 22、持久数据卷及内置 npm。**此版本按单个常驻实例部署**。CLI 安装、stdio 子进程、长任务和本地持久化依赖常驻进程与可写磁盘，不能直接把当前执行层部署成无状态 Serverless/Edge Function。多副本部署需要先接入共享数据库、任务队列和独立隔离执行节点。

本次已验证 Next.js standalone 生产服务；开发机器 Docker daemon 未启动，因此未实际构建/运行 Docker 镜像。

## 服务端能力与隔离

- `/api/rpc`：网页登录会话与扩展授权凭证鉴权、明确的方法白名单、按用户限流、2 MiB 请求上限、精确来源检查。网页只能访问同源服务；扩展需进入 ID 白名单。
- `/api/events`：带 Authorization 的 SSE，输出会话、步骤和操作结果。断开订阅不取消任务，重连可恢复。网页会话在每次状态推送前重新校验。
- 每个用户独立的配置、会话、CLI 安装、日志和 AE Token，路径不可由请求覆盖。API Key 使用 AES-256-GCM，按用户派生密钥并绑定凭证引用。
- CLI 只接受业务工具的参数数组，`shell:false`。服务端不会接受用户传来的 CLI 可执行路径。执行进程不继承服务器主密钥或其他用户凭证。
- CLI 使用一次性的 HOME；AE Token 通过现有 CLI 的 `.ae-config/cli-token.json` 契约临时注入，执行结束后清理。磁盘上的服务凭证为密文。
- 安装只允许官方 `@thinkingai/ae-cli`、精确版本和固定 npm registry，禁用包生命周期脚本，核对 lockfile integrity 后才启用。安装仅发生在当前账号的服务器目录。
- 更新报表前校验版本，写入前持久化操作 ID，保存后补读确认。失败、成功和结果未知分别处理；中断后不盲目重试创建。

这属于应用层工作区隔离。stdio 程序和官方 CLI 运行在同一服务操作系统账号下，不是任意不可信代码的安全沙箱。管理员只应批准可信程序；需要不可信多租户执行时应增加每用户容器或独立执行节点。

## MCP

HTTP MCP URL 同样需要进入服务端 origin 白名单。认证 Token 按用户加密保存。

stdio MCP 运行在服务器，前端只填写管理员预设的**别名**，不接受任意可执行文件或 Shell。管理员环境变量示例：

```dotenv
AE_CHAT_STDIO_COMMANDS={"knowledge":{"command":"/opt/mcp/knowledge-server","args":["--stdio"]}}
```

在扩展中填写 `knowledge`，服务器使用对应的固定程序与参数。发现工具后选择授权并保存，每次调用再通过确认卡批准。OAuth、MCP 包市场和任意第三方 CLI 安装尚未开放。

## 页面同步边界

AE CLI 与 AE 前端保持零改动。扩展匹配环境、项目、账号标识、租户及资源后投递保存事件。现有 AE 页面没有已验证的公开局部刷新/版本验证入口，所以当前需用户确认草稿后重载匹配页面，显示 **已刷新，待验证**。

不会把点击查询或修改 DOM 冒充“已同步”。精确看板卡片刷新、编辑器与图表版本验证、外部修改轮询仍需针对实际 AE 版本适配。服务重启后任务标为中断，已派发但未确认的写操作需要先核实。此版本没有对真实 AE 业务资源执行测试写入。

## 验证

```sh
npm run typecheck
npm test
npm run build
npm run test:browser
npm run test:server
```

服务集成测试会监听本机临时端口。浏览器测试使用临时配置，不改常用浏览器，可用 `CHROMIUM_PATH` 指定 Chrome for Testing。端到端测试启动真实 Next.js 生产服务，用受控模型响应验证扩展连接、加密密钥、服务端流式工具调用与会话恢复；不需要真实模型 API Key。

## 结构

```text
apps/server/                  Next.js 线上服务、首页、网页工作区、RPC、SSE
apps/extension/               Chrome Side Panel、设置、HTTPS 连接、页面同步
packages/execution-service/   服务器 CLI/MCP/模型传输、安装与隔离存储
packages/agent-runtime/       OpenAI Agents SDK 编排
packages/contracts/           协议与校验
packages/ae-cli-adapter/       业务命令适配
packages/page-adapters/        AE 页面识别
packages/sync-engine/          资源匹配与同步规则
```

`apps/native-host` 仅保留旧原型的协议入口用于回归测试，不参与默认扩展构建和线上运行。旧版 macOS tar.gz 安装包不再用于本架构。

参考：[Next.js Route Handlers](https://nextjs.org/docs/app/getting-started/route-handlers)、[Next.js standalone 输出](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)、[OpenAI Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk)。
