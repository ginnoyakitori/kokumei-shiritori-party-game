const express = require('express'); 
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};
const socketRoomMap = {}; // socketID → roomID

// 部屋の状態を全員に同期
function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room) return;

    if (room.members.length === 0) return;

    const host = room.members[room.turnIndex];

    const allMembers = room.members.map(m => ({
        id: m.id,
        name: m.name,
        isHost: m.id === (host ? host.id : null),
        isOnline: !!m.socketId
    }));

    const readyPlayers = room.members
        .filter(m => m.answer !== null)
        .sort((a, b) => a.readyAt - b.readyAt)
        .map((m, index) => ({
            name: m.name,
            order: index + 1
        }));

    io.to(rid).emit('room-data', {
        rid,
        allMembers,
        readyMembers: readyPlayers,
        totalMemberCount: room.members.length,
        status: room.status,
        hostId: host ? host.id : null
    });
}

io.on('connection', (socket) => {

    // 入室
    socket.on('join-room', ({ name, rid, userId }) => {

        if (!rooms[rid]) {
            rooms[rid] = { turnIndex: 0, members: [], status: 'waiting' };
        }

        const room = rooms[rid];

        let player = room.members.find(m => m.id === userId);

        if (player) {

            // 再接続
            if (player.disconnectTimer) {
                clearTimeout(player.disconnectTimer);
                player.disconnectTimer = null;
            }

            player.socketId = socket.id;
            if (name) player.name = name;

        } else {

            if (room.status === 'playing') {
                return socket.emit('error-msg', '現在ゲーム進行中のため入室できません。');
            }

            player = {
                id: userId,
                socketId: socket.id,
                name,
                answer: null,
                readyAt: null,
                disconnectTimer: null
            };

            room.members.push(player);
        }

        socketRoomMap[socket.id] = rid;

        socket.join(rid);

        updateRoomData(rid);
    });

    // ゲーム開始
    socket.on('go-to-setup', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;

        room.status = 'playing';
        io.to(rid).emit('move-to-setup');
        updateRoomData(rid);
    });

    socket.on('back-to-waiting', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;

        room.status = 'waiting';
        io.to(rid).emit('move-to-waiting');
        updateRoomData(rid);
    });

    // 問題送信
    socket.on('send-question', ({ rid, question }) => {
        io.to(rid).emit('receive-question', { question });
    });

    // 回答
    socket.on('submit-answer', ({ rid, userId, answer }) => {
        const room = rooms[rid];
        if (!room) return;

        const player = room.members.find(p => p.id === userId);
        if (!player) return;

        if (player.answer === null) {
            player.answer = answer;
            player.readyAt = Date.now();
        }

        updateRoomData(rid);
    });

    // 結果表示
    socket.on('host-judge', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;

        const results = room.members.map(p => ({
            name: p.name,
            answer: p.answer
        }));

        io.to(rid).emit('show-result', { results });
    });

    // 次ラウンド
    socket.on('next-round', ({ rid }) => {
        const room = rooms[rid];
        if (!room) return;

        if (room.members.length === 0) return;

        room.turnIndex = (room.turnIndex + 1) % room.members.length;

        room.members.forEach(p => {
            p.answer = null;
            p.readyAt = null;
        });

        updateRoomData(rid);

        io.to(rid).emit('prepare-next-round');
    });

    // 退出
    socket.on('leave-room', ({ rid, userId }) => {

        const room = rooms[rid];
        if (!room) return;

        const index = room.members.findIndex(p => p.id === userId);
        if (index !== -1) {
            const player = room.members[index];

            if (player.disconnectTimer) {
                clearTimeout(player.disconnectTimer);
            }

            room.members.splice(index, 1);
        }

        if (room.members.length === 0) {
            delete rooms[rid];
        } else {
            room.turnIndex = room.turnIndex % room.members.length;
            updateRoomData(rid);
        }

        socket.leave(rid);

        delete socketRoomMap[socket.id];

        socket.emit('left-success');
    });

    // 切断
    socket.on('disconnect', () => {

        const rid = socketRoomMap[socket.id];
        delete socketRoomMap[socket.id];

        if (!rid) return;

        const room = rooms[rid];
        if (!room) return;

        const player = room.members.find(m => m.socketId === socket.id);
        if (!player) return;

        player.socketId = null;

        // 再接続猶予
        player.disconnectTimer = setTimeout(() => {

            const r = rooms[rid];
            if (!r) return;

            r.members = r.members.filter(m => m.id !== player.id);

            if (r.members.length === 0) {
                delete rooms[rid];
            } else {
                r.turnIndex = r.turnIndex % r.members.length;
                updateRoomData(rid);
            }

        }, 600000); // 10分

        updateRoomData(rid);
    });

});

const PORT = process.env.PORT || 10000;

server.listen(PORT, '0.0.0.0', () => {
    console.log("server start");
});