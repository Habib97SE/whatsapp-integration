import { NextRequest, NextResponse } from "next/server";
import axios from "axios";

const CHATTRICK_BASE_URL = process.env.CHATTRICK_BASE_URL as string;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN as string;
const REQUEST_TIMEOUT = 30000; // General request timeout
const REFERRER = process.env.REFERRER as string;

// In-memory deduplication cache
const processedMessages = new Set<string>();

// Interface for structured message objects expected from the backend or parsed from text
interface BotMessagePart {
    type: "text" | "image" | "error" | "contact-options" | "ready" | "finished"; // Add other types as needed
    content?: string; // For text messages
    url?: string; // For image messages
    caption?: string; // Optional caption for images (we might extract alt text as caption)
    message?: string; // For error or finished messages
    data?: any; // For generic data
}

async function fetchChatbotConfig(phoneNumber: string) {
    try {
        const endpoint = `${CHATTRICK_BASE_URL}/integrations/whatsapp/phone-number/${phoneNumber}`;
        console.log("Fetching chatbot config from:", endpoint);
        const response = await fetch(endpoint, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });
        const data = await response.json();
        console.log("Fetched chatbot config:", data);
        if (!data) {
            console.error(
                "No data found in chatbot config response for phone number:",
                phoneNumber
            );
            throw new Error("Chatbot configuration not found.");
        }
        return data;
    } catch (error) {
        console.error("Error fetching chatbot config:", error);
        throw new Error("Failed to fetch chatbot configuration.");
    }
}

// Modified function to parse Markdown images and return structured parts
async function getBotStreamingResponse(
    botId: string,
    userMessage: string
): Promise<BotMessagePart[]> {
    const url = `${CHATTRICK_BASE_URL}/chat-stream/${botId}`;
    console.log("Preparing to send request to chat-stream:", url);
    const payload = {
        messages: [{ type: 0, message: userMessage }],
        botId: botId,
        chatContext: [],
        referrer: REFERRER,
    };

    console.log("Sending request to chat-stream:", url, "Payload:", payload);
    const responseParts: BotMessagePart[] = [];
    // Regex to find Markdown images: ![alt text](URL)
    const imageRegex = /!\[(.*?)\]\((.*?)\)/g;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "text/event-stream",
                referer: REFERRER,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(
                `HTTP error! status: ${response.status}, body: ${errorBody}`
            );
            // Return an error part instead of throwing, letting the caller handle it
            return [
                {
                    type: "error",
                    message: `Failed to connect to chat stream: ${response.statusText}`,
                },
            ];
        }

        if (!response.body) {
            // Return an error part
            return [{ type: "error", message: "Response body is null" }];
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let done = false;
        let buffer = "";
        let currentTextBuffer = ""; // Buffer for accumulating text between images or events

        console.log("Starting to read and parse stream for Markdown...");

        while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;

            if (value) {
                buffer += decoder.decode(value, { stream: true });
                let boundary = buffer.indexOf("\n\n");

                while (boundary !== -1) {
                    const messageLine = buffer.substring(0, boundary);
                    buffer = buffer.substring(boundary + 2);

                    if (messageLine.startsWith("data: ")) {
                        try {
                            const jsonString = messageLine.substring(6).trim();
                            if (jsonString === "[DONE]") {
                                console.log("Received [DONE] marker.");
                            } else if (jsonString) {
                                const data: any = JSON.parse(jsonString);
                                console.log("Received SSE JSON event:", data);

                                if (
                                    data.type === "chat-response-progress" &&
                                    typeof data.data === "string"
                                ) {
                                    let progressText = data.data;
                                    let lastIndex = 0;
                                    let match;

                                    // Find all Markdown image occurrences in the current chunk
                                    while (
                                        (match =
                                            imageRegex.exec(progressText)) !==
                                        null
                                    ) {
                                        // 1. Add text preceding the image
                                        const textBefore =
                                            progressText.substring(
                                                lastIndex,
                                                match.index
                                            );
                                        if (textBefore.trim()) {
                                            currentTextBuffer += textBefore;
                                        }
                                        // If there's accumulated text, push it as a text part
                                        if (currentTextBuffer.trim()) {
                                            responseParts.push({
                                                type: "text",
                                                content:
                                                    currentTextBuffer.trim(),
                                            });
                                            currentTextBuffer = ""; // Reset buffer
                                        }

                                        // 2. Add the image part
                                        const altText = match[1]; // Capture group 1: alt text (optional caption)
                                        const imageUrl = match[2]; // Capture group 2: URL
                                        if (imageUrl) {
                                            responseParts.push({
                                                type: "image",
                                                url: imageUrl.trim(),
                                                caption:
                                                    altText.trim() || undefined,
                                            });
                                            console.log(
                                                `Parsed image: URL=${imageUrl.trim()}, Caption=${altText.trim()}`
                                            );
                                        }

                                        lastIndex =
                                            match.index + match[0].length; // Move past the parsed image markdown
                                    }

                                    // Add any remaining text from the chunk to the buffer
                                    const textAfter = progressText
                                        .substring(lastIndex)
                                        .replace("**", "*");
                                    currentTextBuffer += textAfter;
                                } else if (
                                    data.type === "chat-response-finished"
                                ) {
                                    console.log(
                                        "Stream finished event received."
                                    );
                                    // Handle potential final message in the finished event if needed
                                    // If the main content was in data.message and not streamed via progress:
                                    if (
                                        data.message &&
                                        typeof data.message === "string" &&
                                        responseParts.length === 0 &&
                                        !currentTextBuffer.trim()
                                    ) {
                                        // Attempt to parse this final message string as well
                                        let finalMessageText = data.message;
                                        let lastIndex = 0;
                                        let match;
                                        while (
                                            (match =
                                                imageRegex.exec(
                                                    finalMessageText
                                                )) !== null
                                        ) {
                                            const textBefore =
                                                finalMessageText.substring(
                                                    lastIndex,
                                                    match.index
                                                );
                                            if (textBefore.trim()) {
                                                responseParts.push({
                                                    type: "text",
                                                    content: textBefore.trim(),
                                                });
                                            }
                                            const altText = match[1];
                                            const imageUrl = match[2];
                                            if (imageUrl) {
                                                responseParts.push({
                                                    type: "image",
                                                    url: imageUrl.trim(),
                                                    caption:
                                                        altText.trim() ||
                                                        undefined,
                                                });
                                            }
                                            lastIndex =
                                                match.index + match[0].length;
                                        }
                                        const textAfter =
                                            finalMessageText.substring(
                                                lastIndex
                                            );
                                        if (textAfter.trim()) {
                                            responseParts.push({
                                                type: "text",
                                                content: textAfter.trim(),
                                            });
                                        }
                                    }
                                    done = true; // Signal completion
                                } else if (data.type === "error") {
                                    console.error(
                                        "Received error event from stream:",
                                        data.message
                                    );
                                    // Add error part to inform the user
                                    responseParts.push({
                                        type: "error",
                                        message:
                                            data.message ||
                                            "Chat stream returned an error.",
                                    });
                                    // Optionally stop processing on error: done = true;
                                } else if (
                                    data.type === "contact-options" ||
                                    data.type === "ready"
                                ) {
                                    // Handle or ignore these events as needed
                                    console.log(`Received ${data.type} event.`);
                                }
                                // Add other SSE event type handling if necessary
                            }
                        } catch (e) {
                            console.error(
                                "Error parsing SSE JSON data:",
                                e,
                                "Raw line:",
                                messageLine
                            );
                            responseParts.push({
                                type: "error",
                                message: "Error parsing bot response.",
                            });
                        }
                    }
                    if (done) break; // Exit inner loop if finished
                    boundary = buffer.indexOf("\n\n");
                }
            }
        }

        // After the loop, check if there's any remaining text in the buffer
        if (currentTextBuffer.trim()) {
            responseParts.push({
                type: "text",
                content: currentTextBuffer.trim(),
            });
        }

        console.log("Stream finished parsing. Response parts:", responseParts);

        // Add a fallback if no actual content was generated and no error occurred
        if (
            responseParts.filter((p) => p.type === "text" || p.type === "image")
                .length === 0 &&
            !responseParts.some((p) => p.type === "error")
        ) {
            console.warn("No content messages generated.");
            responseParts.push({
                type: "text",
                content: "Sorry, I couldn't generate a response.",
            });
        } else if (responseParts.some((p) => p.type === "error")) {
            // Ensure an error message is included if an error occurred during streaming
            const nonErrorContent = responseParts.filter(
                (p) => p.type === "text" || p.type === "image"
            );
            if (nonErrorContent.length === 0) {
                // If only error parts exist, ensure one is suitable for user display
                const firstError = responseParts.find(
                    (p) => p.type === "error"
                );
                // Replace all parts with a single user-facing text error message
                return [
                    {
                        type: "text",
                        content: firstError?.message || "An error occurred.",
                    },
                ];
            }
            // Optionally filter out 'error' type parts if text/image content exists
            // return responseParts.filter(p => p.type !== 'error');
        }

        // Return the structured parts
        return responseParts;
    } catch (error: any) {
        if (error.name === "TimeoutError") {
            console.error("Request to chat-stream timed out.");
            return [{ type: "text", content: "Sorry, the request timed out." }]; // Return structured error
        }
        console.error("Error getting bot streaming response:", error);
        return [
            {
                type: "text",
                content: `Sorry, an error occurred: ${error.message}`,
            },
        ]; // Return structured error
    }
}

export async function GET(req: NextRequest) {
    const mode = req.nextUrl.searchParams.get("hub.mode");
    const token = req.nextUrl.searchParams.get("hub.verify_token");
    const challenge = req.nextUrl.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
        console.log("Webhook verified successfully!");
        return new Response(challenge, { status: 200 });
    } else {
        console.error(
            "Webhook verification failed. Mode:",
            mode,
            "Token:",
            token,
            "Expected Token:",
            WEBHOOK_VERIFY_TOKEN
        );
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
}

export async function POST(req: NextRequest) {
    // Start timer as soon as we receive the webhook
    const startTime = Date.now();

    try {
        const body = await req.json();
        console.log("Received webhook body:", JSON.stringify(body, null, 2));

        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

        if (!message || message.type !== "text" || !message.text?.body) {
            console.log(
                "Received non-text or empty message:",
                message ? message.type : "No message object"
            );
            return NextResponse.json(
                { status: "Acknowledged non-text/empty message" },
                { status: 200 }
            );
        }

        if (processedMessages.has(message.id)) {
            console.log(
                `Duplicate message ID detected: ${message.id}, skipping.`
            );
            return NextResponse.json(
                { status: "Duplicate message, already processed" },
                { status: 200 }
            );
        }

        processedMessages.add(message.id);
        setTimeout(() => {
            processedMessages.delete(message.id);
            console.log(`Removed message ID ${message.id} from cache.`);
        }, 300000);

        const businessPhoneNumber =
            body.entry?.[0]?.changes?.[0]?.value?.metadata
                ?.display_phone_number;
        const phoneNumberId =
            body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;

        if (!businessPhoneNumber || !phoneNumberId) {
            console.error(
                "Missing required metadata: businessPhoneNumber or phoneNumberId"
            );
            console.error(
                "Metadata:",
                body.entry?.[0]?.changes?.[0]?.value?.metadata
            );
            return NextResponse.json(
                { error: "Missing required metadata" },
                { status: 400 }
            );
        }

        console.log(
            `Processing message for business phone: ${businessPhoneNumber}, WA ID: ${phoneNumberId}`
        );

        const config = await fetchChatbotConfig(businessPhoneNumber);
        if (!config) {
            console.error(
                `Configuration not found for phone number: ${businessPhoneNumber}`
            );
            return NextResponse.json(
                { error: "Configuration not found" },
                { status: 404 }
            );
        }

        const { bot, graphApiToken } = config;

        if (!bot) {
            console.error(
                "Bot ID missing in configuration for phone number:",
                businessPhoneNumber
            );
            return NextResponse.json(
                { error: "Bot ID missing in configuration" },
                { status: 500 }
            );
        }

        // Validate Graph API token
        if (
            !graphApiToken ||
            typeof graphApiToken !== "string" ||
            graphApiToken.trim() === ""
        ) {
            console.error(
                "Invalid or missing Graph API token in configuration for bot ID:",
                bot
            );
            return NextResponse.json(
                { error: "Invalid API token configuration" },
                { status: 500 }
            );
        }

        console.log(`Using Bot ID: ${bot} and associated Graph API token.`);

        // Getting and parsing bot response parts for message
        console.log(
            `Getting and parsing bot response parts for message: "${message.text.body}"`
        );
        const botResponseParts = await getBotStreamingResponse(
            bot,
            message.text.body
        );
        console.log(`Received ${botResponseParts.length} bot response parts.`);

        const headers = {
            Authorization: `Bearer ${graphApiToken}`,
            "Content-Type": "application/json",
        };

        // Aggregate text parts and separate image parts
        let combinedText = "";
        const imageParts: BotMessagePart[] = [];

        for (const part of botResponseParts) {
            if (part.type === "text" && part.content) {
                if (combinedText) combinedText += "\n\n";
                combinedText += part.content;
            } else if (part.type === "image" && part.url) {
                imageParts.push(part);
            } else if (part.type === "error" && part.message) {
                console.error("Error part received from stream:", part.message);
                if (!combinedText && imageParts.length === 0) {
                    combinedText = part.message;
                }
            } else {
                console.log(
                    "Skipping unsupported/empty response part during aggregation:",
                    part
                );
            }
        }

        combinedText = combinedText.trim();
        const messageContext = { message_id: message.id };

        // 1. Send combined text message if it exists
        if (combinedText) {
            const textPayload = {
                messaging_product: "whatsapp",
                to: message.from,
                context: messageContext,
                text: { body: combinedText },
            };
            console.log(
                `Sending combined text: "${combinedText.substring(
                    0,
                    100
                )}..." to ${message.from} via Graph API...`
            );
            try {
                await axios.post(
                    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                    textPayload,
                    { headers, timeout: REQUEST_TIMEOUT }
                );
                console.log(
                    `Combined text sent successfully to ${message.from}.`
                );
            } catch (sendError: any) {
                console.error(`Failed to send combined text message.`);
                console.error(
                    "Axios error details:",
                    sendError.response?.data || sendError.message
                );
            }
        } else {
            console.log("No combined text content to send.");
        }

        // 2. Send image messages one by one
        for (const imagePart of imageParts) {
            if (!imagePart.url) continue;

            const imagePayload: any = {
                messaging_product: "whatsapp",
                to: message.from,
                context: messageContext,
                type: "image",
                image: {
                    link: imagePart.url,
                },
            };
            if (imagePart.caption) {
                imagePayload.image.caption = imagePart.caption;
            }

            const imageDescription =
                `image: ${imagePart.url}` +
                (imagePart.caption
                    ? ` (caption: "${imagePart.caption.substring(0, 30)}...")`
                    : "");
            console.log(
                `Sending ${imageDescription} to ${message.from} via Graph API...`
            );

            try {
                await axios.post(
                    `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                    imagePayload,
                    { headers, timeout: REQUEST_TIMEOUT }
                );
                console.log(`Image part sent successfully to ${message.from}.`);
            } catch (sendError: any) {
                console.error(
                    `Failed to send message part: ${imageDescription}`
                );
                console.error(
                    "Axios error details for sending image:",
                    sendError.response?.data || sendError.message
                );
            }
        }

        // Mark the original message as read *after* attempting to send all replies
        console.log(`Marking original message ${message.id} as read...`);
        try {
            await axios.post(
                `https://graph.facebook.com/v18.0/${phoneNumberId}/messages`,
                {
                    messaging_product: "whatsapp",
                    status: "read",
                    message_id: message.id,
                },
                { headers, timeout: REQUEST_TIMEOUT }
            );
            console.log(`Original message ${message.id} marked as read.`);
        } catch (readError: any) {
            console.error(`Failed to mark message ${message.id} as read.`);
            console.error(
                "Axios error details for marking read:",
                readError.response?.data || readError.message
            );
        }

        // Calculate and log total processing time
        const endTime = Date.now();
        const processingTime = endTime - startTime;
        console.log(
            `🕒 Total message processing time: ${processingTime}ms (${(
                processingTime / 1000
            ).toFixed(2)}s) for message ID: ${message.id}`
        );

        return NextResponse.json({ status: "Success" }, { status: 200 });
    } catch (error: any) {
        // Calculate processing time even for errors
        const endTime = Date.now();
        const processingTime = endTime - startTime;
        console.log(
            `❌ Message processing failed after ${processingTime}ms (${(
                processingTime / 1000
            ).toFixed(2)}s)`
        );

        console.error("-----------------------------------------");
        console.error("Unhandled Error in POST handler:", error);
        if (error.response) {
            console.error("Axios error data:", error.response.data);
            console.error("Axios error status:", error.response.status);
            console.error("Axios error headers:", error.response.headers);
        } else if (error.request) {
            console.error("Axios error request:", error.request);
        } else {
            console.error("Error message:", error.message);
        }
        console.error("Stack trace:", error.stack);
        console.error("-----------------------------------------");
        return NextResponse.json(
            { error: `Failed to process webhook: ${error.message}` },
            { status: 500 }
        );
    }
}
