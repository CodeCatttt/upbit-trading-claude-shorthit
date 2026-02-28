module.exports = {
    apps: [{
        name: 'upbit-trading-bot',
        script: 'src/bot.js',
        cwd: '/home/kook/programming/upbit-trading-claude',
        max_restarts: 5,
        restart_delay: 10000,
        env: {
            NODE_ENV: 'production',
        },
    }],
};
