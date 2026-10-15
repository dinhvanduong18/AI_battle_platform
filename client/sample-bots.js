/* ═══════════════════════════════════════════════════════════
   sample-bots.js — Pre-built Reference Bots for Local Arena
   - template: Basic Starter Bot
   - random: Random Bot choosing any valid move
   - greedy: Greedy AI prioritizing captures and goal advances
   - minimax: 1-ply / 2-ply Minimax evaluation
   ═══════════════════════════════════════════════════════════ */

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.SampleBots = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {

    const SampleBots = {
        template: `/**
 * Bot Template — Điền chiến thuật của bạn vào đây
 * @param {number} myPlayerId - 1 (Xanh) hoặc 2 (Đỏ)
 * @param {object} gameState - { board, validMoves, myPieces, opponentPieces, turn, stepCount }
 * @returns {{ fromRow: number, fromCol: number, toRow: number, toCol: number }}
 */
function getNextMove(myPlayerId, gameState) {
    var validMoves = gameState.validMoves;
    if (!validMoves || validMoves.length === 0) {
        return null;
    }

    // Chọn nước đi đầu tiên làm mặc định
    var move = validMoves[0];
    return {
        fromRow: move.fromRow,
        fromCol: move.fromCol,
        toRow: move.toRow,
        toCol: move.toCol
    };
}`,

        random: `/**
 * Random Bot — Chọn ngẫu nhiên 1 nước đi hợp lệ
 */
function getNextMove(myPlayerId, gameState) {
    var validMoves = gameState.validMoves;
    if (!validMoves || validMoves.length === 0) return null;

    var index = Math.floor(Math.random() * validMoves.length);
    var chosen = validMoves[index];

    return {
        fromRow: chosen.fromRow,
        fromCol: chosen.fromCol,
        toRow: chosen.toRow,
        toCol: chosen.toCol
    };
}`,

        greedy: `/**
 * Greedy AI — Ưu tiên ăn quân đối phương và tiến gần ô chiến thắng
 */
function getNextMove(myPlayerId, gameState) {
    var validMoves = gameState.validMoves;
    if (!validMoves || validMoves.length === 0) return null;

    var targetRow = (myPlayerId === 1) ? 0 : 8;
    var targetCol = (myPlayerId === 1) ? 0 : 8;

    var bestScore = -Infinity;
    var bestMove = validMoves[0];

    for (var i = 0; i < validMoves.length; i++) {
        var m = validMoves[i];
        var score = 0;

        // 1. Thưởng điểm rất cao nếu đây là nước ăn quân
        if (m.isCapture) {
            score += 100;
        }

        // 2. Thưởng điểm nếu tiến gần ô chiến thắng của đối phương
        var currentDist = Math.abs(m.fromRow - targetRow) + Math.abs(m.fromCol - targetCol);
        var nextDist = Math.abs(m.toRow - targetRow) + Math.abs(m.toCol - targetCol);
        if (nextDist < currentDist) {
            score += 20;
        }

        // 3. Ưu tiên đi vào ô trung tâm để kiểm soát bàn cờ
        var centerDist = Math.abs(m.toRow - 4) + Math.abs(m.toCol - 4);
        score += (8 - centerDist) * 2;

        if (score > bestScore) {
            bestScore = score;
            bestMove = m;
        }
    }

    return {
        fromRow: bestMove.fromRow,
        fromCol: bestMove.fromCol,
        toRow: bestMove.toRow,
        toCol: bestMove.toCol
    };
}`,

        minimax: `/**
 * Minimax AI — Đánh giá 1-ply có tính phản công và an toàn quân
 */
function getNextMove(myPlayerId, gameState) {
    var validMoves = gameState.validMoves;
    if (!validMoves || validMoves.length === 0) return null;

    var targetGoal = (myPlayerId === 1) ? { r: 0, c: 0 } : { r: 8, c: 8 };

    // Bảng giá trị cơ bản
    var bestScore = -99999;
    var bestMove = validMoves[0];

    for (var i = 0; i < validMoves.length; i++) {
        var m = validMoves[i];
        var score = 0;

        // Đi vào ô thắng trận lập tức
        if (m.toRow === targetGoal.r && m.toCol === targetGoal.c) {
            return { fromRow: m.fromRow, fromCol: m.fromCol, toRow: m.toRow, toCol: m.toCol };
        }

        // Ăn quân
        if (m.isCapture) {
            score += 150;
        }

        // Đánh giá khoảng cách mục tiêu
        var distToGoal = Math.abs(m.toRow - targetGoal.r) + Math.abs(m.toCol - targetGoal.c);
        score += (16 - distToGoal) * 10;

        // Tránh bị bắt lại bởi quân kề cạnh (Heuristic an toàn)
        var opponents = gameState.opponentPieces || [];
        for (var j = 0; j < opponents.length; j++) {
            var opp = opponents[j];
            var oppDist = Math.abs(opp.row - m.toRow) + Math.abs(opp.col - m.toCol);
            if (oppDist === 1) {
                // Kiểm tra quan hệ Oẳn tù tì
                var myType = m.pieceType;
                var oppType = opp.type;
                var beats = (myType === 1 && oppType === 2) ||
                            (myType === 2 && oppType === 3) ||
                            (myType === 3 && oppType === 1);
                var loses = (myType === 2 && oppType === 1) ||
                            (myType === 3 && oppType === 2) ||
                            (myType === 1 && oppType === 3);

                if (beats) score += 30;
                if (loses) score -= 80;
            }
        }

        if (score > bestScore) {
            bestScore = score;
            bestMove = m;
        }
    }

    return {
        fromRow: bestMove.fromRow,
        fromCol: bestMove.fromCol,
        toRow: bestMove.toRow,
        toCol: bestMove.toCol
    };
}`
    };

    return SampleBots;
});
