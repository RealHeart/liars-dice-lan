const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 游戏配置 ---
const CARD_TYPES = ['🌟', '🌙', '☀️']; // 星星, 月亮, 太阳
const JOKER = '🤡'; // 小丑 (万能牌，视为真话)
const BULLET_COUNT = 6; // 弹巢容量

// --- 全局状态 ---
let players = []; // { id, name, hand: [], isAlive: true, isHost: boolean }
let deck = [];
let turnIndex = 0;
let tableReq = ''; // 当前桌面要求的牌 (例如 '🌙')
let lastPlay = null; // { playerId, count, actualCards: [] }
let gameState = 'lobby'; // 'lobby', 'playing', 'roulette', 'gameover'
let rouletteVictim = null; // 当前正在玩轮盘的人

// --- 辅助函数 ---
function createDeck() {
    let d = [];
    // 每种图案 6 张，鬼牌 2 张 (共20张)
    CARD_TYPES.forEach(type => {
        for(let i=0; i<6; i++) d.push(type);
    });
    for(let i=0; i<2; i++) d.push(JOKER);
    return d.sort(() => Math.random() - 0.5);
}

function getNextAlivePlayer(startIndex) {
    let idx = startIndex;
    let attempts = 0;
    const count = players.length;
    do {
        idx = (idx + 1) % count;
        attempts++;
    } while (!players[idx].isAlive && attempts <= count);
    return idx;
}

function startRound(resetTable = true) {
    const aliveCount = players.filter(p => p.isAlive).length;
    if (aliveCount < 2) {
        const winner = players.find(p => p.isAlive);
        gameState = 'gameover';
        io.emit('gameOver', winner ? winner.name : '无人生还');
        return;
    }

    gameState = 'playing';
    lastPlay = null;
    deck = createDeck();

    // 发牌 (每人5张)
    players.forEach(p => {
        if (p.isAlive) {
            p.hand = [];
            for(let i=0; i<5; i++) {
                if(deck.length) p.hand.push(deck.pop());
            }
        }
    });

    // 随机指定本轮要求
    if (resetTable) {
        tableReq = CARD_TYPES[Math.floor(Math.random() * CARD_TYPES.length)];
    }

    // 确保当前回合的人是活着的
    if (!players[turnIndex].isAlive) {
        turnIndex = getNextAlivePlayer(turnIndex);
    }

    updateGame(`新回合！本轮要求打出: ${tableReq}`);
}

function updateGame(logMsg = "") {
    const publicData = {
        gameState,
        tableReq,
        lastPlay: lastPlay ? {
            playerName: players.find(p=>p.id===lastPlay.playerId)?.name,
            count: lastPlay.count
        } : null,
        currentPlayerId: players[turnIndex].id,
        rouletteVictim,
        players: players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.hand ? p.hand.length : 0,
            isAlive: p.isAlive,
            isHost: p.isHost
        })),
        log: logMsg
    };

    io.emit('stateUpdate', publicData);

    // 发送私有手牌
    players.forEach(p => {
        io.to(p.id).emit('handUpdate', p.hand || []);
    });
}

// --- Socket 事件 ---
io.on('connection', (socket) => {
    console.log('玩家连接:', socket.id);

    socket.on('join', (name) => {
        if (gameState !== 'lobby') {
            socket.emit('err', '游戏进行中，无法加入');
            return;
        }
        const isHost = players.length === 0;
        players.push({
            id: socket.id,
            name: name || `Player${players.length+1}`,
            hand: [],
            isAlive: true,
            isHost: isHost
        });

        io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost})));
        if(isHost) socket.emit('youAreHost');
    });

    socket.on('startGame', () => {
        const p = players.find(pl => pl.id === socket.id);
        if (!p || !p.isHost || players.length < 2) return;

        turnIndex = 0;
        startRound(true);
    });

    socket.on('playCards', (indices) => {
        // indices 是客户端发来的手牌索引数组 [0, 2]
        if (gameState !== 'playing' || socket.id !== players[turnIndex].id) return;
        if (!indices || indices.length === 0) return;

        const p = players.find(pl => pl.id === socket.id);

        // 获取实际牌面
        let playedCards = [];
        // 从大到小排序索引，防止删除时错位
        indices.sort((a, b) => b - a);

        indices.forEach(idx => {
            if (p.hand[idx]) {
                playedCards.push(p.hand[idx]);
                p.hand.splice(idx, 1); // 移除手牌
            }
        });

        lastPlay = {
            playerId: socket.id,
            count: playedCards.length,
            actualCards: playedCards
        };

        // 轮到下一个人
        turnIndex = getNextAlivePlayer(turnIndex);
        updateGame(`${p.name} 打出了 ${playedCards.length} 张牌`);
    });

    socket.on('challenge', () => {
        if (gameState !== 'playing' || !lastPlay) return;
        // 简单规则：只有轮到回合的人可以质疑上一手
        if (socket.id !== players[turnIndex].id) return;

        const challenger = players.find(p => p.id === socket.id);
        const liar = players.find(p => p.id === lastPlay.playerId);

        // 验证谎言
        let isLie = false;
        lastPlay.actualCards.forEach(card => {
            // 如果牌不是要求的类型，并且也不是小丑，那就是撒谎
            if (card !== tableReq && card !== JOKER) {
                isLie = true;
            }
        });

        let msg = '';
        if (isLie) {
            msg = `😮 抓到了！${liar.name} 撒谎了！(真实牌: ${lastPlay.actualCards.join(' ')})`;
            rouletteVictim = liar.id;
        } else {
            msg = `😓 冤枉！${liar.name} 没撒谎！(真实牌: ${lastPlay.actualCards.join(' ')})`;
            rouletteVictim = challenger.id; // 质疑失败，自己吞子弹
        }

        gameState = 'roulette';
        updateGame(msg);
    });

    socket.on('pullTrigger', () => {
        if (gameState !== 'roulette') return;
        if (socket.id !== rouletteVictim) return;

        io.emit('sound', 'spin'); // 播放音效指令

        setTimeout(() => {
            // 1/6 概率触发 (模仿6发左轮)
            const dead = Math.random() < (1/6);
            const victim = players.find(p => p.id === rouletteVictim);

            if (dead) {
                victim.isAlive = false;
                io.emit('sound', 'bang');
                updateGame(`💥 砰！${victim.name} 倒下了...`);

                setTimeout(() => startRound(true), 3000);
            } else {
                io.emit('sound', 'click');
                updateGame(`😅 咔哒... 空枪！${victim.name} 活下来了！`);
                // 活下来，游戏继续，重置牌局
                setTimeout(() => startRound(true), 2000);
            }
        }, 1000);
    });

    socket.on('disconnect', () => {
        players = players.filter(p => p.id !== socket.id);
        if (players.length > 0 && !players.some(p => p.isHost)) {
            players[0].isHost = true; // 移交房主
            io.to(players[0].id).emit('youAreHost');
        }
        if (gameState === 'lobby') {
            io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost})));
        } else if (players.length < 2) {
            gameState = 'gameover';
            io.emit('gameOver', '玩家断开，人数不足');
        }
    });
});

const PORT = 3002;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});