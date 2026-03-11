module.exports = {
  apps: [
    {
      name: 'airtranslate',
      script: 'app.js',
      cwd: '/www/airtranslate',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1024M',
      env: {
        NODE_ENV: 'production',
        PORT: 9001,
      },
    },
  ],
};