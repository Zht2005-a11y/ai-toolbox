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
  cd ~/ai-toolbox
  git pull
  pm2 restart ai-toolbox
  ```
