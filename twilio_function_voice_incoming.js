
// Path: /voice/incoming
exports.handler = async function(context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: "wss://YOUR-DOMAIN/stream" });
  return callback(null, twiml);
};
