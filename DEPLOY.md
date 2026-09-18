# 服务器部署指南（Linux + IP 访问）

以下命令在你的 **Linux 服务器**上执行。

## 0. 前提

- 服务器已装 Node.js（建议 v18+，推荐 v20/22）
- 项目已推到远程 git 仓库（GitHub/Gitee 等）

检查 Node 是否已装：

```bash
node -v
npm -v
```

如果没装，用 nvm 或系统包管理器安装 Node 20+。

---

## 1. 拉取代码

```bash
cd /opt
git clone <你的仓库地址> ai-toolbox
cd ai-toolbox
```

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

# 启动
pm2 start ecosystem.config.js

# 开机自启
pm2 save
pm2 startup   # 按提示执行它输出的那行命令
```

查看状态：`pm2 status`　查看日志：`pm2 logs ai-toolbox`

---

## 5. 访问

浏览器打开：`http://你的服务器IP:3000`

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
- **改代码后更新**：
  ```bash
  cd /opt/ai-toolbox
  git pull
  pm2 restart ai-toolbox
  ```
