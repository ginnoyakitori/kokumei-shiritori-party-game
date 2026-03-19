const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

app.use(express.static(__dirname));

const rooms = {};
const DISCONNECT_GRACE_MS = 10 * 60 * 1000;

function normalizeText(value, maxLength = 60) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function getRoom(rid) {
    if (typeof rid !== 'string') return null;
    return rooms[rid] || null;
}

function getPlayerBySocket(room, socketId) {
    if (!room) return null;
    return room.members.find((member) => member.socketId === socketId) || null;
}

function getPlayerByUserId(room, userId) {
    if (!room) return null;
    return room.members.find((member) => member.id === userId) || null;
}

function isHost(room, userId) {
    if (!room || room.members.length === 0) return false;
    const host = room.members[room.turnIndex % room.members.length];
    return !!host && host.id === userId;
}

function resetAnswers(room) {
    room.members.forEach((member) => {
        member.answer = null;
        member.readyAt = null;
    });
}

function ensureRoomTurnIndex(room) {
    if (!room || room.members.length === 0) return;
    room.turnIndex = ((room.turnIndex % room.members.length) + room.members.length) % room.members.length;
}

function removePlayerFromRoom(rid, userId) {
    const room = rooms[rid];
    if (!room) return;

    room.members = room.members.filter((member) => member.id !== userId);

    if (room.members.length === 0) {
        delete rooms[rid];
        return;
    }

    ensureRoomTurnIndex(room);
    updateRoomData(rid);
}

/**
 * 部屋のデータを全クライアントに同期する
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

io.on('connection', (socket) => {
    socket.on('join-room', ({ name, rid, userId } = {}) => {
        const normalizedName = normalizeText(name, 20);
        const normalizedRoomId = normalizeText(rid, 20);
        const normalizedUserId = normalizeText(userId, 80);

        if (!normalizedName || !normalizedRoomId || !normalizedUserId) {
            socket.emit('error-msg', '名前・部屋番号・ユーザー情報を確認してください。');
            return;
        }

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
            player.socketId = socket.id;
            player.name = normalizedName;
        } else {
            if (room.status === 'playing') {
                socket.emit('error-msg', '現在ゲーム進行中のため入室できません。');
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

    socket.on('go-to-setup', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        room.status = 'playing';
        room.currentQuestion = '';
        resetAnswers(room);
        io.to(rid).emit('move-to-setup');
        updateRoomData(rid);
    });

    socket.on('back-to-waiting', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        room.status = 'waiting';
        room.currentQuestion = '';
        resetAnswers(room);
        io.to(rid).emit('move-to-waiting');
        updateRoomData(rid);
    });

    socket.on('send-question', ({ rid, userId, question } = {}) => {
        const room = getRoom(rid);
        const normalizedQuestion = normalizeText(question, 80);
        if (!room || !isHost(room, userId) || !normalizedQuestion) return;

        room.status = 'playing';
        room.currentQuestion = normalizedQuestion;
        resetAnswers(room);
        io.to(rid).emit('receive-question', { question: normalizedQuestion });
        updateRoomData(rid);
    });

    socket.on('submit-answer', ({ rid, userId, answer } = {}) => {
        const room = getRoom(rid);
        const normalizedAnswer = normalizeText(answer, 40);
        if (!room || !room.currentQuestion || !normalizedAnswer) return;

        const player = getPlayerByUserId(room, userId);
        if (!player || player.socketId !== socket.id || player.answer !== null) return;

        player.answer = normalizedAnswer;
        player.readyAt = Date.now();
        updateRoomData(rid);
    });

    socket.on('host-judge', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

        const answeredPlayers = room.members.filter((member) => member.answer !== null);
        if (answeredPlayers.length !== room.members.length) {
            socket.emit('error-msg', '全員が回答してから結果を開いてください。');
            return;
        }

        const normalizedAnswers = answeredPlayers.map((member) => member.answer.toLowerCase());
        const firstAnswer = normalizedAnswers[0];
        const isMatch = normalizedAnswers.every((answer) => answer === firstAnswer);
        const results = room.members.map((member) => ({
            name: member.name,
            answer: member.answer
        }));

        io.to(rid).emit('show-result', { results, isMatch });
    });

    socket.on('next-round', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId) || room.members.length === 0) return;

        room.turnIndex = (room.turnIndex + 1) % room.members.length;
        room.currentQuestion = '';
        resetAnswers(room);
        updateRoomData(rid);
        io.to(rid).emit('prepare-next-round');
    });

    socket.on('leave-room', ({ rid, userId } = {}) => {
        const room = getRoom(rid);
        const player = getPlayerByUserId(room, userId);
        if (!room || !player || player.socketId !== socket.id) return;

        socket.leave(rid);
        removePlayerFromRoom(rid, userId);
        socket.emit('left-success');
    });

    socket.on('disconnect', () => {
        Object.entries(rooms).forEach(([rid, room]) => {
            const player = getPlayerBySocket(room, socket.id);
            if (!player) return;

            player.socketId = null;
            updateRoomData(rid);

            const waitTime = room.status === 'waiting' ? 1000 : DISCONNECT_GRACE_MS;
            setTimeout(() => {
                const latestRoom = rooms[rid];
                const latestPlayer = getPlayerByUserId(latestRoom, player.id);
                if (!latestRoom || !latestPlayer || latestPlayer.socketId) return;
                removePlayerFromRoom(rid, player.id);
            }, waitTime);
        });
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`server start ${PORT}`);
});