module.exports = {
    apps: [{
        name: 'upbit-trading-bot',
        script: 'src/core/bot.js',
        cwd: '/home/kook/programming/upbit-trading-claude',
        max_restarts: 5,
        restart_delay: 10000,
        env: {
            NODE_ENV: 'production',
        },
    }, {
        name: 'batch-scheduler',
        script: 'src/batch/batch-scheduler.js',
        cwd: '/home/kook/programming/upbit-trading-claude',
        max_restarts: 3,
        restart_delay: 60000,
        env: {
            NODE_ENV: 'production',
        },
    }],
};
