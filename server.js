const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // 外部からの接続を許可
        methods: ["GET", "POST"]
    }
});

// 静的ファイルの提供（index.html, script.js など）
app.use(express.static(__dirname));

// ルーム管理: { roomId: { turnIndex: 0, members: [{id, name, answer}] } }
const rooms = {};

/**
 * 部屋の最新状態（メンバー、現在の親）を全員に配信する
 */
function updateRoomData(rid) {
    const room = rooms[rid];
    if (!room) return;
    
    const host = room.members[room.turnIndex];
    io.to(rid).emit('room-data', {
        rid,
        members: room.members.map(m => m.name),
        hostId: host ? host.id : null,
        hostName: host ? host.name : "待機中"
    });
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 入室処理
    socket.on('join-room', ({ name, rid }) => {
        socket.join(rid);
        if (!rooms[rid]) {
            rooms[rid] = { turnIndex: 0, members: [] };
        }
        rooms[rid].members.push({ id: socket.id, name, answer: null });
        updateRoomData(rid);
    });

    // お題の配信
    socket.on('send-question', ({ rid, question }) => {
        io.to(rid).emit('receive-question', { question });
    });

    // 回答の送信
    socket.on('submit-answer', ({ rid, answer }) => {
        const room = rooms[rid];
        if (!room) return;
        const player = room.members.find(p => p.id === socket.id);
        if (player) player.answer = answer;

        // 全員揃ったか確認
        const allAnswered = room.members.every(p => p.answer !== null);
        if (allAnswered) {
            const hostId = room.members[room.turnIndex].id;
            io.to(hostId).emit('all-answered-notification');
        }
    });

    // ホストによる手動判定（全員に結果を送信）
    socket.on('host-judge', ({ rid, isMatch }) => {
        const room = rooms[rid];
        if (!room) return;
        const results = room.members.map(p => ({ name: p.name, answer: p.answer }));
        io.to(rid).emit('show-result', { isMatch, results });
    });

    // 次のラウンド（親を交代して画面をリセット）
    socket.on('next-round', ({ rid }) => {
        const room = rooms[rid];
        if (!room || room.members.length === 0) return;
        
        // 親の順番を次に進める
        room.turnIndex = (room.turnIndex + 1) % room.members.length;
        // 回答をクリア
        room.members.forEach(p => p.answer = null);
        
        updateRoomData(rid);
        io.to(rid).emit('prepare-next-round');
    });

    // 切断時の処理
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        for (const rid in rooms) {
            const room = rooms[rid];
            const index = room.members.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.members.splice(index, 1);
                if (room.members.length === 0) {
                    delete rooms[rid];
                } else {
                    // 親がいなくなった場合のインデックス調整
                    room.turnIndex = room.turnIndex % room.members.length;
                    updateRoomData(rid);
                }
            }
        }
    });
});

// Renderなどの環境に対応するためのポート設定
const PORT = process.env.PORT || 10000;
// '0.0.0.0' を指定することで外部からのアクセスを受け入れる
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
});