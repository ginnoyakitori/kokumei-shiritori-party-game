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
const DISCONNECT_GRACE_MS = 10 * 60 * 1000;
const MAX_ROOM_SIZE = 10000;

class AsyncQueue {
    constructor() {
        this.queues = {};
        this.processing = {};
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

function isKatakanaOnly(text) {
    if (!text) return false;
    const katakanaRegex = /^[\u30A0-\u30FF]+$/;
    return katakanaRegex.test(text);
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

    // 文字数が少ない順 → 入力が早い順でソート
    const readyPlayers = room.members
        .filter((member) => member.answer !== null)
        .sort((a, b) => {
            const lenDiff = a.answer.length - b.answer.length;
            if (lenDiff !== 0) return lenDiff;
            return a.readyAt - b.readyAt;
        })
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
        currentQuestion: room.currentQuestion || '',
        gameMode: room.gameMode || 'ichimitsu'
    });
}

function removePlayerFromRoom(rid, userId) {
    const room = rooms[rid];
    if (!room) return;

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

io.on('connection', (socket) => {
    socket.on('join-room', ({ name, rid, userId, gameMode } = {}) => {
        const normalizedName = normalizeText(name, 20);
        const normalizedRoomId = normalizeText(rid, 20);
        const normalizedUserId = normalizeText(userId, 80);

        if (!normalizedName || !normalizedRoomId || !normalizedUserId) {
            socket.emit('error-msg', '名前・部屋番号・ユーザー情報を確認してください。');
            return;
        }

        if (rooms[normalizedRoomId] && rooms[normalizedRoomId].members.length >= MAX_ROOM_SIZE) {
            socket.emit('error-msg', 'この部屋は満員です。');
            return;
        }

        asyncQueue.enqueue(normalizedRoomId, async () => {
            if (!rooms[normalizedRoomId]) {
                rooms[normalizedRoomId] = {
                    turnIndex: 0,
                    members: [],
                    status: 'waiting',
                    currentQuestion: '',
                    gameMode: gameMode || 'ichimitsu'
                };
            }

            const room = rooms[normalizedRoomId];
            let player = getPlayerByUserId(room, normalizedUserId);

            if (player) {
                player.socketId = socket.id;
                player.name = normalizedName;
                console.log(`✅ Player ${normalizedUserId} rejoined.`);
            } else {
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
            io.to(rid).emit('receive-question', { question: normalizedQuestion });
            updateRoomData(rid);
        });
    });

    socket.on('submit-answer', ({ rid, userId, answer } = {}) => {
        const room = getRoom(rid);
        const normalizedAnswer = normalizeText(answer, 40);
        
        // デンポーの場合はカタカナチェック
        if (room && room.gameMode === 'denpo' && !isKatakanaOnly(normalizedAnswer)) {
            socket.emit('error-msg', 'デンポーではカタカナのみ入力できます。');
            return;
        }
        
        if (!room || !room.currentQuestion || !normalizedAnswer) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !latestRoom.currentQuestion) return;

            const player = getPlayerByUserId(latestRoom, userId);
            if (!player || player.socketId !== socket.id || player.answer !== null) return;

            player.answer = normalizedAnswer;
            player.readyAt = Date.now();
            updateRoomData(rid);
        });
    });

    socket.on('host-judge', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId)) return;

            const answeredPlayers = latestRoom.members.filter((member) => member.answer !== null);
            if (answeredPlayers.length !== latestRoom.members.length) {
                socket.emit('error-msg', '全員が回答してから結果を開いてください。');
                return;
            }

            const normalizedAnswers = answeredPlayers.map((member) => member.answer.toLowerCase());
            const firstAnswer = normalizedAnswers[0];
            const isMatch = normalizedAnswers.every((answer) => answer === firstAnswer);
            
            // 文字数が少ない順 → 入力が早い順でソート
            const results = latestRoom.members
                .filter((member) => member.answer !== null)
                .sort((a, b) => {
                    const lenDiff = a.answer.length - b.answer.length;
                    return lenDiff !== 0 ? lenDiff : a.readyAt - b.readyAt;
                })
                .map((member, index) => ({
                    name: member.name,
                    answer: member.answer,
                    order: index + 1
                }));

            io.to(rid).emit('show-result', { results, isMatch });
        });
    });

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

    socket.on('disconnect', () => {
        Object.entries(rooms).forEach(([rid, room]) => {
            if (!room || !room.members) return;

            const player = getPlayerBySocket(room, socket.id);
            if (!player) return;

            asyncQueue.enqueue(rid, async () => {
                const latestRoom = rooms[rid];
                if (!latestRoom) return;

                const latestPlayer = getPlayerByUserId(latestRoom, player.id);
                if (!latestPlayer) return;

                latestPlayer.socketId = null;
                updateRoomData(rid);

                const waitTime = latestRoom.status === 'waiting' ? 1000 : DISCONNECT_GRACE_MS;
                
                setTimeout(() => {
                    asyncQueue.enqueue(rid, async () => {
                        const finalRoom = rooms[rid];
                        const finalPlayer = finalRoom ? getPlayerByUserId(finalRoom, player.id) : null;

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
    console.log(`✅ デンポーゲーム（シンプル版）に対応しました`);
});