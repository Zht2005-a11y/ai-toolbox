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
│   └── wiki.js            # LLM Wiki 引擎（Ingest / Query / Lint）
├── index.html             # 首页
├── login.html             # 登录 / 注册
├── rag.html               # 知识库问答
├── report.html            # 周报生成器
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
