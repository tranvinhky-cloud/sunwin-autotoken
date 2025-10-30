const Fastify = require("fastify");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const fetch = require('node-fetch'); // Mày phải cài cái này: npm i node-fetch

const fastify = Fastify({ logger: false });
const PORT = process.env.PORT || 10002;
const HISTORY_FILE = path.join(__dirname, 'taixiu_history.json');
const FIREBASE_URL = 'https://txsunwinbot-default-rtdb.firebaseio.com/tokenfr.json';

let rikResults = [];
let rikCurrentSession = null;
let rikWS = null;
let rikIntervalCmd = null;
let reconnectTimeout = null;
let heartbeatInterval = null;
let pingInterval = null;
let isAuthenticated = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Biến theo dõi trạng thái heartbeat
let lastPongTime = Date.now();
let heartbeatTimeout = null;
let isConnectionHealthy = false;
const HEARTBEAT_INTERVAL = 8000;
const HEARTBEAT_TIMEOUT = 12000;
const PING_INTERVAL = 25000;

// ==================== LẤY TOKEN TỪ FIREBASE ====================
async function getAuthData() {
    console.log('🔥 Đang lấy thông tin xác thực từ Firebase...');
    try {
        const response = await fetch(FIREBASE_URL);
        if (!response.ok) {
            throw new Error(`Đéo lấy được dữ liệu, status: ${response.status}`);
        }
        const firebaseData = await response.json();
        
        const dataArray = firebaseData.data;
        const username1 = dataArray[2];
        const username2 = dataArray[3];
        const authObject = dataArray[4];
        
        const infoString = authObject.info;
        const signature = authObject.signature;
        
        const infoObject = JSON.parse(infoString);
        const wsToken = infoObject.wsToken;

        console.log('✅ Lấy thông tin xác thực thành công!');
        return {
            wsToken,
            username1,
            username2,
            info: infoString,
            signature
        };
    } catch (err) {
        console.error('❌ Lỗi vãi lồn khi lấy dữ liệu từ Firebase:', err.message);
        return null;
    }
}

// Load lịch sử
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            rikResults = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            console.log(`📚 Loaded ${rikResults.length} history records`);
        }
    } catch (err) {
        console.error('Error loading history:', err);
    }
}

// Lưu lịch sử
function saveHistory() {
    try {
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(rikResults), 'utf8');
    } catch (err) {
        console.error('Error saving history:', err);
    }
}

// Xác định Tài/Xỉu
function getTX(d1, d2, d3) {
    return d1 + d2 + d3 >= 11 ? "T" : "X";
}

// Gửi heartbeat (ping định kỳ)
function sendHeartbeat() {
    if (rikWS?.readyState === WebSocket.OPEN && isAuthenticated) {
        try {
            rikWS.ping(JSON.stringify({ type: 'heartbeat', timestamp: Date.now() }));
            console.log("❤️ Sent heartbeat ping");
            
            heartbeatTimeout = setTimeout(() => {
                if ((Date.now() - lastPongTime) > HEARTBEAT_TIMEOUT) {
                    console.log("💔 No pong response, terminating connection...");
                    isConnectionHealthy = false;
                    rikWS.terminate(); // Đóng kết nối ngay lập tức để trigger reconnect
                }
            }, HEARTBEAT_TIMEOUT);
            
        } catch (err) {
            console.error("Heartbeat ping error:", err);
            isConnectionHealthy = false;
        }
    }
}

// Gửi ping keep-alive
function sendKeepAlivePing() {
    if (rikWS?.readyState === WebSocket.OPEN && isAuthenticated) {
        try {
            rikWS.ping(JSON.stringify({ type: 'keepalive', timestamp: Date.now() }));
            console.log("📡 Sent keep-alive ping");
        } catch (err) {
            console.error("Keep-alive ping error:", err);
        }
    }
}

// Xử lý khi nhận được pong
function handlePong(data) {
    lastPongTime = Date.now();
    isConnectionHealthy = true;
    if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
    console.log("🫀 Received pong");
}

// Gửi lệnh định kỳ
function sendPeriodicCommands() {
    if (rikWS?.readyState === WebSocket.OPEN && isAuthenticated) {
        try {
            rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { "cmd": 1005, "sid": rikCurrentSession || 0 }]));
            rikWS.send(JSON.stringify([6, "MiniGame", "lobbyPlugin", { "cmd": 10001 }]));
            rikWS.send(JSON.stringify([6, "MiniGame", "taixiuPlugin", { "cmd": 1003 }]));
            console.log("📤 Sent periodic commands: 1005, 10001, 1003");
        } catch (err) {
            console.error("Error sending commands:", err);
        }
    }
}

// Dọn dẹp tất cả interval và timeout
function cleanupTimers() {
    clearInterval(rikIntervalCmd);
    clearInterval(heartbeatInterval);
    clearInterval(pingInterval);
    clearTimeout(heartbeatTimeout);
    clearTimeout(reconnectTimeout);
}

// ==================== WEBSOCKET CONNECTION (ĐÃ SỬA) ====================

async function connectWebSocket() {
    console.log(`🔌 Đang kết nối WebSocket... Lần thử thứ ${reconnectAttempts + 1}`);
    
    const authData = await getAuthData();
    if (!authData) {
        console.error('Đéo kết nối được vì không lấy được token. Thử lại sau 10 giây...');
        reconnectAttempts++;
        setTimeout(connectWebSocket, 10000);
        return;
    }
    
    // Dọn dẹp kết nối cũ trước khi tạo mới
    if (rikWS) {
        rikWS.removeAllListeners();
        rikWS.terminate();
        rikWS = null;
    }
    cleanupTimers();

    const websocketUrl = `wss://websocket.gmwin.io/websocket?token=${authData.wsToken}`;
    
    try {
        rikWS = new WebSocket(websocketUrl, {
            handshakeTimeout: 20000, // Tăng thời gian chờ lên 20s
            perMessageDeflate: false
        });

        rikWS.on('open', () => {
            console.log("✅ WebSocket đã kết nối");
            reconnectAttempts = 0; // Reset số lần thử lại khi thành công
            isAuthenticated = false;
            lastPongTime = Date.now();
            isConnectionHealthy = true;
            
            const authPayload = [
                1, "MiniGame", authData.username1, authData.username2,
                { "info": authData.info, "pid": 5, "signature": authData.signature, "subi": true }
            ];
            
            rikWS.send(JSON.stringify(authPayload));
            console.log("🔐 Đã gửi thông tin xác thực");
        });

        rikWS.on('message', (data) => {
            try {
                const json = JSON.parse(data.toString());
                
                if (Array.isArray(json) && json[0] === 1 && json[1] === true) {
                    isAuthenticated = true;
                    console.log("✅ Xác thực thành công");
                    
                    cleanupTimers(); // Dọn dẹp timer cũ trước khi tạo mới
                    rikIntervalCmd = setInterval(sendPeriodicCommands, 3000);
                    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
                    pingInterval = setInterval(sendKeepAlivePing, PING_INTERVAL);
                    
                    sendPeriodicCommands(); // Gửi ngay lần đầu
                    return;
                }
                
                if (Array.isArray(json) && json[1]?.cmd === 1008 && json[1]?.sid) {
                    if (!rikCurrentSession || json[1].sid > rikCurrentSession) {
                        rikCurrentSession = json[1].sid;
                        console.log(`📋 Phiên hiện tại: ${rikCurrentSession}`);
                    }
                }
                
                if (Array.isArray(json) && (json[1]?.cmd === 1003 || json[1]?.cmd === 1004) && json[1]?.d1 !== undefined) {
                    const res = json[1];
                    if (rikCurrentSession && (!rikResults[0] || rikResults[0].sid !== rikCurrentSession)) {
                        rikResults.unshift({ sid: rikCurrentSession, d1: res.d1, d2: res.d2, d3: res.d3, timestamp: Date.now() });
                        if (rikResults.length > 100) rikResults.pop();
                        saveHistory();
                        console.log(`🎲 Phiên ${rikCurrentSession} → ${getTX(res.d1, res.d2, res.d3)} (${res.d1},${res.d2},${res.d3})`);
                    }
                }
                
                if (Array.isArray(json) && json[1]?.cmd === 1005 && json[1]?.htr) {
                    const newHistory = json[1].htr.map(i => ({ sid: i.sid, d1: i.d1, d2: i.d2, d3: i.d3 })).sort((a, b) => b.sid - a.sid);
                    if (newHistory.length > 0) {
                        rikResults = newHistory.slice(0, 100);
                        saveHistory();
                        console.log(`📦 Đã tải ${newHistory.length} bản ghi lịch sử`);
                    }
                }
                
            } catch (e) {
                console.error("Parse error:", e.message);
            }
        });

        rikWS.on('close', (code, reason) => {
            console.log(`🔌 WebSocket đã đóng: ${code} - ${reason}. Sẽ kết nối lại.`);
            isAuthenticated = false;
            isConnectionHealthy = false;
            cleanupTimers();
            
            reconnectAttempts++;
            const delay = Math.min(5000 + 1000 * reconnectAttempts, 30000); // Tăng thời gian chờ mỗi lần lỗi
            console.log(`Thử lại sau ${delay / 1000} giây...`);
            
            reconnectTimeout = setTimeout(connectWebSocket, delay);
        });

        // *** ĐÂY LÀ CHỖ QUAN TRỌNG NHẤT CHO MÀY ***
        rikWS.on('error', (err) => {
            console.error("❌ Lỗi WebSocket, địt mẹ nó:", err.message);
            // Không cần làm gì nhiều, sự kiện 'close' sẽ được gọi ngay sau đây
            // và nó sẽ tự động xử lý việc kết nối lại.
            // Chỉ cần đảm bảo kết nối được đóng hoàn toàn.
            if (rikWS) {
                rikWS.terminate();
            }
        });

        rikWS.on('ping', () => rikWS.pong());
        rikWS.on('pong', handlePong);

    } catch (err) {
        // Lỗi này xảy ra nếu new WebSocket() thất bại ngay lập tức
        console.error("Không thể tạo WebSocket:", err.message);
        cleanupTimers();
        reconnectAttempts++;
        const delay = Math.min(5000 + 1000 * reconnectAttempts, 30000);
        reconnectTimeout = setTimeout(connectWebSocket, delay);
    }
}

// ==================== API ENDPOINTS ====================
fastify.register(require('@fastify/cors'));

fastify.get("/api/taixiu/sunwin", async (req, reply) => {
    if (!rikResults.length) return { message: "Đéo có dữ liệu." };
    const current = rikResults[0];
    const sum = current.d1 + current.d2 + current.d3;
    return {
        phien: current.sid,
        xuc_xac_1: current.d1, xuc_xac_2: current.d2, xuc_xac_3: current.d3,
        tong: sum, ket_qua: sum >= 11 ? "Tài" : "Xỉu",
        phien_hien_tai: rikCurrentSession,
        status: isAuthenticated ? "connected" : "disconnected",
        is_healthy: isConnectionHealthy,
    };
});

fastify.get("/api/taixiu/history", async () => {
    return rikResults.map(i => ({
        phien: i.sid, tong: i.d1 + i.d2 + i.d3,
        ket_qua: getTX(i.d1, i.d2, i.d3) === "T" ? "Tài" : "Xỉu"
    }));
});

fastify.post("/reconnect", async () => {
    console.log("Yêu cầu kết nối lại thủ công...");
    reconnectAttempts = 0; // Reset khi có yêu cầu thủ công
    clearTimeout(reconnectTimeout);
    connectWebSocket();
    return { message: "Đang tiến hành kết nối lại" };
});

// ==================== START SERVER ====================
const start = async () => {
    try {
        loadHistory();
        connectWebSocket(); // Bắt đầu chu trình kết nối
        
        await fastify.listen({ port: PORT, host: "0.0.0.0" });
        console.log(`🚀 API chạy tại port ${PORT}`);
    } catch (err) {
        console.error("Server error:", err);
        process.exit(1);
    }
};

start();