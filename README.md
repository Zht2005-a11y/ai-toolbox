# AI 工具箱

一个自托管的 AI 网页应用，包含两个工具：

- **知识库问答**：上传 PDF/TXT/Markdown → 自动编译成结构化知识库（词条 + 双向链接）→ 基于你的资料回答并标注引用词条。
- **AI 周报生成器**：输入流水账，AI 生成结构化周报，支持多种风格。

## 核心设计：为什么不用向量数据库

本项目采用 **LLM Wiki**（Karpathy 提出的编译式知识库模式）而非传统向量 RAG，原因是：

1. **Agnes 没有 embedding 模型**（实测 `/v1/embeddings` 返回 `model_not_found`），向量检索走不通。
2. **aganes-3.0-flash 有 512K 上下文**，长上下文让"检索"这件事本身的价值下降。
3. **编译式方案的知识密度更高**：原文一次编译成精炼词条，查询时读词条而非重新读原文。

工作方式：

```
上传文档
   ↓ 解析 → 切分 → 保存（raw 层，只读）
   ↓ 【异步编译】LLM 提炼成结构化词条 + 更新 index.md + 追加 log.md
知识库（词条 + 双向链接 + 总目录）
   ↓ 【查询】LLM 读 index.md 定位相关词条 → 读词条全文 → 回答
回答（标注引用的词条）
```

关键点：
- **无 embedding、无向量库**，只用 chat 模型 + 文件系统。
- **上传立即返回**，编译在后台队列串行执行，前端轮询状态。
- **查询是语义定位**（LLM 读懂目录后判断该看哪些词条），不是关键字匹配。

## 技术栈

- 前端：纯 HTML + CSS + JavaScript（无构建步骤）
- 后端：Node.js + Express（零额外依赖：无数据库、无向量库、无 ORM）
- 存储：本地文件（JSON + Markdown），密码用 Node 内置 scrypt 哈希
- AI 模型：`agnes-3.0-flash`（Agnes AI，当前免费）

## 目录结构

```
AIprogram/
├── server.js              # 入口：路由 + 静态托管
├── lib/
│   ├── llm.js             # LLM 调用（重试 + 编译节流）
│   ├── auth.js            # 密码哈希 + 会话 + 认证中间件
│   ├── store.js           # 文件持久化（原子写）
│   ├── chunk.js           # 文本切分
│   ├── wiki.js            # LLM Wiki 引擎（Ingest / Query / Lint）
│   └── mailer.js          # 发信（忘记密码用，零依赖 fetch）
├── index.html             # 首页
├── login.html             # 登录 / 注册
├── reset.html             # 忘记密码 / 重置密码
├── rag.html               # 知识库问答
├── report.html            # 周报生成器
├── tests/                 # 测试（Node 内置 node:test）
│   ├── unit/              #   单元层：auth / store / chunk / mailer
│   └── api/               #   接口层：起真实服务跑 HTTP 断言
├── data/                  # 运行时数据（自动创建，已 gitignore）
│   ├── db.json            #   账号、会话、文档元数据
│   ├── content/           #   文档原文（切分后）
│   └── wiki/<userId>/     #   每个用户独立的知识库
│       ├── index.md       #     总目录（查询时的导航入口）
│       ├── log.md         #     操作日志（追加式）
│       └── pages/*.md     #     词条
├── .env                   # 环境变量（含 API Key，不要提交）
├── .env.example           # 环境变量模板
└── .gitignore
```

## 账号与密码重置

- 注册 / 登录：邮箱 + 密码，密码用 Node 内置 scrypt 加盐哈希，会话写在 HttpOnly Cookie（30 天）。
- 忘记密码：登录页点「忘记密码？」→ 输入邮箱 → 收到 6 位验证码（或邮件里的重置链接）→ 设置新密码。
  验证码 15 分钟有效、一次性；重置成功后所有旧会话会被踢掉，需要重新登录。
- **邮件未配置时**的重置流程仍然可用：验证码会打印到服务端日志，并直接显示在页面上（页面会提示"未配置邮件"）。
  线上环境请在 `.env` 里配好 `MAIL_API_URL` / `MAIL_API_KEY` / `MAIL_FROM`，回显会自动关闭。
- 申请验证码接口做了 IP 限流（每分钟 5 次、每小时 20 次），且无论邮箱是否注册都返回成功，避免被用来探测注册用户。

## 测试

用 Node 内置测试运行器（`node:test`），保持零额外依赖。

```bash
npm test            # 全部
npm run test:unit   # 只跑单元测试
npm run test:api    # 只跑接口测试
```

分两层：

- `tests/unit/` 单元层：`auth`（密码哈希与校验、输入校验、Cookie）、`store`（用户/会话/重置记录/文档/wiki 文件/原子写）、`chunk`（文本切分）、`mailer`（发信成功、上游失败、未配置时降级）
- `tests/api/` 接口层：spawn 一个真实服务进程跑 HTTP 断言 —— 登录守卫（未登录 `/rag.html` 必须 302）、注册登录、文档 CRUD、知识库、忘记密码全流程、限流、敏感文件拦截

三条硬约定（写测试时别破）：

- 测试用 `DATA_DIR` 把数据目录指到临时目录，**绝不碰真实的 `data/`**
- 接口测试把 `AGNES_API_KEY` 置空、`AGNES_BASE_URL` 指向不可达地址，**绝不真的调模型**（不花钱、不依赖网络）
- 新增接口要同步补接口测试；改 `lib/` 下的纯逻辑要同步补单元测试

CI：`.github/workflows/test.yml`，push / PR 时在 Node 20 与 22 上自动跑 `npm test`。

## 本地运行

```bash
npm install
# 配置 .env（复制 .env.example，填入 Agnes API Key）
npm start
```

访问 http://localhost:3000

## 部署到服务器

```bash
# 1. 拉代码
git clone <仓库地址> ~/ai-toolbox && cd ~/ai-toolbox

# 2. 创建 .env（Key 不进 git，必须手动建一次）
cat > .env << 'EOF'
AGNES_API_KEY=sk-你的Key
AGNES_BASE_URL=https://apihub.agnes-ai.com/v1
AGNES_MODEL=agnes-3.0-flash
PORT=3000
EOF

# 3. 装依赖并常驻
npm install --production
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

详见 `DEPLOY.md`。

## 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AGNES_API_KEY` | Agnes API Key（必填） | 无 |
| `AGNES_BASE_URL` | Agnes API 地址 | `https://apihub.agnes-ai.com/v1` |
| `AGNES_MODEL` | 模型名 | `agnes-3.0-flash` |
| `PORT` | 服务端口 | `3000` |
| `UPSTREAM_RETRY` | 上游请求重试次数 | `3` |
| `LLM_TIMEOUT_MS` | 单次请求超时 | `180000` |
| `LLM_MIN_INTERVAL_MS` | 编译任务最小调用间隔（限流保护） | `3200` |
| `MAX_DOC_CHARS` | 单篇文档最大字符数 | `1500000` |
| `WIKI_MAX_SINGLE` | 单次送入模型的文本上限 | `60000` |
| `WIKI_MAX_EXISTING` | 已有词条全量送入的上限 | `60000` |
| `WIKI_MAX_UPDATES` | 每次编译最多更新的词条数 | `6` |

## 注意事项

- **API Key 安全**：Key 只在服务器端 `.env`，前端通过后端代理调用，不暴露。
- **国内站 vs 国际站**：Agnes 的 `apihub.agnes-ai.com`（国际站）与 `api.agnes-ai.cn`（国内站）账号体系独立，Key 不互通。
- **免费额度**：`agnes-3.0-flash` 当前免费（约 20 RPM）。编译每份文档会消耗 2~3 次调用，密集上传时队列会自动节流。
- **数据备份**：所有用户数据都在 `data/` 目录，直接打包即为完整备份。
