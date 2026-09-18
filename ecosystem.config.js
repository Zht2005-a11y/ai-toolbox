// PM2 进程管理配置
// 用法：pm2 start ecosystem.config.js
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
