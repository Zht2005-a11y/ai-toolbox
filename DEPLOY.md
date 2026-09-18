# 服务器部署指南（Linux + IP 访问）

以下命令在你的 **Linux 服务器**上执行。

## 0. 前提

- 项目已推到远程 git 仓库（GitHub/Gitee 等）
- 服务器需要 Node.js **18 以上**（推荐 20 LTS）

检查是否已装：

```bash
node -v
npm -v
```

⚠️ **不要直接 `sudo apt install nodejs`** —— Ubuntu 自带的版本往往太旧（22.04 是 v12，跑不了本项目）。用 NodeSource 装 20 LTS：

**Ubuntu / Debian：**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**CentOS / RHEL / 阿里云 Linux：**

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
```

装完再 `node -v` 确认版本 ≥ 18。

---

## 1. 拉取代码

```bash
cd ~
git clone <你的仓库地址> ai-toolbox
cd ai-toolbox
```

> 克隆到**家目录**（`~/ai-toolbox`）不需要 sudo，也不用 chown 过户，最省事。
> 若想放 `/opt`：`sudo git clone <地址> /opt/ai-toolbox`，之后**必须**执行
> `sudo chown -R $USER:$USER /opt/ai-toolbox` 过户，否则下一步建 `.env` 会报 Permission denied。

---

## 2. 创建 .env（关键，只做一次）

`.env` 不会随 git 上传（已 gitignore），需要手动创建：

```bash
cat > .env << 'EOF'
AGNES_API_KEY=sk-你的AgnesKey
AGNES_BASE_URL=https://apihub.agnes-ai.com/v1
AGNES_MODEL=agnes-3.0-flash
PORT=3000
EOF
```

> ⚠️ 把 `sk-你的AgnesKey` 换成你的真实 Key。如果你的 Key 是国内站注册的，把 BASE_URL 改成 `https://api.agnes-ai.cn/v1`。

---

## 3. 安装依赖

```bash
npm install --production
```

---

## 4. 用 PM2 常驻运行（推荐）

```bash
# 安装 pm2
npm install -g pm2

# 启动（注意后缀是 .cjs —— package.json 里 type=module，.js 会被当 ESM 而报错）
pm2 start ecosystem.config.cjs

# 保存进程列表 + 设置开机自启
pm2 save
pm2 startup   # 按提示执行它输出的那行 sudo 命令
```

> 不想用配置文件也行，一条命令等效：`pm2 start server.js --name ai-toolbox`

常用命令：

```bash
pm2 status                # 查看状态（要看到 online）
pm2 logs ai-toolbox       # 看实时日志
pm2 restart ai-toolbox    # 重启
pm2 stop ai-toolbox       # 停止
```

---

## 5. 访问

浏览器打开：`http://你的服务器IP:3000`

首次访问需要**注册一个账号**（邮箱 + 密码，邮箱不用真能收信，只是作为账号标识）。

---

## 5.5 数据存储与备份（重要）

所有用户数据都在项目的 `data/` 目录，服务启动时会自动创建：

```
data/
├── db.json            # 账号、会话、文档元数据
├── content/           # 上传的文档原文（切分后）
└── wiki/<userId>/     # 每个用户独立的知识库
    ├── index.md       #   总目录
    ├── log.md         #   操作日志
    └── pages/*.md     #   词条
```

**备份**：打包 `data/` 即为完整备份

```bash
tar -czf ai-toolbox-backup-$(date +%F).tar.gz ~/ai-toolbox/data
```

**迁移到新服务器**：把 `data/` 一起拷过去即可，账号和知识库都保留。

> `data/` 已加入 `.gitignore`，不会进 git 仓库 —— 账号密码哈希和用户文档不应该放到公开仓库里。

---

## 5.6 环境变量（可选调优）

除上面必填的几项外，还可以在 `.env` 里加：

| 变量 | 作用 | 默认 |
|------|------|------|
| `UPSTREAM_RETRY` | 上游请求重试次数 | `3` |
| `LLM_MIN_INTERVAL_MS` | 编译任务最小调用间隔（防限流） | `3200` |
| `MAX_DOC_CHARS` | 单篇文档最大字符数 | `1500000` |
| `WIKI_MAX_UPDATES` | 每次编译最多更新的词条数 | `6` |

改完 `.env` 需要重启：`pm2 restart ai-toolbox`

---

## 6.（可选）用 Nginx 反代 + 去掉端口号

如果想让访问更干净（`http://IP` 而非 `http://IP:3000`）：

```bash
# 装 nginx
sudo apt install nginx -y   # 或 yum install nginx -y

# 写配置
sudo tee /etc/nginx/conf.d/ai-toolbox.conf > /dev/null << 'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Connection "";

        # 流式 SSE 支持（重要）
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF

# 测试并重载
sudo nginx -t
sudo systemctl reload nginx
```

之后访问 `http://你的服务器IP` 即可。

---

## 常见问题

- **端口不通**：检查云服务器安全组/防火墙是否放行 3000（或 80）端口。
  ```bash
  # 临时放行（firewalld）
  sudo firewall-cmd --add-port=3000/tcp --permanent && sudo firewall-cmd --reload
  ```

- **上传文档后一直显示「编译中」**：这是正常的。编译要把原文交给模型提炼成词条，
  一份普通文档大约需要 **1~2 分钟**（免费档调用有节流）。编译期间可以直接提问，
  系统会降级为「直接读原文回答」。

- **编译失败**：看日志找原因
  ```bash
  pm2 logs ai-toolbox --err --lines 50
  ```
  常见原因是 Key 无效（401）或网络抖动（已自动重试 3 次）。修复后在页面上点文档重新编译即可。

- **用户忘记密码**：目前没有找回功能（没接邮件服务）。直接删掉 `data/db.json` 里对应用户即可重新注册：
  ```bash
  # 先停服务，编辑后再启动
  pm2 stop ai-toolbox
  nano ~/ai-toolbox/data/db.json
  pm2 start ai-toolbox
  ```

- **改代码后更新**：
  ```bash
  cd ~/ai-toolbox
  git pull
  pm2 restart ai-toolbox
  ```
  > 只有 `server.js` / `lib/` / `.env` 改动才需要重启；HTML 等静态文件 `git pull` 后刷新即生效。

---

## 架构速览（便于排查）

```
浏览器 ──HTTP──▶ Node/Express
                  ├─ /api/auth/*     账号（scrypt 哈希 + HttpOnly Cookie 会话）
                  ├─ /api/docs/*     文档管理（存 data/content/）
                  ├─ /api/wiki/*     知识库读取
                  ├─ /api/rag/ask    问答（SSE 流式）
                  └─ /api/chat       通用 AI 代理（周报用）
                        │
                        ▼
                  Agnes API（Key 只在服务端）
                        │
                  lib/wiki.js 编译队列（串行 + 节流）
```
