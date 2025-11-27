const socket = io();
let myHand = [];
let selectedIndices = [];
let amIHost = false;

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
});

socket.on('lobbyUpdate', (players) => {
    const list = document.getElementById('player-list');
    list.innerHTML = players.map(p => `<li>${p.name} ${p.isHost ? '(房主)' : ''}</li>`).join('');
});

// --- 游戏循环 ---
socket.on('stateUpdate', (state) => {
    if (state.gameState === 'lobby') return;
    if (state.gameState === 'gameover') return; // 单独处理

    // 切换界面
    document.getElementById('lobby-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'flex';
    document.getElementById('roulette-modal').style.display = 'none';

    // 更新基本信息
    document.getElementById('req-card-display').innerText = state.tableReq;
    document.getElementById('game-log').innerText = state.log;

    // 更新中间出牌信息
    const lastInfo = document.getElementById('last-play-info');
    if (state.lastPlay) {
        lastInfo.style.opacity = 1;
        document.getElementById('last-player-name').innerText = state.lastPlay.playerName;
        document.getElementById('last-card-count').innerText = state.lastPlay.count;
    } else {
        lastInfo.style.opacity = 0;
    }

    // 渲染对手
    const oppDiv = document.getElementById('opponents-container');
    oppDiv.innerHTML = '';
    state.players.forEach(p => {
        if (p.id === socket.id) return;
        const div = document.createElement('div');
        div.className = `opponent ${p.id === state.currentPlayerId ? 'active' : ''} ${!p.isAlive ? 'dead' : ''}`;
        div.innerHTML = `<div>${p.name}</div><div>🃏 ${p.cardCount}</div>`;
        oppDiv.appendChild(div);
    });

    // 按钮状态控制
    const isMyTurn = state.currentPlayerId === socket.id;
    const playBtn = document.getElementById('btn-play');
    const challBtn = document.getElementById('btn-challenge');

    // 只有轮到我且游戏状态为playing时，可以出牌
    playBtn.disabled = !(isMyTurn && state.gameState === 'playing');

    // 只有轮到我，且上一手有人出牌时，可以质疑
    if (isMyTurn && state.lastPlay && state.gameState === 'playing') {
        challBtn.style.display = 'inline-block';
    } else {
        challBtn.style.display = 'none';
    }

    // 处理轮盘赌
    if (state.gameState === 'roulette') {
        document.getElementById('roulette-modal').style.display = 'flex';
        const isVictim = state.rouletteVictim === socket.id;
        document.getElementById('roulette-msg').innerText = isVictim ? "😱 轮到你了！拿起枪..." : "🍿 围观中...";
        document.getElementById('trigger-btn').style.display = isVictim ? 'inline-block' : 'none';
    }
});

socket.on('handUpdate', (cards) => {
    myHand = cards;
    renderHand();
});

socket.on('gameOver', (winner) => {
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
        el.innerText = card;
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
    socket.emit('pullTrigger');
}