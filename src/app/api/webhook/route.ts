import { NextRequest, NextResponse } from "next/server";
import { io } from "socket.io-client";
import axios from "axios";

// Load environment variables
const CHATTRICK_BASE_URL = process.env.CHATTRICK_BASE_URL as string;
const BOT_ID = process.env.BOT_ID as string;
const GRAPH_API_TOKEN = process.env.GRAPH_API_TOKEN as string;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN as string;

type ChatAcknowledgment = {
    status: string;
    message?: string;
};

// WebSocket client setup
const socket = io(CHATTRICK_BASE_URL, {
    path: "/api/chat",
    query: {
        botId: BOT_ID, // Replace with your bot ID
    },
});

// WebSocket Event listeners
socket.on("connect", () => console.log("Connected to WebSocket server"));
socket.on("error", (error) => console.error("Error from WebSocket server:", error));
socket.on("disconnect", () => console.log("Disconnected from WebSocket server"));

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
            const business_phone_number_id =
                body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

            const userMessage = message.text.body; // WhatsApp message text
            const chatPayload = {
                messages: [{ type: 0, message: userMessage }],
                customFields: {}, // Optional
                chatContext: [], // Optional
            };

            // Emit to Chattrick WebSocket
            socket.emit("chat", chatPayload, (acknowledgment: ChatAcknowledgment) => {
                console.log("Acknowledgment from WebSocket server:", acknowledgment);
            });

            // Listen for Chattrick's response
            const botReply = await new Promise<string>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 10000); // Timeout in 10 seconds
                socket.once("chat-response-finished", (data) => {
                    clearTimeout(timeout);
                    resolve(data.response || "I'm sorry, I couldn't process that.");
                });
            });

            // Send Chattrick's reply back to WhatsApp
            await axios.post(
                `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
                {
                    messaging_product: "whatsapp",
                    to: message.from,
                    text: { body: botReply },
                    context: { message_id: message.id },
                },
                {
                    headers: {
                        Authorization: `Bearer ${GRAPH_API_TOKEN}`,
                    },
                }
            );

            console.log("Message sent to WhatsApp user:", botReply);

            // Mark the message as read
            await axios.post(
                `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
                {
                    messaging_product: "whatsapp",
                    status: "read",
                    message_id: message.id,
                },
                {
                    headers: {
                        Authorization: `Bearer ${GRAPH_API_TOKEN}`,
                    },
                }
            );

            return NextResponse.json({ status: "Webhook processed successfully" }, { status: 200 });
        } else {
            console.log("No text message found.");
        }
    } catch (error) {
        console.error("Error processing webhook:", error instanceof Error ? error.message : 'Unknown error');
        return NextResponse.json({ error: "Failed to process webhook" }, { status: 500 });
    }
    return NextResponse.json({ status: "No action taken" }, { status: 200 });
}
