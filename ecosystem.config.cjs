// PM2 进程管理配置
//
// ⚠️ 必须用 .cjs 后缀：package.json 里声明了 "type": "module"，
// 若文件名是 .js 会被 Node 当成 ESM，导致 module.exports 报错、pm2 启动失败。
//
// 用法：pm2 start ecosystem.config.cjs

module.exports = {
  apps: [
    {
      name: 'ai-toolbox',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
};
