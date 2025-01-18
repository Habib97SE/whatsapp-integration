import { NextRequest, NextResponse } from "next/server";
import { io, Socket } from "socket.io-client";
import axios from "axios";

const CHATTRICK_BASE_URL = process.env.CHATTRICK_BASE_URL as string;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN as string;
const SOCKET_TIMEOUT = 30000; 
const SOCKET_RECONNECTION_ATTEMPTS = 3;
const SOCKET_RECONNECTION_DELAY = 1000;

// In-memory deduplication cache
const processedMessages = new Set<string>();

// Enhanced socket cache with connection status
interface SocketCacheEntry {
    socket: ReturnType<typeof io>;
    lastUsed: number;
    isConnected: boolean;
}

const socketCache: Record<string, SocketCacheEntry> = {};

// Socket cleanup interval (every 5 minutes)
setInterval(() => {
    const now = Date.now();
    Object.entries(socketCache).forEach(([botId, entry]) => {
        if (now - entry.lastUsed > 300000) { // 5 minutes
            entry.socket.disconnect();
            delete socketCache[botId];
            console.log(`Cleaned up inactive socket for bot ID ${botId}`);
        }
    });
}, 300000);

async function fetchChatbotConfig(phoneNumber: string) {
    const response = await axios.get(`${CHATTRICK_BASE_URL}/api/integrations/whatsapp?phone_number=${phoneNumber}`);
    console.log("Response:", response.data);
    return response.data;
}

function setupSocketConnection(botId: string): Promise<Socket> {
    console.log("Setting up socket connection for bot ID:", botId);
    return new Promise((resolve, reject) => {
        const socket = io(CHATTRICK_BASE_URL, {
            path: "/api/chat",
            query: { botId },
            extraHeaders: {
                Referer: "https://whatsapp-integration-puce.vercel.app",
            },
            reconnectionAttempts: SOCKET_RECONNECTION_ATTEMPTS,
            reconnectionDelay: SOCKET_RECONNECTION_DELAY,
            timeout: SOCKET_TIMEOUT,
        });

        // Initialize socket cache entry immediately
        socketCache[botId] = {
            socket,
            lastUsed: Date.now(),
            isConnected: false,
        };

        const connectionTimeout = setTimeout(() => {
            socket.disconnect();
            reject(new Error("Socket connection timeout"));
        }, SOCKET_TIMEOUT);

        socket.on("connect", () => {
            clearTimeout(connectionTimeout);
            console.log(`Connected to WebSocket for bot ID ${botId}`);
            socketCache[botId].isConnected = true;
            socketCache[botId].lastUsed = Date.now();
            resolve(socket);
        });

        socket.on("connect_error", (error) => {
            console.error(`Connection error for bot ID ${botId}:`, error);
            if (socketCache[botId]) {
                socketCache[botId].isConnected = false;
            }
        });

        socket.on("disconnect", () => {
            console.log(`Disconnected WebSocket for bot ID ${botId}`);
            if (socketCache[botId]) {
                socketCache[botId].isConnected = false;
            }
        });
    });
}

async function getBotResponse(socket: Socket, message: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const chatPayload = {
            messages: [{ type: 0, message }],
            customFields: {},
            chatContext: [],
        };

        const timeoutId = setTimeout(() => {
            cleanup();
            reject(new Error(`WebSocket response timeout after ${SOCKET_TIMEOUT}ms`));
        }, SOCKET_TIMEOUT);

        const cleanup = () => {
            clearTimeout(timeoutId);
            socket.off("chat-response-finished");
            socket.off("error");
        };

        socket.once("error", (error) => {
            cleanup();
            reject(error);
        });

        socket.once("chat-response-finished", (data: { response?: string }) => {
            cleanup();
            resolve(data.response || "Sorry, I couldn't process your request.");
        });

        socket.emit("chat", chatPayload, (ack: { status: string; message?: string }) => {
            if (ack.status !== "success") {
                cleanup();
                reject(new Error(ack.message || "Failed to send message"));
            }
            console.log("Message acknowledgment:", ack);
        });
    });
}

export async function GET(req: NextRequest) {
    const mode = req.nextUrl.searchParams.get("hub.mode");
    const token = req.nextUrl.searchParams.get("hub.verify_token");
    const challenge = req.nextUrl.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
        console.log("Webhook verified successfully!");
        return new Response(challenge, { status: 200 });
    } else {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        // Acknowledge the webhook immediately
        if (!message || message.type !== "text") {
            console.log("No valid message found, acknowledging immediately");
            return NextResponse.json({ status: "No valid message" }, { status: 200 });
        }

        // Check for duplicate message
        if (processedMessages.has(message.id)) {
            console.log("Duplicate message detected, skipping processing");
            return NextResponse.json({ status: "Duplicate message, already processed" }, { status: 200 });
        }

        // Mark message as processed and set expiration for deduplication
        processedMessages.add(message.id);
        setTimeout(() => processedMessages.delete(message.id), 300000); // Remove after 5 minutes

        const businessPhoneNumber = body.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number;
        const phoneNumberId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

        if (!businessPhoneNumber || !phoneNumberId) {
            return NextResponse.json({ error: "Missing required metadata" }, { status: 400 });
        }

        const config = await fetchChatbotConfig(businessPhoneNumber);
        if (!config) {
            return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
        }

        const { bot_id, graph_api_token } = config.data;

        if (!graph_api_token || typeof graph_api_token !== "string" || graph_api_token.trim() === "") {
            console.error("Invalid Graph API token:", graph_api_token);
            return NextResponse.json({ error: "Invalid API token configuration" }, { status: 500 });
        }

        let socketEntry = socketCache[bot_id];
        if (!socketEntry || !socketEntry.isConnected) {
            await setupSocketConnection(bot_id);
            socketEntry = socketCache[bot_id];
        }

        socketEntry.lastUsed = Date.now();

        const botReply = await getBotResponse(socketEntry.socket, message.text.body);

        const headers = {
            Authorization: `Bearer ${graph_api_token}`,
            "Content-Type": "application/json",
        };

        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
            {
                messaging_product: "whatsapp",
                to: message.from,
                text: { body: botReply },
                context: { message_id: message.id },
            },
            { headers }
        );

        await axios.post(
            `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
            {
                messaging_product: "whatsapp",
                status: "read",
                message_id: message.id,
            },
            { headers }
        );

        return NextResponse.json({ status: "Success" }, { status: 200 });
    } catch (error) {
        console.error("Error processing webhook:", error);
        return NextResponse.json({ error: "Failed to process webhook" }, { status: 500 });
    }
}