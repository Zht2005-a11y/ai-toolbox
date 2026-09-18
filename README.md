# AI 工具箱

一个自托管的 AI 网页应用，包含两个实用工具：

- **知识库问答（RAG）**：上传 PDF/TXT/Markdown，针对文档内容提问，AI 基于资料回答并标注引用来源。
- **AI 周报生成器**：输入流水账，AI 生成结构化周报，支持多种风格。

## 技术栈

- 前端：纯 HTML + CSS + JavaScript（无构建步骤）
- 后端：Node.js + Express（AI 代理 + 静态托管）
- AI 模型：`agnes-3.0-flash`（Agnes AI，当前免费）

## 目录结构

```
AIprogram/
├── server.js          # 后端：AI 代理 + 静态托管
├── package.json       # 依赖声明（仅 express）
├── index.html         # 首页
├── rag.html           # 知识库问答
├── report.html        # 周报生成器
├── .env               # 环境变量（含 API Key，不要提交）
├── .env.example       # 环境变量模板
└── .gitignore
```

## 本地运行

```bash
# 1. 安装依赖
npm install

# 2. 配置 .env（复制 .env.example 改名为 .env，填入你的 Agnes API Key）

# 3. 启动
npm start
```

启动后访问 http://localhost:3000

## 部署到服务器

1. 把整个目录上传到服务器（注意 `.env` 要一起带上，且不要提交到 git）
2. 服务器上 `npm install && npm start`
3. 建议用 `pm2` 或 `systemd` 让服务常驻：
   ```bash
   npm install -g pm2
   pm2 start server.js --name ai-toolbox
   pm2 save
   ```
4. 用 Nginx 反向代理到 3000 端口（可选，配置 HTTPS）

## 环境变量说明

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AGNES_API_KEY` | Agnes AI 的 API Key（必填） | 无 |
| `AGNES_BASE_URL` | Agnes API 地址 | `https://apihub.agnes-ai.com/v1` |
| `AGNES_MODEL` | 模型名 | `agnes-3.0-flash` |
| `PORT` | 服务端口 | `3000` |

## 注意事项

- **API Key 安全**：Key 只存在服务器端 `.env`，前端通过 `/api/chat` 代理调用，不暴露 Key。
- **域名说明**：Agnes 国际站（`apihub.agnes-ai.com`）和国内站（`api.agnes-ai.cn`）账号体系独立，Key 不互通。如果你的 Key 是在国内站注册的，需要把 `AGNES_BASE_URL` 改成 `https://api.agnes-ai.cn/v1`。
- **免费额度**：`agnes-3.0-flash` 当前免费（约 20 RPM 限制），正式定价以 Agnes 官方为准。
