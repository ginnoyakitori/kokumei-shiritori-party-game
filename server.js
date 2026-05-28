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
    const lenDiff = a.answer.length - b.answer.length;
    if (lenDiff !== 0) return lenDiff;
    return compareSubmittedAt(a, b);
}


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

    room.answerSeq = 0;

    room.members.forEach((member) => {
        member.answer = null;
        member.readyAt = null;
        member.readySeq = null;
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

    // ゲームモードに応じて異なるソート順序
    let readyPlayers = [];
    if (room.gameMode === 'denpo') {
        // デンポー: 文字数が少ない順 → 入力が早い順でソート
        readyPlayers = room.members
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
    } else {
        // 全員一致: 入力が早い順でソート
        readyPlayers = room.members
            .filter((member) => member.answer !== null)
            .sort(function compareSubmittedAt(a, b) {
                        const timeDiff = (a.readyAt || 0) - (b.readyAt || 0);
                        if (timeDiff !== 0) return timeDiff;
                        return (a.readySeq || 0) - (b.readySeq || 0);
}
)
            .map((member, index) => ({
                name: member.name,
                order: index + 1
            }));
    }

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
                    gameMode: normalizeGameMode(gameMode),
                    answerSeq: 0
                };

            }

            const room = rooms[normalizedRoomId];
            let player = room.members.find(p => p.id === userId);

            if (player) {
    // 再接続
                player.socketId = socket.id;
                player.name = normalizedName;
            } else {
                player = {
                    id: userId,
                    socketId: socket.id,
                    name: normalizedName,
                    answer: null,
                    readyAt: null,
                    readySeq: null
                };
                if (room.members.find(m => m.id === userId)) return;

            }

            socket.join(normalizedRoomId);
            updateRoomData(normalizedRoomId);
        });
    });

    socket.on('go-to-setup', ({ rid, userId, gameMode } = {}) => {
    const room = getRoom(rid);
    if (!room || !isHost(room, userId)) return;

    const selectedMode = normalizeGameMode(gameMode);

    asyncQueue.enqueue(rid, async () => {
        const latestRoom = getRoom(rid);
        if (!latestRoom || !isHost(latestRoom, userId)) return;

        latestRoom.gameMode = selectedMode;
        latestRoom.status = 'playing';
        latestRoom.currentQuestion = '';
        resetAnswers(latestRoom);
        io.to(rid).emit('move-to-setup');
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

    socket.on('submit-answer', ({ rid, userId, answer }) => {
    asyncQueue.enqueue(rid, async () => {

        const room = getRoom(rid);
        if (!room) return;

        const player = getPlayerByUserId(room, userId);
        if (!player || player.answer !== null) return;

        player.answer = answer;
        player.readyAt = Date.now();

        room.answerSeq++;
        player.readySeq = room.answerSeq;

        updateRoomData(rid);
    });
});

    socket.on('submit-answer', ({ rid, userId, answer } = {}) => {
        const room = getRoom(rid);
        const normalizedAnswer = normalizeText(answer, 40);
        
        if (!room || !room.currentQuestion || !normalizedAnswer) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !latestRoom.currentQuestion) return;

            const player = getPlayerByUserId(latestRoom, userId);
            if (!player || player.socketId !== socket.id || player.answer !== null) return;

            player.answer = normalizedAnswer;
            player.readyAt = Date.now();

            latestRoom.answerSeq = (latestRoom.answerSeq || 0) + 1;
            player.readySeq = latestRoom.answerSeq;


            latestRoom.answerSeq = (latestRoom.answerSeq || 0) + 1;
            player.readySeq = latestRoom.answerSeq;

            updateRoomData(rid);

        });
    });

    socket.on('denpo-judge', ({ rid, userId }) => {
    const room = getRoom(rid);
    if (!room || !isHost(room, userId)) return;

    asyncQueue.enqueue(rid, async () => {

        const results = room.members
            .filter(m => m.answer !== null)
            .sort(compareDenpoAnswerOrder)
            .map((m, i) => ({
                name: m.name,
                answer: m.answer,
                order: i + 1
            }));

        io.to(rid).emit('show-result', {
            results,
            answeredCount: results.length,
            totalCount: room.members.length,
            gameMode: 'denpo'
        });
    });
});

    socket.on('host-judge', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId)) return;

            // 入力が早い順でソート
            const results = latestRoom.members
                .filter((member) => member.answer !== null)
                .sort(function compareSubmittedAt(a, b) {
                         const timeDiff = (a.readyAt || 0) - (b.readyAt || 0);
                          if (timeDiff !== 0) return timeDiff;
                        return (a.readySeq || 0) - (b.readySeq || 0);
                    }
)
                .map((member) => ({
                    name: member.name,
                    answer: member.answer
                }));

            // 全員一致の判定
            if (results.length > 0) {
                const normalizedAnswers = results.map((member) => member.answer.toLowerCase());
                const firstAnswer = normalizedAnswers[0];
                const isMatch = normalizedAnswers.every((answer) => answer === firstAnswer);
                
                io.to(rid).emit('show-result', { 
                    results, 
                    isMatch,
                    answeredCount: results.length,
                    totalCount: latestRoom.members.length
                });
            } else {
                io.to(rid).emit('show-result', { 
                    results: [], 
                    isMatch: false,
                    answeredCount: 0,
                    totalCount: latestRoom.members.length
                });
            }
        });
    });

    socket.on('denpo-judge', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        asyncQueue.enqueue(rid, async () => {
            const latestRoom = getRoom(rid);
            if (!latestRoom || !isHost(latestRoom, userId)) return;

            // 入力が早い順でソート
            const results = latestRoom.members
                .filter((member) => member.answer !== null)
                .sort(compareDenpoAnswerOrder)
                .map((member, index) => ({
                    name: member.name,
                    answer: member.answer,
                    order: index + 1
                }));
``

            io.to(rid).emit('show-result', { 
                results, 
                isMatch: false,
                answeredCount: results.length,
                totalCount: latestRoom.members.length,
                gameMode: 'denpo'
            });
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

                player.socketId = null;

                setTimeout(() => {
                    const p = getPlayerByUserId(room, player.id);

                    if (p && !p.socketId) {
                        room.members = room.members.filter(m => m.id !== player.id);
                        updateRoomData(rid);
                    }
                }, 30000);

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
    console.log(`✅ 全員一致＆デンポーゲームに対応しました`);
});