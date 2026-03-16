const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server,{
    cors:{origin:"*"}
});

app.use(express.static(__dirname));

const rooms = {};

function updateRoomData(rid){

    const room = rooms[rid];
    if(!room) return;

    const host = room.members[room.turnIndex];

    const allMembers = room.members.map(m=>({
        id:m.id,
        name:m.name,
        isHost:m.id === (host ? host.id : null),
        isOnline:!!m.socketId
    }));

    const readyPlayers = room.members
    .filter(m=>m.answer !== null)
    .sort((a,b)=>a.readyAt-b.readyAt)
    .map((m,i)=>({
        name:m.name,
        order:i+1
    }));

    io.to(rid).emit('room-data',{
        rid,
        allMembers,
        readyMembers:readyPlayers,
        totalMemberCount:room.members.length,
        status:room.status,
        hostId:host?host.id:null
    });

}

io.on('connection',(socket)=>{

    socket.on('join-room',({name,rid,userId})=>{

        if(!rooms[rid]){
            rooms[rid]={
                turnIndex:0,
                members:[],
                status:'waiting'
            };
        }

        const room = rooms[rid];

        let player = room.members.find(m=>m.id===userId);

        if(player){

            player.socketId = socket.id;

            if(name) player.name = name;

        }else{

            if(room.status==='playing'){
                return socket.emit('error-msg','ゲーム進行中です');
            }

            player={
                id:userId,
                socketId:socket.id,
                name,
                answer:null,
                readyAt:null
            };

            room.members.push(player);

        }

        socket.join(rid);

        updateRoomData(rid);

    });

    socket.on('go-to-setup',({rid})=>{

        if(!rooms[rid]) return;

        rooms[rid].status='playing';

        io.to(rid).emit('move-to-setup');

        updateRoomData(rid);

    });

    socket.on('back-to-waiting',({rid})=>{

        if(!rooms[rid]) return;

        rooms[rid].status='waiting';

        io.to(rid).emit('move-to-waiting');

        updateRoomData(rid);

    });

    socket.on('send-question',({rid,question})=>{

        io.to(rid).emit('receive-question',{question});

    });

    socket.on('submit-answer',({rid,userId,answer})=>{

        const room = rooms[rid];
        if(!room) return;

        const player = room.members.find(p=>p.id===userId);

        if(player && player.answer===null){

            player.answer=answer;
            player.readyAt=Date.now();

        }

        updateRoomData(rid);

    });

    socket.on('host-judge',({rid})=>{

        const room = rooms[rid];
        if(!room) return;

        const results = room.members.map(p=>({
            name:p.name,
            answer:p.answer
        }));

        io.to(rid).emit('show-result',{results});

    });

    socket.on('next-round',({rid})=>{

        const room = rooms[rid];
        if(!room) return;

        room.turnIndex = (room.turnIndex+1) % room.members.length;

        room.members.forEach(p=>{
            p.answer=null;
            p.readyAt=null;
        });

        updateRoomData(rid);

        io.to(rid).emit('prepare-next-round');

    });

    socket.on('leave-room',({rid,userId})=>{

        if(!rooms[rid]) return;

        const room = rooms[rid];

        room.members = room.members.filter(p=>p.id!==userId);

        socket.leave(rid);

        if(room.members.length===0){

            delete rooms[rid];

        }else{

            room.turnIndex = room.turnIndex % room.members.length;

            updateRoomData(rid);

        }

        socket.emit('left-success');

    });

    socket.on('disconnect',()=>{

        for(const rid in rooms){

            const room = rooms[rid];

            const player = room.members.find(m=>m.socketId===socket.id);

            if(player){

                player.socketId=null;

                setTimeout(()=>{

                    if(rooms[rid] && !player.socketId){

                        rooms[rid].members = rooms[rid].members.filter(m=>m.id!==player.id);

                        if(rooms[rid].members.length===0){

                            delete rooms[rid];

                        }else{

                            updateRoomData(rid);

                        }

                    }

                },600000);

                updateRoomData(rid);

            }

        }

    });

});

const PORT = process.env.PORT || 10000;

server.listen(PORT,'0.0.0.0',()=>{

    console.log("server start "+PORT);

});