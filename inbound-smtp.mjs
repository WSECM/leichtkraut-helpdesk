import { SMTPServer } from "smtp-server"
import { simpleParser } from "mailparser"

const WEBHOOK = "http://127.0.0.1:5181/api/inbound/email"

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ["AUTH"],
  size: 25 * 1024 * 1024,
  onData(stream, session, callback) {
    simpleParser(stream).then(async (p) => {
      const from = (p.from && p.from.value && p.from.value[0]) || {}
      const to = (p.to && p.to.text) || ""
      const body = {
        from: from.address || "unbekannt",
        from_name: from.name || null,
        subject: p.subject || "(Kein Betreff)",
        text: (p.text || (p.html ? p.html.replace(/<[^>]+>/g, " ") : "") || "").trim(),
      }
      try {
        await fetch(WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        console.log(new Date().toISOString(), "[mx] Mail von", body.from, "an", to, "-> Ticket")
      } catch (e) { console.log("[mx] webhook-Fehler:", e.message) }
      callback()
    }).catch((e) => { console.log("[mx] parse-Fehler:", e.message); callback() })
  },
})
server.on("error", (e) => console.log("[mx] server-Fehler:", e.message))
server.listen(25, "0.0.0.0", () => console.log("[mx] SMTP-Empfaenger laeuft auf Port 25"))
