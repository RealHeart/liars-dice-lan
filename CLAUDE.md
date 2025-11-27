# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个基于 Node.js + Socket.IO 的局域网多人在线卡牌游戏，游戏规则类似"骗子酒馆"（Liar's Bar）。玩家轮流出牌，可以撒谎，其他玩家可以质疑或发起"王的审判"。质疑错误或被抓包的玩家需要玩俄罗斯轮盘赌（模拟左轮手枪）。

### 技术栈
- **后端**: Node.js + Express + Socket.IO
- **前端**: 原生 HTML/CSS/JavaScript + Socket.IO Client
- **通信**: WebSocket (Socket.IO)
- **端口**: 3002，监听所有网络接口 (0.0.0.0)

## 常用命令

### 安装依赖
```bash
pnpm install
```

### 启动服务器
```bash
pnpm start
# 或
node server.js
```

服务器启动后，局域网内其他设备可通过 `http://<服务器IP>:3002` 访问游戏。

### 测试多玩家
由于是局域网游戏，需要：
1. 启动服务器
2. 在浏览器打开多个标签页访问 `http://localhost:3002`，或从不同设备访问

### 查看服务器日志
服务器使用 `console.log` 输出连接和事件日志，直接查看终端输出即可。

## 核心架构

### 文件结构
```
.
├── server.js           # 后端主文件（Socket.IO 服务器 + 游戏逻辑）
├── public/             # 前端静态资源
│   ├── index.html      # 游戏 UI
│   ├── script.js       # 客户端逻辑 + Socket.IO 事件处理
│   ├── style.css       # 样式
│   └── assets/         # 卡牌图片资源（.bmp 格式）
└── package.json
```

### 游戏状态机 (server.js)

游戏有 4 种状态 (`gameState`):
- `lobby`: 大厅，等待玩家加入
- `playing`: 游戏进行中，玩家轮流出牌
- `roulette`: 俄罗斯轮盘赌阶段（质疑后的惩罚）
- `gameover`: 游戏结束

### 核心数据结构

#### 玩家对象 (server.js:18)
```javascript
{
  id: socket.id,         // Socket.IO 连接 ID
  name: string,          // 玩家昵称
  hand: [],              // 手牌数组（如 ['🌟', '🌙', ...]）
  isAlive: boolean,      // 是否存活
  isHost: boolean,       // 是否房主（第一个加入的玩家）
  bulletPosition: 1-6,   // 左轮手枪中子弹的位置（1-6）
  shotsFired: 0          // 已经扣动扳机的次数
}
```

#### 卡牌系统 (server.js:13-14)
- 3 种普通牌: 🌟（星星）、🌙（月亮）、☀️（太阳）
- 1 种万能牌: 🤡（小丑/鬼牌，视为真话）
- 牌堆构成: 每种普通牌 6 张 + 鬼牌 2 张 = 共 20 张
- 每回合每人发 5 张手牌

#### 左轮机制 (server.js:293-296, 370-426)
- 每个玩家有独立的 6 发左轮手枪
- `bulletPosition`: 随机 1-6，表示子弹在第几发
- `shotsFired`: 累计扣动次数，当 `shotsFired === bulletPosition` 时中弹死亡
- 开完 6 枪后自动重新装填（重新随机子弹位置，重置计数）

### Socket.IO 事件流

#### 客户端 → 服务器
| 事件 | 参数 | 触发时机 | 处理逻辑位置 |
|------|------|----------|--------------|
| `join` | `name` | 玩家加入游戏 | server.js:192 |
| `startGame` | - | 房主开始游戏 | server.js:214 |
| `playCards` | `indices[]` | 玩家出牌（手牌索引数组） | server.js:222 |
| `challenge` | - | 质疑上一手牌 | server.js:256 |
| `kingJudgment` | - | 发起王的审判（任何活着的玩家都可发起） | server.js:311 |
| `pullTrigger` | - | 扣动扳机（轮盘赌阶段） | server.js:370 |
| `triggerAd` | - | 房主触发广告（测试用） | server.js:429 |

#### 服务器 → 客户端
| 事件 | 数据 | 说明 |
|------|------|------|
| `lobbyUpdate` | `players[]` | 更新大厅玩家列表 |
| `youAreHost` | - | 通知该客户端成为房主 |
| `stateUpdate` | `publicData` | 游戏状态更新（公共信息） |
| `handUpdate` | `hand[]` | 私有手牌更新（仅发给特定玩家） |
| `gameLog` | `{message, type}` | 游戏日志消息 |
| `gameOver` | `winnerName` | 游戏结束 |
| `sound` | `'spin'|'bang'|'click'` | 播放音效指令 |
| `adRedirect` | `url` | 跳转广告（测试用） |
| `returnToLobby` | - | 通知所有玩家返回大厅 |
| `err` | `message` | 错误消息 |

### 核心游戏逻辑

#### 回合流程 (server.js:76-120)
1. `startRound()` 被调用（游戏开始或上一回合结束后）
2. 洗牌并给每个存活玩家发 5 张手牌
3. 随机指定本轮要求的牌型（🌟/🌙/☀️）
4. 玩家轮流出牌，声称出了 N 张要求的牌
5. 下一个玩家选择：跟牌、质疑 (`challenge`) 或王的审判 (`kingJudgment`)

#### 质疑机制 (server.js:256-309)
- **普通质疑**: 只有轮到回合的玩家可以质疑上一手
- **验证逻辑**: 检查上一手牌中是否有非要求牌型且非小丑的牌
- **结果**:
  - 质疑成功 → 出牌者玩轮盘赌（扣动 1 次扳机）
  - 质疑失败 → 质疑者玩轮盘赌（扣动 1 次扳机）

#### 王的审判 (server.js:311-368)
- **特点**: 任何活着的玩家都可发起（不限于轮到自己）
- **惩罚加重**: 失败方需扣动 **2 次** 扳机（`requiredShots = 2`）
- **使用场景**: 确信对方撒谎且愿意承担更高风险

#### 轮盘赌机制 (server.js:370-427)
- 受害者必须扣动扳机 `requiredShots` 次（普通质疑 1 次，王的审判 2 次）
- 每次扣动 `shotsFired++`，检查是否 `shotsFired === bulletPosition`
- 中弹死亡 → 标记 `isAlive = false`，3 秒后开始新回合
- 幸存 → 2 秒后开始新回合（牌局重新洗牌）
- 开完 6 枪自动重新装填

### 前端架构 (public/script.js)

#### 动画系统
- **出牌动画** (`animateCardsToTable`): 牌从手牌区飞入桌面中央
- **翻牌动画** (`flipTableCards`): 质疑/审判后翻开桌面的牌
- **死亡动画** (`showDeathMessage`): 全屏显示死亡消息 + 音效
- **审判动画** (`showJudgmentMessage`): 显示"王的审判"特效

#### UI 状态管理
- 手牌选择：点击卡牌切换选中状态（边框高亮）
- 按钮显示逻辑：根据 `gameState` 和 `currentPlayerId` 动态显示/隐藏操作按钮
- 轮盘赌倒计时：3 秒自动开枪机制（可手动取消）

#### 卡牌图片
- 使用 `.webp` 格式图片（位于 `public/assets/`）
- 映射关系定义在 `script.js:13-18`
- 图片经过优化，从 BMP 格式转换为 WebP，大小减少约 90%

## 开发注意事项

### 修改游戏规则
- **回合判定**: 修改 `getNextAlivePlayer()` (server.js:41)
- **发牌逻辑**: 修改 `startRound()` (server.js:76)
- **质疑验证**: 修改 server.js:266-272 的谎言判定逻辑
- **左轮机制**: 修改 server.js:370-426 的轮盘赌逻辑

### 添加新卡牌类型
1. 在 `server.js:13` 的 `CARD_TYPES` 数组中添加新图案
2. 在 `server.js:31-39` 的 `createDeck()` 中调整牌堆构成
3. 在 `public/script.js:13-18` 的 `CARD_IMAGES` 中添加对应图片路径
4. 在 `public/assets/` 中添加对应的卡牌图片

### 调整游戏参数
- **手牌数量**: `startRound()` 中的循环次数 (server.js:103)
- **弹巢容量**: `BULLET_COUNT` 常量 (server.js:15) 和相关逻辑
- **最少玩家数**: `startGame` 事件中的人数检查 (server.js:216)
- **自动重置延迟**: `setTimeout` 调用中的延迟时间 (server.js:85, 459)

### 调试技巧
- **服务器端**: 使用 `sendGameLog()` 发送调试信息到客户端日志
- **客户端**: 浏览器控制台会显示 Socket.IO 事件和错误
- **状态检查**: 在浏览器控制台执行 `socket.emit('stateUpdate')` 手动触发状态更新

### 常见问题

**问题: 玩家断线后游戏卡住**
- 处理逻辑: server.js:439-466，断线时自动移交房主，人数不足时重置游戏

**问题: 轮盘赌后不开始新回合**
- 检查 `startRound()` 是否被正确调用（server.js:404, 422）

**问题: 卡牌图片不显示**
- 检查图片路径是否正确（相对于 `public/` 目录）
- 确认图片文件存在于 `public/assets/`

**问题: 质疑逻辑错误**
- 检查小丑牌判定逻辑 (server.js:268)：小丑视为万能牌，不算撒谎

## 扩展建议

### 可能的功能扩展
- 添加聊天系统（利用 Socket.IO 事件）
- 增加游戏记录/历史统计
- 支持自定义规则（手牌数、子弹数等）
- 添加 AI 玩家（简单策略）
- 实现房间系统（支持多个独立游戏房间）

### 性能优化
- 大量玩家时考虑优化 `players` 数组的遍历
- 前端动画可考虑使用 CSS transitions 替代 JavaScript 动画
- 图片资源已优化为 WebP 格式，大幅减小体积

### 安全性
- 当前版本为局域网游戏，未做身份验证
- 如需公网部署，需添加：
  - 玩家身份验证
  - 房间密码/权限系统
  - 防作弊机制（手牌加密、服务器验证等）
