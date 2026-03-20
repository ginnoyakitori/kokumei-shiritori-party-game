const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

// ✅ public フォルダを static として指定
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const DISCONNECT_GRACE_MS = 10 * 60 * 1000;
const MAX_ROOM_SIZE = 10000; // 大人数対応

/**
 * 非同期キューで room 操作を順序付けして実行
 * Race condition を防ぐため、各 room に対して1つずつ操作を実行
 */
class AsyncQueue {
    constructor() {
        this.queues = {}; // roomId -> queue
        this.processing = {}; // roomId -> processing flag
    }

    enqueue(roomId, operation) {
        if (!this.queues[roomId]) {
            this.queues[roomId] = [];
        }
        this.queues[roomId].push(operation);
        this.process(roomId);
    }

    async process(roomId) {
        if (this.processing[roomId] || !this.queues[roomId] || this.queues[roomId].length === 0) {
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
    }
}

const asyncQueue = new AsyncQueue();

function normalizeText(value, maxLength = 60) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

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

function isHost(room, userId) {
    if (!room || room.members.length === 0) return false;
    const host = room.members[room.turnIndex % room.members.length];
    return !!host && host.id === userId;
}

function resetAnswers(room) {
    if (!room || !room.members) return;
    room.members.forEach((member) => {
        member.answer = null;
        member.readyAt = null;
    });
}

function ensureRoomTurnIndex(room) {
    if (!room || room.members.length === 0) {
        return;
    }
    room.turnIndex = ((room.turnIndex % room.members.length) + room.members.length) % room.members.length;
}

/**
 * room データを全クライアントに同期する
 * 大規模なメンバーがいる場合でも効率的に処理
 * ✅ 出題者も含めて全員の回答を回答順で返す
 */
function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room || !room.members) return;

    if (room.members.length === 0) {
        delete rooms[rid];
        return;
    }

    ensureRoomTurnIndex(room);
    const host = room.members[room.turnIndex];

    const allMembers = room.members.map((member) => ({
        id: member.id,
        name: member.name,
        isHost: member.id === (host ? host.id : null),
        isOnline: !!member.socketId
    }));

    // ✅ readyAt で回答順をソート（早く回答した順）
    const readyPlayers = room.members
        .filter((member) => member.answer !== null)
        .sort((a, b) => a.readyAt - b.readyAt)
        .map((member, index) => ({
            name: member.name,
            order: index + 1
        }));

    io.to(rid).emit('room-data', {
        rid,
        allMembers,
        readyMembers: readyPlayers,
        totalMemberCount: room.members.length,
        status: room.status,
        hostId: host ? host.id : null,
        hasQuestion: Boolean(room.currentQuestion),
        currentQuestion: room.currentQuestion || ''
    });
}

/**
 * 安全に player を room から削除
 */
function removePlayerFromRoom(rid, userId) {
    const room = rooms[rid];
    if (!room) return;

    const initialLength = room.members.length;
    room.members = room.members.filter((member) => member.id !== userId);

    if (room.members.length === initialLength) {
        // 該当プレイヤーが見つからなかった
        return false;
    }

    if (room.members.length === 0) {
        delete rooms[rid];
        return true;
    }

    ensureRoomTurnIndex(room);
    updateRoomData(rid);
    return true;
}

io.on('connection', (socket) => {
    /**
     * join-room: ユーザーが room に参加
     * 既存ユーザーの再接続と新規参加の両方に対応
     */
    socket.on('join-room', ({ name, rid, userId } = {}) => {
        const normalizedName = normalizeText(name, 20);
        const normalizedRoomId = normalizeText(rid, 20);
        const normalizedUserId = normalizeText(userId, 80);

        if (!normalizedName || !normalizedRoomId || !normalizedUserId) {
            socket.emit('error-msg', '名前・部屋番号・ユーザー情報を確認してください。');
            return;
        }

        // room size チェック（大人数対応）
        if (rooms[normalizedRoomId] && rooms[normalizedRoomId].members.length >= MAX_ROOM_SIZE) {
            socket.emit('error-msg', 'この部屋は満員です。');
            return;
        }

        // 非同期キューに入室操作をキューイング
        asyncQueue.enqueue(normalizedRoomId, async () => {
            // room の初期化
            if (!rooms[normalizedRoomId]) {
                rooms[normalizedRoomId] = {
                    turnIndex: 0,
                    members: [],
                    status: 'waiting',
                    currentQuestion: ''
                };
            }

            const room = rooms[normalizedRoomId];
            let player = getPlayerByUserId(room, normalizedUserId);

            if (player) {
                // 既存プレイヤーの再接続
                player.socketId = socket.id;
                player.name = normalizedName;
            } else {
                // 新規プレイヤー
                if (room.status === 'playing') {
                    socket.emit('error-msg', '現在ゲーム進行中のため入室できません。');
                    return;
                }

                if (room.members.length >= MAX_ROOM_SIZE) {
                    socket.emit('error-msg', 'この部屋は満員です。');
                    return;
                }

                player = {
                    id: normalizedUserId,
                    socketId: socket.id,
                    name: normalizedName,
                    answer: null,
                    readyAt: null
                };
                room.members.push(player);
            }

            socket.join(normalizedRoomId);
            updateRoomData(normalizedRoomId);
        });
    });

    /**
     * go-to-setup: host がゲーム開始準備へ遷移
     */
    socket.on('go-to-setup', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId)) return;

            latestRoom.status = 'playing';
            latestRoom.currentQuestion = '';
            resetAnswers(latestRoom);
            io.to(rid).emit('move-to-setup');
            updateRoomData(rid);
        });
    });

    /**
     * back-to-waiting: ゲームを中止して待機状態に戻す
     */
    socket.on('back-to-waiting', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId)) return;

            latestRoom.status = 'waiting';
            latestRoom.currentQuestion = '';
            resetAnswers(latestRoom);
            io.to(rid).emit('move-to-waiting');
            updateRoomData(rid);
        });
    });

    /**
     * send-question: host がお題を送信
     * ✅ 出題者もゲーム画面に遷移して回答できる
     */
    socket.on('send-question', ({ rid, userId, question } = {}) => {
        const room = getRoom(rid);
        const normalizedQuestion = normalizeText(question, 80);
        if (!room || !isHost(room, userId) || !normalizedQuestion) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId)) return;

            latestRoom.status = 'playing';
            latestRoom.currentQuestion = normalizedQuestion;
            resetAnswers(latestRoom);
            // ✅ 全員（出題者も含む）に receive-question を送信
            io.to(rid).emit('receive-question', { question: normalizedQuestion });
            updateRoomData(rid);
        });
    });

    /**
     * submit-answer: プレイヤーが回答を送信
     * ✅ 出題者も回答できるように修正
     * 同じプレイヤーから複数回送信されないようガード
     */
    socket.on('submit-answer', ({ rid, userId, answer } = {}) => {
        const room = getRoom(rid);
        const normalizedAnswer = normalizeText(answer, 40);
        if (!room || !room.currentQuestion || !normalizedAnswer) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !latestRoom.currentQuestion) return;

            const player = getPlayerByUserId(latestRoom, userId);
            if (!player || player.socketId !== socket.id || player.answer !== null) return;

            // ✅ readyAt を現在時刻で設定 → 回答順を正確に記録
            player.answer = normalizedAnswer;
            player.readyAt = Date.now();
            updateRoomData(rid);
        });
    });

    /**
     * host-judge: 全員の回答を確認して結果発表
     * ✅ 出題者も含めて全員が回答しているか確認
     */
    socket.on('host-judge', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId)) return;

            // ✅ 出題者も含めて全員が回答しているかチェック
            const answeredPlayers = latestRoom.members.filter((member) => member.answer !== null);
            if (answeredPlayers.length !== latestRoom.members.length) {
                socket.emit('error-msg', '全員が回答してから結果を開いてください。');
                return;
            }

            const normalizedAnswers = answeredPlayers.map((member) => member.answer.toLowerCase());
            const firstAnswer = normalizedAnswers[0];
            // ✅ 全員の回答が一致しているか判定
            const isMatch = normalizedAnswers.every((answer) => answer === firstAnswer);
            // ✅ 回答順に結果を表示
            const results = latestRoom.members
                .filter((member) => member.answer !== null)
                .sort((a, b) => a.readyAt - b.readyAt)
                .map((member) => ({
                    name: member.name,
                    answer: member.answer
                }));

            io.to(rid).emit('show-result', { results, isMatch });
        });
    });

    /**
     * next-round: 次のお題担当へ遷移
     */
    socket.on('next-round', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId) || room.members.length === 0) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId) || latestRoom.members.length === 0) return;

            latestRoom.turnIndex = (latestRoom.turnIndex + 1) % latestRoom.members.length;
            latestRoom.currentQuestion = '';
            resetAnswers(latestRoom);
            updateRoomData(rid);
            io.to(rid).emit('prepare-next-round');
        });
    });

    /**
     * leave-room: プレイヤーが明示的に room を退出
     */
    socket.on('leave-room', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom) return;

            const player = getPlayerByUserId(latestRoom, userId);
            if (!player || player.socketId !== socket.id) return;

            socket.leave(rid);
            removePlayerFromRoom(rid, userId);
            socket.emit('left-success');
        });
    });

    /**
     * disconnect: socket が切断された
     * graceful period を設けて再��続を許容
     */
    socket.on('disconnect', () => {
        const disconnectTime = Date.now();
        
        // 全 room をスキャンしてこの socket のプレイヤーを探す
        Object.entries(rooms).forEach(([rid, room]) => {
            if (!room || !room.members) return;

            const player = getPlayerBySocket(room, socket.id);
            if (!player) return;

            asyncQueue.enqueue(rid, async () => {
                const latestRoom = rooms[rid];
                if (!latestRoom) return;

                const latestPlayer = getPlayerByUserId(latestRoom, player.id);
                if (!latestPlayer) return;

                // socket.id を null にして "オフライン" 状態へ
                latestPlayer.socketId = null;
                updateRoomData(rid);

                // graceful period のタイマーをセット
                // ゲーム進行中: 10分間の猶予
                // 待機中: 1秒後に削除（新規参加を促す）
                const waitTime = latestRoom.status === 'waiting' ? 1000 : DISCONNECT_GRACE_MS;
                
                setTimeout(() => {
                    asyncQueue.enqueue(rid, async () => {
                        const finalRoom = rooms[rid];
                        const finalPlayer = finalRoom ? getPlayerByUserId(finalRoom, player.id) : null;

                        // 再接続されていなければ削除
                        if (finalRoom && finalPlayer && !finalPlayer.socketId) {
                            removePlayerFromRoom(rid, player.id);
                        }
                    });
                }, waitTime);
            });
        });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server started on port ${PORT}`);
    console.log(`Max room size: ${MAX_ROOM_SIZE} users`);
    console.log(`Static files served from: ${path.join(__dirname, 'public')}`);
    console.log(`✅ 出題者も回答できるようになりました`);
});