/**
 * AI 玩家决策模块
 * 提供三种难度级别的 AI
 */

const CARD_TYPES = ['🌟', '🌙', '☀️'];
const JOKER = '🤡';

class AIPlayer {
    /**
     * @param {string} difficulty - 'easy' | 'medium' | 'hard'
     */
    constructor(difficulty = 'medium') {
        this.difficulty = difficulty;
        this.name = this.generateName();
    }

    generateName() {
        const prefixes = ['智能', '电脑', 'AI', '机器人'];
        const suffixes = ['小明', '小红', '小刚', '小李', '小王', '阿强', '阿华'];
        const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
        return `${prefix}${suffix}`;
    }

    /**
     * 决定要出哪些牌
     * @param {Array} hand - 手牌数组
     * @param {string} tableReq - 当前要求的牌型
     * @returns {Array} - 要出的牌的索引数组
     */
    decideCardsToPlay(hand, tableReq) {
        // 统计手牌中符合要求的牌（包括小丑）
        const matchingIndices = [];
        const nonMatchingIndices = [];

        hand.forEach((card, idx) => {
            if (card === tableReq || card === JOKER) {
                matchingIndices.push(idx);
            } else {
                nonMatchingIndices.push(idx);
            }
        });

        let indicesToPlay = [];

        switch (this.difficulty) {
            case 'easy':
                // 简单 AI：随机出 1-3 张牌，不管是否符合要求
                const easyCount = Math.floor(Math.random() * 3) + 1;
                indicesToPlay = this.getRandomIndices(hand.length, easyCount);
                break;

            case 'medium':
                // 中等 AI：优先出真牌，不够时掺假牌
                const mediumCount = Math.floor(Math.random() * 2) + 1; // 1-2张
                if (matchingIndices.length >= mediumCount) {
                    // 有足够的真牌
                    indicesToPlay = matchingIndices.slice(0, mediumCount);
                } else {
                    // 真牌不够，掺假牌
                    indicesToPlay = [...matchingIndices];
                    const needed = mediumCount - matchingIndices.length;
                    indicesToPlay.push(...nonMatchingIndices.slice(0, needed));
                }
                break;

            case 'hard':
                // 困难 AI：策略性出牌
                // 如果有 3+ 真牌，出 2-3 张真牌
                // 如果有 1-2 张真牌，出所有真牌
                // 如果没有真牌，出 1 张假牌并赌一把
                if (matchingIndices.length >= 3) {
                    const count = Math.floor(Math.random() * 2) + 2; // 2-3张
                    indicesToPlay = matchingIndices.slice(0, count);
                } else if (matchingIndices.length > 0) {
                    indicesToPlay = [...matchingIndices];
                } else {
                    // 没有真牌，只能撒谎
                    indicesToPlay = [nonMatchingIndices[0]];
                }
                break;

            default:
                indicesToPlay = this.getRandomIndices(hand.length, 1);
        }

        return indicesToPlay;
    }

    /**
     * 决定是否质疑上一手牌
     * @param {Object} lastPlay - 上一手出牌信息 {count, playerId}
     * @param {Array} myHand - 自己的手牌
     * @param {string} tableReq - 当前要求的牌型
     * @returns {boolean} - 是否质疑
     */
    shouldChallenge(lastPlay, myHand, tableReq) {
        if (!lastPlay) return false;

        const count = lastPlay.count;

        switch (this.difficulty) {
            case 'easy':
                // 简单 AI：随机质疑（20% 概率）
                return Math.random() < 0.2;

            case 'medium':
                // 中等 AI：根据出牌数量决定
                // 出 3+ 张牌时，50% 概率质疑
                // 出 1-2 张牌时，20% 概率质疑
                if (count >= 3) {
                    return Math.random() < 0.5;
                } else {
                    return Math.random() < 0.2;
                }

            case 'hard':
                // 困难 AI：根据概率计算
                // 考虑牌堆中符合要求的牌的数量
                // 总共 6 张每种普通牌 + 2 张小丑
                const myMatchingCount = myHand.filter(c => c === tableReq || c === JOKER).length;
                const totalMatching = 8; // 6张指定牌 + 2张小丑
                const remainingMatching = totalMatching - myMatchingCount;

                // 如果对方声称出了比剩余符合牌更多的牌，肯定撒谎
                if (count > remainingMatching) {
                    return true;
                }

                // 根据出牌数量和剩余符合牌数量计算质疑概率
                const challengeProbability = Math.min(0.8, count / remainingMatching);
                return Math.random() < challengeProbability;

            default:
                return Math.random() < 0.3;
        }
    }

    /**
     * 决定是否发起王的审判
     * @param {Object} lastPlay - 上一手出牌信息
     * @param {Array} myHand - 自己的手牌
     * @param {string} tableReq - 当前要求的牌型
     * @returns {boolean} - 是否发起王的审判
     */
    shouldKingJudgment(lastPlay, myHand, tableReq) {
        if (!lastPlay) return false;

        // 只有困难 AI 才会使用王的审判（风险更高）
        if (this.difficulty !== 'hard') return false;

        const count = lastPlay.count;
        const myMatchingCount = myHand.filter(c => c === tableReq || c === JOKER).length;
        const totalMatching = 8;
        const remainingMatching = totalMatching - myMatchingCount;

        // 只有在非常确信对方撒谎时才发起王的审判
        // 条件：出牌数 >= 4 且超过剩余符合牌的 70%
        if (count >= 4 && count > remainingMatching * 0.7) {
            return Math.random() < 0.3; // 30% 概率发起
        }

        return false;
    }

    /**
     * 获取随机索引数组
     * @param {number} max - 最大索引（不包含）
     * @param {number} count - 需要的索引数量
     * @returns {Array} - 索引数组
     */
    getRandomIndices(max, count) {
        const indices = [];
        const available = Array.from({ length: max }, (_, i) => i);

        for (let i = 0; i < Math.min(count, max); i++) {
            const randomIdx = Math.floor(Math.random() * available.length);
            indices.push(available[randomIdx]);
            available.splice(randomIdx, 1);
        }

        return indices;
    }

    /**
     * 获取操作延迟时间（模拟思考时间）
     * @returns {number} - 延迟时间（毫秒）
     */
    getActionDelay() {
        switch (this.difficulty) {
            case 'easy':
                return 1000 + Math.random() * 1000; // 1-2秒
            case 'medium':
                return 1500 + Math.random() * 1500; // 1.5-3秒
            case 'hard':
                return 2000 + Math.random() * 2000; // 2-4秒
            default:
                return 2000;
        }
    }
}

module.exports = AIPlayer;
