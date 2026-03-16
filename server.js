const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const rooms = {};

/**
 * 部屋の最新状態を全メンバーに送信する
 */
function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room) return;
    
    const host = room.members[room.turnIndex];
    
    // 1. 全員のリスト (待機画面用)
    const allMembers = room.members.map(m => ({
        id: m.id,
        name: m.name,
        isHost: m.id === (host ? host.id : null)
    }));

    // 2. 回答済みのプレイヤーを抽出して提出順(readyAt)にソート (ゲーム画面用)
    const readyPlayers = room.members
        .filter(m => m.answer !== null)
        .sort((a, b) => a.readyAt - b.readyAt)
        .map((m, index) => ({
            name: m.name,
            order: index + 1 // 提出順位
        }));

    io.to(rid).emit('room-data', {
        rid,
        allMembers: allMembers,       // 全員の名簿
        readyMembers: readyPlayers,   // 回答済みの人のみ（提出順）
        totalMemberCount: room.members.length,
        hostId: host ? host.id : null,
        status: room.status // 'waiting' か 'playing'
    });
}

io.on('connection', (socket) => {
    // --- 入室処理 ---
    socket.on('join-room', ({ name, rid }) => {
        if (!rooms[rid]) {
            rooms[rid] = { turnIndex: 0, members: [], status: 'waiting' };
        }

        // ゲーム進行中の場合は、既存メンバー以外の入室を拒否
        const isExisting = rooms[rid].members.find(m => m.id === socket.id);
        if (rooms[rid].status === 'playing' && !isExisting) {
            return socket.emit('error-msg', '現在ゲーム進行中のため入室できません。');
        }

        socket.join(rid);
        if (!isExisting) {
            rooms[rid].members.push({ id: socket.id, name, answer: null, readyAt: null });
        }
        updateRoomData(rid);
    });

    // --- 画面遷移コントロール ---
    socket.on('go-to-setup', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].status = 'playing'; // 入室制限開始
            io.to(rid).emit('move-to-setup');
            updateRoomData(rid);
        }
    });

    socket.on('back-to-waiting', ({ rid }) => {
        if (rooms[rid]) {
            rooms[rid].status = 'waiting'; // 入室制限解除
            io.to(rid).emit('move-to-waiting');
            updateRoomData(rid);
        }
    });

    // --- ゲームロジック ---
    socket.on('send-question', ({ rid, question }) => {
        io.to(rid).emit('receive-question', { question });
    });

    socket.on('submit-answer', ({ rid, answer }) => {
        const room = rooms[rid];
        if (room) {
            const player = room.members.find(p => p.id === socket.id);
            if (player && player.answer === null) {
                player.answer = answer;
                player.readyAt = Date.now(); // 提出した瞬間のサーバー時刻を記録
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
        // 次の親（ホスト）へ交代
        room.turnIndex = (room.turnIndex + 1) % room.members.length;
        // 全員の回答をリセット
        room.members.forEach(p => { 
            p.answer = null; 
            p.readyAt = null; 
        });
        updateRoomData(rid);
        io.to(rid).emit('prepare-next-round');
    });

    // --- 退出・切断処理 ---
    const handleLeave = (socket, rid) => {
        if (!rooms[rid]) return;
        rooms[rid].members = rooms[rid].members.filter(p => p.id !== socket.id);
        socket.leave(rid);
        
        if (rooms[rid].members.length === 0) {
            delete rooms[rid];
        } else {
            rooms[rid].turnIndex = rooms[rid].turnIndex % rooms[rid].members.length;
            updateRoomData(rid);
        }
    };

    socket.on('leave-room', ({ rid }) => {
        handleLeave(socket, rid);
        socket.emit('left-success');
    });

    socket.on('disconnect', () => {
        for (const rid in rooms) {
            handleLeave(socket, rid);
        }
    });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});