
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import WebSocket from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();
const server = http.createServer(app);

// Health check
app.get("/", (req, res) => res.status(200).send("BranchLink Realtime proxy is running."));

// ---- GHL / Make Webhook (MVP) ----
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

async function postJSON(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    return await res.text();
  } catch (e) {
    console.error("Webhook post failed:", e.message);
    return null;
  }
}

// ---- WebSocket bridge Twilio <-> OpenAI Realtime ----
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", async (twilioWS) => {
  let openaiWS = null;
  let streamSid = null;
  let open = false;

  const cleanup = () => {
    try { twilioWS.close(); } catch {}
    try { openaiWS && openaiWS.close(); } catch {}
  };

  // Connect to OpenAI Realtime
  try {
    openaiWS = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
  } catch (e) {
    cleanup();
    return;
  }

  openaiWS.on("open", () => {
    open = true;
    if (WEBHOOK_URL) {
      postJSON(WEBHOOK_URL, { type: "call_started", at: new Date().toISOString() });
    }
    // Configure Swedish session and BSR scope
    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions: `
Du är BranchLinks svenska röstagent för BSR.
Scope: bokning/ombokning/avbokning, offert (regnr, bil, kontakt), öppettider/adress, tjänster (trim/uppdatering/garanti).
Om något är utanför BSR: svara kort "Jag kan bara hjälpa till med BSR-frågor. Vill du boka, få offert eller veta öppettider?"
Var kort (max 2 meningar) och trevlig. Ställ alltid en relevant följdfråga.
`,
        language: "sv-SE",
        modalities: ["audio"],
        voice: "alloy",
        input_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 },
        output_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 }
      }
    };
    openaiWS.send(JSON.stringify(sessionUpdate));
  });

  // Relay Twilio -> OpenAI
  twilioWS.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());
      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        if (WEBHOOK_URL) {
          postJSON(WEBHOOK_URL, { type: "media_stream_start", at: new Date().toISOString(), start: msg.start || {} });
        }
      }
      if (msg.event === "media" && open) {
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        }));
      }
      if ((msg.event === "mark" || msg.event === "stop") && open) {
        openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        openaiWS.send(JSON.stringify({ type: "response.create" }));
        if (msg.event === "stop") {
          if (WEBHOOK_URL) { postJSON(WEBHOOK_URL, { type: "call_ended", at: new Date().toISOString() }); }
          cleanup();
        }
      }
    } catch (_) {}
  });

  // Relay OpenAI -> Twilio
  openaiWS.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf.toString());
      if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
        twilioWS.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta }
        }));
      }
    } catch (_) {}
  });

  // Cleanup
  twilioWS.on("close", cleanup);
  twilioWS.on("error", cleanup);
  openaiWS.on("close", cleanup);
  openaiWS.on("error", cleanup);
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("BranchLink Realtime proxy listening on port", port);
});
