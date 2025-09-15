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
app.get("/", (req, res) =>
  res.status(200).send("BranchLink Realtime proxy is running.")
);

// ---- GHL / Make Webhook (MVP) ----
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

async function postJSON(url, payload) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
  let ready = false;
  let buffer = []; // buffrar Twilio-paket tills OpenAI är redo

  const cleanup = () => {
    try {
      twilioWS.close();
    } catch {}
    try {
      openaiWS && openaiWS.close();
    } catch {}
  };

  try {
    openaiWS = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
  } catch (e) {
    cleanup();
    return;
  }

  openaiWS.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    ready = true;

    // skicka ev. buffrade paket
    buffer.forEach((msg) => {
      console.log("📤 Skickar buffrat meddelande till OpenAI:", msg.type);
      openaiWS.send(JSON.stringify(msg));
    });
    buffer = [];

    if (WEBHOOK_URL) {
      postJSON(WEBHOOK_URL, { type: "call_started", at: new Date().toISOString() });
    }
  });

  // Twilio -> OpenAI
  twilioWS.on("message", (buf) => {
    try {
      const msg = JSON.parse(buf.toString());

      if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        console.log("🔗 Twilio stream start:", streamSid);

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
            output_audio_format: { type: "g711_ulaw", sample_rate_hz: 8000 },
          },
        };

        if (ready) {
          console.log("📤 Skickar session.update till OpenAI");
          openaiWS.send(JSON.stringify(sessionUpdate));
        } else {
          buffer.push(sessionUpdate);
        }

        // Autosvar
        const hello = {
          type: "response.create",
          response: {
            instructions: "Hej och välkommen till BSR! Jag är en AI-assistent. Vad kan jag hjälpa dig med?",
          },
        };

        if (ready) {
          console.log("📤 Skickar autosvar till OpenAI");
          openaiWS.send(JSON.stringify(hello));
        } else {
          buffer.push(hello);
        }
      }

      if (msg.event === "media") {
        console.log("🎙️ Twilio audio packet mottaget");
        const audioMsg = {
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        };

        if (ready) {
          openaiWS.send(JSON.stringify(audioMsg));
        } else {
          buffer.push(audioMsg);
        }
      }

      if (msg.event === "stop") {
        console.log("🛑 Twilio stream stoppad");
        if (ready) {
          openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWS.send(JSON.stringify({ type: "response.create" }));
        }
        cleanup();
      }
    } catch (err) {
      console.error("❌ Error Twilio->OpenAI:", err.message);
    }
  });

  // OpenAI -> Twilio
  openaiWS.on("message", (buf) => {
    try {
      const evt = JSON.parse(buf.toString());
      if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
        console.log("🔊 OpenAI skickar ljud tillbaka → Twilio");
        twilioWS.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: evt.delta },
          })
        );
      }
    } catch (err) {
      console.error("❌ Error OpenAI->Twilio:", err.message);
    }
  });

  // Cleanup
  twilioWS.on("close", () => {
    console.log("⚠️ Twilio WebSocket stängd");
    cleanup();
  });
  twilioWS.on("error", (err) => {
    console.error("❌ Twilio error:", err.message);
    cleanup();
  });
  openaiWS.on("close", () => {
    console.log("⚠️ OpenAI WebSocket stängd");
    cleanup();
  });
  openaiWS.on("error", (err) => {
    console.error("❌ OpenAI error:", err.message);
    cleanup();
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log("BranchLink Realtime proxy listening on port", port);
});
