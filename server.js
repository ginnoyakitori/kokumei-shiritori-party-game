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
    // 各プレイヤーの「名前」と「回答済みか(isReady)」を送信
    const membersData = room.members.map(m => ({
        id: m.id,
        name: m.name,
        isReady: m.answer !== null
    }));

    io.to(rid).emit('room-data', {
        rid,
        members: membersData,
        hostId: host ? host.id : null,
        hostName: host ? host.name : "待機中"
    });
}

io.on('connection', (socket) => {
    socket.on('join-room', ({ name, rid }) => {
        socket.join(rid);
        if (!rooms[rid]) rooms[rid] = { turnIndex: 0, members: [] };
        rooms[rid].members.push({ id: socket.id, name, answer: null });
        updateRoomData(rid);
    });

    socket.on('send-question', ({ rid, question }) => {
        io.to(rid).emit('receive-question', { question });
    });

    socket.on('submit-answer', ({ rid, answer }) => {
        const room = rooms[rid];
        if (!room) return;
        const player = room.members.find(p => p.id === socket.id);
        if (player) player.answer = answer;
        updateRoomData(rid); // Ready状態を全員に通知
    });

    socket.on('host-judge', ({ rid, isMatch }) => {
        const room = rooms[rid];
        if (!room) return;
        const results = room.members.map(p => ({ name: p.name, answer: p.answer }));
        io.to(rid).emit('show-result', { isMatch, results });
    });

    socket.on('next-round', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;
        room.turnIndex = (room.turnIndex + 1) % room.members.length;
        room.members.forEach(p => p.answer = null);
        updateRoomData(rid);
        io.to(rid).emit('prepare-next-round');
    });

    socket.on('disconnect', () => {
        for (const rid in rooms) {
            rooms[rid].members = rooms[rid].members.filter(p => p.id !== socket.id);
            if (rooms[rid].members.length === 0) delete rooms[rid];
            else {
                rooms[rid].turnIndex = rooms[rid].turnIndex % rooms[rid].members.length;
                updateRoomData(rid);
            }
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));