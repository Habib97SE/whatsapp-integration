import { NextResponse } from "next/server";

export async function GET() {
    const envVars = {
        CHATTRICK_BASE_URL: process.env.CHATTRICK_BASE_URL,
        BOT_ID: process.env.BOT_ID,
        WEBHOOK_VERIFY_TOKEN: process.env.WEBHOOK_VERIFY_TOKEN,
        GRAPH_API_TOKEN: process.env.GRAPH_API_TOKEN
    };

    const missingVars = Object.entries(envVars)
        .filter(([, value]) => !value)
        .map(([key]) => key);

    if (missingVars.length === 0) {
        return NextResponse.json({ message: "Up and running" }, { status: 200 });
    } else {
        return NextResponse.json({ 
            message: "Error", 
            missing: missingVars 
        }, { status: 400 });
    }
}
