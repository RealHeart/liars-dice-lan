const socket = io();
let myHand = [];
let selectedIndices = [];
let amIHost = false;
let isGameStarted = false;
let currentTableCards = []; // 当前桌面上的牌（用于跟踪）
let lastPlayId = null; // 跟踪上一次出牌，避免重复动画
let previousDeadPlayer = null; // 跟踪上次死亡的玩家
let triggerCountdown = null; // 开枪倒计时定时器

// 卡片类型到图片路径的映射
const CARD_IMAGES = {
    '🌟': 'assets/手牌星星2k.bmp',
    '🌙': 'assets/手牌月亮2k.bmp',
    '☀️': 'assets/手牌太阳2k.bmp',
    '🤡': 'assets/手牌万能2k.bmp'
};

// 根据卡片类型获取图片路径
function getCardImage(card) {
    return CARD_IMAGES[card] || '';
}

// 显示牌飞入桌面动画
function animateCardsToTable(count) {
    const tableArea = document.getElementById('table-cards-area');
    tableArea.innerHTML = ''; // 清空之前的牌
    currentTableCards = [];

    // 一张一张飞入
    for (let i = 0; i < count; i++) {
        setTimeout(() => {
            const cardDiv = document.createElement('div');
            cardDiv.className = 'table-card card-back flying-in';
            tableArea.appendChild(cardDiv);
            currentTableCards.push(cardDiv);

            // 动画结束后移除飞入类
            setTimeout(() => {
                cardDiv.classList.remove('flying-in');
            }, 500);
        }, i * 200); // 每张牌间隔200ms
    }
}

// 翻开桌面的牌
function flipTableCards(actualCards) {
    if (!actualCards || actualCards.length === 0) return;

    // 如果牌还没有飞入完成，等待一下
    const waitTime = currentTableCards.length === actualCards.length ? 0 : 1000;

    setTimeout(() => {
        currentTableCards.forEach((cardDiv, index) => {
            setTimeout(() => {
                // 添加翻牌动画
                cardDiv.classList.add('flipping');

                // 翻牌动画中间时切换内容
                setTimeout(() => {
                    cardDiv.classList.remove('card-back');
                    cardDiv.className = 'table-card card flipping';

                    // 显示真实牌面
                    if (actualCards[index]) {
                        const img = document.createElement('img');
                        img.src = getCardImage(actualCards[index]);
                        img.alt = actualCards[index];
                        cardDiv.innerHTML = '';
                        cardDiv.appendChild(img);
                    }
                }, 300); // 翻到一半时切换内容

                // 动画结束后移除翻牌类
                setTimeout(() => {
                    cardDiv.classList.remove('flipping');
                }, 600);
            }, index * 150); // 每张牌间隔150ms翻开
        });
    }, waitTime);
}

// 显示死亡消息
function showDeathMessage(playerName) {
    const deathMsg = document.getElementById('death-message');
    const deathPlayerName = document.getElementById('death-player-name');

    deathPlayerName.innerText = playerName + ' ';
    deathMsg.style.display = 'flex';

    // 3秒后隐藏
    setTimeout(() => {
        deathMsg.style.display = 'none';
    }, 2500);
}

// 日志功能
function toggleGameLog() {
    const panel = document.getElementById('game-log-panel');
    panel.classList.toggle('minimized');
}

function addGameLog(message, type = 'info') {
    const logContent = document.getElementById('game-log-content');
    if (!logContent) return;

    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;

    const time = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    entry.innerHTML = `<span class="log-time">${time}</span>${message}`;

    logContent.appendChild(entry);

    // 自动滚动到底部
    logContent.scrollTop = logContent.scrollHeight;

    // 限制日志条目数量（最多保留100条）
    while (logContent.children.length > 100) {
        logContent.removeChild(logContent.firstChild);
    }
}

// --- 登录逻辑 ---
function joinGame() {
    const name = document.getElementById('username').value;
    if (name) {
        socket.emit('join', name);
        document.querySelector('.login-box').style.display = 'none';
        document.getElementById('waiting-area').style.display = 'block';
    }
}

function startGame() {
    socket.emit('startGame');
}

socket.on('youAreHost', () => {
    amIHost = true;
    document.getElementById('start-btn').style.display = 'block';
    // 如果游戏已经开始，显示广告按钮
    if (isGameStarted) {
        document.getElementById('ad-btn').style.display = 'block';
    }
});

socket.on('lobbyUpdate', (players) => {
    const list = document.getElementById('player-list');
    list.innerHTML = players.map(p => `<li>${p.name} ${p.isHost ? '(房主)' : ''}</li>`).join('');
});

socket.on('gameLog', (data) => {
    addGameLog(data.message, data.type || 'info');
});

socket.on('returnToLobby', () => {
    // 返回大厅
    isGameStarted = false;
    document.body.classList.remove('my-turn'); // 移除轮到我的提示
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('game-over-screen').style.display = 'none';
    document.getElementById('lobby-screen').style.display = 'flex';
    document.getElementById('waiting-area').style.display = 'block';
    document.querySelector('.login-box').style.display = 'none';
    document.getElementById('ad-btn').style.display = 'none';
});

// --- 游戏循环 ---
socket.on('stateUpdate', (state) => {
    if (state.gameState === 'lobby') return;
    if (state.gameState === 'gameover') return; // 单独处理

    // 检测玩家死亡
    if (state.lastDeadPlayer && state.lastDeadPlayer !== previousDeadPlayer) {
        const deadPlayer = state.players.find(p => p.id === state.lastDeadPlayer);
        if (deadPlayer) {
            showDeathMessage(deadPlayer.name);
        }
        previousDeadPlayer = state.lastDeadPlayer;
    } else if (!state.lastDeadPlayer) {
        previousDeadPlayer = null;
    }

    // 切换界面
    isGameStarted = true;
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'flex';

    // 如果是房主，显示广告按钮
    if (amIHost) {
        document.getElementById('ad-btn').style.display = 'block';
    }

    // 更新基本信息 - 使用图片显示当前要求
    const reqDisplay = document.getElementById('req-card-display');
    reqDisplay.innerHTML = ''; // 清空内容
    if (state.tableReq) {
        const reqCard = document.createElement('span');
        reqCard.className = 'req-card';
        const img = document.createElement('img');
        img.src = getCardImage(state.tableReq);
        img.alt = state.tableReq;
        reqCard.appendChild(img);
        reqDisplay.appendChild(reqCard);
    }
    document.getElementById('game-log').innerText = state.log;

    // 更新中间出牌信息
    const lastInfo = document.getElementById('last-play-info');
    if (state.lastPlay) {
        lastInfo.style.opacity = 1;
        document.getElementById('last-player-name').innerText = state.lastPlay.playerName;
        document.getElementById('last-card-count').innerText = state.lastPlay.count;

        // 生成唯一ID来跟踪出牌
        const currentPlayId = `${state.lastPlay.playerName}_${state.lastPlay.count}_${state.lastPlay.revealed}`;

        // 如果有新的出牌，显示牌飞入桌面
        if (state.lastPlay.count > 0 && !state.lastPlay.revealed && lastPlayId !== currentPlayId) {
            animateCardsToTable(state.lastPlay.count);
            lastPlayId = currentPlayId;
        }

        // 如果牌已被翻开（质疑后）
        if (state.lastPlay.revealed && state.lastPlay.actualCards) {
            const revealedId = `${currentPlayId}_revealed`;
            if (lastPlayId !== revealedId) {
                flipTableCards(state.lastPlay.actualCards);
                lastPlayId = revealedId;
            }
        }
    } else {
        lastInfo.style.opacity = 0;
        // 清空桌面牌
        document.getElementById('table-cards-area').innerHTML = '';
        currentTableCards = [];
        lastPlayId = null;
    }

    // 渲染对手
    const oppDiv = document.getElementById('opponents-container');
    oppDiv.innerHTML = '';
    state.players.forEach(p => {
        if (p.id === socket.id) return;
        const div = document.createElement('div');
        div.className = `opponent ${p.id === state.currentPlayerId ? 'active' : ''} ${!p.isAlive ? 'dead' : ''}`;

        // 如果这个玩家是轮盘赌受害者，显示枪图标
        const gunIcon = (state.gameState === 'roulette' && state.rouletteVictim === p.id)
            ? '<span class="gun-icon"><img src="assets/gun-pistol-revolver-.svg" alt="枪"></span>'
            : '';

        // 表情图标（左上角）
        let emotionIcon = '';

        // 优先级：刚死亡 > 质疑者 > 被质疑者
        if (state.lastDeadPlayer === p.id) {
            // 刚死亡的玩家显示爆炸
            emotionIcon = '<span class="emotion-icon explode"><img src="assets/爆炸.svg" alt="爆炸"></span>';
        } else if (state.challengerId === p.id) {
            // 质疑者显示愤怒
            emotionIcon = '<span class="emotion-icon angry"><img src="assets/愤怒.svg" alt="愤怒"></span>';
        } else if (state.lastPlay && state.lastPlay.revealed && state.rouletteVictim === p.id) {
            // 被质疑者显示质疑表情（在轮盘赌阶段且牌已翻开）
            emotionIcon = '<span class="emotion-icon questioned"><img src="assets/质疑.svg" alt="质疑"></span>';
        }

        // 如果玩家已死亡（但不是刚死亡），显示幽灵图标
        const ghostIcon = (!p.isAlive && state.lastDeadPlayer !== p.id)
            ? '<span class="ghost-icon"><img src="assets/幽灵.svg" alt="幽灵"></span>'
            : '';

        // 如果这个玩家是轮盘赌受害者，显示子弹指示
        let bulletInfo = '';
        if (state.gameState === 'roulette' && state.rouletteVictim === p.id) {
            const shotsFired = p.shotsFired || 0;
            const remaining = 6 - shotsFired;

            // 创建子弹视觉指示
            let bullets = '';
            for (let i = 0; i < shotsFired; i++) {
                bullets += '💀';
            }
            for (let i = 0; i < remaining; i++) {
                bullets += '🔘';
            }

            bulletInfo = `<div class="opponent-bullets">${bullets}</div>`;
        }

        div.innerHTML = `${emotionIcon}<div>${p.name}${gunIcon}</div><div>🃏 ${p.cardCount}</div>${bulletInfo}${ghostIcon}`;
        oppDiv.appendChild(div);
    });

    // 按钮状态控制
    const isMyTurn = state.currentPlayerId === socket.id;
    const playBtn = document.getElementById('btn-play');
    const challBtn = document.getElementById('btn-challenge');

    // 轮到我时的视觉提示
    if (isMyTurn && state.gameState === 'playing') {
        document.body.classList.add('my-turn');
    } else {
        document.body.classList.remove('my-turn');
    }

    // 只有轮到我且游戏状态为playing时，可以出牌
    playBtn.disabled = !(isMyTurn && state.gameState === 'playing');

    // 只有轮到我，且上一手有人出牌时，可以质疑
    if (isMyTurn && state.lastPlay && state.gameState === 'playing') {
        challBtn.style.display = 'inline-block';
    } else {
        challBtn.style.display = 'none';
    }

    // 处理轮盘赌
    const triggerContainer = document.getElementById('trigger-container');
    const bulletDisplay = document.getElementById('bullet-display');

    if (state.gameState === 'roulette') {
        const isVictim = state.rouletteVictim === socket.id;
        const victimPlayer = state.players.find(p => p.id === state.rouletteVictim);

        // 如果是我，显示扣动扳机按钮和子弹指示
        if (isVictim) {
            triggerContainer.style.display = 'inline-block';

            // 启动10秒倒计时
            startTriggerCountdown();

            // 显示子弹指示器
            if (bulletDisplay && victimPlayer) {
                const shotsFired = victimPlayer.shotsFired || 0;
                const remaining = 6 - shotsFired;

                // 创建子弹视觉指示：已发射的用💀，剩余的用🔘
                let bullets = '';
                for (let i = 0; i < shotsFired; i++) {
                    bullets += '💀';
                }
                for (let i = 0; i < remaining; i++) {
                    bullets += '🔘';
                }

                bulletDisplay.innerHTML = `<div class="bullet-indicator">${bullets} (剩余${remaining}发)</div>`;
                bulletDisplay.style.display = 'block';
            }
        } else {
            triggerContainer.style.display = 'none';
            if (bulletDisplay) bulletDisplay.style.display = 'none';
            clearTriggerCountdown(); // 清除倒计时
        }
    } else {
        triggerContainer.style.display = 'none';
        if (bulletDisplay) bulletDisplay.style.display = 'none';
        clearTriggerCountdown(); // 清除倒计时
    }
});

socket.on('handUpdate', (cards) => {
    myHand = cards;
    renderHand();
});

socket.on('gameOver', (winner) => {
    document.body.classList.remove('my-turn'); // 移除轮到我的提示
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('game-over-screen').style.display = 'flex';
    document.getElementById('winner-name').innerText = `获胜者: ${winner}`;
});

socket.on('sound', (type) => {
    // 这里可以加音效逻辑，暂留空
    console.log("Sound effect:", type);
});

socket.on('err', (msg) => alert(msg));

// --- 交互逻辑 ---

function renderHand() {
    const div = document.getElementById('my-hand');
    div.innerHTML = '';
    selectedIndices = []; //由于手牌刷新，重置选择

    myHand.forEach((card, index) => {
        const el = document.createElement('div');
        el.className = 'card';

        // 使用图片而不是emoji
        const img = document.createElement('img');
        img.src = getCardImage(card);
        img.alt = card;
        el.appendChild(img);

        el.onclick = () => {
            // 切换选中状态
            if (selectedIndices.includes(index)) {
                selectedIndices = selectedIndices.filter(i => i !== index);
                el.classList.remove('selected');
            } else {
                selectedIndices.push(index);
                el.classList.add('selected');
            }
        };
        div.appendChild(el);
    });
}

function submitPlay() {
    if (selectedIndices.length === 0) {
        alert("请至少选择一张牌！");
        return;
    }
    socket.emit('playCards', selectedIndices);
}

function submitChallenge() {
    if(confirm("确定要质疑他撒谎吗？如果他说的是真话，你就要对自己开枪！")) {
        socket.emit('challenge');
    }
}

function pullTrigger() {
    // 清除倒计时
    clearTriggerCountdown();
    socket.emit('pullTrigger');
}

// 清除开枪倒计时
function clearTriggerCountdown() {
    if (triggerCountdown) {
        clearTimeout(triggerCountdown);
        triggerCountdown = null;
    }

    // 移除进度条动画
    const progressCircle = document.getElementById('progress-circle');
    if (progressCircle) {
        progressCircle.classList.remove('countdown');
        // 强制重置动画
        void progressCircle.offsetWidth;
    }
}

// 启动开枪倒计时
function startTriggerCountdown() {
    clearTriggerCountdown();

    const progressCircle = document.getElementById('progress-circle');
    if (progressCircle) {
        // 重新添加动画类
        progressCircle.classList.add('countdown');
    }

    // 10秒后自动开枪
    triggerCountdown = setTimeout(() => {
        pullTrigger();
    }, 10000);
}

// 触发广告
function triggerAd() {
    if (amIHost) {
        socket.emit('triggerAd');
    }
}

// 监听广告跳转
socket.on('adRedirect', (url) => {
    window.location.href = url;
});