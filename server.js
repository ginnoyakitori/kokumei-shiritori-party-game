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

function getRoom(rid) {
    if (typeof rid !== 'string') return null;
    return rooms[rid] || null;
}

function getPlayerByUserId(room, userId) {
    if (!room || !room.members) return null;
    return room.members.find(m => m.id === userId) || null;
}

function isHost(room, userId) {
    if (!room || room.members.length === 0) return false;
    const host = room.members[room.turnIndex % room.members.length];
    return host && host.id === userId;
}

function resetAnswers(room) {
    if (!room || !room.members) return;
    room.answerSeq = 0;

    room.members.forEach(m => {
        m.answer = null;
        m.readyAt = null;
        m.readySeq = null;
    });
}

function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room) return;

    const host = room.members[room.turnIndex];

    let readyPlayers = [];

    if (room.gameMode === 'denpo') {
        readyPlayers = room.members
            .filter(m => m.answer !== null)
            .sort(compareDenpoAnswerOrder)
            .map((m, i) => ({
                name: m.name,
                order: i + 1
            }));
    } else {
        readyPlayers = room.members
            .filter(m => m.answer !== null)
            .sort(compareSubmittedAt)
            .map((m, i) => ({
                name: m.name,
                order: i + 1
            }));
    }

    io.to(rid).emit('room-data', {
        rid,
        allMembers: room.members,
        readyMembers: readyPlayers,
        totalMemberCount: room.members.length,
        status: room.status,
        hostId: host?.id,
        currentQuestion: room.currentQuestion || '',
        hasQuestion: Boolean(room.currentQuestion),
        gameMode: room.gameMode
    });
}

io.on('connection', (socket) => {

    socket.on('join-room', ({ name, rid, userId, gameMode }) => {
        name = normalizeText(name);
        rid = normalizeText(rid);

        if (!rooms[rid]) {
            rooms[rid] = {
                members: [],
                turnIndex: 0,
                status: 'waiting',
                currentQuestion: '',
                gameMode: normalizeGameMode(gameMode),
                answerSeq: 0
            };
        }

        const room = rooms[rid];

        room.members.push({
            id: userId,
            socketId: socket.id,
            name,
            answer: null,
            readyAt: null,
            readySeq: null
        });

        socket.join(rid);
        updateRoomData(rid);
    });

    socket.on('denpo-judge', ({ rid, userId }) => {
        const room = getRoom(rid);
        if (!room || !isHost(room, userId)) return;

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