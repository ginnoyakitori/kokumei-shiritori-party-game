const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};

function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room) return;
    
    const host = room.members[room.turnIndex];
    
    // 回答済みのプレイヤーだけを抽出して、提出順にソート
    const readyPlayers = room.members
        .filter(m => m.answer !== null)
        .sort((a, b) => a.readyAt - b.readyAt)
        .map((m, index) => ({
            id: m.id,
            name: m.name,
            order: index + 1
        }));

    io.to(rid).emit('room-data', {
        rid,
        readyMembers: readyPlayers, // 提出済みの人だけのリスト
        totalMemberCount: room.members.length, // 全員の人数（判定用）
        hostId: host ? host.id : null,
        status: room.status
    });
}

io.on('connection', (socket) => {
    socket.on('join-room', ({ name, rid }) => {
        if (!rooms[rid]) rooms[rid] = { turnIndex: 0, members: [], status: 'waiting' };
        if (rooms[rid].status === 'playing' && !rooms[rid].members.find(m => m.id === socket.id)) {
            return socket.emit('error-msg', '進行中です');
        }
        socket.join(rid);
        if (!rooms[rid].members.find(m => m.id === socket.id)) {
            rooms[rid].members.push({ id: socket.id, name, answer: null, readyAt: null });
        }
        updateRoomData(rid);
    });

    socket.on('go-to-setup', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].status = 'playing';
            io.to(rid).emit('move-to-setup');
            updateRoomData(rid);
        }
    });

    socket.on('submit-answer', ({ rid, answer }) => {
        const room = rooms[rid];
        if (room) {
            const player = room.members.find(p => p.id === socket.id);
            if (player && player.answer === null) {
                player.answer = answer;
                player.readyAt = Date.now();
            }
            updateRoomData(rid);
        }
    });

    socket.on('host-judge', ({ rid, isMatch }) => {
        const room = rooms[rid];
        if (!room) return;
        const results = room.members.map(p => ({ name: p.name, answer: p.answer }));
        io.to(rid).emit('show-result', { isMatch, results });
    });

    socket.on('next-round', ({ rid }) => {
        const room = rooms[rid];
        if (room) {
            room.turnIndex = (room.turnIndex + 1) % room.members.length;
            room.members.forEach(p => { p.answer = null; p.readyAt = null; });
            updateRoomData(rid);
            io.to(rid).emit('prepare-next-round');
        }
    });

    socket.on('back-to-waiting', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].status = 'waiting';
            io.to(rid).emit('move-to-waiting');
            updateRoomData(rid);
        }
    });

    socket.on('send-question', ({ rid, question }) => {
        io.to(rid).emit('receive-question', { question });
    });

    socket.on('leave-room', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].members = rooms[rid].members.filter(p => p.id !== socket.id);
            if (rooms[rid].members.length === 0) delete rooms[rid];
            else updateRoomData(rid);
        }
        socket.emit('left-success');
    });

    socket.on('disconnect', () => {
        for (const rid in rooms) {
            rooms[rid].members = rooms[rid].members.filter(p => p.id !== socket.id);
            if (rooms[rid].members.length === 0) delete rooms[rid];
            else updateRoomData(rid);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0');