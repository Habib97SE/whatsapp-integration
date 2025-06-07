import { NextResponse } from "next/server";


/**
 * This route is used to generate long live token for WhatsApp API using the endpoint: 
 * 
 * @param request 
 * @returns 
 */
export async function POST(request: Request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");
    const redirect_uri = searchParams.get("redirect_uri");
    const client_id = process.env.AUTH0_CLIENT_ID;
    const client_secret = process.env.AUTH0_CLIENT_SECRET;

    const tokenResponse = await fetch("https://dev-2354-2.us.auth0.com/oauth/token", {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `grant_type=authorization_code&code=${code}&redirect_uri=${redirect_uri}&client_id=${client_id}&client_secret=${client_secret}`,
    });
    
    const data = await tokenResponse.json();
    return NextResponse.json(data);
}