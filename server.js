const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: '*' },
    // 不正に大きなペイロードでメモリを食われないようにする
    maxHttpBufferSize: 16 * 1024,
    // 大人数・低速回線でも不必要に切断されにくくする
    pingInterval: 25000,
    pingTimeout: 60000
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).send('ok'));

const rooms = {};
// socket.id -> { rid, userId }  (disconnect時に全部屋を走査しないための索引)
const socketSessions = new Map();

const DISCONNECT_GRACE_MS_PLAYING = 10 * 60 * 1000;
const DISCONNECT_GRACE_MS_WAITING = 30 * 1000;
const MAX_ROOM_SIZE = 10000;
const MAX_ROOMS = 5000;

// room-data のブロードキャスト最小間隔(大人数で提出が殺到しても送信量を抑える)
const ROOM_UPDATE_INTERVAL_MS = 150;

// 1ソケットあたりのイベント数制限
const RATE_LIMIT_WINDOW_MS = 5000;
const RATE_LIMIT_MAX = 40;

class AsyncQueue {
    constructor() {
        this.queues = {};
        this.processing = {};
    }

    enqueue(roomId, operation) {
        if (!roomId) return;

        if (!this.queues[roomId]) {
            this.queues[roomId] = [];
        }

        this.queues[roomId].push(operation);
        this.process(roomId);
    }

    async process(roomId) {
        if (
            this.processing[roomId] ||
            !this.queues[roomId] ||
            this.queues[roomId].length === 0
        ) {
            return;
        }

        this.processing[roomId] = true;

        while (this.queues[roomId] && this.queues[roomId].length > 0) {
            const operation = this.queues[roomId].shift();

            try {
                await operation();
            } catch (error) {
                console.error(`Error processing room ${roomId}:`, error);
            }
        }

        this.processing[roomId] = false;

        if (this.queues[roomId] && this.queues[roomId].length === 0) {
            delete this.queues[roomId];
            delete this.processing[roomId];
        }
    }
}

const asyncQueue = new AsyncQueue();

/* ---------- ユーティリティ ---------- */

function normalizeText(value, maxLength = 60) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeRoomId(value, maxLength = 20) {
    if (typeof value !== 'string') return '';

    const halfWidth = value
        .trim()
        .replace(/[０-９]/g, (char) =>
            String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
        );

    if (!/^\d+$/.test(halfWidth)) {
        return '';
    }

    const normalized = halfWidth.replace(/^0+(?=\d)/, '');

    return normalized.slice(0, maxLength);
}

function normalizeGameMode(value) {
    return value === 'denpo' ? 'denpo' : 'ichimitsu';
}

function answerCharLength(answer) {
    return Array.from(typeof answer === 'string' ? answer : '').length;
}

// 全員一致判定用: 全角/半角・大文字/小文字の違いを吸収する
function normalizeForCompare(answer) {
    return String(answer).normalize('NFKC').toLowerCase();
}

function compareSubmittedAt(a, b) {
    const timeDiff = (a.readyAt || 0) - (b.readyAt || 0);
    if (timeDiff !== 0) return timeDiff;

    return (a.readySeq || 0) - (b.readySeq || 0);
}

function compareDenpoAnswerOrder(a, b) {
    const lenDiff = answerCharLength(a.answer) - answerCharLength(b.answer);
    if (lenDiff !== 0) return lenDiff;

    return compareSubmittedAt(a, b);
}

function isKatakanaOnly(value) {
    return /^[\u30A0-\u30FF]+$/.test(value);
}

/* ---------- ルーム / プレイヤー ---------- */

function getRoom(rid) {
    if (typeof rid !== 'string') return null;
    return rooms[rid] || null;
}

function getPlayerBySocket(room, socketId) {
    if (!room || !room.members) return null;
    return room.members.find((member) => member.socketId === socketId) || null;
}

function getPlayerByUserId(room, userId) {
    if (!room || !room.members) return null;
    return room.members.find((member) => member.id === userId) || null;
}

// 同名プレイヤーがいると結果画面で区別できないので連番を付ける
function makeUniqueName(room, name, excludeUserId) {
    const used = new Set(
        room.members
            .filter((member) => member.id !== excludeUserId)
            .map((member) => member.name)
    );

    if (!used.has(name)) return name;

    for (let n = 2; n < MAX_ROOM_SIZE + 2; n++) {
        const suffix = `(${n})`;
        const candidate = name.slice(0, 20 - suffix.length) + suffix;
        if (!used.has(candidate)) return candidate;
    }

    return name;
}

function ensureRoomTurnIndex(room) {
    if (!room || !room.members || room.members.length === 0) return;

    room.turnIndex =
        ((room.turnIndex % room.members.length) + room.members.length) %
        room.members.length;
}

function getHost(room) {
    if (!room || !room.members || room.members.length === 0) return null;

    ensureRoomTurnIndex(room);
    return room.members[room.turnIndex] || null;
}

function isHost(room, userId) {
    const host = getHost(room);
    return !!host && host.id === userId;
}

function resetAnswers(room) {
    if (!room || !room.members) return;

    room.answerSeq = 0;

    room.members.forEach((member) => {
        member.answer = null;
        member.readyAt = null;
        member.readySeq = null;
    });
}

function createRoom(gameMode) {
    return {
        turnIndex: 0,
        members: [],
        status: 'waiting',
        currentQuestion: '',
        gameMode: normalizeGameMode(gameMode),
        answerSeq: 0,
        updateTimer: null,
        updatePending: false
    };
}

function createPlayer({ id, socketId, name }) {
    return {
        id,
        socketId,
        name,
        answer: null,
        readyAt: null,
        readySeq: null,
        disconnectTimer: null
    };
}

function clearDisconnectTimer(player) {
    if (player && player.disconnectTimer) {
        clearTimeout(player.disconnectTimer);
        player.disconnectTimer = null;
    }
}

function destroyRoom(rid) {
    const room = rooms[rid];
    if (!room) return;

    if (room.updateTimer) clearTimeout(room.updateTimer);
    (room.members || []).forEach(clearDisconnectTimer);

    delete rooms[rid];
}

function getReadyMembers(room) {
    if (!room || !room.members) return [];

    const answeredMembers = room.members.filter(
        (member) => member.answer !== null
    );

    const comparator =
        room.gameMode === 'denpo' ? compareDenpoAnswerOrder : compareSubmittedAt;

    return answeredMembers.sort(comparator).map((member, index) => ({
        name: member.name,
        order: index + 1
    }));
}

function emitRoomData(rid) {
    const room = rooms[rid];

    if (!room || !room.members) return;

    if (room.members.length === 0) {
        destroyRoom(rid);
        return;
    }

    ensureRoomTurnIndex(room);

    const host = getHost(room);
    const hostId = host ? host.id : null;

    const allMembers = room.members.map((member) => ({
        id: member.id,
        name: member.name,
        isHost: member.id === hostId,
        isOnline: !!member.socketId
    }));

    io.to(rid).emit('room-data', {
        rid,
        allMembers,
        readyMembers: getReadyMembers(room),
        totalMemberCount: room.members.length,
        status: room.status,
        hostId,
        hasQuestion: Boolean(room.currentQuestion),
        currentQuestion: room.currentQuestion || '',
        gameMode: room.gameMode || 'ichimitsu'
    });
}

/**
 * room-data を送る。
 * - immediate: true  → 状態遷移など、順序が重要なとき。即座に送る
 * - immediate: false → 提出/接続状況の変化など。ROOM_UPDATE_INTERVAL_MS 内の連続更新は1回にまとめる
 */
function updateRoomData(rid, { immediate = true } = {}) {
    const room = rooms[rid];
    if (!room) return;

    if (immediate) {
        if (room.updateTimer) {
            clearTimeout(room.updateTimer);
            room.updateTimer = null;
        }
        room.updatePending = false;
        emitRoomData(rid);
        return;
    }

    if (room.updateTimer) {
        room.updatePending = true;
        return;
    }

    emitRoomData(rid);

    room.updateTimer = setTimeout(() => {
        const current = rooms[rid];
        if (!current) return;

        current.updateTimer = null;

        if (current.updatePending) {
            current.updatePending = false;
            updateRoomData(rid, { immediate: false });
        }
    }, ROOM_UPDATE_INTERVAL_MS);
}

function removePlayerFromRoom(rid, userId) {
    const room = rooms[rid];
    if (!room || !room.members) return false;

    const index = room.members.findIndex((member) => member.id === userId);
    if (index === -1) return false;

    ensureRoomTurnIndex(room);

    const wasHost = index === room.turnIndex;

    clearDisconnectTimer(room.members[index]);
    room.members.splice(index, 1);

    if (room.members.length === 0) {
        destroyRoom(rid);
        return true;
    }

    // ホストより前の人が抜けても、ホストが別の人に変わらないようにずらす
    if (index < room.turnIndex) {
        room.turnIndex -= 1;
    }
    ensureRoomTurnIndex(room);

    // ホストが抜けた場合は、次の人がホストになり、お題入力からやり直す
    const needsReset = wasHost && room.status === 'playing';
    if (needsReset) {
        room.currentQuestion = '';
        resetAnswers(room);
    }

    updateRoomData(rid, { immediate: true });

    if (needsReset) {
        io.to(rid).emit('prepare-next-round');
    }

    return true;
}

function normalizeEventIds({ rid, userId }) {
    return {
        rid: normalizeRoomId(rid, 20),
        userId: normalizeText(userId, 80)
    };
}

function scheduleDisconnectRemoval(rid, player, room) {
    clearDisconnectTimer(player);

    const waitTime =
        room.status === 'playing'
            ? DISCONNECT_GRACE_MS_PLAYING
            : DISCONNECT_GRACE_MS_WAITING;

    player.disconnectTimer = setTimeout(() => {
        asyncQueue.enqueue(rid, async () => {
            const finalRoom = getRoom(rid);
            if (!finalRoom) return;

            const finalPlayer = getPlayerByUserId(finalRoom, player.id);
            if (!finalPlayer) return;

            finalPlayer.disconnectTimer = null;

            if (!finalPlayer.socketId) {
                removePlayerFromRoom(rid, player.id);
            }
        });
    }, waitTime);
}

/* ---------- ソケット ---------- */

function allowEvent(socket) {
    const now = Date.now();
    const rate = socket.data.rate || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };

    if (now >= rate.resetAt) {
        rate.count = 0;
        rate.resetAt = now + RATE_LIMIT_WINDOW_MS;
    }

    rate.count += 1;
    socket.data.rate = rate;

    return rate.count <= RATE_LIMIT_MAX;
}

// payload が null / 文字列などでも落ちないようにし、例外でプロセスが死なないようにする
function safeOn(socket, event, handler) {
    socket.on(event, (payload) => {
        if (!allowEvent(socket)) return;

        try {
            const safePayload =
                payload && typeof payload === 'object' ? payload : {};
            handler(safePayload);
        } catch (error) {
            console.error(`Error in "${event}" handler:`, error);
        }
    });
}

// このソケットが別の部屋/ユーザーとして参加済みなら、そちらから外す
function detachPreviousSession(socket, nextRid, nextUserId) {
    const previous = socketSessions.get(socket.id);
    if (!previous) return;

    if (previous.rid === nextRid && previous.userId === nextUserId) return;

    socketSessions.delete(socket.id);
    socket.leave(previous.rid);

    asyncQueue.enqueue(previous.rid, async () => {
        const room = getRoom(previous.rid);
        if (!room) return;

        const player = getPlayerByUserId(room, previous.userId);
        if (player && player.socketId === socket.id) {
            removePlayerFromRoom(previous.rid, previous.userId);
        }
    });
}

io.on('connection', (socket) => {
    safeOn(socket, 'join-room', ({ name, rid, userId, gameMode }) => {
        const normalizedName = normalizeText(name, 20);
        const normalizedRoomId = normalizeRoomId(rid, 20);
        const normalizedUserId = normalizeText(userId, 80);
        const selectedMode = normalizeGameMode(gameMode);

        if (!normalizedName || !normalizedRoomId || !normalizedUserId) {
            socket.emit(
                'error-msg',
                '名前・数字の部屋番号・ユーザー情報を確認してください。'
            );
            return;
        }

        detachPreviousSession(socket, normalizedRoomId, normalizedUserId);

        asyncQueue.enqueue(normalizedRoomId, async () => {
            let room = rooms[normalizedRoomId];
            let player = room
                ? getPlayerByUserId(room, normalizedUserId)
                : null;

            // 再接続
            if (player) {
                // 別タブ/別端末の古い接続は切り離す
                if (player.socketId && player.socketId !== socket.id) {
                    const oldSocket = io.sockets.sockets.get(player.socketId);
                    socketSessions.delete(player.socketId);
                    if (oldSocket) oldSocket.leave(normalizedRoomId);
                }

                clearDisconnectTimer(player);

                player.socketId = socket.id;
                player.name = makeUniqueName(
                    room,
                    normalizedName,
                    normalizedUserId
                );

                socketSessions.set(socket.id, {
                    rid: normalizedRoomId,
                    userId: normalizedUserId
                });
                socket.join(normalizedRoomId);
                updateRoomData(normalizedRoomId, { immediate: false });

                console.log(
                    `✅ Player ${normalizedUserId} rejoined room ${normalizedRoomId}.`
                );
                return;
            }

            if (!room) {
                if (Object.keys(rooms).length >= MAX_ROOMS) {
                    socket.emit(
                        'error-msg',
                        'ただいま部屋が混み合っています。しばらくしてからお試しください。'
                    );
                    return;
                }

                room = rooms[normalizedRoomId] = createRoom(selectedMode);
            }

            if (room.status === 'playing') {
                socket.emit(
                    'error-msg',
                    '現在ゲーム進行中のため新規入室できません。'
                );
                return;
            }

            if (room.members.length >= MAX_ROOM_SIZE) {
                socket.emit('error-msg', 'この部屋は満員です。');
                return;
            }

            player = createPlayer({
                id: normalizedUserId,
                socketId: socket.id,
                name: makeUniqueName(room, normalizedName, normalizedUserId)
            });

            room.members.push(player);

            socketSessions.set(socket.id, {
                rid: normalizedRoomId,
                userId: normalizedUserId
            });
            socket.join(normalizedRoomId);
            updateRoomData(normalizedRoomId, { immediate: false });
        });
    });

    safeOn(socket, 'go-to-setup', ({ rid, userId, gameMode }) => {
        const ids = normalizeEventIds({ rid, userId });
        const selectedMode = normalizeGameMode(gameMode);

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room || !isHost(room, ids.userId)) return;

            room.gameMode = selectedMode;
            room.status = 'playing';
            room.currentQuestion = '';
            resetAnswers(room);

            io.to(ids.rid).emit('move-to-setup');
            updateRoomData(ids.rid, { immediate: true });
        });
    });

    safeOn(socket, 'back-to-waiting', ({ rid, userId }) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room || !isHost(room, ids.userId)) return;

            room.status = 'waiting';
            room.currentQuestion = '';
            resetAnswers(room);

            io.to(ids.rid).emit('move-to-waiting');
            updateRoomData(ids.rid, { immediate: true });
        });
    });

    safeOn(socket, 'send-question', ({ rid, userId, question }) => {
        const ids = normalizeEventIds({ rid, userId });
        const normalizedQuestion = normalizeText(question, 80);

        if (!ids.rid || !ids.userId || !normalizedQuestion) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room || !isHost(room, ids.userId)) return;

            room.status = 'playing';
            room.currentQuestion = normalizedQuestion;
            resetAnswers(room);

            io.to(ids.rid).emit('receive-question', {
                question: normalizedQuestion
            });

            updateRoomData(ids.rid, { immediate: true });
        });
    });

    safeOn(socket, 'submit-answer', ({ rid, userId, answer }) => {
        const ids = normalizeEventIds({ rid, userId });
        const normalizedAnswer = normalizeText(answer, 40);

        if (!ids.rid || !ids.userId || !normalizedAnswer) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);

            if (!room || !room.currentQuestion) return;

            const player = getPlayerByUserId(room, ids.userId);

            if (!player) return;
            if (player.socketId !== socket.id) return;
            if (player.answer !== null) return;

            if (room.gameMode === 'denpo' && !isKatakanaOnly(normalizedAnswer)) {
                socket.emit(
                    'error-msg',
                    'デンポーではカタカナのみ入力できます。'
                );
                return;
            }

            player.answer = normalizedAnswer;
            player.readyAt = Date.now();

            room.answerSeq = (room.answerSeq || 0) + 1;
            player.readySeq = room.answerSeq;

            // 大人数が同時に提出しても送信は一定間隔にまとめる
            updateRoomData(ids.rid, { immediate: false });
        });
    });

    safeOn(socket, 'host-judge', ({ rid, userId }) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room || !isHost(room, ids.userId)) return;

            const results = room.members
                .filter((member) => member.answer !== null)
                .sort(compareSubmittedAt)
                .map((member) => ({
                    name: member.name,
                    answer: member.answer
                }));

            if (results.length === 0) {
                io.to(ids.rid).emit('show-result', {
                    results: [],
                    isMatch: false,
                    answeredCount: 0,
                    totalCount: room.members.length,
                    gameMode: 'ichimitsu'
                });
                return;
            }

            const firstAnswer = normalizeForCompare(results[0].answer);

            const isMatch = results.every(
                (result) => normalizeForCompare(result.answer) === firstAnswer
            );

            io.to(ids.rid).emit('show-result', {
                results,
                isMatch,
                answeredCount: results.length,
                totalCount: room.members.length,
                gameMode: 'ichimitsu'
            });
        });
    });

    safeOn(socket, 'denpo-judge', ({ rid, userId }) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room || !isHost(room, ids.userId)) return;

            const results = room.members
                .filter((member) => member.answer !== null)
                .sort(compareDenpoAnswerOrder)
                .map((member, index) => ({
                    name: member.name,
                    answer: member.answer,
                    order: index + 1
                }));

            io.to(ids.rid).emit('show-result', {
                results,
                answeredCount: results.length,
                totalCount: room.members.length,
                gameMode: 'denpo'
            });
        });
    });

    safeOn(socket, 'next-round', ({ rid, userId }) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);

            if (!room || !isHost(room, ids.userId)) return;
            if (!room.members || room.members.length === 0) return;

            room.turnIndex = (room.turnIndex + 1) % room.members.length;
            room.currentQuestion = '';
            resetAnswers(room);

            updateRoomData(ids.rid, { immediate: true });
            io.to(ids.rid).emit('prepare-next-round');
        });
    });

    safeOn(socket, 'leave-room', ({ rid, userId }) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room) return;

            const player = getPlayerByUserId(room, ids.userId);

            if (!player || player.socketId !== socket.id) return;

            socketSessions.delete(socket.id);
            socket.leave(ids.rid);
            removePlayerFromRoom(ids.rid, ids.userId);

            socket.emit('left-success');
        });
    });

    socket.on('disconnect', () => {
        // 全部屋を走査せず、索引から該当ルームだけを引く
        const session = socketSessions.get(socket.id);
        socketSessions.delete(socket.id);

        if (!session) return;

        const { rid, userId } = session;

        asyncQueue.enqueue(rid, async () => {
            const room = getRoom(rid);
            if (!room) return;

            const player = getPlayerByUserId(room, userId);
            if (!player) return;

            // すでに別のソケットで再接続済みなら何もしない
            if (player.socketId !== socket.id) return;

            player.socketId = null;

            updateRoomData(rid, { immediate: false });
            scheduleDisconnectRemoval(rid, player, room);
        });
    });
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT}`);
    console.log('✅ 全員一致＆デンポーゲームに対応しました');
});