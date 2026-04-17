require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const tmi = require('tmi.js');
const { google } = require('googleapis');
const WebSocket = require('ws'); // <-- La solución definitiva para Kick

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ==========================================
// 1. INTEGRACIÓN CON TWITCH
// ==========================================
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL || 'GalardonMT'; // set via .env
if (!process.env.TWITCH_CHANNEL) {
    console.log('TWITCH_CHANNEL no definido en .env — usando valor por defecto:', TWITCH_CHANNEL);
}

const twitchClient = new tmi.Client({
    channels: [TWITCH_CHANNEL]
});
twitchClient.connect().catch(console.error);

twitchClient.on('message', (channel, tags, message, self) => {
    if (self) return; 
    io.emit('nuevo_mensaje', {
        plataforma: 'twitch',
        usuario: tags['display-name'],
        mensaje: message
    });
});

// ==========================================
// 2. INTEGRACIÓN CON KICK (Vía WebSocket Puro)
// ==========================================
if (process.env.KICK_CHATROOM_ID) {
    // Nos conectamos directamente al clúster 'us2' de Pusher que usa Kick
    const kickWs = new WebSocket('wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false');

    kickWs.on('open', () => {
        console.log("Conectado al WebSocket de Kick.");
        
        // Le decimos a Pusher que queremos escuchar tu chatroom
        const subscribeMessage = JSON.stringify({
            event: "pusher:subscribe",
            data: {
                auth: "",
                channel: `chatrooms.${process.env.KICK_CHATROOM_ID}.v2`
            }
        });
        kickWs.send(subscribeMessage);
    });

    kickWs.on('message', (data) => {
        const parsed = JSON.parse(data);
        
        // Pusher manda varios eventos internos. Solo nos importan los mensajes de chat.
        if (parsed.event === 'App\\Events\\ChatMessageEvent') {
            const messageData = JSON.parse(parsed.data);
            
            io.emit('nuevo_mensaje', {
                plataforma: 'kick',
                usuario: messageData.sender.username,
                mensaje: messageData.content
            });
        }
    });

    // Pusher cierra la conexión si no hay actividad. Enviamos un "ping" cada 30 segundos.
    setInterval(() => {
        if (kickWs.readyState === WebSocket.OPEN) {
            kickWs.send(JSON.stringify({ event: "pusher:ping", data: {} }));
        }
    }, 30000);

} else {
    console.log("Falta el KICK_CHATROOM_ID en el archivo .env");
}

// ==========================================
// 3. INTEGRACIÓN CON YOUTUBE
// ==========================================
const youtube = google.youtube({
    version: 'v3',
    auth: process.env.YOUTUBE_API_KEY
});

let ytLiveChatId = null;
let ytNextPageToken = '';

async function getLiveVideoIdFromChannel(channelId) {
    const res = await youtube.search.list({
        part: 'id',
        channelId,
        eventType: 'live',
        type: 'video',
        maxResults: 1
    });

    const firstItem = res.data.items && res.data.items[0];
    return firstItem?.id?.videoId || null;
}

async function initYouTube() {
    try {
        let videoId = process.env.YOUTUBE_VIDEO_ID;

        // If VIDEO_ID is not provided, resolve current live stream using CHANNEL_ID.
        if (!videoId && process.env.YOUTUBE_CHANNEL_ID) {
            videoId = await getLiveVideoIdFromChannel(process.env.YOUTUBE_CHANNEL_ID);
            if (!videoId) {
                console.log('No se encontro un live activo para YOUTUBE_CHANNEL_ID.');
                return;
            }
        }

        if (!videoId) {
            console.log('Falta YOUTUBE_VIDEO_ID o YOUTUBE_CHANNEL_ID en el archivo .env');
            return;
        }
        
        const res = await youtube.videos.list({
            part: 'liveStreamingDetails',
            id: videoId
        });

        if (res.data.items && res.data.items.length > 0) {
            ytLiveChatId = res.data.items[0].liveStreamingDetails.activeLiveChatId;
            if (!ytLiveChatId) {
                console.log('El live de YouTube no tiene chat activo.');
                return;
            }
            console.log("Conectado al chat de YouTube.");
            pollYouTubeChat(); 
        } else {
            console.log('No se pudo obtener liveStreamingDetails para YouTube.');
        }
    } catch (err) {
        console.error("Error conectando a YouTube:", err.message);
    }
}

async function pollYouTubeChat() {
    if (!ytLiveChatId) return;

    try {
        const res = await youtube.liveChatMessages.list({
            liveChatId: ytLiveChatId,
            part: 'snippet,authorDetails',
            pageToken: ytNextPageToken
        });

        ytNextPageToken = res.data.nextPageToken;
        const messages = res.data.items;

        if (messages && messages.length > 0) {
            messages.forEach(msg => {
                io.emit('nuevo_mensaje', {
                    plataforma: 'youtube',
                    usuario: msg.authorDetails.displayName,
                    mensaje: msg.snippet.displayMessage
                });
            });
        }
    } catch (err) {
        console.error("Error leyendo YouTube:", err.message);
    }

    setTimeout(pollYouTubeChat, 5000);
}

initYouTube();

// ==========================================
// INICIO DEL SERVIDOR
// ==========================================
const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Servidor unificado corriendo en http://localhost:${PORT}`);
});