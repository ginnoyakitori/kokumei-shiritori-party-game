const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server,{cors:{origin:"*"}});

app.use(express.static(__dirname));

const rooms = {};

function updateRoom(rid){

const room=rooms[rid];
if(!room) return;

const host=room.members[room.turnIndex];

io.to(rid).emit("room-data",{
rid,
members:room.members.map(m=>({
id:m.id,
name:m.name,
online:!!m.socketId,
isHost:host && host.id===m.id
})),
hostId:host?host.id:null,
status:room.status
});

}

function nextHost(room){

room.turnIndex=(room.turnIndex+1)%room.members.length;

}

io.on("connection",(socket)=>{

socket.on("join-room",({rid,name,userId})=>{

if(!rooms[rid]){

rooms[rid]={
members:[],
turnIndex:0,
status:"waiting"
};

}

const room=rooms[rid];

let player=room.members.find(p=>p.id===userId);

if(player){

player.socketId=socket.id;
player.name=name;

}else{

if(room.status==="playing"){
return socket.emit("error-msg","ゲーム進行中");
}

player={
id:userId,
socketId:socket.id,
name,
answer:null
};

room.members.push(player);

}

socket.join(rid);

updateRoom(rid);

});

socket.on("start-game",({rid,question})=>{

const room=rooms[rid];
if(!room) return;

room.status="playing";
room.question=question;

room.members.forEach(p=>p.answer=null);

io.to(rid).emit("game-start",{
question
});

updateRoom(rid);

});

socket.on("submit-answer",({rid,userId,answer})=>{

const room=rooms[rid];
if(!room) return;

const p=room.members.find(m=>m.id===userId);

if(p && p.answer===null){
p.answer=answer;
}

const answered=room.members.filter(m=>m.answer!==null).length;

if(answered===room.members.length){

const results=room.members.map(m=>({
name:m.name,
answer:m.answer
}));

io.to(rid).emit("show-result",{results});

}

});

socket.on("next-round",({rid})=>{

const room=rooms[rid];
if(!room) return;

nextHost(room);

room.members.forEach(p=>p.answer=null);

room.status="waiting";

updateRoom(rid);

});

socket.on("leave-room",({rid,userId})=>{

const room=rooms[rid];
if(!room) return;

room.members=room.members.filter(p=>p.id!==userId);

socket.leave(rid);

if(room.members.length===0){

delete rooms[rid];

}else{

room.turnIndex%=room.members.length;

updateRoom(rid);

}

});

socket.on("disconnect",()=>{

for(const rid in rooms){

const room=rooms[rid];

const p=room.members.find(m=>m.socketId===socket.id);

if(p){

p.socketId=null;

setTimeout(()=>{

if(rooms[rid] && !p.socketId){

rooms[rid].members=rooms[rid].members.filter(m=>m.id!==p.id);

if(rooms[rid].members.length===0){

delete rooms[rid];

}else{

updateRoom(rid);

}

}

},600000);

updateRoom(rid);

}

}

});

});

const PORT=process.env.PORT||10000;

server.listen(PORT,"0.0.0.0",()=>{

console.log("server start "+PORT);

});