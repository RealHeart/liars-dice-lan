const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');
const { internalIpV4 } = require('internal-ip');
const AIPlayer = require('./ai-player');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- 游戏配置 ---
const CARD_TYPES = ['🌟', '🌙', '☀️']; // 星星, 月亮, 太阳
const JOKER = '🤡'; // 小丑 (万能牌，视为真话)
const BULLET_COUNT = 6; // 弹巢容量

// --- 全局状态 ---
let players = []; // { id, name, hand: [], isAlive: true, isHost: boolean, bulletPosition: 1-6, shotsFired: 0, isAI: false, ai: AIPlayer|null }
let deck = [];
let turnIndex = 0;
let tableReq = ''; // 当前桌面要求的牌 (例如 '🌙')
let lastPlay = null; // { playerId, count, actualCards: [] }
let gameState = 'lobby'; // 'lobby', 'playing', 'roulette', 'gameover'
let rouletteVictim = null; // 当前正在玩轮盘的人
let challengerId = null; // 质疑者ID
let lastDeadPlayer = null; // 最近死亡的玩家ID
let requiredShots = 1; // 需要扣动扳机的次数（王的审判时为2）
let currentShot = 0; // 当前已经扣动的次数

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
    requiredShots = 1;
    currentShot = 0;

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
    requiredShots = 1;
    currentShot = 0;
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
    // 如果没有玩家，不发送更新
    if (players.length === 0) {
        return;
    }

    // 在轮盘赌状态下，currentPlayerId 应该是 rouletteVictim
    // 在普通游戏状态下，currentPlayerId 是 players[turnIndex].id
    let currentPlayerId;
    if (gameState === 'roulette' && rouletteVictim) {
        currentPlayerId = rouletteVictim;
    } else if (players[turnIndex]) {
        currentPlayerId = players[turnIndex].id;
    } else {
        // 如果 turnIndex 无效，使用第一个活着的玩家
        const firstAlive = players.find(p => p.isAlive);
        currentPlayerId = firstAlive ? firstAlive.id : (players[0] ? players[0].id : null);
    }

    if (!currentPlayerId) {
        return; // 没有有效的玩家ID，不发送更新
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
        currentPlayerId: currentPlayerId,
        rouletteVictim,
        challengerId,
        lastDeadPlayer,
        requiredShots,
        currentShot,
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

    // 触发 AI 自动操作
    triggerAIAction();
}

// --- AI 自动操作 ---
function triggerAIAction() {
    if (gameState === 'playing') {
        // 检查当前回合是否是 AI 玩家
        const currentPlayer = players[turnIndex];
        if (currentPlayer && currentPlayer.isAI && currentPlayer.isAlive) {
            // AI 玩家出牌
            setTimeout(() => {
                executeAIPlayCards(currentPlayer);
            }, currentPlayer.ai.getActionDelay());
        }
    } else if (gameState === 'roulette') {
        // 检查是否是 AI 需要扣扳机
        const victim = players.find(p => p.id === rouletteVictim);
        if (victim && victim.isAI && victim.isAlive) {
            setTimeout(() => {
                executeAIPullTrigger(victim);
            }, victim.ai.getActionDelay());
        }
    }
}

function executeAIPlayCards(aiPlayer) {
    if (gameState !== 'playing' || !players[turnIndex] || players[turnIndex].id !== aiPlayer.id) {
        return; // 状态已改变，取消操作
    }

    // 先检查是否要质疑上一手牌
    if (lastPlay && lastPlay.playerId !== aiPlayer.id) {
        // 决定是否质疑
        const shouldChallenge = aiPlayer.ai.shouldChallenge(lastPlay, aiPlayer.hand, tableReq);
        const shouldJudgment = aiPlayer.ai.shouldKingJudgment(lastPlay, aiPlayer.hand, tableReq);

        if (shouldJudgment) {
            // 发起王的审判
            executeAIKingJudgment(aiPlayer);
            return;
        } else if (shouldChallenge) {
            // 普通质疑
            executeAIChallenge(aiPlayer);
            return;
        }
    }

    // 决定出哪些牌
    const indices = aiPlayer.ai.decideCardsToPlay(aiPlayer.hand, tableReq);

    if (!indices || indices.length === 0) return;

    // 获取实际牌面
    let playedCards = [];
    indices.sort((a, b) => b - a);

    indices.forEach(idx => {
        if (aiPlayer.hand[idx]) {
            playedCards.push(aiPlayer.hand[idx]);
            aiPlayer.hand.splice(idx, 1);
        }
    });

    lastPlay = {
        playerId: aiPlayer.id,
        count: playedCards.length,
        actualCards: playedCards
    };

    turnIndex = getNextAlivePlayer(turnIndex);
    const msg = `${aiPlayer.name} 打出了 ${playedCards.length} 张牌`;
    sendGameLog(msg, 'play');
    updateGame(msg);
}

function executeAIChallenge(aiPlayer) {
    if (gameState !== 'playing' || !lastPlay) return;

    const liar = players.find(p => p.id === lastPlay.playerId);
    if (!liar) return;

    // 验证谎言
    let isLie = false;
    lastPlay.actualCards.forEach(card => {
        if (card !== tableReq && card !== JOKER) {
            isLie = true;
        }
    });

    lastPlay.revealed = true;
    challengerId = aiPlayer.id;

    let msg = '';
    let victim;
    if (isLie) {
        msg = `😮 抓到了！${liar.name} 撒谎了！(真实牌: ${lastPlay.actualCards.join(' ')})`;
        rouletteVictim = liar.id;
        victim = liar;
    } else {
        msg = `😓 冤枉！${liar.name} 没撒谎！(真实牌: ${lastPlay.actualCards.join(' ')})`;
        rouletteVictim = aiPlayer.id;
        victim = aiPlayer;
    }

    if (victim.shotsFired >= 6) {
        victim.bulletPosition = Math.floor(Math.random() * 6) + 1;
        victim.shotsFired = 0;
    }

    gameState = 'roulette';
    sendGameLog(`${aiPlayer.name} 质疑了 ${liar.name}`, 'challenge');
    sendGameLog(msg, 'challenge');

    updateGame('质疑中...');
    setTimeout(() => {
        updateGame(msg);
    }, 1000);
}

function executeAIKingJudgment(aiPlayer) {
    if (gameState !== 'playing' || !lastPlay) return;

    const accused = players.find(p => p.id === lastPlay.playerId);
    if (!accused) return;

    // 验证谎言
    let isLie = false;
    lastPlay.actualCards.forEach(card => {
        if (card !== tableReq && card !== JOKER) {
            isLie = true;
        }
    });

    lastPlay.revealed = true;
    challengerId = aiPlayer.id;

    let msg = '';
    let victim;
    if (isLie) {
        msg = `⚔️ 审判成功！${accused.name} 撒谎了！(真实牌: ${lastPlay.actualCards.join(' ')}) 需扣动2次扳机！`;
        rouletteVictim = accused.id;
        victim = accused;
    } else {
        msg = `⚔️ 审判失败！${accused.name} 没撒谎！(真实牌: ${lastPlay.actualCards.join(' ')}) ${aiPlayer.name} 需扣动2次扳机！`;
        rouletteVictim = aiPlayer.id;
        victim = aiPlayer;
    }

    if (victim.shotsFired >= 6) {
        victim.bulletPosition = Math.floor(Math.random() * 6) + 1;
        victim.shotsFired = 0;
    }

    requiredShots = 2;
    currentShot = 0;

    gameState = 'roulette';
    sendGameLog(`👑 ${aiPlayer.name} 发起了王的审判，审判 ${accused.name}！`, 'challenge');
    sendGameLog(msg, 'challenge');

    updateGame('王的审判中...');
    setTimeout(() => {
        updateGame(msg);
    }, 1000);
}

function executeAIPullTrigger(aiPlayer) {
    if (gameState !== 'roulette' || aiPlayer.id !== rouletteVictim) return;

    aiPlayer.shotsFired++;
    currentShot++;
    const shotsRemaining = 7 - aiPlayer.shotsFired;

    sendGameLog(`${aiPlayer.name} 扣动了扳机... (第${currentShot}/${requiredShots}次，剩余${shotsRemaining}发)`, 'roulette');
    io.emit('sound', 'spin');

    setTimeout(() => {
        const dead = aiPlayer.shotsFired === aiPlayer.bulletPosition;

        if (dead) {
            aiPlayer.isAlive = false;
            lastDeadPlayer = aiPlayer.id;
            io.emit('sound', 'bang');
            const msg = `💥 砰！${aiPlayer.name} 倒下了... (第${aiPlayer.shotsFired}枪命中！)`;
            sendGameLog(msg, 'roulette');
            updateGame(msg);

            aiPlayer.bulletPosition = Math.floor(Math.random() * 6) + 1;
            aiPlayer.shotsFired = 0;

            setTimeout(() => {
                lastDeadPlayer = null;
                startRound(true);
            }, 3000);
        } else {
            io.emit('sound', 'click');

            if (currentShot < requiredShots) {
                const msg = `😅 咔哒... 空枪！${aiPlayer.name} 还需要再扣动 ${requiredShots - currentShot} 次扳机！`;
                sendGameLog(msg, 'roulette');
                updateGame(msg);
            } else {
                const msg = `😅 咔哒... 空枪！${aiPlayer.name} 活下来了！(已开${aiPlayer.shotsFired}枪，剩余${6 - aiPlayer.shotsFired}发)`;
                sendGameLog(msg, 'roulette');
                updateGame(msg);
                setTimeout(() => {
                    challengerId = null;
                    startRound(true);
                }, 2000);
            }
        }
    }, 1000);
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
            shotsFired: 0,
            isAI: false,
            ai: null
        });

        io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost, isAI: p.isAI})));
        if(isHost) socket.emit('youAreHost');
        sendGameLog(`${playerName} 加入了游戏`, 'join');
    });

    socket.on('addAI', (difficulty) => {
        const player = players.find(p => p.id === socket.id);
        // 只有房主可以添加 AI
        if (!player || !player.isHost || gameState !== 'lobby') return;

        // 限制最多 7 个玩家（包括 AI）
        if (players.length >= 7) {
            socket.emit('err', '玩家数量已达上限（7人）');
            return;
        }

        const validDifficulty = ['easy', 'medium', 'hard'].includes(difficulty) ? difficulty : 'medium';
        const ai = new AIPlayer(validDifficulty);
        const aiId = `ai_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        players.push({
            id: aiId,
            name: ai.name,
            hand: [],
            isAlive: true,
            isHost: false,
            bulletPosition: Math.floor(Math.random() * 6) + 1,
            shotsFired: 0,
            isAI: true,
            ai: ai
        });

        io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost, isAI: p.isAI})));
        sendGameLog(`${ai.name} (${validDifficulty}) 加入了游戏`, 'join');
    });

    socket.on('removeAI', () => {
        const player = players.find(p => p.id === socket.id);
        // 只有房主可以移除 AI
        if (!player || !player.isHost || gameState !== 'lobby') return;

        // 找到最后一个 AI 玩家并移除
        for (let i = players.length - 1; i >= 0; i--) {
            if (players[i].isAI) {
                const aiName = players[i].name;
                players.splice(i, 1);
                io.emit('lobbyUpdate', players.map(p => ({name: p.name, isHost: p.isHost, isAI: p.isAI})));
                sendGameLog(`${aiName} 离开了游戏`, 'leave');
                break;
            }
        }
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

    socket.on('kingJudgment', () => {
        if (gameState !== 'playing' || !lastPlay) return;

        // 王的审判：任何人都可以发起（不限于轮到自己）
        const judge = players.find(p => p.id === socket.id);
        const accused = players.find(p => p.id === lastPlay.playerId);
        if (!judge || !accused) return;
        if (!judge.isAlive) return; // 死了的人不能发起审判

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

        // 设置质疑者（发起审判的人）
        challengerId = judge.id;

        let msg = '';
        let victim;
        if (isLie) {
            msg = `⚔️ 审判成功！${accused.name} 撒谎了！(真实牌: ${lastPlay.actualCards.join(' ')}) 需扣动2次扳机！`;
            rouletteVictim = accused.id;
            victim = accused;
        } else {
            msg = `⚔️ 审判失败！${accused.name} 没撒谎！(真实牌: ${lastPlay.actualCards.join(' ')}) ${judge.name} 需扣动2次扳机！`;
            rouletteVictim = judge.id; // 审判失败，自己扣动2次扳机
            victim = judge;
        }

        // 如果受害者之前已经开完6枪，重新装填左轮
        if (victim.shotsFired >= 6) {
            victim.bulletPosition = Math.floor(Math.random() * 6) + 1;
            victim.shotsFired = 0;
        }

        // 设置需要扣动2次扳机
        requiredShots = 2;
        currentShot = 0;

        gameState = 'roulette';
        sendGameLog(`👑 ${judge.name} 发起了王的审判，审判 ${accused.name}！`, 'challenge');
        sendGameLog(msg, 'challenge');

        // 先发送一次更新显示翻牌动画
        updateGame('王的审判中...');

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
        currentShot++; // 增加当前已扣动次数
        const shotsRemaining = 7 - victim.shotsFired; // 剩余子弹数（包括当前这枪）

        sendGameLog(`${victim.name} 扣动了扳机... (第${currentShot}/${requiredShots}次，剩余${shotsRemaining}发)`, 'roulette');

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

                // 检查是否还需要继续扣动扳机
                if (currentShot < requiredShots) {
                    const msg = `😅 咔哒... 空枪！${victim.name} 还需要再扣动 ${requiredShots - currentShot} 次扳机！`;
                    sendGameLog(msg, 'roulette');
                    updateGame(msg);
                    // 继续轮盘赌，不重置牌局
                } else {
                    const msg = `😅 咔哒... 空枪！${victim.name} 活下来了！(已开${victim.shotsFired}枪，剩余${6 - victim.shotsFired}发)`;
                    sendGameLog(msg, 'roulette');
                    updateGame(msg);
                    // 活下来，游戏继续，重置牌局
                    setTimeout(() => {
                        challengerId = null; // 清除质疑者标记
                        startRound(true);
                    }, 2000);
                }
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