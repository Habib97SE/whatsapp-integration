import { NextRequest, NextResponse } from "next/server";
import { io, Socket } from "socket.io-client";
import axios from "axios";

const CHATTRICK_BASE_URL = process.env.CHATTRICK_BASE_URL as string;

const SOCKET_TIMEOUT = 30000; // Increased timeout to 30 seconds
const SOCKET_RECONNECTION_ATTEMPTS = 3;
const SOCKET_RECONNECTION_DELAY = 1000;


const fetchChatbotConfig = async (phoneNumber: string) => {
    const response = await axios.get(`${CHATTRICK_BASE_URL}/api/integrations/whatsapp?phone_number=${phoneNumber}`);
    console.log("Response:", response.data);
    return response.data;
};

type ChatAcknowledgment = {
    status: string;
    message?: string;
};

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
            isConnected: false, // Start as disconnected
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

        socket.emit("chat", chatPayload, (ack: ChatAcknowledgment) => {
            if (ack.status !== "success") {
                cleanup();
                reject(new Error(ack.message || "Failed to send message"));
            }
            console.log("Message acknowledgment:", ack);
        });
    });
}

// Add this type near the top of the file with other types
type WhatsAppAPIError = {
    response?: {
        status: number;
        data: unknown;
    };
    message: string;
};

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        if (!message || message.type !== "text") {
            return NextResponse.json({ status: "No text message found" }, { status: 200 });
        }

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

        // Add token validation
        if (!graph_api_token || typeof graph_api_token !== 'string' || graph_api_token.trim() === '') {
            console.error("Invalid Graph API token:", graph_api_token);
            return NextResponse.json({ error: "Invalid API token configuration" }, { status: 500 });
        }

        console.log("Bot ID:", bot_id);
        console.log("Graph API Token length:", graph_api_token.length);
        console.log("Graph API Token prefix:", graph_api_token.substring(0, 6) + "...");

        // Get or create socket connection
        let socketEntry = socketCache[bot_id];
        if (!socketEntry || !socketEntry.isConnected) {
            await setupSocketConnection(bot_id);
            socketEntry = socketCache[bot_id];
        }

        socketEntry.lastUsed = Date.now();

        try {
            const botReply = await getBotResponse(socketEntry.socket, message.text.body);
            
            console.log("Bot Reply:", botReply);
            // Send reply to WhatsApp
            const headers = {
                Authorization: `Bearer ${graph_api_token}`,
                'Content-Type': 'application/json'
            };
            console.log(`phoneNumberId: ${phoneNumberId}`);
            try {
                const response = await axios.post(
                    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                    {
                        messaging_product: "whatsapp",
                        to: message.from,
                        text: { body: botReply },
                        context: { message_id: message.id },
                    },
                    { headers }
                );
                console.log("WhatsApp API Response:", response.status, response.statusText);
            } catch (error: unknown) {
                const apiError = error as WhatsAppAPIError;
                console.error("WhatsApp API Error:", {
                    status: apiError.response?.status,
                    data: apiError.response?.data,
                    message: apiError.message
                });
                throw apiError;
            }

            // Mark as read
            await axios.post(
                `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                {
                    messaging_product: "whatsapp",
                    status: "read",
                    message_id: message.id,
                },
                {
                    headers: {
                        Authorization: `Bearer ${graph_api_token}`,
                    },
                }
            );

            return NextResponse.json({ status: "Success" }, { status: 200 });
        } catch (error) {
            console.error("Error processing message:", error);

            // Attempt to send error message to user
            try {
                await axios.post(
                    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                    {
                        messaging_product: "whatsapp",
                        to: message.from,
                        text: { body: "Sorry, I'm having trouble processing your message. Please try again in a moment." },
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${graph_api_token}`,
                        },
                    }
                );
            } catch (sendError) {
                console.error("Failed to send error message:", sendError);
            }

            return NextResponse.json({ error: "Failed to process message" }, { status: 500 });
        }
    } catch (error) {
        console.error("Error processing webhook:", error);
        return NextResponse.json({ error: "Failed to process webhook" }, { status: 500 });
    }
}