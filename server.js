const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { internalIpV4 } = require('internal-ip');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 游戏配置 ---
const CARD_TYPES = ['🌟', '🌙', '☀️']; // 星星, 月亮, 太阳
const JOKER = '🤡'; // 小丑 (万能牌，视为真话)
const BULLET_COUNT = 6; // 弹巢容量

// --- 全局状态 ---
let players = []; // { id, name, hand: [], isAlive: true, isHost: boolean, bulletPosition: 1-6, shotsFired: 0 }
let deck = [];
let turnIndex = 0;
let tableReq = ''; // 当前桌面要求的牌 (例如 '🌙')
let lastPlay = null; // { playerId, count, actualCards: [] }
let gameState = 'lobby'; // 'lobby', 'playing', 'roulette', 'gameover'
let rouletteVictim = null; // 当前正在玩轮盘的人
let challengerId = null; // 质疑者ID
let lastDeadPlayer = null; // 最近死亡的玩家ID

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

function resetGame() {
    gameState = 'lobby';
    players.forEach(p => {
        p.hand = [];
        p.isAlive = true;
    });
    turnIndex = 0;
    lastPlay = null;
    tableReq = '';
    rouletteVictim = null;
    challengerId = null;
    lastDeadPlayer = null;

    // 只有在有玩家的情况下才通知
    if (players.length > 0) {
        // 通知所有玩家回到大厅
        io.emit('returnToLobby');
        io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost})));
        sendGameLog('游戏已重置，返回大厅', 'info');
    }
}

function startRound(resetTable = true) {
    const aliveCount = players.filter(p => p.isAlive).length;
    if (aliveCount < 2) {
        const winner = players.find(p => p.isAlive);
        gameState = 'gameover';
        io.emit('gameOver', winner ? winner.name : '无人生还');
        sendGameLog(`游戏结束！获胜者: ${winner ? winner.name : '无人生还'}`, 'win');

        // 5秒后自动重置游戏
        setTimeout(() => {
            resetGame();
        }, 5000);
        return;
    }

    gameState = 'playing';
    lastPlay = null;
    challengerId = null; // 清除质疑者
    lastDeadPlayer = null; // 清除死亡标记
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
    if (players[turnIndex] && !players[turnIndex].isAlive) {
        turnIndex = getNextAlivePlayer(turnIndex);
    }

    updateGame(`新回合！本轮要求打出: ${tableReq}`);
}

function sendGameLog(message, type = 'info') {
    io.emit('gameLog', { message, type });
}

function updateGame(logMsg = "") {
    // 如果没有玩家或者 turnIndex 无效，不发送更新
    if (players.length === 0 || !players[turnIndex]) {
        return;
    }

    const publicData = {
        gameState,
        tableReq,
        lastPlay: lastPlay ? {
            playerName: players.find(p=>p.id===lastPlay.playerId)?.name,
            count: lastPlay.count,
            revealed: lastPlay.revealed || false,
            actualCards: lastPlay.revealed ? lastPlay.actualCards : undefined
        } : null,
        currentPlayerId: players[turnIndex].id,
        rouletteVictim,
        challengerId,
        lastDeadPlayer,
        players: players.map(p => ({
            id: p.id,
            name: p.name,
            cardCount: p.hand ? p.hand.length : 0,
            isAlive: p.isAlive,
            isHost: p.isHost,
            shotsFired: p.shotsFired || 0
        })),
        log: logMsg
    };

    io.emit('stateUpdate', publicData);

    // 发送私有手牌
    players.forEach(p => {
        io.to(p.id).emit('handUpdate', p.hand || []);
    });

    // 发送游戏日志
    if (logMsg) {
        sendGameLog(logMsg, 'info');
    }
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
        const playerName = name || `Player${players.length+1}`;
        players.push({
            id: socket.id,
            name: playerName,
            hand: [],
            isAlive: true,
            isHost: isHost,
            bulletPosition: Math.floor(Math.random() * 6) + 1, // 随机1-6
            shotsFired: 0
        });

        io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost})));
        if(isHost) socket.emit('youAreHost');
        sendGameLog(`${playerName} 加入了游戏`, 'join');
    });

    socket.on('startGame', () => {
        const p = players.find(pl => pl.id === socket.id);
        if (!p || !p.isHost || players.length < 2) return;

        turnIndex = 0;
        startRound(true);
    });

    socket.on('playCards', (indices) => {
        // indices 是客户端发来的手牌索引数组 [0, 2]
        if (gameState !== 'playing') return;
        if (!players[turnIndex] || socket.id !== players[turnIndex].id) return;
        if (!indices || indices.length === 0) return;

        const p = players.find(pl => pl.id === socket.id);
        if (!p) return;

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
        const msg = `${p.name} 打出了 ${playedCards.length} 张牌`;
        sendGameLog(msg, 'play');
        updateGame(msg);
    });

    socket.on('challenge', () => {
        if (gameState !== 'playing' || !lastPlay) return;
        // 简单规则：只有轮到回合的人可以质疑上一手
        if (!players[turnIndex] || socket.id !== players[turnIndex].id) return;

        const challenger = players.find(p => p.id === socket.id);
        const liar = players.find(p => p.id === lastPlay.playerId);
        if (!challenger || !liar) return;

        // 验证谎言
        let isLie = false;
        lastPlay.actualCards.forEach(card => {
            // 如果牌不是要求的类型，并且也不是小丑，那就是撒谎
            if (card !== tableReq && card !== JOKER) {
                isLie = true;
            }
        });

        // 标记牌已被翻开
        lastPlay.revealed = true;

        // 设置质疑者
        challengerId = challenger.id;

        let msg = '';
        let victim;
        if (isLie) {
            msg = `😮 抓到了！${liar.name} 撒谎了！(真实牌: ${lastPlay.actualCards.join(' ')})`;
            rouletteVictim = liar.id;
            victim = liar;
        } else {
            msg = `😓 冤枉！${liar.name} 没撒谎！(真实牌: ${lastPlay.actualCards.join(' ')})`;
            rouletteVictim = challenger.id; // 质疑失败，自己吞子弹
            victim = challenger;
        }

        // 如果受害者之前已经开完6枪，重新装填左轮
        if (victim.shotsFired >= 6) {
            victim.bulletPosition = Math.floor(Math.random() * 6) + 1;
            victim.shotsFired = 0;
        }

        gameState = 'roulette';
        sendGameLog(`${challenger.name} 质疑了 ${liar.name}`, 'challenge');
        sendGameLog(msg, 'challenge');

        // 先发送一次更新显示翻牌动画
        updateGame('质疑中...');

        // 1秒后再显示结果
        setTimeout(() => {
            updateGame(msg);
        }, 1000);
    });

    socket.on('pullTrigger', () => {
        if (gameState !== 'roulette') return;
        if (socket.id !== rouletteVictim) return;

        const victim = players.find(p => p.id === rouletteVictim);

        // 开枪次数+1
        victim.shotsFired++;
        const shotsRemaining = 7 - victim.shotsFired; // 剩余子弹数（包括当前这枪）

        sendGameLog(`${victim.name} 扣动了扳机... (剩余${shotsRemaining}发)`, 'roulette');

        io.emit('sound', 'spin'); // 播放音效指令

        setTimeout(() => {
            // 真实左轮机制：检查当前位置是否是子弹位置
            const dead = victim.shotsFired === victim.bulletPosition;

            if (dead) {
                victim.isAlive = false;
                lastDeadPlayer = victim.id; // 记录最近死亡的玩家
                io.emit('sound', 'bang');
                const msg = `💥 砰！${victim.name} 倒下了... (第${victim.shotsFired}枪命中！)`;
                sendGameLog(msg, 'roulette');
                updateGame(msg);

                // 重置受害者的左轮状态
                victim.bulletPosition = Math.floor(Math.random() * 6) + 1;
                victim.shotsFired = 0;

                // 3秒后清除死亡标记并开始新回合
                setTimeout(() => {
                    lastDeadPlayer = null;
                    startRound(true);
                }, 3000);
            } else {
                io.emit('sound', 'click');
                const msg = `😅 咔哒... 空枪！${victim.name} 活下来了！(已开${victim.shotsFired}枪，剩余${6 - victim.shotsFired}发)`;
                sendGameLog(msg, 'roulette');
                updateGame(msg);
                // 活下来，游戏继续，重置牌局
                setTimeout(() => {
                    challengerId = null; // 清除质疑者标记
                    startRound(true);
                }, 2000);
            }
        }, 1000);
    });

    socket.on('triggerAd', () => {
        const player = players.find(p => p.id === socket.id);
        // 只有房主可以触发广告
        if (!player || !player.isHost) return;

        sendGameLog(`${player.name} 触发了广告，所有人即将跳转...`, 'info');
        // 通知所有玩家跳转到百度
        io.emit('adRedirect', 'https://www.baidu.com');
    });

    socket.on('disconnect', () => {
        const player = players.find(p => p.id === socket.id);
        if (player) {
            sendGameLog(`${player.name} 离开了游戏`, 'leave');
        }

        players = players.filter(p => p.id !== socket.id);
        if (players.length > 0 && !players.some(p => p.isHost)) {
            players[0].isHost = true; // 移交房主
            io.to(players[0].id).emit('youAreHost');
        }
        if (gameState === 'lobby') {
            io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost})));
        } else if (players.length < 2 && players.length > 0) {
            // 还有玩家但人数不足，结束游戏并返回大厅
            gameState = 'gameover';
            io.emit('gameOver', '玩家断开，人数不足');
            sendGameLog('玩家断开，人数不足，游戏结束', 'leave');

            // 3秒后自动重置游戏
            setTimeout(() => {
                resetGame();
            }, 3000);
        } else if (players.length === 0) {
            // 所有玩家都离开了，直接重置游戏状态
            resetGame();
        }
    });
});

const PORT = 3002;

server.listen(PORT, '0.0.0.0', async () => {
    const localIP = await internalIpV4() || 'localhost';
    console.log(`\n🎮 游戏服务器已启动！\n`);
    console.log(`本地访问:   http://localhost:${PORT}`);
    console.log(`局域网访问: http://${localIP}:${PORT}`);
    console.log(`\n其他设备可通过局域网地址加入游戏\n`);
});