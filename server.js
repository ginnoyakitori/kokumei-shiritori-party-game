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
    const readyPlayers = room.members
        .filter(m => m.answer !== null)
        .sort((a, b) => a.readyAt - b.readyAt);

    const membersData = room.members.map(m => {
        const readyIndex = readyPlayers.findIndex(p => p.id === m.id);
        return {
            id: m.id,
            name: m.name,
            isReady: m.answer !== null,
            readyOrder: readyIndex !== -1 ? readyIndex + 1 : null
        };
    });

    io.to(rid).emit('room-data', {
        rid,
        members: membersData,
        hostId: host ? host.id : null,
        status: room.status // 'waiting' or 'playing'
    });
}

io.on('connection', (socket) => {
    socket.on('join-room', ({ name, rid }) => {
        if (!rooms[rid]) {
            rooms[rid] = { turnIndex: 0, members: [], status: 'waiting' };
        }

        // ゲーム進行中の場合は拒否
        if (rooms[rid].status === 'playing') {
            return socket.emit('error-msg', '現在ゲーム進行中のため入室できません。');
        }

        socket.join(rid);
        rooms[rid].members.push({ id: socket.id, name, answer: null, readyAt: null });
        updateRoomData(rid);
    });

    // 待機室から「お題設定」へ移動（入室制限開始）
    socket.on('go-to-setup', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].status = 'playing';
            io.to(rid).emit('move-to-setup');
            updateRoomData(rid);
        }
    });

    // お題設定から待機室へ戻る（入室制限解除）
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

    socket.on('submit-answer', ({ rid, answer }) => {
        const room = rooms[rid];
        if (room) {
            const player = room.members.find(p => p.id === socket.id);
            if (player) {
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
        if (!room) return;
        room.turnIndex = (room.turnIndex + 1) % room.members.length;
        room.members.forEach(p => { p.answer = null; p.readyAt = null; });
        updateRoomData(rid);
        io.to(rid).emit('prepare-next-round');
    });

    socket.on('leave-room', ({ rid }) => {
        leave(socket, rid);
    });

    socket.on('disconnect', () => {
        for (const rid in rooms) {
            leave(socket, rid);
        }
    });

    function leave(socket, rid) {
        if (!rooms[rid]) return;
        rooms[rid].members = rooms[rid].members.filter(p => p.id !== socket.id);
        socket.leave(rid);
        if (rooms[rid].members.length === 0) {
            delete rooms[rid];
        } else {
            rooms[rid].turnIndex = rooms[rid].turnIndex % rooms[rid].members.length;
            updateRoomData(rid);
        }
        socket.emit('left-success');
    }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0');