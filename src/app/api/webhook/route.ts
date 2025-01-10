import { NextRequest, NextResponse } from "next/server";
import { io } from "socket.io-client";
import axios from "axios";

// Load environment variables
const CHATTRICK_BASE_URL = process.env.CHATTRICK_BASE_URL as string;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN as string;
//const PHONE_NUMBER_URL = process.env.PHONE_NUMBER_URL as string;

type ChatAcknowledgment = {
    status: string;
    message?: string;
};

// Cache WebSocket connections for bot IDs
const socketCache: Record<string, import('socket.io-client').Socket> = {};

// Fetch chatbot configuration
// async function fetchChatbotConfig(phoneNumber: string) {
//     try {
//         const response = await axios.get(
//             `${PHONE_NUMBER_URL}/api/integrations/whatsapp?phone_number=${phoneNumber}`
//         );
//         console.log(`Phone number:`);
//         console.log(response.data.data)

//         return response.data.data;
//     } catch (error) {
//         console.error("Error fetching chatbot configuration:", error);
//         throw new Error("Failed to fetch chatbot configuration");
//     }
// }

// GET handler for webhook verification
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

// POST handler for incoming WhatsApp messages
export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        console.log("Incoming webhook message:", JSON.stringify(body, null, 2));

        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        if (message?.type === "text") {
            const businessPhoneNumber = body.entry?.[0]?.changes?.[0]?.value?.metadata?.display_phone_number;
            const phoneNumberId = body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

            if (!businessPhoneNumber || !phoneNumberId) {
                console.error("Missing business phone number or phone number ID");
                return NextResponse.json({ error: "Missing required metadata" }, { status: 400 });
            }

            // Fetch configuration for the given phone number
            //const config = await fetchChatbotConfig(businessPhoneNumber);
            // if (!config) {
            //     console.error("No configuration found for phone number:", businessPhoneNumber);
            //     return NextResponse.json({ error: "Configuration not found" }, { status: 404 });
            // }

            // const { bot_id, graph_api_token } = config;

            const bot_id = "048e197f-9817-47c0-992f-f7ee77c7a80e"
            const graph_api_token = "EAAIL3ZAXFxxQBO2XKV3SfsNwhmCAWQKWM0YBnrpWrdJJjiIOU7O0kZAKlxU4lNgiDeKfvmQcBvpiU9J8aDv4uZCrBjKzal4mX0Qd5PRg3QBQzTegsp814DZA5bYxXJUtUWuHpI1JVLvdel31tlgS6gn2cwGiINamWYP6abTjrG4F13v45biB33pvFq3D99HgccMzfQrD9fh2"


            console.log(`bot_id: ${bot_id}`);
            console.log(`graph_api_token: ${graph_api_token}`);

            // Ensure a WebSocket connection exists for the bot ID
            if (!socketCache[bot_id]) {
                console.log(`Creating WebSocket connection for bot ID ${bot_id}`);
                socketCache[bot_id] = io(CHATTRICK_BASE_URL, {
                    path: "/api/chat",
                    query: { botId: bot_id },
                });

                socketCache[bot_id].on("connect", () => {
                    console.log(`Connected to WebSocket for bot ID ${bot_id}`);
                });

                socketCache[bot_id].on("error", (error: Error) => {
                    console.error(`WebSocket error for bot ID ${bot_id}:`, error);
                });

                socketCache[bot_id].on("disconnect", () => {
                    console.log(`Disconnected WebSocket for bot ID ${bot_id}`);
                });
            }

            const socket = socketCache[bot_id];

            // Prepare the chat payload
            const userMessage = message.text.body;
            const chatPayload = {
                messages: [{ type: 0, message: userMessage }],
                customFields: {},
                chatContext: [],
            };

            // Emit the payload to the WebSocket
            console.log("Sending message to WebSocket...");
            socket.emit("chat", chatPayload, (ack: ChatAcknowledgment) => {
                console.log("Acknowledgment from WebSocket server:", ack);
            });

            // Listen for the bot's response
            const botReply = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 10000);
                socket.once("chat-response-finished", (data: { response?: string }) => {
                    clearTimeout(timeout);
                    resolve(data.response || "Sorry, I couldn't process your request.");
                });
            });

            // Send the bot's reply back to the user on WhatsApp
            console.log("Sending bot reply back to WhatsApp...");
            console.log(botReply);
            console.log(`phoneNumberId: ${phoneNumberId}`);
            console.log(`message.from: ${message.from}`);
            await axios.post(
                `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                {
                    messaging_product: "whatsapp",
                    to: message.from,
                    text: { body: botReply },
                    context: { message_id: message.id },
                },
                {
                    headers: {
                        Authorization: `Bearer ${graph_api_token}`,
                    },
                }
            );

            console.log("Bot reply sent successfully:", botReply);

            // Mark the message as read
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

            return NextResponse.json({ status: "Webhook processed successfully" }, { status: 200 });
        } else {
            console.log("No text message found.");
            return NextResponse.json({ status: "No text message found" }, { status: 200 });
        }
    } catch (error) {
        console.error("Error processing webhook:", error);
        return NextResponse.json({ error: "Failed to process webhook" }, { status: 500 });
    }
}
