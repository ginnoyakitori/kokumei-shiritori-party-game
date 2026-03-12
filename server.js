const http = require("http");
http.createServer((req,res)=>{res.end("party-game");}).listen(process.env.PORT||4173);
