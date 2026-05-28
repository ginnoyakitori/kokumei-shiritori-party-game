const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const DISCONNECT_GRACE_MS_PLAYING = 10 * 60 * 1000;
const DISCONNECT_GRACE_MS_WAITING = 30 * 1000;
const MAX_ROOM_SIZE = 10000;

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

function normalizeText(value, maxLength = 60) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function normalizeGameMode(value) {
    return value === 'denpo' ? 'denpo' : 'ichimitsu';
}

function answerCharLength(answer) {
    return Array.from(typeof answer === 'string' ? answer : '').length;
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
        answerSeq: 0
    };
}

function createPlayer({ id, socketId, name }) {
    return {
        id,
        socketId,
        name,
        answer: null,
        readyAt: null,
        readySeq: null
    };
}

function getReadyMembers(room) {
    if (!room || !room.members) return [];

    const answeredMembers = room.members.filter(
        (member) => member.answer !== null
    );

    if (room.gameMode === 'denpo') {
        return answeredMembers
            .sort(compareDenpoAnswerOrder)
            .map((member, index) => ({
                name: member.name,
                order: index + 1
            }));
    }

    return answeredMembers
        .sort(compareSubmittedAt)
        .map((member, index) => ({
            name: member.name,
            order: index + 1
        }));
}

function updateRoomData(rid) {
    const room = rooms[rid];

    if (!room || !room.members) return;

    if (room.members.length === 0) {
        delete rooms[rid];
        return;
    }

    ensureRoomTurnIndex(room);

    const host = getHost(room);

    const allMembers = room.members.map((member) => ({
        id: member.id,
        name: member.name,
        isHost: member.id === (host ? host.id : null),
        isOnline: !!member.socketId
    }));

    io.to(rid).emit('room-data', {
        rid,
        allMembers,
        readyMembers: getReadyMembers(room),
        totalMemberCount: room.members.length,
        status: room.status,
        hostId: host ? host.id : null,
        hasQuestion: Boolean(room.currentQuestion),
        currentQuestion: room.currentQuestion || '',
        gameMode: room.gameMode || 'ichimitsu'
    });
}

function removePlayerFromRoom(rid, userId) {
    const room = rooms[rid];
    if (!room || !room.members) return false;

    const initialLength = room.members.length;

    room.members = room.members.filter((member) => member.id !== userId);

    if (room.members.length === initialLength) {
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

function normalizeEventIds({ rid, userId }) {
    return {
        rid: normalizeText(rid, 20),
        userId: normalizeText(userId, 80)
    };
}

io.on('connection', (socket) => {
    socket.on('join-room', ({ name, rid, userId, gameMode } = {}) => {
        const normalizedName = normalizeText(name, 20);
        const normalizedRoomId = normalizeText(rid, 20);
        const normalizedUserId = normalizeText(userId, 80);
        const selectedMode = normalizeGameMode(gameMode);

        if (!normalizedName || !normalizedRoomId || !normalizedUserId) {
            socket.emit(
                'error-msg',
                '名前・部屋番号・ユーザー情報を確認してください。'
            );
            return;
        }

        asyncQueue.enqueue(normalizedRoomId, async () => {
            if (!rooms[normalizedRoomId]) {
                rooms[normalizedRoomId] = createRoom(selectedMode);
            }

            const room = rooms[normalizedRoomId];

            let player = getPlayerByUserId(room, normalizedUserId);

            if (player) {
                player.socketId = socket.id;
                player.name = normalizedName;

                socket.join(normalizedRoomId);
                updateRoomData(normalizedRoomId);

                console.log(`✅ Player ${normalizedUserId} rejoined room ${normalizedRoomId}.`);
                return;
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
                name: normalizedName
            });

            room.members.push(player);

            socket.join(normalizedRoomId);
            updateRoomData(normalizedRoomId);
        });
    });

    socket.on('go-to-setup', ({ rid, userId, gameMode } = {}) => {
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
            updateRoomData(ids.rid);
        });
    });

    socket.on('back-to-waiting', ({ rid, userId } = {}) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room || !isHost(room, ids.userId)) return;

            room.status = 'waiting';
            room.currentQuestion = '';
            resetAnswers(room);

            io.to(ids.rid).emit('move-to-waiting');
            updateRoomData(ids.rid);
        });
    });

    socket.on('send-question', ({ rid, userId, question } = {}) => {
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

            updateRoomData(ids.rid);
        });
    });

    socket.on('submit-answer', ({ rid, userId, answer } = {}) => {
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

            updateRoomData(ids.rid);
        });
    });

    socket.on('host-judge', ({ rid, userId } = {}) => {
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

            const normalizedAnswers = results.map((result) =>
                result.answer.toLowerCase()
            );

            const firstAnswer = normalizedAnswers[0];

            const isMatch = normalizedAnswers.every(
                (answer) => answer === firstAnswer
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

    socket.on('denpo-judge', ({ rid, userId } = {}) => {
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

    socket.on('next-round', ({ rid, userId } = {}) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);

            if (!room || !isHost(room, ids.userId)) return;
            if (!room.members || room.members.length === 0) return;

            room.turnIndex = (room.turnIndex + 1) % room.members.length;
            room.currentQuestion = '';
            resetAnswers(room);

            updateRoomData(ids.rid);
            io.to(ids.rid).emit('prepare-next-round');
        });
    });

    socket.on('leave-room', ({ rid, userId } = {}) => {
        const ids = normalizeEventIds({ rid, userId });

        if (!ids.rid || !ids.userId) return;

        asyncQueue.enqueue(ids.rid, async () => {
            const room = getRoom(ids.rid);
            if (!room) return;

            const player = getPlayerByUserId(room, ids.userId);

            if (!player || player.socketId !== socket.id) return;

            socket.leave(ids.rid);
            removePlayerFromRoom(ids.rid, ids.userId);

            socket.emit('left-success');
        });
    });

    socket.on('disconnect', () => {
        Object.entries(rooms).forEach(([rid, room]) => {
            if (!room || !room.members) return;

            const player = getPlayerBySocket(room, socket.id);

            if (!player) return;

            asyncQueue.enqueue(rid, async () => {
                const latestRoom = getRoom(rid);
                if (!latestRoom) return;

                const latestPlayer = getPlayerByUserId(latestRoom, player.id);
                if (!latestPlayer) return;

                if (latestPlayer.socketId !== socket.id) return;

                latestPlayer.socketId = null;

                updateRoomData(rid);

                const waitTime =
                    latestRoom.status === 'playing'
                        ? DISCONNECT_GRACE_MS_PLAYING
                        : DISCONNECT_GRACE_MS_WAITING;

                setTimeout(() => {
                    asyncQueue.enqueue(rid, async () => {
                        const finalRoom = getRoom(rid);
                        if (!finalRoom) return;

                        const finalPlayer = getPlayerByUserId(
                            finalRoom,
                            player.id
                        );

                        if (!finalPlayer) return;

                        if (!finalPlayer.socketId) {
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
    console.log('✅ 全員一致＆デンポーゲームに対応しました');
});