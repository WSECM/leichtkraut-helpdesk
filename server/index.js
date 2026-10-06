import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import nodemailer from 'nodemailer'
import { registerMetaKommentare } from './meta-kommentare.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, '.env') })

const PORT = process.env.PORT || 5181
const DIST_DIR = path.resolve(process.cwd(), 'dist')
const DATA_DIR = path.join(__dirname, 'data')
const CONN_FILE = path.join(DATA_DIR, 'connections.json')
const INBOUND_FILE = path.join(DATA_DIR, 'inbound.json')
// Feedback-Lektionen: Sams Korrekturen pro Fall — fließen in JEDE Barbara-Antwort ein,
// ohne den System-Prompt aufzublähen. Wird über /api/lessons gepflegt.
const LESSONS_FILE = path.join(DATA_DIR, 'lessons.json')
function readLessons() { try { return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8')) } catch { return [] } }
function writeLessons(list) { fs.writeFileSync(LESSONS_FILE, JSON.stringify(list, null, 2)) }
// Wissensbasis (Second Brain, 06.08.): Produkt- und Stilfakten aus dem
// Herzensstück als einzige Wahrheitsquelle — wird als eigener System-Block
// mitgeschickt, damit Barbara Produktfragen aus Fakten statt Vermutung beantwortet.
const WISSEN_FILE = path.join(DATA_DIR, 'wissen.md')
function readWissen() { try { return fs.readFileSync(WISSEN_FILE, 'utf8') } catch { return '' } }
// Outcome-Log (Second Brain): jede relevante Aktion (Entwurf, Versand mit/ohne
// Änderung, Statuswechsel, Nachfassen) landet als JSON-Zeile hier — die Datenbasis
// für Closing-Rate pro Falltyp und das Diff-Learning aus Samuels Korrekturen.
const OUTCOMES_FILE = path.join(DATA_DIR, 'outcomes.jsonl')
function appendOutcome(entry) {
  try { fs.appendFileSync(OUTCOMES_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n') } catch {}
}

// ── Konversations-Threading (wie Resolvia): Antworten desselben Kunden zum
// selben Betreff landen als neue Nachricht im BESTEHENDEN Ticket, nicht als
// neues Ticket. Betreff-Normalisierung entfernt Re:/AW:/Fwd:-Präfixe.
function normSubject(s) {
  return String(s || '').replace(/^(\s*(re|aw|antw|fwd|wg)\s*:\s*)+/i, '').trim().toLowerCase()
}

// Sammelt Links aus dem HTML-Teil einer Mail, die im Klartext fehlen, und
// hängt sie lesbar an (Tracking-/Abmelde-/Bild-URLs werden ausgefiltert).
// HTML sicher zu Text: mailparser liefert `html: false`, wenn es keinen
// HTML-Teil gibt. `false?.replace` faengt das NICHT ab (Optional Chaining
// greift nur bei null/undefined) - genau daran starb der Abruf am 30.08.
function htmlZuText(html) {
  return typeof html === 'string' ? html.replace(/<[^>]+>/g, ' ') : ''
}
function appendHtmlLinks(text, html) {
  if (!html) return text
  const junk = /unsubscribe|abmelden|mailto:|\.(png|jpg|jpeg|gif|svg|css|js)(\?|$)|googleusercontent|list-manage|doubleclick|facebook\.com\/tr|sendgrid|mailchimp|\/track\//i
  const found = [...String(html).matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1])
  const extra = []
  for (const raw of found) {
    let u = raw.replace(/&amp;/g, '&')
    // Google-Weiterleitungen auf das echte Ziel zurückführen
    const g = u.match(/^https?:\/\/www\.google\.com\/url\?q=([^&]+)/i)
    if (g) { try { u = decodeURIComponent(g[1]) } catch { /* roh lassen */ } }
    if (junk.test(u)) continue
    if (text.includes(u)) continue
    if (extra.includes(u)) continue
    extra.push(u)
  }
  if (!extra.length) return text
  return (text + '\n\n— Links aus dieser E-Mail —\n' + extra.slice(0, 8).join('\n')).slice(0, 6000)
}

function ensureMessages(rec) {
  if (!Array.isArray(rec.messages)) {
    rec.messages = [{ direction: 'in', body_text: rec.body_text || '', created_at: rec.received_at, from_name: rec.customer_name }]
  }
  return rec
}

// ── E-Mail-Anhänge (Bilder, PDFs …) speichern und über /api/attachments ausliefern ──
const ATT_DIR = path.join(DATA_DIR, 'attachments')
fs.mkdirSync(ATT_DIR, { recursive: true })
function saveAttachments(parsed, uid) {
  const out = []
  for (const a of parsed?.attachments || []) {
    try {
      if (!a.content || (a.size || a.content.length) > 12 * 1024 * 1024) continue
      const safe = String(a.filename || 'anhang').replace(/[^\w.\-äöüÄÖÜß ]+/g, '_').slice(0, 80) || 'anhang'
      const fname = `${uid}-${out.length}-${safe}`
      fs.writeFileSync(path.join(ATT_DIR, fname), a.content)
      out.push({
        filename: safe,
        content_type: a.contentType || 'application/octet-stream',
        size: a.size || a.content.length,
        url: `/api/attachments/${encodeURIComponent(fname)}`,
      })
    } catch { /* einzelner Anhang optional */ }
  }
  return out
}
// Shopify-Kontaktformular & Co: Die Mail kommt vom Relay (mailer@shopify.com),
// die ECHTE Kundin steht im Text ("Name: ...", "E-Mail: ..."). Extrahieren!
function extractRealCustomer(fromEmail, fromName, bodyText) {
  const relay = /mailer@shopify\.com|no-?reply|notification/i.test(String(fromEmail || ''))
  if (!relay) return { email: fromEmail || 'unbekannt', name: fromName || null }
  const t = String(bodyText || '')
  const em = t.match(/E-?Mail:\s*\r?\n?\s*([^\s@,;<>]+@[^\s@,;<>]+\.[a-zA-Z]{2,})/i)
  const nm = t.match(/Name:\s*\r?\n?\s*([^\r\n]{2,60})/i)
  return {
    email: em ? em[1].trim().toLowerCase() : (fromEmail || 'unbekannt'),
    name: nm ? nm[1].trim() : (fromName || null),
  }
}

// Findet das bestehende Gespräch, hängt die neue Kundennachricht an und
// reaktiviert das Ticket. Gibt true zurück, wenn angehängt wurde.
// Eindeutige Ticketnummer: höchste vorhandene +1 (Länge des Stores ist
// kollisionsanfällig, weil Einträge gelöscht/eingefügt werden).
function nextTicketNumber(store) {
  const nums = store.map((r) => parseInt(r.ticket_number, 10)).filter((n) => Number.isFinite(n))
  return String((nums.length ? Math.max(...nums) : 1000) + 1)
}

function threadIntoExisting(store, { email, subject, text, date, attachments }) {
  const ns = normSubject(subject)
  let rec = store.find((r) => r.customer_email?.toLowerCase() === email.toLowerCase() && (normSubject(r.subject) === ns || !ns))
  // TICKETNUMMER IM BETREFF (14.08., Fall #1694/#1695 Kundin I):
  // Unsere Eingangsbestaetigung traegt den Betreff '... (Ticket #1694)'. Antwortet
  // die Kundin darauf, passt der Betreff NICHT mehr zum Originalticket ('Bestellung'),
  // und es wurde ein zweites Ticket aufgemacht - fuer Samuel sah es aus wie unbeantwortete
  // Arbeit. Die Nummer stammt von UNS und ist damit das zuverlaessigste Signal, das es gibt.
  // Sie wird deshalb ZUERST ausgewertet, aber nur wenn die Absenderadresse zum Ticket passt
  // (sonst koennte eine weitergeleitete Mail in ein fremdes Gespraech rutschen).
  const nummerImBetreff = String(subject || '').match(/Ticket\s*#\s*(\d{3,6})/i)
  if (nummerImBetreff) {
    const treffer = store.find((r) => String(r.ticket_number) === nummerImBetreff[1]
      && String(r.customer_email || '').toLowerCase() === String(email || '').toLowerCase()
      && !r.is_spam)
    if (treffer) {
      console.log('[thread] Antwort ueber Ticketnummer im Betreff zugeordnet -> #' + treffer.ticket_number)
      rec = treffer
    }
  }
  // THREADING-FIX (05.08.): Wenn KEIN Betreff vorhanden (mobile Mail-Apps
  // schicken oft leer), an das letzte OFFENE Ticket derselben Kundin hängen,
  // sofern es weniger als 90 Minuten alt ist. Verhindert, dass Nachfolge-
  // Nachrichten als drei separate Tickets aufmachen (Kundin B 1479-81).
  if (!ns) {
    const nowMs = Date.parse(date || 0) || Date.now()
    const NINETY_MIN = 90 * 60_000
    const candidates = store.filter((r) =>
      r.customer_email?.toLowerCase() === email.toLowerCase()
      && (r.status === 'open' || r.status === 'new' || r.status === 'pending')
      && !r.is_spam
      && r.imap_uid && !String(r.imap_uid).startsWith('compose:')
      && (nowMs - (Date.parse(r.received_at || 0) || 0)) < NINETY_MIN)
    if (candidates.length) rec = candidates[0]
  }
  if (!rec) return false
  ensureMessages(rec)
  rec.messages.push({ direction: 'in', body_text: text, created_at: date, from_name: rec.customer_name, ...(attachments?.length ? { attachments } : {}) })
  rec.received_at = date
  rec.body_text = text                // neueste Kundennachricht — auch für Compose-Tickets,
                                      // sonst generiert die Auto-Pipeline dort nie einen Entwurf
  rec.status = 'open'                 // Kundin hat geantwortet → wieder offen
  // ORDNER-REGEL (Samuel, 30.07.): Kundenantwort = Posteingang, IMMER.
  // Compose-Tickets liegen wegen ihrer imap_uid "compose:*" im Entwürfe-Ordner —
  // sobald die Kundin antwortet, wird die uid umgeschrieben, damit das Ticket
  // im Posteingang erscheint (Frontend-Prädikat prüft auf "compose:"-Präfix).
  if (String(rec.imap_uid || '').startsWith('compose:')) rec.imap_uid = 'reply:' + Date.now()
  delete rec.manual_draft             // gehört nach Samuels Regel nie an eingehende Tickets
  delete rec.ai_draft                 // Barbara entwirft neu, mit vollem Verlauf
  // SPERRE AUFHEBEN (14.08., Faelle #1671/#1679/#1691): Von Hand geschriebene
  // Entwuerfe tragen ai_draft_locked. Antwortet die Kundin, wird der Entwurf
  // hier geloescht - blieb die Sperre stehen, schrieb NIEMAND mehr einen neuen
  // (der Auto-Entwurf ueberspringt gesperrte Tickets). Drei Kundinnen warteten
  // dadurch ohne Antwort. Eine Kundenantwort macht die Sperre gegenstandslos.
  delete rec.ai_draft_locked
  delete rec.ai_draft_at
  delete rec.ai_draft_error
  delete rec.ai_draft_sent            // neue Kundenantwort → Neu-Entwurf wieder erlaubt
  // SNOOZE AUFWECKEN (Wunsch aus dem Team, 23.08.): Antwortet die Kundin, waehrend
  // das Ticket schlummert, wacht es SOFORT auf - sonst wird sie uebersehen.
  delete rec.snooze_until
  delete rec.snoozed_by
  store.splice(store.indexOf(rec), 1)
  store.unshift(rec)                  // nach oben (neueste Aktivität zuerst)
  return true
}

fs.mkdirSync(DATA_DIR, { recursive: true })

const BARBARA_PROMPT = `Du bist Barbara, eine echte, herzliche Kundenservice-Mitarbeiterin bei Leichtkraut (deutsche Marke für natürliche Lymphtropfen, Sitz München). Du beantwortest Kundenanfragen per E-Mail: warm, empathisch, professionell, lösungsorientiert. Emojis sparsam (🌿 💚). Unterschreibe immer mit "Freundliche Grüße, Barbara / Leichtkraut Kundenservice".
Regeln: Ungeöffnete, versiegelte Flaschen → volle Erstattung möglich (vorher Foto anfordern). Geöffnete Flaschen → Widerruf nach § 312g Abs. 2 Nr. 3 BGB ausgeschlossen (Hygiene), Kulanz/Teilerstattung möglich. Niemals Informationen erfinden (Adressen, Nummern). Antworte nur mit dem E-Mail-Text, ohne Betreff.
WARTEZEIT-REGEL (Samuel, 02.08.): Wenn eine Kundin lange auf ihr Paket wartet, IMMER den ehrlichen Grund nennen: Wir hatten sehr hohe Nachfrage und waren zeitweise ausverkauft, deshalb dauert es länger. Dazu betonen, dass wir unser Bestmögliches geben, damit das Paket schnellstmöglich ankommt. Niemals nur vertrösten ("dauert leider länger") ohne Begründung. Und NIE Beigaben oder Gesten erfinden, die nicht bestätigt sind (z. B. "Überraschung im Paket") — das Paket ist meist schon unterwegs.

EINWANDBEHANDLUNG (Samuel, 03.08.) — WICHTIGSTE REGEL FÜR STORNIERUNGEN UND KRITIK:
Eine Stornierung, ein Widerruf oder ein Vorwurf ("unehrlich", "Abzocke", "hilft nicht", "zu teuer") wird NIEMALS kommentarlos ausgeführt. Du bearbeitest immer erst den Einwand. Ablauf in dieser Reihenfolge:
1. ANERKENNEN, nicht rechtfertigen. Den Vorwurf beim Namen nennen und ernst nehmen. Wenn wir einen Fehler gemacht haben (späte Antwort, Lieferverzug), diesen ZUERST einräumen — sonst klingt alles Weitere hohl.
2. VERSTEHEN. Eine konkrete, ehrlich gemeinte Rückfrage stellen: Was genau hat den Eindruck ausgelöst? Was hat nicht funktioniert? Seit wann nimmt sie die Tropfen? Ohne diese Information kann man nicht helfen und nichts verbessern.
3. FAKTEN LIEFERN, die sie noch nicht kennt: Sendungsstatus mit Tracking-Link, tatsächlicher Bearbeitungsstand, was gerade passiert. Nie erfinden, nur Belegbares.
4. RISIKO UMKEHREN. Das stärkste ehrliche Argument: Sie testet ohne Risiko. "Probieren Sie es in Ruhe aus. Wenn es nichts für Sie war, bekommen Sie Ihr Geld zurück und dürfen die Flaschen behalten, ohne Rücksendung und ohne Nachweis." Bei Unzufriedenheit mit der Wirkung: 50 % Teilerstattung anbieten, Ware behalten.
5. ENTSCHEIDUNG RESPEKTIEREN. Immer einen klaren, bedingungslosen Ausweg nennen ("Schreiben Sie einfach 'Stornierung', dann erstatten wir sofort und vollständig"). Niemals Druck aufbauen, nicht drängen, keine Schuldgefühle erzeugen, kein zweites Nachfassen nach einem klaren Nein.
Der Ton bleibt dabei immer: ruhig, respektvoll, auf Augenhöhe. Ziel ist nicht, die Kundin zu überreden, sondern ihr eine echte Grundlage für ihre Entscheidung zu geben. Bei einem ausdrücklichen zweiten Nein wird sofort und freundlich storniert.`

const DEFAULT_CONNECTIONS = {
  // Modelle bewusst festgelegt (Kostenkontrolle):
  //   draftModel   – Kundenmails: braucht Feingefühl → Sonnet 4.6
  //   utilityModel – Übersetzen & Risiko-Einstufung: mechanisch → Haiku 4.5 (5x günstiger)
  // NIE automatisch auf ein teureres Modell wechseln.
  ai: { connected: false, provider: 'anthropic', model: 'claude-sonnet-5', utilityModel: 'claude-haiku-4-5-20251001', temperature: 0.5, systemPrompt: BARBARA_PROMPT, autoSend: false, autoDraft: true, hasKey: false },
  shopify: { connected: false, store: '', shopName: '', clientId: '', hasClientSecret: false, hasToken: false },
  domain: { connected: false, domain: '', verified: false, dns: null },
  gmail: { connected: false, authMethod: 'oauth', email: '', clientId: '', hasClientSecret: false, oauthConnected: false, hasPassword: false, lastSync: null, syncedCount: 0 },
  imap: { connected: false, provider: 'ionos', host: 'imap.ionos.de', smtpHost: 'smtp.ionos.de', smtpPort: 465, email: '', hasPassword: false, lastSync: null, syncedCount: 0 },
  dhl: { connected: false, hasKey: false },
  klarna: { connected: false, hasKey: false },
  meta: { connected: false },
}

// ---- persistence -----------------------------------------------------------
function loadConnections() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONN_FILE, 'utf8'))
    return { ...structuredClone(DEFAULT_CONNECTIONS), ...raw }
  } catch {
    return structuredClone(DEFAULT_CONNECTIONS)
  }
}
function saveConnections(c) {
  fs.writeFileSync(CONN_FILE, JSON.stringify(c, null, 2))
}
let connections = loadConnections()

// Secrets live here (server-side only), never sent to the client.
const secrets = {
  ai: process.env.ANTHROPIC_API_KEY || connections.ai?._key || '',
  shopify: connections.shopify?._token || '',
  gmail: process.env.GMAIL_APP_PASSWORD || connections.gmail?._password || '',
  gmailClientSecret: process.env.GMAIL_CLIENT_SECRET || connections.gmail?._clientSecret || '',
  gmailRefresh: connections.gmail?._refresh || '',
  gmailAccess: null, // { token, exp }
  imap: process.env.IMAP_PASSWORD || connections.imap?._password || '',
  shopifyClientSecret: process.env.SHOPIFY_CLIENT_SECRET || connections.shopify?._clientSecret || '',
  metaClientSecret: process.env.META_APP_SECRET || connections.meta?._clientSecret || '',
}
if (secrets.ai) connections.ai.hasKey = true

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER-WEICHE (Samuel, 12.08.): Anthropic-Guthaben war zum zweiten Mal leer,
// Samuel will auf Gemini Flash ueber kie.ai wechseln. Diese eine Funktion
// ersetzt alle direkten fetch()-Aufrufe an api.anthropic.com. Sie erkennt am
// MODELLNAMEN, wohin der Aufruf geht:
//   claude-*  -> Anthropic (unveraendert, Format bleibt 1:1)
//   gemini-*  -> kie.ai (OpenAI-kompatibel), Anfrage/Antwort werden uebersetzt
// Dadurch ist der Wechsel eine reine Konfigurationsfrage (connections.ai.model)
// und jederzeit ohne Deploy rueckgaengig zu machen.
// ─────────────────────────────────────────────────────────────────────────────
const KIE_KEY = process.env.KIE_API_KEY || ''
const KIE_ENDPOINTS = {
  'gemini-3.5-flash': 'gemini-3-5-flash-openai',
  'gemini-3-flash': 'gemini-3-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash',
}
function kieEndpointFor(model) {
  return KIE_ENDPOINTS[model] || KIE_ENDPOINTS['gemini-2.5-flash']
}
function anthropicContentToOpenAI(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content ?? '')
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    if (part.type === 'image' && part.source?.type === 'base64') {
      return { type: 'image_url', image_url: { url: `data:${part.source.media_type};base64,${part.source.data}` } }
    }
    return { type: 'text', text: '' }
  })
}
// VERBRAUCHS-STATISTIK (29.08., Samuels Credit-Frust): Jeder API-Call wird
// mit Tokens (inkl. Cache-Lesen/Schreiben) je Zweck und Tag in ai-usage.json
// gezaehlt. Zweck wird aus Modell + max_tokens abgeleitet (eindeutig belegt).
const AI_USAGE_FILE = path.join(DATA_DIR, 'ai-usage.json')
function aiZweck(model, maxTokens) {
  if (!String(model).includes('haiku')) return 'entwurf'
  if (maxTokens === 2500) return 'pruefer'
  if (maxTokens === 2000) return 'uebersetzung'
  if (maxTokens <= 8) return 'zufriedenheit/ping'
  return 'sonstiges'
}
function aiUsageZaehlen(model, maxTokens, usage) {
  try {
    if (!usage) return
    let st = {}
    try { st = JSON.parse(fs.readFileSync(AI_USAGE_FILE, 'utf8')) } catch {}
    const tag = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())
    const zweck = aiZweck(model, maxTokens)
    const d = (st[tag] = st[tag] || {})
    const z = (d[zweck] = d[zweck] || { calls: 0, in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
    z.calls += 1
    z.in += usage.input_tokens || 0
    z.out += usage.output_tokens || 0
    z.cacheRead += usage.cache_read_input_tokens || 0
    z.cacheWrite += usage.cache_creation_input_tokens || 0
    // 5-Minuten- und 1-Stunden-Schreibvorgaenge getrennt: die 1-Stunde kostet pro
    // Schreibvorgang mehr, spart aber Schreibvorgaenge. Nur getrennt sieht man, ob
    // sich die Umstellung vom 05.09.2026 rechnet.
    const cc = usage.cache_creation || {}
    z.cacheWrite5m = (z.cacheWrite5m || 0) + (cc.ephemeral_5m_input_tokens || 0)
    z.cacheWrite1h = (z.cacheWrite1h || 0) + (cc.ephemeral_1h_input_tokens || 0)
    // nur die letzten 60 Tage behalten
    const tage = Object.keys(st).sort()
    while (tage.length > 60) delete st[tage.shift()]
    fs.writeFileSync(AI_USAGE_FILE, JSON.stringify(st, null, 2))
  } catch {}
}
// ── KI-STOERUNGSMELDER (15.09.2026) ──────────────────────────────────────────
// Der fuenfte Guthaben-Ausfall (06.08., 12.08., 29.08., 04.09., 15.09.). Jedes
// Mal lief das Tool scheinbar normal weiter, nur ohne Entwuerfe und ohne
// Uebersetzung. Mitarbeiterin A hat am 15.09. einen ganzen Arbeitstag so gearbeitet,
// ohne zu wissen warum, und Samuel hat es erst abends erfahren. Ab jetzt
// merkt sich der Server jeden Guthaben- und Limitfehler an EINER Stelle
// (aiFetch ist der einzige Weg zur Anthropic-API) und das Tool zeigt einen
// roten Balken. Eine stille Stoerung soll es nicht mehr geben.
const kiStoerung = { aktiv: false, grund: '', code: '', seit: null, zaehler: 0, zuletzt: null }
function kiStoerungMelden(status, text) {
  const t = String(text || '')
  let grund = '', code = ''
  if (/credit balance|too low|billing/i.test(t)) { code = 'guthaben'; grund = 'Das KI-Guthaben ist aufgebraucht. Entwürfe und Übersetzung pausieren, bis Sam auflädt.' }
  else if (status === 429 || /rate.?limit/i.test(t)) { code = 'limit'; grund = 'Das KI-Limit ist erreicht. Entwürfe kommen verzögert.' }
  else if (status === 529 || /overloaded/i.test(t)) { code = 'ueberlast'; grund = 'Die KI ist gerade überlastet. Entwürfe kommen verzögert.' }
  else return
  kiStoerung.zaehler++
  kiStoerung.zuletzt = new Date().toISOString()
  kiStoerung.grund = grund
  kiStoerung.code = code
  if (!kiStoerung.aktiv) {
    kiStoerung.aktiv = true
    kiStoerung.seit = kiStoerung.zuletzt
    console.log('[ki] STOERUNG: ' + grund)
  }
}
function kiStoerungEntwarnung() {
  if (!kiStoerung.aktiv) return
  console.log('[ki] Stoerung vorbei nach ' + kiStoerung.zaehler + ' Fehlern (seit ' + kiStoerung.seit + ')')
  kiStoerung.aktiv = false; kiStoerung.grund = ''; kiStoerung.code = ''; kiStoerung.seit = null; kiStoerung.zaehler = 0
}

async function aiFetch(_url, opts) {
  const body = JSON.parse(opts.body)
  const model = String(body.model || '')
  if (!model.startsWith('gemini')) {
    const res = await fetch('https://api.anthropic.com/v1/messages', opts)   // Anthropic, unveraendert
    if (res.ok) {
      kiStoerungEntwarnung()
      try { res.clone().json().then((d) => aiUsageZaehlen(model, body.max_tokens, d && d.usage)).catch(() => {}) } catch {}
    } else {
      try { res.clone().text().then((t) => kiStoerungMelden(res.status, t)).catch(() => {}) } catch {}
    }
    return res
  }
  if (!KIE_KEY) {
    return { ok: false, status: 500, text: async () => 'KIE_API_KEY fehlt in .env', json: async () => ({ error: 'KIE_API_KEY fehlt' }) }
  }
  // Anthropic-Format -> OpenAI-Format
  const messages = []
  if (body.system) {
    const sysText = Array.isArray(body.system) ? body.system.map((b) => b.text || '').join('\n\n') : String(body.system)
    if (sysText.trim()) messages.push({ role: 'system', content: sysText })
  }
  for (const m of body.messages || []) {
    messages.push({ role: m.role, content: anthropicContentToOpenAI(m.content) })
  }
  // thinking / output_config / cache_control gibt es dort nicht — bewusst weglassen
  const kieBody = { messages, stream: false, ...(body.max_tokens ? { max_tokens: body.max_tokens } : {}) }
  const r = await fetch(`https://api.kie.ai/${kieEndpointFor(model)}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KIE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(kieBody),
  })
  if (!r.ok) {
    const t = await r.text()
    return { ok: false, status: r.status, text: async () => t, json: async () => { try { return JSON.parse(t) } catch { return { error: t } } } }
  }
  const data = await r.json()
  const text = data.choices?.[0]?.message?.content ?? ''
  // OpenAI-Antwort -> Anthropic-Form, damit alle Aufrufer unveraendert bleiben
  const anthroLike = {
    content: [{ type: 'text', text: typeof text === 'string' ? text : JSON.stringify(text) }],
    usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
    stop_reason: data.choices?.[0]?.finish_reason || 'end_turn',
    model,
    _kie_credits: data.credits_consumed,
  }
  return { ok: true, status: 200, json: async () => anthroLike, text: async () => JSON.stringify(anthroLike) }
}
if (secrets.shopify) connections.shopify.hasToken = true
if (secrets.gmail) connections.gmail.hasPassword = true
if (secrets.gmailClientSecret) connections.gmail.hasClientSecret = true
if (secrets.gmailRefresh) connections.gmail.oauthConnected = true
if (secrets.imap) connections.imap.hasPassword = true
// .env can fully configure the IONOS mailbox (email + host), so the browser form
// is optional. This is the deterministic path.
if (process.env.IMAP_EMAIL) connections.imap.email = process.env.IMAP_EMAIL
if (process.env.IMAP_HOST) connections.imap.host = process.env.IMAP_HOST
if (process.env.DHL_API_KEY) { connections.dhl.connected = true; connections.dhl.hasKey = true }
if (process.env.SMTP_HOST) connections.imap.smtpHost = process.env.SMTP_HOST
if (process.env.SMTP_PORT) connections.imap.smtpPort = Number(process.env.SMTP_PORT)
if (process.env.SEND_AS) connections.imap.sendAs = process.env.SEND_AS

// Return a client-safe view (no secrets).
function publicConnections() {
  const c = structuredClone(connections)
  for (const k of Object.keys(c)) {
    if (c[k]) { delete c[k]._key; delete c[k]._token; delete c[k]._password; delete c[k]._clientSecret; delete c[k]._refresh }
    // Alles mit Unterstrich ist serverseitig (Tokens, Archive alter Konfigs) — nie an den Browser.
    if (c[k] && typeof c[k] === 'object') for (const f of Object.keys(c[k])) if (f.startsWith('_')) delete c[k][f]
  }
  c.meta = c.meta || {}
  c.meta.hasClientSecret = !!secrets.metaClientSecret
  c.ai.hasKey = !!secrets.ai
  c.shopify.hasToken = !!secrets.shopify
  c.gmail.hasPassword = !!secrets.gmail
  c.gmail.hasClientSecret = !!secrets.gmailClientSecret
  c.gmail.oauthConnected = !!secrets.gmailRefresh
  c.imap.hasPassword = !!secrets.imap
  c.shopify.hasClientSecret = !!secrets.shopifyClientSecret
  return c
}

// ---- Gmail via IMAP (App Password) ----------------------------------------
function readInbound() {
  // Sicherheitsnetz gegen halb geschriebene Dateien (11.08.: leerte im Frontend
  // kurzzeitig den ganzen Posteingang). Mit atomarem writeInbound() sieht ein
  // Leser ohnehin immer eine vollstaendige Datei; der zweite Versuch faengt nur
  // das winzige rename-Fenster ab. Eine faelschliche [] wird NIE stillschweigend
  // geliefert, sondern geloggt.
  // LESE-CACHE (16.08., Speed-Runde): Die Datei ist 5+ MB gross und wurde bei
  // JEDEM API-Aufruf neu gelesen und geparst (App-Poll alle 4 s, /kurz alle
  // 2,5 s, Worker im Minutentakt = dutzende 5-MB-Parses pro Minute). Der Cache
  // haengt an mtime+size: writeInbound tauscht atomar per rename, das aendert
  // mtime immer, also invalidiert jeder Schreibvorgang automatisch. Externe
  // Skripte editieren die Datei nur bei gestopptem Dienst - auch abgedeckt.
  // Aufrufer duerfen das gelieferte Objekt mutieren, weil ueberall die Regel
  // gilt: lesen -> synchron mutieren -> sofort writeInbound, ohne await dazwischen.
  try {
    const st = fs.statSync(INBOUND_FILE)
    const key = st.mtimeMs + ':' + st.size
    if (__inboundCache && __inboundCache.key === key) return __inboundCache.data
    const data = JSON.parse(fs.readFileSync(INBOUND_FILE, 'utf8'))
    __inboundCache = { key, data }
    return data
  } catch (e1) {
    try { return JSON.parse(fs.readFileSync(INBOUND_FILE, 'utf8')) } catch (e2) {
      console.log('[store] readInbound fehlgeschlagen:', String(e2 && e2.message ? e2.message : e2).slice(0, 80))
      return []
    }
  }
}
let __inboundCache = null

// ARCHIV (30.08.): writeInbound schnitt die Liste bei JEDEM Schreibvorgang auf
// 500 Tickets zurueck - alles darueber war endgueltig geloescht. Von den
// Ticketnummern 1267 bis 2643 fehlten dadurch 877 Stueck, und Samuel konnte
// nach nichts suchen, was aelter als ~5 Tage war. Der Ueberhang wandert jetzt
// ins Archiv statt in den Muell. Der Arbeitssatz bleibt bei 500, damit
// /api/inbound (Frontend-Poll alle 4 s) genauso schnell bleibt wie bisher.
const ARCHIV_FILE = path.join(DATA_DIR, 'archiv.json')
const ARBEITSSATZ = 500
let __archivCache = null
function readArchiv() {
  try {
    const st = fs.statSync(ARCHIV_FILE)
    const key = st.mtimeMs + ':' + st.size
    if (__archivCache && __archivCache.key === key) return __archivCache.data
    const data = JSON.parse(fs.readFileSync(ARCHIV_FILE, 'utf8'))
    __archivCache = { key, data }
    return data
  } catch { return [] }
}
function schreibeArchiv(liste) {
  const tmp = ARCHIV_FILE + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(liste))
  fs.renameSync(tmp, ARCHIV_FILE)
  __archivCache = null
}
// Letzte Aktivitaet eines Tickets (Eingang oder juengste Nachricht). Danach wird
// sortiert, BEVOR abgeschnitten wird: So faellt nie ein Ticket ins Archiv, in dem
// gerade noch geschrieben wird, nur weil es weit hinten in der Datei stand.
function letzteAktivitaet(t) {
  let max = String(t.received_at || '')
  for (const m of t.messages || []) {
    const c = String(m.created_at || '')
    if (c > max) max = c
  }
  return max
}
function archiviere(ueberhang) {
  if (!ueberhang || !ueberhang.length) return
  try {
    const alt = readArchiv()
    const bekannt = new Set(alt.map((t) => String(t.ticket_number)))
    const neu = ueberhang.filter((t) => t && !bekannt.has(String(t.ticket_number)))
    if (!neu.length) return
    const zusammen = [...neu, ...alt].sort((a, b) => letzteAktivitaet(b).localeCompare(letzteAktivitaet(a)))
    schreibeArchiv(zusammen)
    console.log('[archiv] ' + neu.length + ' Ticket(s) archiviert statt geloescht, Archiv jetzt ' + zusammen.length)
  } catch (e) {
    console.log('[archiv] Archivierung fehlgeschlagen:', String((e && e.message) || e).slice(0, 90))
  }
}
function writeInbound(list) {
  // ATOMAR SCHREIBEN (11.08.): fs.writeFileSync schrieb die grosse Datei nicht
  // in einem Stueck. Ein gleichzeitiger Leser (Frontend pollt alle 4 s) sah sie
  // dann halb fertig, readInbound() lieferte [] und der Posteingang wirkte leer.
  // Deshalb erst in eine temporaere Datei schreiben und dann per rename atomar
  // austauschen: ein Leser sieht immer entweder die alte oder die neue Datei,
  // niemals eine halbe.
  // Nach letzter Aktivitaet sortieren, dann erst schneiden: Der Ueberhang ist
  // damit garantiert der aelteste, inaktive Teil - und der wird archiviert.
  const sortiert = [...list].sort((a, b) => letzteAktivitaet(b).localeCompare(letzteAktivitaet(a)))
  if (sortiert.length > ARBEITSSATZ) archiviere(sortiert.slice(ARBEITSSATZ))
  const data = JSON.stringify(sortiert.slice(0, ARBEITSSATZ), null, 2)
  const tmp = INBOUND_FILE + '.tmp-' + process.pid + '-' + Date.now()
  try {
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, INBOUND_FILE)
    // Cache sofort auf den neuen Stand setzen (gleicher Inhalt wie die Datei):
    try {
      const st = fs.statSync(INBOUND_FILE)
      __inboundCache = { key: st.mtimeMs + ':' + st.size, data: sortiert.slice(0, ARBEITSSATZ) }
    } catch { __inboundCache = null }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch {}
    throw e
  }
}

async function syncGmail({ limit = 20 } = {}) {
  const email = connections.gmail.email
  const pass = secrets.gmail
  if (!email || !pass) throw new Error('Gmail nicht verbunden (E-Mail + App-Passwort erforderlich).')
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: email, pass }, logger: false,
  })
  await client.connect()
  let added = 0
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const status = await client.status('INBOX', { messages: true })
      const total = status.messages || 0
      if (total > 0) {
        const start = Math.max(1, total - limit + 1)
        const store = readInbound()
        const known = new Set(store.map((t) => t.gmail_uid).filter(Boolean))
        for await (const msg of client.fetch(`${start}:*`, { source: true, uid: true })) {
          if (known.has(msg.uid)) continue
          const parsed = await simpleParser(msg.source)
          const fromAddr = parsed.from?.value?.[0] || {}
          // skip our own outgoing copies
          if ((fromAddr.address || '').toLowerCase() === email.toLowerCase()) continue
          store.unshift({
            id: Date.now() + msg.uid,
            gmail_uid: msg.uid,
            ticket_number: nextTicketNumber(store),
            subject: parsed.subject || '(Kein Betreff)',
            customer_email: fromAddr.address || 'unbekannt',
            customer_name: fromAddr.name || null,
            channel: 'email',
            status: 'open',
            received_at: (parsed.date || new Date()).toISOString(),
            body_text: (parsed.text || htmlZuText(parsed.html) || '').trim().slice(0, 4000),
          })
          added++
        }
        writeInbound(store)
      }
    } finally { lock.release() }
  } finally { await client.logout().catch(() => {}) }
  connections.gmail.lastSync = new Date().toISOString()
  connections.gmail.syncedCount = (connections.gmail.syncedCount || 0) + added
  connections.gmail.connected = true
  saveConnections(connections)
  return added
}

// ---- Gmail via OAuth (Google API) — no app password needed ----------------
const GMAIL_REDIRECT = `http://localhost:${PORT}/api/gmail/oauth/callback`
// Workspace-Kennung der Oberflaeche - betrieblich, deshalb aus der Umgebung.
const APP_WORKSPACE = process.env.APP_WORKSPACE || 'workspace'
const APP_INTEGRATIONS_URL = process.env.APP_URL
  ? `${process.env.APP_URL}/workspace/${APP_WORKSPACE}/organization/integrations`
  : `http://localhost:5180/workspace/${APP_WORKSPACE}/organization/integrations`
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ')

function b64urlDecode(s) {
  try { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8') } catch { return '' }
}
function gmailExtractBody(payload) {
  if (!payload) return ''
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64urlDecode(payload.body.data)
  if (payload.parts) { for (const p of payload.parts) { const t = gmailExtractBody(p); if (t) return t } }
  if (payload.mimeType === 'text/html' && payload.body?.data) return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, ' ')
  if (payload.body?.data) return b64urlDecode(payload.body.data)
  return ''
}

async function gmailAccessToken() {
  if (secrets.gmailAccess && secrets.gmailAccess.exp > Date.now() + 30000) return secrets.gmailAccess.token
  if (!secrets.gmailRefresh) throw new Error('Gmail OAuth nicht verbunden.')
  const body = new URLSearchParams({
    client_id: connections.gmail.clientId, client_secret: secrets.gmailClientSecret,
    refresh_token: secrets.gmailRefresh, grant_type: 'refresh_token',
  })
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
  const t = await r.json()
  if (!t.access_token) throw new Error('Token-Refresh fehlgeschlagen: ' + JSON.stringify(t).slice(0, 150))
  secrets.gmailAccess = { token: t.access_token, exp: Date.now() + (t.expires_in || 3500) * 1000 }
  return t.access_token
}

async function syncGmailApi({ limit = 20 } = {}) {
  const token = await gmailAccessToken()
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=in:inbox`, { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json())
  const msgs = list.messages || []
  const store = readInbound()
  const known = new Set(store.map((t) => t.gmail_id).filter(Boolean))
  let added = 0
  for (const m of msgs) {
    if (known.has(m.id)) continue
    const full = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.json())
    const headers = full.payload?.headers || []
    const h = (n) => (headers.find((x) => x.name.toLowerCase() === n) || {}).value || ''
    const from = h('from')
    const fromEmail = ((from.match(/<(.+?)>/) || [])[1] || from).trim()
    const fromName = from.replace(/<.*>/, '').replace(/"/g, '').trim() || null
    if ((fromEmail || '').toLowerCase() === (connections.gmail.email || '').toLowerCase()) continue
    const bodyText = (gmailExtractBody(full.payload) || full.snippet || '').trim().slice(0, 4000)
    store.unshift({
      id: Date.now() + added,
      gmail_id: m.id,
      ticket_number: nextTicketNumber(store),
      subject: h('subject') || '(Kein Betreff)',
      customer_email: fromEmail || 'unbekannt',
      customer_name: fromName,
      channel: 'email', status: 'open',
      received_at: h('date') ? new Date(h('date')).toISOString() : new Date().toISOString(),
      body_text: bodyText,
    })
    added++
  }
  writeInbound(store)
  connections.gmail.lastSync = new Date().toISOString()
  connections.gmail.syncedCount = (connections.gmail.syncedCount || 0) + added
  saveConnections(connections)
  if (added > 0) autoDraftNewRecords().catch(() => {})
  return added
}

// send a reply via Gmail API (RFC822 raw)
async function gmailSend({ to, subject, text }) {
  const token = await gmailAccessToken()
  const raw = [
    `From: ${connections.gmail.email}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=UTF-8',
    '', text,
  ].join('\r\n')
  const encoded = Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  })
  if (!r.ok) throw new Error('Gmail send ' + r.status + ': ' + (await r.text()).slice(0, 200))
  return r.json()
}

// Provider-Namen, die nie als Kundenname durchgehen dürfen
const GENERIC_FROM_NAME = /^(gmail|google|googlemail|outlook|hotmail|yahoo|gmx|web\.de|t-online|icloud|mail|e-?mail|apple|freenet)$/i

// Quoted-Printable nachträglich auflösen (04.08.): Manche Absender (z.B. Klaviyo)
// liefern Text, dessen Kodierung der Parser nicht auflöst — dann steht "=C3=B6"
// statt "ö" und "=\n" mitten im Satz im Ticket (siehe #1457). Wir dekodieren nur,
// wenn der Text eindeutig danach aussieht, damit normale Mails unberührt bleiben.
function decodeQuotedPrintable(s) {
  const str = String(s || '')
  if (!str) return str
  const softBreaks = (str.match(/=\r?\n/g) || []).length
  const hexEsc = (str.match(/=[0-9A-F]{2}/g) || []).length
  if (softBreaks < 2 && hexEsc < 4) return str            // sieht normal aus
  try {
    const joined = str.replace(/=\r?\n/g, '')             // Soft Line Breaks entfernen
    const bytes = []
    for (let i = 0; i < joined.length; i++) {
      const m = joined.slice(i, i + 3).match(/^=([0-9A-F]{2})$/)
      if (m) { bytes.push(parseInt(m[1], 16)); i += 2 } else {
        for (const b of Buffer.from(joined[i], 'utf8')) bytes.push(b)
      }
    }
    const out = Buffer.from(bytes).toString('utf8')
    // Nur übernehmen, wenn das Ergebnis plausibel ist (keine Ersatzzeichen-Flut)
    if ((out.match(/�/g) || []).length > 3) return str
    return out.replace(/ /g, ' ').replace(/[​-‍﻿]/g, '')
  } catch { return str }
}

// WICHTIGE ABSENDER, die niemals im Spam versauern duerfen. Reine Domain-Liste,
// gegen die ECHTE Absenderadresse geprueft (IONOS pruefta SPF/DKIM vorher).
// Erweitern: einfach Domain ergaenzen.
const SPAM_RETTUNG_DOMAINS = [
  'triplewhale.com', 'shopify.com', 'klarna.com', 'paypal.com', 'stripe.com',
  'ionos.de', 'ionos.com', 'hetzner.com', 'hetzner.de', 'anthropic.com',
  'dhl.de', 'post.at', 'post.ch', 'google.com', 'meta.com', 'facebook.com',
  'faire.com', 'kaching.apps', 'billbee.io', 'sendcloud.com',
  // Finanzdienste ergaenzt 13.09.2026: Bestaetigungs- und Verifizierungsmails
  // dieser Anbieter duerfen NIE im Spam haengen bleiben (Airwallex-Anmeldung).
  'airwallex.com', 'wise.com', 'revolut.com', 'mollie.com', 'adyen.com',
]
function istGeretteterAbsender(adresse) {
  const a = String(adresse || '').toLowerCase().trim()
  const dom = a.split('@')[1] || ''
  if (!dom) return false
  return SPAM_RETTUNG_DOMAINS.some((d) => dom === d || dom.endsWith('.' + d))
}
// Holt Mails wichtiger Absender aus dem Spam-Ordner zurueck in den Posteingang.
// Laeuft direkt vor dem normalen Abruf, damit die geretteten Mails im selben
// Durchgang zu Tickets werden. Fehler hier duerfen den Abruf NIE stoppen.
async function rettungAusSpam(client) {
  let gerettet = 0
  let lock
  try { lock = await client.getMailboxLock('Spam') } catch { return 0 }
  try {
    const gesamt = client.mailbox.exists || 0
    if (!gesamt) return 0
    const von = Math.max(1, gesamt - 80)   // nur der frische Teil, spart Zeit
    const uids = []
    for await (const m of client.fetch(`${von}:*`, { envelope: true, uid: true })) {
      const abs = (m.envelope && m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || ''
      if (istGeretteterAbsender(abs)) uids.push(m.uid)
    }
    if (uids.length) {
      await client.messageMove(uids, 'INBOX', { uid: true })
      gerettet = uids.length
      console.log('[imap] ' + gerettet + ' Mail(s) wichtiger Absender aus dem Spam zurueckgeholt')
    }
  } catch (e) {
    console.log('[imap] Spam-Rettung uebersprungen:', String((e && e.message) || e).slice(0, 80))
  } finally { try { lock.release() } catch {} }
  return gerettet
}

// ---- Generic IMAP mailbox (IONOS etc.) — normal password, no OAuth --------
async function syncImapMailbox({ limit = 25 } = {}) {
  const conf = connections.imap
  const host = conf.host || 'imap.ionos.de'
  const email = conf.email
  const pass = secrets.imap
  if (!email || !pass) throw new Error('E-Mail und Passwort erforderlich.')
  const client = new ImapFlow({ host, port: 993, secure: true, auth: { user: email, pass }, logger: false })
  await client.connect()
  let added = 0
  try {
    await rettungAusSpam(client)          // wichtige Absender zuerst aus dem Spam holen
    const lock = await client.getMailboxLock('INBOX')
    try {
      const status = await client.status('INBOX', { messages: true })
      const total = status.messages || 0
      if (total > 0) {
        const start = Math.max(1, total - limit + 1)
        // RACE-FIX (31.07.): Früher wurde EINE Store-Kopie über den gesamten,
        // lange laufenden Abruf gehalten und am Ende komplett zurückgeschrieben.
        // Alles, was parallel schrieb (gesendete Antworten, ack_sent-Vermerke,
        // Statuswechsel, ganze Tickets wie damals #1188), wurde dabei überrollt.
        // Jetzt: pro Mail frisch lesen und sofort schreiben — zwischen
        // readInbound() und writeInbound() liegt bewusst KEIN await.
        const known = new Set(readInbound().flatMap((t) => [t.imap_uid, ...(t.seen_uids || [])]).filter((x) => x != null))
        for await (const msg of client.fetch(`${start}:*`, { source: true, uid: true })) {
          if (known.has(`${host}:${msg.uid}`)) continue
          const parsed = await simpleParser(msg.source)
          const fromAddr = parsed.from?.value?.[0] || {}
          if ((fromAddr.address || '').toLowerCase() === email.toLowerCase()) continue
          let bodyText = decodeQuotedPrintable((parsed.text || htmlZuText(parsed.html) || '').trim())
          // Manche Absender packen HTML in den Text-Teil → Tags raus, sonst
          // landet roher Code als Ticket-Body.
          if (/<[a-z!/][^>]*>/i.test(bodyText)) {
            bodyText = bodyText.replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
              .replace(/&nbsp;/gi, ' ').replace(/&#39;/g, "'").replace(/&amp;/gi, '&')
              .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
          }
          // CSS-Reste entfernen: Wenn eine Kundin auf unsere (gestylte) Shopify-
          // Bestellbestätigung antwortet, wandelt ihr Mail-Client das HTML in Text
          // um — die CSS-Regeln aus dem <style>-Kopf landen dann als Klartext im
          // Body ("body { margin: 0px; } h1 a:hover { … }"). Solche Regel-Blöcke
          // (Selektor + geschweifte Klammern mit CSS-Deklarationen) rausfiltern.
          bodyText = bodyText
            .replace(/(?:^|\s)[.#\w][-\w.#:,()\s>*]{0,120}\{[^{}]*:[^{}]*\}/g, ' ')
            .replace(/@media[^{]*\{[\s\S]*?\}\s*\}/g, ' ')
            .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
          bodyText = bodyText.slice(0, 4000)
          // Links aus dem HTML-Teil retten: Gmail/Apple-Mail packen z.B.
          // Google-Drive-Freigaben NUR als <a href> ins HTML — im Text steht
          // bloß der Dateiname. Ohne das gehen uns Video-/Datei-Links verloren.
          bodyText = appendHtmlLinks(bodyText, parsed.html)
          const dateIso = (parsed.date || new Date()).toISOString()
          // Bei Relay-Mails (Shopify-Kontaktformular) die echte Kundin aus dem Text ziehen
          const real = extractRealCustomer(fromAddr.address, fromAddr.name, bodyText)
          const custEmail = real.email
          const atts = saveAttachments(parsed, msg.uid)
          // Ab hier kein await mehr: frischer Stand rein, Änderung sofort raus.
          const store = readInbound()
          known.add(`${host}:${msg.uid}`)
          // Absendername "Gmail"/"Google"/&co. ist der Mail-PROVIDER, nicht die
          // Kundin (manche Konten senden so). Dann: echten Namen aus früheren
          // Tickets derselben Adresse übernehmen, sonst lieber gar kein Name —
          // "Guten Abend Gmail" darf nie wieder passieren (31.07., #1372-74).
          if (real.name && GENERIC_FROM_NAME.test(real.name.trim())) {
            const prior = store.find((x) => String(x.customer_email || '').toLowerCase() === String(custEmail || '').toLowerCase()
              && x.customer_name && !GENERIC_FROM_NAME.test(String(x.customer_name).trim()))
            real.name = prior ? prior.customer_name : null
          }
          if (threadIntoExisting(store, { email: custEmail, subject: parsed.subject, text: bodyText, date: dateIso, attachments: atts })) {
            // Antwort im bestehenden Gespräch — UID als bekannt markieren
            const rec0 = store[0]
            if (!Array.isArray(rec0.seen_uids)) rec0.seen_uids = []
            rec0.seen_uids.push(`${host}:${msg.uid}`)
            writeInbound(store)
            added++
            continue
          }
          const recNew = ensureMessages({
            id: Date.now() + msg.uid,
            imap_uid: `${host}:${msg.uid}`,
            ticket_number: nextTicketNumber(store),
            subject: parsed.subject || '(Kein Betreff)',
            customer_email: custEmail,
            customer_name: real.name,
            channel: 'email', status: 'open',
            received_at: dateIso,
            body_text: bodyText,
          })
          if (atts.length) recNew.messages[recNew.messages.length - 1].attachments = atts
          store.unshift(recNew)
          writeInbound(store)
          added++
        }
      }
    } finally { lock.release() }
  } finally { await client.logout().catch(() => {}) }
  connections.imap.lastSync = new Date().toISOString()
  connections.imap.syncedCount = (connections.imap.syncedCount || 0) + added
  connections.imap.connected = true
  saveConnections(connections)
  if (added > 0) autoDraftNewRecords().catch(() => {})
  return added
}

// HTML-Version jeder Antwort: Text + die originale Barbara-Signatur aus den
// Leichtkraut-Klaviyo-Flows (1:1 von Samuel übernommen, 16.07.2026).
// Schneidet KI-Meta-Vorspann VOR der eigentlichen Anrede ab — solcher interner
// Kommentar ("Ich sehe, dass die Nachricht leer ist…") darf nie in die Mail.
function stripPreamble(s) {
  const str = String(s || '')
  const m = str.match(/(Liebe[rs]?\s|Hallo\s|Guten\s(?:Morgen|Tag|Abend)|Sehr geehrte)/i)
  if (m && m.index > 0) {
    const pre = str.slice(0, m.index).toLowerCase()
    if (/ich sehe|ich schaue|einschätzung|routing-regel|es handelt sich|hier ist|hier der|hinweis|entwurf|die (?:letzte )?nachricht|ist leer|leer angekommen|interne|kein neuer text/.test(pre)) {
      return str.slice(m.index)
    }
  }
  return str
}

// Nackte Tracking-URLs deterministisch in [Sendung verfolgen](url) umwandeln,
// falls die KI mal nur die rohe URL ausgibt (die bettet der Editor sonst nicht ein).
function embedTrackingLinks(text, fallbackLink, sendung) {
  let s = String(text || '')
  const re = /(?<!\]\()(https?:\/\/(?:www\.)?(?:dhl\.de|post\.at|post\.ch)\/[^\s<>()\]]+)/gi
  s = s.replace(re, (url) => `[Sendung verfolgen](${url})`)
  // REPARATUR (06.08., Fall #1553 Kundin D): Das Modell schrieb den
  // Linktext "Sendung verfolgen" hin, ließ die URL aber weg — die Kundin sah
  // ein totes Wort statt eines Links. Passiert vor allem bei AT/CH-Sendungen,
  // weil die Prompt-Regel DHL-lastig formuliert ist. Wir verlassen uns deshalb
  // nicht mehr auf das Modell: Steht der Linktext ohne URL da und wir kennen
  // die echte Sendungs-URL, setzen wir sie deterministisch ein.
  if (fallbackLink) {
    s = s.replace(/(?<!\]\()(?<!\[)\bSendung verfolgen\b(?!\]\()(?!\]\()/gi, `[Sendung verfolgen](${fallbackLink})`)
    // Doppelte Verlinkung heilen, falls der Text schon einen Link enthielt
    s = s.replace(/\[\[Sendung verfolgen\]\([^)]*\)\]\([^)]*\)/gi, `[Sendung verfolgen](${fallbackLink})`)
  }
  // ENTDOPPLUNG (08.08., Fall #1585 Kunde J): Das Modell schreibt den Link
  // manchmal doppelt — einmal als fertigen Markdown-Link und direkt dahinter
  // noch einmal die nackte URL in Klammern. Die Umwandlung oben macht daraus
  // zwei identische Links, die Kundin sah "Sendung verfolgen (Sendung verfolgen)".
  // Deshalb am Ende IMMER zusammenführen, unabhängig davon, wer den Link erzeugt hat.
  //   a) Link, direkt gefolgt vom selben Link in Klammern
  s = s.replace(/(\[Sendung verfolgen\]\(([^)]+)\))\s*\(\s*\[Sendung verfolgen\]\(\2\)\s*\)/gi, '$1')
  //   b) Link, direkt gefolgt vom selben Link ohne Klammern
  s = s.replace(/(\[Sendung verfolgen\]\(([^)]+)\))(?:\s*\[Sendung verfolgen\]\(\2\))+/gi, '$1')
  //   c) Link, gefolgt von der nackten gleichen URL (auch in Klammern)
  s = s.replace(/(\[Sendung verfolgen\]\(([^)]+)\))\s*\(?\s*\2\s*\)?/gi, '$1')
  //   d) Letzte Sicherung: dieselbe Sendungs-URL taucht mehrfach im Text auf,
  //      auch weit auseinander. Nur das erste Vorkommen bleibt stehen, spätere
  //      werden samt umschließender Klammern entfernt.
  const gesehen = new Set()
  s = s.replace(/\s*\(?\s*\[Sendung verfolgen\]\(([^)]+)\)\s*\)?/gi, (treffer, url, pos) => {
    if (gesehen.has(url)) return ' '
    gesehen.add(url)
    return treffer
  })
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n')
  // SENDUNGSNUMMER SICHTBAR (08.08., Fall #1585): Der Link allein reicht nicht.
  // Kunden wollen die Nummer lesen und selbst kopieren koennen, und sie wollen
  // wissen, WELCHER Dienstleister liefert. Deshalb haengen wir die Nummer hinter
  // den Link, falls das Modell sie nicht ohnehin schon genannt hat.
  //
  // ZWEI FEHLER, BEIDE AM 09.08. (Fall #1596) gefunden und behoben:
  //   (1) Die Nummer kam nur an, wenn der Aufrufer sie mitgab. Sie hing damit an
  //       trackShipment(), einer Fremd-API, die still ausfallen kann. Fällt sie
  //       aus, schreibt das Modell den Link trotzdem (die Nummer steht ja im
  //       Kontext), aber die Zeile fehlte. Jetzt lesen wir die Nummer notfalls
  //       AUS DEM LINK selbst — der ist immer da, wenn es etwas zu verfolgen gibt.
  //   (2) Die Prüfung "steht die Nummer schon im Text?" war schlicht falsch: die
  //       Nummer steckt IMMER in der URL (piececode=...), die Bedingung war also
  //       nie erfüllt und die Zeile wurde NIE angehängt. Wir prüfen jetzt nur den
  //       Fließtext, ohne die Link-Ziele.
  // Damit hängt die Sendungsnummer an nichts Unzuverlässigem mehr.
  //
  let nummer = sendung && sendung.number ? String(sendung.number).trim() : ''
  let carrier = sendung && sendung.carrier ? String(sendung.carrier).trim() : ''
  const ersterLink = s.match(/\[Sendung verfolgen\]\(([^)]+)\)/i)
  if (ersterLink) {
    const ziel = ersterLink[1]
    if (!nummer) {
      // längste Ziffernfolge in der URL ist die Sendungsnummer (piececode, IDs, …)
      const kandidaten = (ziel.match(/\d{8,}/g) || []).sort((a, b) => b.length - a.length)
      if (kandidaten.length) nummer = kandidaten[0]
    }
    if (!carrier) {
      carrier = /dhl\.de/i.test(ziel) ? 'DHL'
        : /post\.at/i.test(ziel) ? 'Österreichische Post'
        : /post\.ch/i.test(ziel) ? 'Schweizerische Post' : ''
    }
  }
  if (nummer && !carrier) {
    const erkannt = detectCarrier(nummer, fallbackLink || '')
    if (erkannt && erkannt !== 'unknown') carrier = CARRIER_META[erkannt].name
  }
  if (nummer && ersterLink) {
    const ohneLinkZiele = s.replace(/\]\([^)]*\)/g, ']()')   // Link-URLs ausblenden
    if (!ohneLinkZiele.includes(nummer)) {
      s = s.replace(/(\[Sendung verfolgen\]\([^)]+\))/i,
        `$1\n\nSendungsnummer${carrier ? ' (' + carrier + ')' : ''}: ${nummer}`)
    }
  }
  // DRITTER FALL, 10.08. (Fall #1612): Barbara schrieb ueber die Sendung
  // ("bei DHL elektronisch angekuendigt"), setzte aber KEINEN Link, weil das
  // Paket noch nicht unterwegs ist. Damit fiel auch die Nummer weg, denn beides
  // hing bisher an der Anwesenheit eines Links. Die Kundin sah weder Nummer noch
  // Link, obwohl beides bekannt war. Jetzt bauen wir den Block selbst, sobald
  // (a) eine Sendungsnummer bekannt ist und (b) die Mail ueberhaupt von der
  // Sendung handelt. Ohne Versandbezug passiert weiterhin nichts, damit z.B.
  // eine Kuendigungsbestaetigung keinen Tracking-Block bekommt.
  const versandBezug = /\b(paket|sendung|dhl|versand|verschickt|versendet|unterwegs|zustell|lieferung|geliefert|abholung)/i
  if (nummer && !ersterLink && versandBezug.test(s)) {
    let link = fallbackLink || ''
    if (!link) {
      const erkannt = detectCarrier(nummer, '')
      link = CARRIER_META[erkannt] ? CARRIER_META[erkannt].link(nummer) : ''
      if (!carrier && erkannt !== 'unknown') carrier = CARRIER_META[erkannt].name
    }
    if (link) {
      const block = `Sendungsnummer${carrier ? ' (' + carrier + ')' : ''}: ${nummer}\n[Sendung verfolgen](${link})`
      const gruss = s.match(/\n\n(Ich wünsche |Alles Liebe|Alles Gute|Herzliche Grüße|Liebe Grüße|Viele Grüße|Beste Grüße)/)
      if (gruss) s = s.slice(0, gruss.index) + `\n\n${block}` + s.slice(gruss.index)
      else s = s.replace(/\s*$/, '') + `\n\n${block}`
    }
  }
  return s
}

function buildHtmlMail(text) {
  let esc = embedTrackingLinks(stripPreamble(text)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Links klickbar machen: erst Markdown [Text](URL), dann nackte URLs
  esc = esc.replace(/\[([^\]]{1,80})\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" style="color:#1d5240;font-weight:600;">$1</a>')
  esc = esc.replace(/(^|[^">])(https?:\/\/[^\s<>"]+)/g, '$1<a href="$2" style="color:#1d5240;">$2</a>')
  esc = esc.replace(/\n/g, '<br/>')
  // KEINE Bilder mehr in ausgehenden Mails: eingebettete Grafiken (Unterschrift/Avatar)
  // lösen bei Empfängern die "Bilder ausgeblendet / diese Nachricht sieht verdächtig
  // aus"-Warnung aus. Signatur daher ausschließlich als Text.
  // Dynamische Signatur: persönliche Gründer-/CEO-Mails werden von "Leon" gezeichnet
  // (erkennbar an CEO/Gründer-Nennung im Text) — sonst der Standard "Barbara".
  const isFounder = /\bLeon\b/.test(text) && /(CEO|Gr[üu]nder|Gesch[äa]ftsf[üu]hrer)/i.test(text)
  const sigName = isFounder ? 'Leon' : 'Barbara'
  const sigRole = isFounder ? 'GRÜNDER &amp; CEO · LEICHTKRAUT' : 'LEICHTKRAUT KUNDENBETREUUNG'
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff;">
  <div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:600px;padding:8px 4px;">
    ${esc}
    <div style="margin-top:28px;border-top:1px solid #e5e7eb;padding-top:18px;">
      <!-- LEICHTKRAUT · SIGNATUR (reiner Text, keine Bilder) -->
      <div style="text-align:left;"><span style="color:#0f2a20;font-weight:600;font-family:Lora,Georgia,serif;font-size:20px;font-style:italic;">${sigName}</span></div>
      <div style="line-height:4px;height:4px;font-size:4px;">&nbsp;</div>
      <div style="text-align:left;"><a href="mailto:barbara@leichtkraut.de" style="color:#3e6857;font-family:Inter,Arial,sans-serif;font-size:12px;text-decoration:none;">barbara@leichtkraut.de</a></div>
      <div style="line-height:4px;height:4px;font-size:4px;">&nbsp;</div>
      <div style="text-align:left;"><span style="color:#3e6857;font-weight:600;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.06em;">${sigRole}</span></div>
    </div>
  </div></body></html>`
}

async function smtpSend({ to, subject, text, attachments, bcc }) {
  const conf = connections.imap
  if (!secrets.imap || !conf.email) throw new Error('IONOS-Postfach nicht verbunden.')
  // Hetzner blockt Port 465 outbound — 587 (STARTTLS) ist der verifizierte Weg.
  const port = Number(conf.smtpPort || 587)
  const transporter = nodemailer.createTransport({
    host: conf.smtpHost || 'smtp.ionos.com',
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: conf.email, pass: secrets.imap },
  })
  // Prefer the brand address as sender if configured; fall back to the mailbox itself
  // if IONOS rejects foreign From headers. Display-Name: "Barbara von Leichtkraut".
  const addr = conf.sendAs || conf.email
  const from = { name: 'Barbara von Leichtkraut', address: addr }
  try {
    return await transporter.sendMail({ from, replyTo: conf.sendAs || conf.email, to, ...(bcc ? { bcc } : {}), subject: subject || '(Kein Betreff)', text, html: buildHtmlMail(text), attachments: attachments || [] })
  } catch (e) {
    if (addr !== conf.email) {
      console.log('[smtp] From', addr, 'abgelehnt, sende als', conf.email, '—', String(e?.message || e).slice(0, 120))
      return transporter.sendMail({ from: { name: 'Barbara von Leichtkraut', address: conf.email }, replyTo: conf.sendAs || conf.email, to, ...(bcc ? { bcc } : {}), subject: subject || '(Kein Betreff)', text, html: buildHtmlMail(text), attachments: attachments || [] })
    }
    throw e
  }
}

const app = express()
// KEIN CACHING AUF /api (Samuel, 11.08.): Die nginx-Logs bewiesen, dass ein
// Browser-Poll 7 Sekunden NACH einem Versand ein 304 (Not Modified) bekam und
// mit seiner veralteten Kopie weiterarbeitete — gesendete Mails blieben dadurch
// im Posteingang stehen. ETags/bedingte Antworten sind fuer eine Live-Liste,
// die sich sekuendlich aendert, schlicht das falsche Werkzeug. Ab jetzt: jede
// /api-Antwort ist voll und frisch, nichts darf sie unterwegs oder im Browser
// zwischenspeichern. Die Bandbreite faengt nginx-gzip auf.
app.set('etag', false)
app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store, no-cache, must-revalidate'); next() })
app.use(cors())
// Sicherheits-Header (Sam, 05.10.2026): HTTPS erzwingen, kein Einbetten auf fremden Seiten, kein MIME-Raten, keine Kamera/Mikro/Standort
app.use((req, res, next) => { res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'SAMEORIGIN'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()'); next() })
// Icons fuer Browser-Tabs, Seitenleisten und Homescreen (OS 2.65): oeffentlich, ohne Login, eine Woche im Cache
const ICON_DIR = path.join(__dirname, 'pages', 'icons')
const ICONS = { '/favicon.ico': 'favicon.ico', '/favicon.svg': 'favicon.svg', '/favicon-16.png': 'favicon-16.png', '/favicon-32.png': 'favicon-32.png', '/favicon-48.png': 'favicon-48.png', '/apple-touch-icon.png': 'apple-touch-icon.png', '/apple-touch-icon-precomposed.png': 'apple-touch-icon.png', '/icon-192.png': 'icon-192.png', '/icon-512.png': 'icon-512.png' }
// nginx liefert *.png/*.ico auf dieser Domain aus /opt/topg/dist (Mail-App); deshalb fuer das OS unter /api/icons/, das geht immer an Node
for (const k of Object.keys(ICONS)) ICONS['/api/icons' + k] = ICONS[k]
app.get(Object.keys(ICONS), (req, res) => { const f = path.join(ICON_DIR, ICONS[req.path]); if (!fs.existsSync(f)) return res.status(404).end(); res.setHeader('Cache-Control', 'public, max-age=604800'); res.sendFile(f) })
app.get('/os.webmanifest', (req, res) => { res.type('application/manifest+json').send(JSON.stringify({ name: 'Leichtkraut OS', short_name: 'Leichtkraut OS', start_url: '/os', display: 'standalone', background_color: '#08070d', theme_color: '#0b0912', icons: [{ src: '/api/icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/api/icons/icon-512.png', sizes: '512x512', type: 'image/png' }] })) })
app.use(express.json({ limit: '25mb', verify: (req, _res, buf) => { req.rawBody = buf } }))

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

// ─────────────────────────────────────────────────────────────────────────────
// AUTHENTIFIZIERUNG
// Vorher war das Tool komplett offen: Jeder mit der URL konnte alle Kundendaten
// lesen. Jetzt: Session-Login mit scrypt-gehashten Passwörtern, httpOnly-Cookie,
// geschützte API. Beim ersten Start wird über /setup das Admin-Konto angelegt.
// ─────────────────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(DATA_DIR, 'users.json')
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json')
const SESSION_DAYS = 14

function readUsers() { try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) } catch { return [] } }
function writeUsers(u) { fs.writeFileSync(USERS_FILE, JSON.stringify(u, null, 2), { mode: 0o600 }) }
function readSessions() { try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')) } catch { return {} } }
function writeSessions(s) { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 }) }

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const dk = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 })
  return `${salt}:${dk.toString('hex')}`
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hex] = String(stored).split(':')
    const dk = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 })
    return crypto.timingSafeEqual(Buffer.from(hex, 'hex'), dk)
  } catch { return false }
}
function parseCookies(req) {
  const out = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
function createSession(userId, extra) {
  const token = crypto.randomBytes(32).toString('hex')
  const sessions = readSessions()
  // abgelaufene Sessions gleich mit aufräumen
  const now = Date.now()
  for (const [k, v] of Object.entries(sessions)) if (!v.exp || v.exp < now) delete sessions[k]
  sessions[token] = Object.assign({ userId, exp: now + SESSION_DAYS * 86400_000, created: now }, extra || {})
  writeSessions(sessions)
  return token
}
function sessionUser(req) {
  const token = parseCookies(req).lk_session
  if (!token) return null
  const s = readSessions()[token]
  if (!s || s.exp < Date.now()) return null
  const u = readUsers().find((x) => x.id === s.userId)
  if (!u) return null
  // Admins (Zugang zum OS) nur mit Sitzung nach bestandener Zwei-Faktor-Anmeldung (seit 05.10.2026)
  if (u.role === 'admin' && !s.zf) return null
  return { ...u, _token: token }
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `lk_session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax; Secure`)
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'lk_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure')
}
// Einfache Brute-Force-Bremse pro IP
const loginFails = new Map()
function tooManyAttempts(ip) {
  const e = loginFails.get(ip)
  if (!e) return false
  if (Date.now() - e.first > 15 * 60_000) { loginFails.delete(ip); return false }
  return e.count >= 8
}
function noteFail(ip) {
  const e = loginFails.get(ip) || { count: 0, first: Date.now() }
  e.count++; loginFails.set(ip, e)
}

// ── Zwei-Faktor (TOTP, RFC 6238): 6 Ziffern, 30 Sekunden, kompatibel mit Google Authenticator, 1Password, Authy ──
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32enc(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5 } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out }
function b32dec(str) { let bits = 0, val = 0; const out = []; for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8 } } return Buffer.from(out) }
function totpCode(secret, step) { const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(step)); const h = crypto.createHmac('sha1', b32dec(secret)).update(buf).digest(); const o = h[h.length - 1] & 15; return String(((h.readUInt32BE(o) & 0x7fffffff) % 1000000)).padStart(6, '0') }
// Gibt den Zeitschritt zurueck, wenn der Code passt (±30 s Toleranz), sonst -1. Ein Schritt darf nur einmal benutzt werden.
function totpPruefen(secret, code, letzter, fenster) { code = String(code || '').replace(/\D/g, ''); if (!/^\d{6}$/.test(code)) return -1; const jetzt = Math.floor(Date.now() / 30000); const f = fenster || 1; const ds = [0]; for (let i = 1; i <= f; i++) ds.push(-i, i); for (const d of ds) { const st = jetzt + d; if (letzter && st <= letzter) continue; const c = totpCode(secret, st); if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(code))) return st } return -1 }
const zfTickets = new Map() // Ticket nach richtigem Passwort, 5 Minuten gueltig, hoechstens 5 Code-Versuche
function zfTicket(userId, art, secret) { const t = crypto.randomBytes(24).toString('hex'); zfTickets.set(t, { userId, art, secret, exp: Date.now() + 5 * 60_000, versuche: 0 }); for (const [k, v] of zfTickets) if (v.exp < Date.now()) zfTickets.delete(k); return t }

// Diese Pfade bleiben ohne Login erreichbar (OAuth-Rückläufer + Login selbst)
const PUBLIC_API = new Set(['/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/setup', '/api/auth/2fa', '/api/auth/2fa-einrichten'])
function isPublicPath(p) {
  if (PUBLIC_API.has(p)) return true
  return p.startsWith('/api/shopify/oauth/') || p.startsWith('/api/gmail/oauth/')
    || p.startsWith('/api/meta/oauth/') || p === '/api/meta/webhook'
    || p === '/api/os/shopify/webhook' || p === '/api/hook/chat-fertig'   // Shopify-Webhook: prueft selbst die HMAC-Signatur (OS Manager, 05.09.2026)
    || p.startsWith('/api/os/video/')    // signierte, zeitlich begrenzte Video-Links fuer Meta (OS Manager, 06.09.2026)
}

// ENTFERNT 07.09.2026: Hier stand ein temporaerer Einmal-Link, mit dem Sam sein
// Passwort OHNE Anmeldung neu setzen konnte. Der Merker stand auf Modulebene und
// sprang bei JEDEM Serverneustart wieder auf "offen" - die Adresse war also
// dauerhaft ohne Login erreichbar. Gefunden beim Vorbereiten der
// GitHub-Veroeffentlichung. Passwoerter aendert Sam angemeldet im Tool.

// Service-Token für serverseitige Automatisierung (Wartungsskripte, Cronjobs).
// Liegt nur in server/.env und ist von außen nicht erreichbar — im Gegensatz zu
// einem localhost-Bypass, der wegen des nginx-Proxys jeden Besucher durchlassen
// würde.
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || ''
// Geteilte Planung (Sam, 04.10.2026): Wer den geheimen Link hat, sieht und bearbeitet NUR die Planung (Daily To-dos, Ziele).
// Erlaubt sind genau diese Aufrufe, alles andere bleibt hinter dem Login. Schluessel in data/os-module/planung-teilen.json, widerrufbar im OS.
const TEILEN_FILE = path.join(__dirname, 'data', 'os-module', 'planung-teilen.json')
function teilenLesen() { try { return JSON.parse(fs.readFileSync(TEILEN_FILE, 'utf8')) } catch { return {} } }
function teilenGueltig(tok) { const t = teilenLesen(); if (!t.aktiv || !t.token || !tok) return null; const a = Buffer.from(String(tok)), b = Buffer.from(String(t.token)); return a.length === b.length && crypto.timingSafeEqual(a, b) ? t : null }
// Nicht unter einem Mount-Pfad registriert: Express wuerde den umgeschriebenen req.url sonst nach next() wieder mit dem Praefix versehen
app.use((req, res, next) => {
  const m = req.path.match(/^\/api\/teilen\/([^/]+)(\/.*)?$/); if (!m) return next()
  const t = teilenGueltig(decodeURIComponent(m[1])); if (!t) return res.status(404).json({ error: 'Link ungültig oder widerrufen' })
  const rest = m[2] || '', q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  let ziel = null
  if (req.method === 'GET' && rest === '/planung') ziel = '/api/os/planung' + q
  else if (req.method === 'POST' && rest === '/aufgabe') ziel = '/api/os/planung/aufgabe'
  else if (req.method === 'POST' && rest === '/reihenfolge') ziel = '/api/os/planung/reihenfolge'
  else if (req.method === 'POST' && /^\/aufgabe\/[A-Za-z0-9]+$/.test(rest)) ziel = '/api/os/planung' + rest
  else if (req.method === 'POST' && /^\/ziel\/[A-Za-z0-9]+$/.test(rest)) ziel = '/api/os/planung' + rest
  if (!ziel) return res.status(404).json({ error: 'Nicht freigegeben' })
  req.user = { id: 'gast', name: t.name || 'Gast (Link)', role: 'admin', gast: true }; req._gast = true; req.url = ziel; next()
})
// Chat fertig → Prioritaets-To-do melden (Sam, 05.10.2026). Ein Stop-Hook in Claude Code auf Sams Mac schickt seine Hook-Daten hierher.
// Zuordnung zum Chat ueber den Projektordner (cwd). Gemeldet wird NUR, wenn Sam an diesem Chat eine offene, mit ★ markierte Aufgabe fuer heute hat.
// Ohne Login erreichbar, tut aber nichts ausser dieser einen Telegram-Meldung; je Aufgabe hoechstens alle 5 Minuten.
const hookZuletzt = {}
app.post('/api/hook/chat-fertig', express.json({ limit: '64kb' }), async (req, res) => {
  res.json({ ok: true })
  try {
    const b = req.body || {}; const cwd = String(b.cwd || '').replace(/\/+$/, ''); if (!cwd) return
    const chats = (osLesen().chats || []); // Exakter Ordner oder ein Unterordner davon (Chat 8 wechselt in Projektordner); der laengste passende Ordner gewinnt
    const c = chats.filter((x) => x.cwd && (cwd === x.cwd.replace(/\/+$/, '') || cwd.startsWith(x.cwd.replace(/\/+$/, '') + '/'))).sort((a, b) => b.cwd.length - a.cwd.length)[0]; if (!c) return
    hookZuletzt['chat' + c.nr] = Date.now(); console.log('[hook] Chat ' + c.nr + ' fertig')
    const d = planungLesen(), heute = berlinTag()
    const offen = d.heute.aufgaben.filter((a) => (a.person || 'sam') === 'sam' && Number(a.chat) === c.nr && a.prioritaet && !a.done && ((a.tag || heute) <= heute))
      .sort((x, y) => (x.pos == null ? 1e9 : x.pos) - (y.pos == null ? 1e9 : y.pos)); if (!offen.length) return
    const a = offen[0]; if (hookZuletzt[a.id] && Date.now() - hookZuletzt[a.id] < 5 * 60_000) return; hookZuletzt[a.id] = Date.now()
    const nr = d.heute.aufgaben.filter((x) => (x.person || 'sam') === 'sam' && (x.tag || heute) === (a.tag || heute)).sort((x, y) => (x.pos == null ? 1e9 : x.pos) - (y.pos == null ? 1e9 : y.pos)).findIndex((x) => x.id === a.id) + 1
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const text = '🔔 <b>CHAT ' + c.nr + ' · ' + esc(String(c.name || '').toUpperCase()) + ' IST FERTIG</b>\n\n⭐ Deine Priorität' + (nr ? ' Nr. ' + nr : '') + ':\n<b>' + esc(a.text) + '</b>\n\nWeiter geht\'s, der Chat wartet auf dich.'
    const id = tgLesen().chatId; if (!TG_TOKEN || !id) return
    await tgApi('sendMessage', { chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: [[{ text: '▶ Chat ' + c.nr + ' öffnen', url: 'https://os.leichtkraut.de/chat/' + c.nr }], [{ text: '🗓 Planung öffnen', url: 'https://os.leichtkraut.de/os#planung' }]] } })
    console.log('[hook] Chat ' + c.nr + ' fertig, Priorität gemeldet: ' + a.text.slice(0, 60))
  } catch (e) { console.warn('[hook] chat-fertig:', e.message) }
})
app.use((req, res, next) => {
  if (req._gast) return next()
  if (!req.path.startsWith('/api/')) return next()
  if (isPublicPath(req.path)) return next()
  if (SERVICE_TOKEN && req.headers['x-service-token'] === SERVICE_TOKEN) {
    req.user = { id: 'service', name: 'Automatisierung', role: 'admin' }
    return next()
  }
  const u = sessionUser(req)
  if (!u) return res.status(401).json({ error: 'Nicht angemeldet', login: true })
  req.user = u
  next()
})

// Stoerungsampel fuer die Oberflaeche. Absichtlich fuer JEDEN angemeldeten
// Benutzer lesbar, nicht nur fuer Admins: Mitarbeiterin A merkt als Erste, dass keine
// Entwuerfe kommen, und soll den Grund sehen statt zu raten.
app.get('/api/ki-status', (req, res) => {
  res.json({
    ok: !kiStoerung.aktiv,
    grund: kiStoerung.grund || '',
    code: kiStoerung.code || '',
    seit: kiStoerung.seit,
    zaehler: kiStoerung.zaehler,
  })
})

// Absturzmeldung aus dem Browser (16.09.2026). Nach Mitarbeiterin As
// "Unexpected Application Error" mussten wir raten, was den Absturz ausgeloest
// hat. Diese Meldung haelt fest, was im Moment des Absturzes aktiv war -
// vor allem, ob der Browser die Seite uebersetzt hat. Reine Diagnose,
// nichts davon steuert das Verhalten des Tools.
// NEUIGKEITEN-POP-UP (20.09.2026): Kleine "Neu im Tool"-Hinweise, die eine
// Person beim naechsten Oeffnen genau einmal sieht. Eintraege stehen in
// data/neuigkeiten.json: { id, fuer: "alle" | ["Mitarbeiterin B", ...], titel_de,
// titel_en, text_de: [...], text_en: [...] }. Wer was gesehen hat, steht in
// data/neuigkeiten-gesehen.json. Neuen Hinweis anlegen = Eintrag in die Datei
// schreiben, kein Neustart noetig (wird bei jeder Abfrage frisch gelesen).
const NEUIGKEITEN_FILE = path.join(DATA_DIR, 'neuigkeiten.json')
const NEUIGKEITEN_GESEHEN_FILE = path.join(DATA_DIR, 'neuigkeiten-gesehen.json')
function leseJsonDatei(f, leer) { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return leer } }
app.get('/api/neuigkeiten', (req, res) => {
  const u = req.user || {}
  const name = String(u.name || '').toLowerCase()
  const gesehen = (leseJsonDatei(NEUIGKEITEN_GESEHEN_FILE, {})[String(u.id)] || [])
  const alle = leseJsonDatei(NEUIGKEITEN_FILE, [])
  const offen = (Array.isArray(alle) ? alle : []).filter((n) => n && n.id && !gesehen.includes(n.id)
    && (n.fuer === 'alle' || (Array.isArray(n.fuer) && n.fuer.some((x) => String(x).toLowerCase() === name))))
  res.json({ neuigkeiten: offen })
})
app.post('/api/neuigkeiten/:id/gesehen', (req, res) => {
  const u = req.user || {}
  if (!u.id) return res.status(400).json({ error: 'Kein Benutzer.' })
  const g = leseJsonDatei(NEUIGKEITEN_GESEHEN_FILE, {})
  const liste = g[String(u.id)] || []
  if (!liste.includes(req.params.id)) liste.push(String(req.params.id).slice(0, 80))
  g[String(u.id)] = liste
  fs.writeFileSync(NEUIGKEITEN_GESEHEN_FILE + '.tmp', JSON.stringify(g, null, 2))
  fs.renameSync(NEUIGKEITEN_GESEHEN_FILE + '.tmp', NEUIGKEITEN_GESEHEN_FILE)
  console.log('[neuigkeiten] ' + (u.name || '?') + ' hat "' + req.params.id + '" gesehen')
  res.json({ ok: true })
})

app.post('/api/client-fehler', (req, res) => {
  const b = req.body || {}
  const kurz = (v, n) => String(v == null ? '' : v).slice(0, n)
  const z = b.zahlen || {}
  console.log('[client] Absturz bei ' + (req.user && req.user.name ? req.user.name : '?')
    + ' | Browser-Uebersetzung: ' + (b.uebersetzt ? 'JA' : 'nein')
    + ' | Fremdspuren: ' + (kurz(b.spuren, 120) || 'keine')
    + ' | font-Knoten: ' + (z.font == null ? '?' : z.font)
    + ' | Badges: ' + (z.badges == null ? '?' : z.badges)
    + ' | Seite: ' + kurz(b.pfad, 80)
    + ' | Bundle: ' + kurz(b.bundle, 40) + '/' + kurz(z.enhance, 8)
    + ' | Browser: ' + kurz(b.browser, 120)
    + ' | Meldung: ' + kurz(b.meldung, 200))
  res.json({ ok: true })
})

app.get('/api/auth/status', (req, res) => {
  const users = readUsers()
  const u = sessionUser(req)
  res.json({ setupNeeded: users.length === 0, authenticated: !!u, user: u ? { id: u.id, name: u.name, role: u.role, uiLang: u.uiLang || 'de' } : null })
})

app.post('/api/auth/setup', (req, res) => {
  if (readUsers().length > 0) return res.status(403).json({ error: 'Setup bereits abgeschlossen.' })
  const { name, password } = req.body || {}
  if (!name || String(password || '').length < 8) return res.status(400).json({ error: 'Name und Passwort (min. 8 Zeichen) erforderlich.' })
  const user = { id: crypto.randomUUID(), name: String(name).trim(), role: 'admin', pass: hashPassword(password), created: new Date().toISOString() }
  writeUsers([user])
  setSessionCookie(res, createSession(user.id))
  console.log(`[auth] 🔐 Admin-Konto angelegt: ${user.name}`)
  res.json({ ok: true, user: { id: user.id, name: user.name, role: user.role } })
})

app.post('/api/auth/login', (req, res) => {
  const ip = req.headers['x-real-ip'] || req.ip || 'unknown'
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.' })
  const { name, password } = req.body || {}
  const u = readUsers().find((x) => x.name.toLowerCase() === String(name || '').trim().toLowerCase())
  // Konten koennen ohne Passwort angelegt werden (neue Mitarbeiterin). Solche
  // Konten sind gesperrt, bis ein Admin unter /benutzer ein Passwort setzt.
  if (u && !u.pass) { noteFail(ip); return res.status(403).json({ error: 'Für dieses Konto wurde noch kein Passwort vergeben. Bitte bei Sam melden.' }) }
  if (!u || !verifyPassword(password, u.pass)) { noteFail(ip); return res.status(401).json({ error: 'Name oder Passwort ist falsch.' }) }
  loginFails.delete(ip)
  if (u.role === 'admin') {
    if (u.totp && u.totp.aktiv) { console.log(`[auth] Passwort ok, warte auf 2FA: ${u.name}`); return res.json({ zweiFaktor: true, ticket: zfTicket(u.id, 'code') }) }
    // Gleiches Geheimnis bei jedem Versuch, bis die Einrichtung bestaetigt ist (sonst passt die App nach einem zweiten Login nicht mehr)
    let secret = u.totpPending && Date.now() - Date.parse(u.totpPending.at) < 24 * 3600_000 ? u.totpPending.secret : null
    if (!secret) { secret = b32enc(crypto.randomBytes(20)); const all = readUsers(); const me = all.find((y) => y.id === u.id); if (me) { me.totpPending = { secret, at: new Date().toISOString() }; writeUsers(all) } }
    const ticket = zfTicket(u.id, 'einrichten', secret)
    console.log(`[auth] Passwort ok, 2FA wird eingerichtet: ${u.name}`)
    return res.json({ einrichten: true, ticket, secret, otpauth: 'otpauth://totp/' + encodeURIComponent('Leichtkraut OS:' + u.name) + '?secret=' + secret + '&issuer=' + encodeURIComponent('Leichtkraut OS') + '&digits=6&period=30' })
  }
  setSessionCookie(res, createSession(u.id))
  console.log(`[auth] ✅ Anmeldung: ${u.name}`)
  res.json({ ok: true, user: { id: u.id, name: u.name, role: u.role } })
})
function zfTicketHolen(req, res, art) {
  const ip = req.headers['x-real-ip'] || req.ip || 'unknown'
  if (tooManyAttempts(ip)) { res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte 15 Minuten warten.' }); return null }
  const t = zfTickets.get(String((req.body || {}).ticket || '')); if (!t || t.exp < Date.now() || t.art !== art) { res.status(401).json({ error: 'Sitzung abgelaufen. Bitte neu anmelden.', neu: true }); return null }
  if (++t.versuche > 5) { zfTickets.delete(String(req.body.ticket)); noteFail(ip); res.status(401).json({ error: 'Zu viele falsche Codes. Bitte neu anmelden.', neu: true }); return null }
  return { t, ip }
}
// Schritt 2: Code aus der Authenticator-App (oder ein Notfall-Code)
app.post('/api/auth/2fa', (req, res) => {
  const x = zfTicketHolen(req, res, 'code'); if (!x) return
  const users = readUsers(); const u = users.find((y) => y.id === x.t.userId); if (!u || !u.totp) return res.status(401).json({ error: 'Konto nicht gefunden.', neu: true })
  const code = String(req.body.code || '').trim(); let ok = false
  const st = totpPruefen(u.totp.secret, code, u.totp.letzterSchritt); if (st >= 0) { u.totp.letzterSchritt = st; ok = true }
  else if (/^[A-Za-z0-9-]{8,12}$/.test(code)) { const i = (u.totp.notfall || []).findIndex((h) => verifyPassword(code.replace(/-/g, '').toUpperCase(), h)); if (i >= 0) { u.totp.notfall.splice(i, 1); ok = true; console.log(`[auth] Notfall-Code benutzt: ${u.name} (${u.totp.notfall.length} übrig)`) } }
  if (!ok) { noteFail(x.ip); return res.status(401).json({ error: 'Code falsch. Bitte den aktuellen Code aus der App eingeben.' }) }
  writeUsers(users); zfTickets.delete(String(req.body.ticket)); loginFails.delete(x.ip)
  setSessionCookie(res, createSession(u.id, { zf: true }))
  console.log(`[auth] ✅ Anmeldung mit 2FA: ${u.name}`)
  res.json({ ok: true, user: { id: u.id, name: u.name, role: u.role } })
})
// Erste Einrichtung: Code aus der App bestaetigt das Geheimnis, dann 8 Notfall-Codes (nur einmal sichtbar)
app.post('/api/auth/2fa-einrichten', (req, res) => {
  const x = zfTicketHolen(req, res, 'einrichten'); if (!x) return
  const users = readUsers(); const u = users.find((y) => y.id === x.t.userId); if (!u) return res.status(401).json({ error: 'Konto nicht gefunden.', neu: true })
  if (u.totp && u.totp.aktiv) return res.status(409).json({ error: '2FA ist für dieses Konto schon eingerichtet. Bitte neu anmelden.', neu: true })
  const st = totpPruefen(x.t.secret, req.body.code, 0, 2); if (st < 0) { noteFail(x.ip); return res.status(401).json({ error: 'Code passt nicht. Lösche alte „Leichtkraut OS“-Einträge in der App, scanne genau diesen QR-Code neu und gib den aktuellen Code ein.' }) }
  const notfall = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase())
  u.totp = { secret: x.t.secret, aktiv: true, seit: new Date().toISOString(), letzterSchritt: st, notfall: notfall.map((c) => hashPassword(c)) }; delete u.totpPending
  writeUsers(users); zfTickets.delete(String(req.body.ticket)); loginFails.delete(x.ip)
  setSessionCookie(res, createSession(u.id, { zf: true }))
  console.log(`[auth] 🔐 2FA eingerichtet: ${u.name}`)
  res.json({ ok: true, notfallCodes: notfall.map((c) => c.slice(0, 5) + '-' + c.slice(5)) })
})

app.post('/api/auth/logout', (req, res) => {
  const t = parseCookies(req).lk_session
  if (t) { const s = readSessions(); delete s[t]; writeSessions(s) }
  clearSessionCookie(res)
  res.json({ ok: true })
})

// Benutzerverwaltung (nur Admin) — für den späteren Mitarbeiter-Zugang

// ─────────────────────────────────────────────────────────────────────────────
// ZEITERFASSUNG
// Der Browser meldet alle 30 s "ich arbeite". Aus dem Abstand zweier Meldungen
// wird die Arbeitszeit gebildet; Lücken über 2 Minuten zählen als Pause, damit
// ein offener Tab im Hintergrund keine Stunden sammelt.
// ─────────────────────────────────────────────────────────────────────────────
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json')
const HEARTBEAT_GAP_MAX = 120 // Sekunden — größere Lücke = Pause, wird nicht gezählt

function readActivity() { try { return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8')) } catch { return {} } }
function writeActivity(a) { fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(a, null, 2)) }
function berlinDay(ts = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts))
}

app.post('/api/track/heartbeat', (req, res) => {
  const u = req.user
  if (!u || u.id === 'service') return res.json({ ok: true, skipped: true })
  const now = Date.now()
  const act = readActivity()
  const rec = act[u.id] || (act[u.id] = { name: u.name, days: {}, lastSeen: 0 })
  rec.name = u.name
  const gap = rec.lastSeen ? Math.round((now - rec.lastSeen) / 1000) : 0
  const day = berlinDay(now)
  const d = rec.days[day] || (rec.days[day] = { seconds: 0, first: now, last: now })
  if (gap > 0 && gap <= HEARTBEAT_GAP_MAX) d.seconds += gap
  d.last = now
  rec.lastSeen = now
  // EINZELTAKTE (31.08.): Tagessummen reichen nicht fuer ein rollierendes
  // Fenster. Wir halten die Takte 48 Stunden vor - daraus laesst sich jedes
  // Zeitfenster exakt rechnen, und die Datei bleibt trotzdem klein
  // (ein voller Arbeitstag sind rund 1.000 Zahlen).
  if (!Array.isArray(rec.ticks)) rec.ticks = []
  rec.ticks.push(now)
  const grenze = now - 48 * 3600_000
  if (rec.ticks.length > 60 && rec.ticks[0] < grenze) rec.ticks = rec.ticks.filter((t) => t >= grenze)
  writeActivity(act)
  res.json({ ok: true, todaySeconds: d.seconds })
})

// Gearbeitete Sekunden in einem beliebigen Zeitfenster, aus den Einzeltakten.
// Gezaehlt wird wie bei der Tagessumme: Der Abstand zwischen zwei Takten gilt
// als Arbeitszeit, solange er hoechstens HEARTBEAT_GAP_MAX betraegt. Ein Takt-
// paar, das nur teilweise im Fenster liegt, wird anteilig gezaehlt.
function sekundenImFenster(rec, von, bis) {
  const roh = Array.isArray(rec.ticks) ? rec.ticks : []
  const ticks = roh.filter((t) => t >= von - HEARTBEAT_GAP_MAX * 1000 && t <= bis).sort((a, b) => a - b)
  let summe = 0
  for (let i = 1; i < ticks.length; i++) {
    const luecke = (ticks[i] - ticks[i - 1]) / 1000
    if (luecke <= 0 || luecke > HEARTBEAT_GAP_MAX) continue
    const start = Math.max(ticks[i - 1], von)
    const ende = Math.min(ticks[i], bis)
    if (ende > start) summe += (ende - start) / 1000
  }
  // RUECKFALL fuer die Zeit VOR dem ersten Takt: aus den Tagessummen anteilig
  // rechnen. Jeder Tag kennt seine Arbeitsspanne (first..last) und die darin
  // gezaehlten Sekunden; davon wird der Anteil genommen, der ins Fenster faellt.
  // Das ist eine Schaetzung - sie wird als solche gekennzeichnet.
  const ersterTakt = (Array.isArray(rec.ticks) && rec.ticks.length) ? rec.ticks[0] : null
  const luecke = ersterTakt != null ? Math.min(ersterTakt, bis) : bis
  let geschaetzt = 0
  if (luecke > von) {
    for (const d of Object.values(rec.days || {})) {
      if (!d || !d.seconds || !d.first || !d.last || d.last <= d.first) continue
      const start = Math.max(d.first, von)
      const ende = Math.min(d.last, luecke)
      if (ende > start) geschaetzt += d.seconds * ((ende - start) / (d.last - d.first))
    }
  }
  return { sekunden: Math.round(summe + geschaetzt), geschaetzt: geschaetzt > 1 }
}
// Ab wann liegen ueberhaupt Einzeltakte vor? Vor diesem Zeitpunkt kann das
// 24-Stunden-Fenster nichts anzeigen - das muss die Oberflaeche sagen duerfen,
// sonst wirkt eine kleine Zahl wie ein Fehler.
function aeltesterTakt(act) {
  let min = null
  for (const r of Object.values(act || {})) {
    const t = Array.isArray(r.ticks) && r.ticks.length ? r.ticks[0] : null
    if (t && (min === null || t < min)) min = t
  }
  return min
}

// Übersicht: Team-Baum + Arbeitszeiten + Leistungszahlen
// Detailprotokoll: JEDE gesendete Mail einer Person mit Zeitpunkt, Ticketnummer,
// Kundin und Betreff. Grundlage für die Aufklapp-Ansicht auf der Team-Seite.
// Bewusst getrennt vom Übersichts-Endpunkt: Die Liste kann lang werden und soll
// erst geladen werden, wenn jemand wirklich hineinschaut.
app.get('/api/track/mails', (req, res) => {
  // Admin darf jede Person abfragen. Mitarbeitende sehen ihre EIGENEN Daten —
  // volle Transparenz über die eigene Arbeit, aber nie über die anderer.
  const isAdmin = req.user?.role === 'admin'
  if (!isAdmin && req.query.user && req.query.user !== req.user?.id) {
    return res.status(403).json({ error: 'Nur die eigenen Daten.' })
  }
  const userId = isAdmin ? String(req.query.user || '') : String(req.user?.id || '')
  const limit = Math.min(Number(req.query.limit) || 200, 1000)
  const rows = []
  for (const t of readInbound()) {
    for (const m of t.messages || []) {
      if (m.direction === 'in' || m.is_internal_note || m.auto_ack) continue
      if (userId && m.sentBy !== userId) continue
      if (!userId && !m.sentBy) continue
      const ts = Date.parse(m.created_at || 0) || 0
      rows.push({
        ts,
        day: berlinDay(ts),
        time: new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' }).format(new Date(ts)),
        ticket: t.ticket_number,
        ticketId: t.id,
        customer: t.customer_name || t.customer_email || 'unbekannt',
        email: t.customer_email || '',
        subject: (t.subject || '(Kein Betreff)').slice(0, 120),
        preview: String(m.body_text || '').replace(/\s+/g, ' ').slice(0, 160),
        chars: String(m.body_text || '').length,
        sentBy: m.sentBy || null,
        sentByName: m.sentByName || null,
      })
    }
  }
  rows.sort((a, b) => b.ts - a.ts)
  // ZUFRIEDENHEIT (Samuel, 23.08.): Wie ist das Ticket ausgegangen? Die per
  // Haiku bewertete Kundenreaktion wird an die LETZTE gesendete Mail vor der
  // Reaktion gehaengt. NUR fuer Admins - Mitarbeitende sehen auf /me keine
  // Bewertungen ihrer eigenen Mails.
  if (isAdmin) {
    const reakByTicket = {}
    for (const t of readInbound()) {
      if (t.reaction && t.reaction.at) reakByTicket[String(t.ticket_number)] = t.reaction
    }
    const vergeben = new Set()
    for (const r of rows) {
      const rk = reakByTicket[String(r.ticket)]
      if (!rk || vergeben.has(String(r.ticket))) continue
      if (r.ts <= (Date.parse(rk.at) || 0)) { r.reaction = rk.wert; vergeben.add(String(r.ticket)) }
    }
  }
  // Tagesweise gruppieren, damit die Oberfläche direkt "Montag: 12 Mails" zeigen kann
  const byDay = {}
  for (const r of rows) (byDay[r.day] || (byDay[r.day] = [])).push(r)
  res.json({
    total: rows.length,
    days: Object.keys(byDay).sort().reverse().map((d) => ({ day: d, count: byDay[d].length })),
    mails: rows.slice(0, limit),
  })
})

app.get('/api/track/stats', (req, res) => {
  // Admin sieht das ganze Team. Mitarbeitende sehen dieselben Kennzahlen —
  // aber ausschließlich über sich selbst (eigene Zeit, eigene Mails).
  const isAdmin = req.user?.role === 'admin'
  const users = isAdmin ? readUsers() : readUsers().filter((u) => u.id === req.user?.id)
  const act = readActivity()
  const now = Date.now()
  const today = berlinDay(now)
  // Wochenanfang (Montag) in Berliner Zeit
  const days7 = []
  for (let i = 0; i < 7; i++) days7.push(berlinDay(now - i * 86400_000))
  // Leistungszahlen aus dem Postfach
  // Archiv mitzaehlen: Seit der Archivierung (30.08.) liegen aeltere Tickets
  // nicht mehr im Arbeitssatz. Ohne sie waeren Wochen- und Gesamtzahl zu klein.
  const store = readInbound().concat(readArchiv())
  const sentByDay = {}
  const perUser = {}   // userId -> { day -> Anzahl }
  // ROLLIERENDE 24 STUNDEN (Samuel, 30.08.): Der Kalendertag springt um
  // Mitternacht auf 0 und sagt morgens frueh nichts aus. Das 24-Stunden-Fenster
  // zeigt durchgehend, was zuletzt wirklich rausging.
  const seit24h = now - 24 * 3600_000
  const per24h = {}    // userId -> Anzahl
  let sent24h = 0
  for (const t of store) {
    for (const m of t.messages || []) {
      // auto_ack = automatische Eingangsbestaetigung, keine echte Antwort.
      // Zaehlt sie mit, sieht die Leistung fast doppelt so gross aus.
      if (m.direction === 'in' || m.is_internal_note || m.auto_ack) continue
      const ts = Date.parse(m.created_at || 0) || 0
      const d = berlinDay(ts)
      sentByDay[d] = (sentByDay[d] || 0) + 1
      if (ts >= seit24h) {
        sent24h++
        if (m.sentBy) per24h[m.sentBy] = (per24h[m.sentBy] || 0) + 1
      }
      if (m.sentBy) {
        const p = perUser[m.sentBy] || (perUser[m.sentBy] = {})
        p[d] = (p[d] || 0) + 1
      }
    }
  }
  const out = users.map((u) => {
    const rec = act[u.id] || { days: {}, lastSeen: 0 }
    const sec = (d) => (rec.days[d]?.seconds || 0)
    const total = Object.values(rec.days).reduce((a, x) => a + (x.seconds || 0), 0)
    const mails = perUser[u.id] || {}
    const mailsTotal = Object.values(mails).reduce((a, x) => a + x, 0)
    const mailsToday = mails[today] || 0
    const mails24h = per24h[u.id] || 0
    const fenster24 = sekundenImFenster(rec, now - 24 * 3600_000, now)
    const mailsWeek = days7.reduce((a, d) => a + (mails[d] || 0), 0)
    const weekSec = days7.reduce((a, d) => a + sec(d), 0)
    return {
      mailsToday, mails24h, mailsWeek, mailsTotal,
      // Minuten pro gesendeter Mail — Grundlage für die Kosten je Mail
      minPerMailWeek: mailsWeek ? Math.round(weekSec / 60 / mailsWeek * 10) / 10 : null,
      id: u.id, name: u.name, role: u.role, created: u.created, createdBy: u.createdBy || null,
      online: rec.lastSeen && (now - rec.lastSeen) < 120_000,
      lastSeen: rec.lastSeen || null,
      todaySeconds: sec(today),
      sec24h: fenster24.sekunden,
      sec24hGeschaetzt: fenster24.geschaetzt,
      weekSeconds: days7.reduce((a, d) => a + sec(d), 0),
      totalSeconds: total,
      days: days7.map((d) => ({ day: d, seconds: sec(d) })).reverse(),
    }
  })
  // Nicht-Admins bekommen als Gesamtzahlen ihre eigenen, nicht die des Shops
  const ownToday = isAdmin ? (sentByDay[today] || 0) : (out[0]?.mailsToday || 0)
  const own24h = isAdmin ? sent24h : (out[0]?.mails24h || 0)
  const ownWeek = isAdmin ? days7.reduce((a, d) => a + (sentByDay[d] || 0), 0) : (out[0]?.mailsWeek || 0)
  res.json({
    users: out,
    today: { sentMails: ownToday },
    letzte24h: { sentMails: own24h },
    week: { sentMails: ownWeek },
    zeitMessungSeit: aeltesterTakt(act),
    isAdmin,
  })
})

app.get('/api/auth/users', (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins.' })
  res.json({ users: readUsers().map((u) => ({ id: u.id, name: u.name, role: u.role, created: u.created, uiLang: u.uiLang || 'de', hatPasswort: !!u.pass, passChanged: u.passChanged || null })), ich: req.user.id })
})
app.post('/api/auth/users', (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins.' })
  const { name, password, role, uiLang } = req.body || {}
  // Passwort ist optional: ein Konto ohne Passwort ist angelegt, aber gesperrt,
  // bis jemand es unter /benutzer setzt. So muss niemand ein Passwort per Chat
  // oder Mail weiterreichen.
  if (!name) return res.status(400).json({ error: 'Name erforderlich.' })
  if (password !== undefined && password !== null && password !== '' && String(password).length < 8) return res.status(400).json({ error: 'Passwort muss mindestens 8 Zeichen haben.' })
  const users = readUsers()
  if (users.some((u) => u.name.toLowerCase() === String(name).trim().toLowerCase())) return res.status(409).json({ error: 'Name bereits vergeben.' })
  // SPRACH-STANDARD (Samuel, 22.08., Fall einer neuen Mitarbeiterin): Neue Agents bekamen kein
  // uiLang und landeten auf Deutsch - und die Sprachsperre verhindert, dass
  // sie selbst umstellen. Samuels Team arbeitet auf Englisch, deshalb ist
  // Englisch jetzt der Standard fuer neue Agents; 'de' kann bei der Anlage
  // explizit mitgegeben werden.
  const rolle = role === 'admin' ? 'admin' : 'agent'
  const sprache = uiLang === 'de' ? 'de' : (rolle === 'agent' ? 'en' : 'de')
  const user = { id: crypto.randomUUID(), name: String(name).trim(), role: rolle, uiLang: sprache, pass: (password ? hashPassword(password) : null), created: new Date().toISOString(), createdBy: req.user?.id || null }
  users.push(user); writeUsers(users)
  res.json({ ok: true, user: { id: user.id, name: user.name, role: user.role } })
})
// ── PASSWORTVERWALTUNG (14.09.2026) ─────────────────────────────────────────
// Bis heute gab es KEINE Moeglichkeit, ein Passwort zu aendern. Wer seins
// vergass, kam nicht mehr rein, und es gab keinen sauberen Weg, Passwoerter
// turnusmaessig zu wechseln. Deshalb drei Routen und die Seite /benutzer.
// Passwoerter werden ausschliesslich im Browser eingegeben und nur als
// scrypt-Hash gespeichert. Sie stehen nirgends im Klartext.
app.post('/api/auth/password', (req, res) => {
  if (!req.user || req.user.id === 'service') return res.status(403).json({ error: 'Nur angemeldet.' })
  const { aktuell, neu } = req.body || {}
  if (String(neu || '').length < 10) return res.status(400).json({ error: 'Neues Passwort: mindestens 10 Zeichen.' })
  const users = readUsers()
  const u = users.find((x) => x.id === req.user.id)
  if (!u) return res.status(404).json({ error: 'Benutzer nicht gefunden.' })
  if (u.pass && !verifyPassword(aktuell, u.pass)) return res.status(401).json({ error: 'Aktuelles Passwort ist falsch.' })
  u.pass = hashPassword(neu); u.passChanged = new Date().toISOString()
  writeUsers(users)
  // Alle ANDEREN Sitzungen dieses Benutzers beenden, die aktuelle bleibt.
  const eigen = parseCookies(req).lk_session
  const sess = readSessions(); let weg = 0
  for (const [k, v] of Object.entries(sess)) if (v.userId === u.id && k !== eigen) { delete sess[k]; weg++ }
  writeSessions(sess)
  console.log(`[auth] 🔑 ${u.name} hat das eigene Passwort geaendert (${weg} andere Sitzungen beendet)`)
  res.json({ ok: true, andereSitzungenBeendet: weg })
})

app.post('/api/auth/users/:id/password', (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins.' })
  const neu = String((req.body || {}).neu || '')
  if (neu.length < 10) return res.status(400).json({ error: 'Passwort: mindestens 10 Zeichen.' })
  const users = readUsers()
  const u = users.find((x) => x.id === req.params.id)
  if (!u) return res.status(404).json({ error: 'Benutzer nicht gefunden.' })
  u.pass = hashPassword(neu); u.passChanged = new Date().toISOString(); u.passSetBy = req.user.name
  writeUsers(users)
  const sess = readSessions(); let weg = 0
  for (const [k, v] of Object.entries(sess)) if (v.userId === u.id) { delete sess[k]; weg++ }
  writeSessions(sess)
  console.log(`[auth] 🔑 ${req.user.name} hat das Passwort von ${u.name} gesetzt (${weg} Sitzungen beendet)`)
  res.json({ ok: true, sitzungenBeendet: weg })
})

app.post('/api/auth/logout-all', (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins.' })
  const eigen = parseCookies(req).lk_session
  const meineBehalten = (req.body || {}).meineBehalten !== false
  const sess = readSessions(); let weg = 0
  for (const k of Object.keys(sess)) {
    if (meineBehalten && k === eigen) continue
    delete sess[k]; weg++
  }
  writeSessions(sess)
  console.log(`[auth] 🚪 ${req.user.name} hat ${weg} Sitzung(en) beendet (eigene ${meineBehalten ? 'behalten' : 'ebenfalls beendet'})`)
  res.json({ ok: true, beendet: weg })
})

app.get('/benutzer', (req, res) => {
  const u = sessionUser(req)
  if (!u) return res.redirect('/login')
  if (u.role !== 'admin') return res.redirect('/')
  res.setHeader('Cache-Control', 'no-store')
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'pages', 'benutzer.html'), 'utf8'))
})

app.delete('/api/auth/users/:id', (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins.' })
  const users = readUsers()
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Eigenes Konto kann nicht gelöscht werden.' })
  const rest = users.filter((u) => u.id !== req.params.id)
  writeUsers(rest)
  // Sessions des gelöschten Nutzers sofort ungültig machen
  const s = readSessions()
  for (const [k, v] of Object.entries(s)) if (v.userId === req.params.id) delete s[k]
  writeSessions(s)
  res.json({ ok: true })
})


app.get('/api/connections', (_req, res) => res.json(publicConnections()))

// Update a connection. Secrets (apiKey, token) are stored separately, never echoed back.
app.post('/api/connections/:key', (req, res) => {
  const { key } = req.params
  if (!connections[key]) return res.status(404).json({ error: 'Unbekannte Verbindung' })
  const body = req.body || {}
  if (key === 'ai' && body.apiKey) { secrets.ai = body.apiKey; connections.ai._key = body.apiKey; connections.ai.hasKey = true }
  if (key === 'shopify' && body.token) { secrets.shopify = body.token; connections.shopify._token = body.token; connections.shopify.hasToken = true }
  if (key === 'gmail' && body.password) { secrets.gmail = body.password; connections.gmail._password = body.password; connections.gmail.hasPassword = true }
  if (key === 'gmail' && body.clientSecret) { secrets.gmailClientSecret = body.clientSecret; connections.gmail._clientSecret = body.clientSecret; connections.gmail.hasClientSecret = true }
  if (key === 'imap' && body.password) { secrets.imap = body.password; connections.imap._password = body.password; connections.imap.hasPassword = true }
  if (key === 'shopify' && body.clientSecret) { secrets.shopifyClientSecret = body.clientSecret; connections.shopify._clientSecret = body.clientSecret; connections.shopify.hasClientSecret = true }
  if (key === 'meta' && body.clientSecret) { secrets.metaClientSecret = body.clientSecret; connections.meta._clientSecret = body.clientSecret; connections.meta.hasClientSecret = true }
  if (key === 'meta' && body.clientId) body.clientId = String(body.clientId).trim()
  const { apiKey, token, password, clientSecret, ...rest } = body
  connections[key] = { ...connections[key], ...rest }
  saveConnections(connections)
  res.json(publicConnections())
})

app.post('/api/connections/:key/disconnect', (req, res) => {
  const { key } = req.params
  if (!connections[key]) return res.status(404).json({ error: 'Unbekannte Verbindung' })
  connections[key] = structuredClone(DEFAULT_CONNECTIONS[key])
  if (key === 'ai') { secrets.ai = ''; }
  if (key === 'shopify') { secrets.shopify = '' }
  if (key === 'gmail') { secrets.gmail = ''; secrets.gmailClientSecret = ''; secrets.gmailRefresh = ''; secrets.gmailAccess = null }
  if (key === 'imap') { secrets.imap = '' }
  if (key === 'meta') { secrets.metaClientSecret = ''; metaVerifyTokenSicherstellen() }
  saveConnections(connections)
  res.json(publicConnections())
})

// ---- connection tests (real calls) ----------------------------------------
app.post('/api/connections/:key/test', async (req, res) => {
  const { key } = req.params
  try {
    if (key === 'meta') {
      const m = connections.meta || {}
      if (!m.connected || !m.pageId || !(m._pageTokens || {})[m.pageId]) return res.status(400).json({ ok: false, error: 'Noch nicht verbunden — erst „Mit Meta anmelden".' })
      const tok = m._pageTokens[m.pageId]
      const page = await metaGet(`/${m.pageId}`, { fields: 'name,fan_count', access_token: tok })
      const pg = (m.pages || []).find((p) => p.id === m.pageId) || {}
      let ig = null
      if (pg.igId) ig = await metaGet(`/${pg.igId}`, { fields: 'username,followers_count', access_token: tok }).catch((e) => ({ error: String(e.message) }))
      return res.json({ ok: true, page: page.name, fans: page.fan_count, instagram: ig, connections: publicConnections() })
    }
    if (key === 'shopify') {
      const store = (req.body?.store || connections.shopify.store || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
      const token = req.body?.token || secrets.shopify
      if (!store || !token) return res.status(400).json({ ok: false, error: 'Store-Domain und Admin-API-Token erforderlich.' })
      const r = await fetch(`https://${store}/admin/api/2024-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      })
      if (!r.ok) return res.status(400).json({ ok: false, error: `Shopify antwortete mit ${r.status}. Store/Token prüfen.` })
      const data = await r.json()
      secrets.shopify = token
      connections.shopify = { ...connections.shopify, connected: true, store, shopName: data.shop?.name || store, hasToken: true, _token: token }
      saveConnections(connections)
      return res.json({ ok: true, shopName: data.shop?.name, plan: data.shop?.plan_display_name, connections: publicConnections() })
    }
    if (key === 'domain') {
      const domain = (req.body?.domain || connections.domain.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
      if (!domain) return res.status(400).json({ ok: false, error: 'Domain erforderlich.' })
      const result = { mx: [], spf: null, dmarc: null }
      try { result.mx = await dns.resolveMx(domain) } catch { result.mx = [] }
      try { const txt = await dns.resolveTxt(domain); result.spf = txt.flat().find((t) => t.includes('v=spf1')) || null } catch {}
      try { const d = await dns.resolveTxt(`_dmarc.${domain}`); result.dmarc = d.flat().join('') || null } catch {}
      const verified = result.mx.length > 0
      connections.domain = { ...connections.domain, domain, verified, connected: verified, dns: result }
      saveConnections(connections)
      return res.json({ ok: verified, dns: result, verified, connections: publicConnections() })
    }
    if (key === 'imap') {
      const email = req.body?.email || connections.imap.email
      const host = req.body?.host || connections.imap.host || 'imap.ionos.de'
      const pass = req.body?.password || secrets.imap
      if (!email || !pass) return res.status(400).json({ ok: false, error: 'E-Mail-Adresse und Passwort erforderlich.' })
      if (req.body?.password) { secrets.imap = req.body.password; connections.imap._password = req.body.password }
      connections.imap = { ...connections.imap, email, host, hasPassword: true }
      saveConnections(connections)
      let added = 0
      try { added = await syncImapMailbox({ limit: 25 }) }
      catch (e) {
        const raw = String(e?.responseText || e?.message || e)
        console.log('[imap] Fehler:', raw)
        return res.status(400).json({ ok: false, error: `Login fehlgeschlagen: E-Mail/Passwort/Server prüfen. (${raw.slice(0, 120)})` })
      }
      return res.json({ ok: true, added, connections: publicConnections() })
    }
    if (key === 'gmail') {
      const email = req.body?.email || connections.gmail.email
      const pass = req.body?.password || secrets.gmail
      if (!email || !pass) return res.status(400).json({ ok: false, error: 'Gmail-Adresse und App-Passwort erforderlich.' })
      if (req.body?.password) { secrets.gmail = req.body.password; connections.gmail._password = req.body.password }
      connections.gmail = { ...connections.gmail, email, hasPassword: !!secrets.gmail }
      saveConnections(connections) // persist immediately so it survives restarts
      let added = 0
      try { added = await syncGmail({ limit: 25 }) }
      catch (e) {
        const raw = (e && (e.responseText || e.message)) ? String(e.responseText || e.message) : String(e)
        console.log('[gmail] IMAP-Fehler:', raw)
        let hint = 'App-Passwort korrekt? IMAP in Gmail aktiviert?'
        if (e && e.authenticationFailed) hint = 'App-Passwort wurde abgelehnt (Authentifizierung fehlgeschlagen). Neues App-Passwort erstellen und ohne Leerzeichen einfügen.'
        if (/web login|accounts\/answer|support\.google/i.test(raw)) hint = 'Google verlangt einen Web-Login/OAuth — App-Passwörter sind bei dir evtl. durch den Workspace-Admin gesperrt. Dann brauchen wir die Weiterleitungs-Variante.'
        if (/imap.*disable|not enabled|ALERT.*IMAP/i.test(raw)) hint = 'IMAP ist im Gmail-Konto noch nicht aktiviert (Einstellungen → Weiterleitung & POP/IMAP → IMAP aktivieren → speichern).'
        return res.status(400).json({ ok: false, error: `IMAP-Login fehlgeschlagen. ${hint}`, detail: raw.slice(0, 300) })
      }
      return res.json({ ok: true, added, connections: publicConnections() })
    }
    if (key === 'ai') {
      const apiKey = req.body?.apiKey || secrets.ai
      if (!apiKey) return res.status(400).json({ ok: false, error: 'Kein API-Key hinterlegt.' })
      // Lightweight validation call.
      const r = await aiFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        // Ping über das Utility-Modell: billig, und Opus 5 würde bei max_tokens 8
        // das Budget fürs eingebaute Thinking verbrauchen.
        body: JSON.stringify({ model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      })
      if (r.status === 401) return res.status(400).json({ ok: false, error: 'API-Key ungültig (401).' })
      if (!r.ok && r.status !== 400) {
        const t = await r.text()
        return res.status(400).json({ ok: false, error: `AI-Anbieter antwortete mit ${r.status}: ${t.slice(0, 120)}` })
      }
      secrets.ai = apiKey; connections.ai._key = apiKey
      connections.ai = { ...connections.ai, connected: true, hasKey: true }
      saveConnections(connections)
      return res.json({ ok: true, model: connections.ai.model, connections: publicConnections() })
    }
    return res.status(400).json({ ok: false, error: 'Test für diese Verbindung nicht verfügbar.' })
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err?.message || err) })
  }
})

// ---- AI reply generation (real Anthropic call) ----------------------------
// Core Barbara generation — shared by the manual endpoint and the auto-draft pipeline.
// BETREFF ALS NACHRICHT (30.08., Fall Kundin E #2603-#2605): Manche
// Kundinnen schreiben ihre ganze Nachricht in die BETREFFZEILE und lassen den
// Mailtext leer. Solche Tickets bekamen NIE einen Entwurf und fielen dabei
// durch jedes Raster: Die Entwurfs-Pipeline verlangte body_text, und der
// Verlaufsaufbau filterte leere Nachrichten weg. Kein Fehler, kein Badge, die
// Mail lag einfach still im Posteingang. Jetzt gilt: Ist der Mailtext leer,
// IST der Betreff die Nachricht.
function betreffAlsText(ticket) {
  const s = String((ticket && ticket.subject) || '').trim()
  if (s.length < 3) return ''
  if (/^\(?\s*(kein betreff|no subject)\s*\)?$/i.test(s)) return ''
  if (/^#?\d{3,6}$/.test(s)) return ''   // reine Ticketnummer ist keine Nachricht
  return s
}
// Der Text, der fuer diese Nachricht wirklich gilt (Mailtext, sonst Betreff).
// Nur fuer EINGEHENDE Nachrichten: Bei unseren eigenen Mails waere der Betreff
// nur eine Wiederholung.
function nachrichtText(m, ticket) {
  if (!m) return ''
  if (String(m.body_text || '').trim()) return m.body_text
  if (m.direction !== 'out' && !m.auto_ack) return betreffAlsText(ticket)
  return ''
}
async function generateBarbaraReply(ticket, opts = {}) {
  const apiKey = secrets.ai
  if (!apiKey) throw Object.assign(new Error('AI nicht verbunden.'), { code: 'no_key' })

  const thread = (ticket.messages || [])
    .filter((m) => !m.is_internal_note)
    .map((m) => ({ m, txt: nachrichtText(m, ticket) }))
    .filter((x) => x.txt)
    .map(({ m, txt }) => `${m.direction === 'out' ? 'Barbara (wir)' : (m.from_name || ticket.customer_name || 'Kunde')}: ${txt}`)
    .join('\n\n')

  // Live-Bestelldaten aus Shopify (Bestellnr., Artikel, Status, Tracking) —
  // damit Barbara konkret antworten kann statt generisch.
  let shopCtx = ''
  try {
    const live = await fetchShopifyContext(ticket.customer_email, {
      name: ticket.customer_name,
      text: `${ticket.subject || ''}\n${thread}`.slice(0, 3000),
    })
    if (live?.found) {
      shopCtx = `\n\nLive-Shopify-Daten des Kunden (nutze sie konkret, z.B. Bestellnummer/Tracking): ${JSON.stringify(live).slice(0, 1200)}`
      // KLARTEXT-BEFUND (04.08.): Rohes JSON wurde zu oft übersehen — Barbara
      // fragte die Kundin nach Dingen, die in den Daten längst standen
      // ("falls eine offene Anfrage angezeigt wird…", obwohl disputes leer war).
      // Deshalb hier die entscheidenden Fakten als ausformulierte Sätze.
      const orders = live.orders || []
      const disputed = orders.filter((o) => o.dispute?.open)
      const facts = []
      if (orders.length) {
        const o = orders[0]
        const tage = o.created_at ? Math.floor((Date.now() - Date.parse(o.created_at)) / 86400000) : null
        facts.push(`Neueste Bestellung: ${o.name || '?'}${o.total ? ` über ${o.total}` : ''}${tage != null ? `, aufgegeben vor ${tage} Tag(en)` : ''}.`)
        if (o.fulfillment_status) facts.push(`Versandstatus laut Shopify: ${o.fulfillment_status}.`)
        if (o.financial_status) facts.push(`Zahlungsstatus: ${o.financial_status}.`)
      }
      facts.push(disputed.length
        ? `Es gibt eine OFFENE Zahlungsanfrage/Dispute zu ${disputed.map((o) => o.name).join(', ')}.`
        : `WICHTIG: Es gibt KEINE offene Zahlungsanfrage und KEINEN Klarna-Fall zu dieser Kundin. Bitte sie also NIEMALS, "eine offene Anfrage zu schließen" oder in der Klarna-App nachzusehen. Das wäre falsch und verwirrt sie.`)
      shopCtx += `\n\nGEPRÜFTER BEFUND (das weißt du bereits, frage die Kundin NICHT danach):\n- ${facts.join('\n- ')}`
      // Offener Klarna-/Payment-Fall → absolute Top-Priorität für Barbara
      if ((live.orders || []).some((o) => o.dispute?.open)) {
        shopCtx += `\n\n🚨 HÖCHSTE PRIORITÄT — OFFENER KLARNA-/ZAHLUNGSFALL: Diese Kundin hat eine offene Klarna-Anfrage/Dispute zu ihrer Bestellung. Für diesen Fall gelten SONDERREGELN, die alles andere überschreiben: (1) Du ANTWORTEST (keine bloße interne Notiz), außer die Kundin droht explizit mit Anwalt/Gericht — dann interne Notiz an Samuel. (2) Die Kulanz-Staffel (10-50%) gilt hier NICHT: Komm der Kundin maximal entgegen und biete sofort die großzügigste sinnvolle Lösung an (kostenloser Neuversand, volle Erstattung, was immer den Fall am schnellsten löst) — ein geschlossener Fall ist wichtiger als jede Kulanz-Ersparnis. (3) Ziel: Die Kundin ist so zufrieden, dass sie die Klarna-Anfrage zurückzieht und es NIE zu einem Chargeback kommt. (4) Sachlicher, warmer, entgegenkommender Ton, keine fröhlichen Emojis. (5) Erwähne den Zahlungsfall nur, wenn die Kundin ihn selbst anspricht.`
      }
      // Live-Paketposition mitgeben — DE via DHL, AT via Österreichische Post,
      // CH via Schweizerische Post (Carrier automatisch am Nummernformat erkannt)
      const tr = (live.orders || []).map((o) => o.tracking).find((t) => t?.number)
      if (tr) {
        // Die Sendungsnummer steht bereits in Shopify. Sie darf NIEMALS davon
        // abhaengen, ob die Tracking-API des Carriers gerade antwortet.
        opts.trackingNumber = tr.number
        // Carrier UND Link stehen durch die Shopify-Nummer bereits fest und
        // duerfen nicht davon abhaengen, ob die Tracking-API antwortet.
        const vorabCarrier = detectCarrier(tr.number, tr.url || '')
        if (CARRIER_META[vorabCarrier]) {
          opts.trackingLink = CARRIER_META[vorabCarrier].link(tr.number)
          if (vorabCarrier !== 'unknown') opts.trackingCarrier = CARRIER_META[vorabCarrier].name
        }
        const st = await trackShipment(tr.number, tr.url).catch(() => null)
        if (st?.found) {
          const zugestellt = st.statusCode === 'delivered'
          const retour = st.statusCode === 'returned'
          shopCtx += `\n\nSENDUNGS-LIVE-STATUS (${st.carrierName}) zu ${tr.number}: ${st.statusCode || st.status}${st.description ? ' — ' + st.description : ''}${st.location ? ' · Ort: ' + st.location : ''}${st.estimatedDelivery ? ' · Voraussichtliche Zustellung: ' + st.estimatedDelivery : ''}.` + (retour ? ` 🚨 WICHTIG — RETOURE: Diese Sendung konnte NICHT zugestellt werden und ist an UNS zurückgegangen. Die Kundin hat ihr Paket NICHT erhalten. Behaupte NIEMALS, das Paket sei zugestellt. Stattdessen: (1) ehrlich erklären, dass die Zustellung nicht möglich war (z.B. niemand angetroffen / nicht rechtzeitig in der Filiale abgeholt) und das Paket an uns zurückgelaufen ist, (2) eine KOSTENLOSE Neuzusendung anbieten und die aktuelle/vollständige Lieferadresse erfragen bzw. bestätigen lassen, (3) erst wenn die Kundin ausdrücklich auf Erstattung besteht, diese zusichern (TOP-1-REGEL beachten).` : zugestellt ? ` WICHTIG: Diese Sendung ist bereits ZUGESTELLT — weise die Kundin freundlich und proaktiv darauf hin (z.B. \"ich sehe in der Sendungsverfolgung, dass dein Paket inzwischen zugestellt wurde\"), auch wenn sie nur allgemein schreibt. Bei \"nicht erhalten\"-Faellen die Zustellung sachlich, aber freundlich benennen.` : ` Nutze das konkret, wenn die Kundin nach dem Paket fragt.`) + ` Der Versanddienstleister ist ${st.carrierName} — wenn du einen Tracking-Link einbettest, verwende EXAKT diesen: ${st.trackingLink}`
          opts.trackingLink = st.trackingLink
          opts.trackingNumber = tr.number
          opts.trackingCarrier = st.carrierName
        } else if (st?.trackingLink) {
          shopCtx += `\n\nVERSANDDIENSTLEISTER dieser Sendung (${tr.number}): ${st.carrierName}. Wenn du einen Sendungsverfolgungs-Link einbettest, verwende EXAKT diesen: ${st.trackingLink} (NIEMALS einen Link eines anderen Carriers).`
          opts.trackingLink = st.trackingLink
          opts.trackingNumber = tr.number
          opts.trackingCarrier = st.carrierName
        }
      }
    }
  } catch { /* Shopify optional */ }
  if (!shopCtx && ticket.shopify) shopCtx = `\n\nBekannte Shopify-Daten des Kunden: ${JSON.stringify(ticket.shopify).slice(0, 500)}`
  // Bild-Auswertung (05.08.): Wenn die Kundin einen Screenshot geschickt hat,
  // haben wir ihn ausgelesen. Diese Info MUSS Barbara nutzen — sie darf nie
  // sagen "kein Bild angekommen" (Kundin B #1481 hat das ausgelöst).
  if (ticket.visionContext) shopCtx += ticket.visionContext

  // Sams Feedback-Lektionen (Erfahrungswissen aus echten Fällen) — verbindlich.
  const lessons = readLessons()
  const lessonsCtx = lessons.length
    // KAPPUNG AUFGEHOBEN (05.09.2026): Die alte Grenze von 6000 Zeichen liess von
    // 116 Lektionen nur 11 durch - 91 Prozent von Samuels verbindlichen Regeln
    // wurden stillschweigend weggeschnitten. Genau deshalb hat die Mitarbeiterin staendig
    // dieselben Dinge von Hand korrigiert (z. B. Sendungsnummern herausgeloescht),
    // obwohl es dafuer laengst eine Regel gab. Die Lektionen stehen jetzt im
    // System-Block und werden zwischengespeichert, kosten also nicht pro Aufruf.
    ? `\n\n## INTERNE FEEDBACK-LEKTIONEN (von Sam, VERBINDLICH über allem anderen)\n${lessons.map((l) => `- [${(l.tags || []).join(', ')}] ${l.text}`).join('\n')}`
    : ''

  // Echtzeit in Deutschland — damit Begrüßung & Verabschiedung zur Tageszeit
  // und zum Wochentag passen (Zeit-Regeln stehen im System-Prompt).
  const now = new Date()
  const deDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)
  const deTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(now)
  const deHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: 'numeric', hour12: false }).format(now))
  // Samuel (09.08.): Die Tageszeit hatte hier andere Grenzen als greetingForHour().
  // Dadurch stand im Prompt "Nachmittag", waehrend die Auslieferung "Guten Abend"
  // erzwang. Es gibt jetzt nur noch EINE Quelle: greetingForHour().
  const grussJetzt = greetingForHour(deHour)
  const wochentag = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long' }).format(now)
  const timeCtx = `\n\nAKTUELLE ZEIT IN DEUTSCHLAND: ${deDate}, ${deTime} Uhr.`
    + `\nHEUTE IST ${wochentag.toUpperCase()}.`
    + `\nDIE ANREDE MUSS EXAKT SO BEGINNEN: "${grussJetzt}, liebe Frau ..." bzw. "${grussJetzt}, lieber Herr ..." (bei Du-Kundinnen "${grussJetzt}, liebe <Vorname>"). Schreibe NIEMALS "Sehr geehrte" oder "Hallo" als Einstieg — die Mail beginnt IMMER mit dieser Tageszeit-Anrede.`
    + `\nWENN DIE KUNDIN EINEN WUNSCH AUSSPRICHT ("schoenen Sonntag", "schoenes Wochenende", "schoene Feiertage", "gute Besserung"), gib ihn am Ende ausdruecklich zurueck, z.B. "Ich wuensche Ihnen ebenfalls einen schoenen ${wochentag}." Das ist Pflicht, nicht optional — es wirkt kalt, einen Wunsch zu ueberlesen.`

  // Fakten-Kontext nach außen reichen (Second Brain): Der Qualitäts-Prüfer
  // gleicht den fertigen Entwurf gegen exakt dieselben Daten ab, die Barbara
  // beim Schreiben hatte — nur so ist der Fakten-Guard fair und präzise.
  opts.factsCtx = `${timeCtx}${shopCtx}`
  opts.thread = thread
  const fixCtx = opts.fixNotes
    ? `\n\nWICHTIG — KORREKTUREN AUS DER QUALITÄTSPRÜFUNG (dein erster Entwurf hatte diese Fehler, behebe sie ALLE):\n- ${opts.fixNotes}`
    : ''
  const userMsg = `Betreff: ${ticket.subject}\nKunde: ${ticket.customer_name || ticket.customer_email}${timeCtx}${shopCtx}${fixCtx}\n\nBisheriger Verlauf:\n${thread}\n\nSchreibe die nächste passende Antwort von Barbara auf die letzte Kundennachricht.`

  // Wissensbasis als zweiter System-Block. cache_control sitzt auf dem LETZTEN
  // Block und cached damit Prompt + Wissen zusammen (Präfix-Match). Beide Texte
  // müssen byte-stabil bleiben, sonst zahlt jeder Call den vollen Preis.
  const wissen = readWissen()
  const systemBlocks = [{ type: 'text', text: connections.ai.systemPrompt || BARBARA_PROMPT }]
  if (wissen) systemBlocks.push({ type: 'text', text: `\n\n## WISSENSBASIS LEICHTKRAUT (Herzensstück — verbindliche Produkt-, Stil- und Gewohnheits-Fakten)\n${wissen}` })
  // Lektionen als eigener System-Block: sie aendern sich nur, wenn Samuel eine
  // freigibt. Damit bleiben sie zwischengespeichert und kosten nicht bei jedem Entwurf.
  if (lessonsCtx) systemBlocks.push({ type: 'text', text: lessonsCtx })
  // HALTBARKEIT 1 STUNDE (05.09.2026): Der Systemprompt ist 42.641 Token gross.
  // Mit 5 Minuten Haltbarkeit wurden am 05.09. 1,75 Mio. Token NEU geschrieben und
  // nur 4,48 Mio. gelesen - bei rund 6 Entwuerfen pro Stunde lief der Speicher
  // staendig ab. Eine Stunde kostet pro Schreibvorgang mehr, spart aber die
  // meisten Schreibvorgaenge und damit netto deutlich.
  systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral', ttl: '1h' }

  const r = await aiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: connections.ai.model || 'claude-sonnet-5',
      // Kostenumstellung 06.08.: Opus 5 kostete ~12 $/Tag (5 $/25 $ pro Mio.
      // Token × 3 Calls pro Ticket). Sonnet 5 liefert bei Support-Mails
      // praktisch dieselbe Qualität für 2 $/10 $ (Einführungspreis bis 31.08.).
      // effort "medium" auf Sonnet 5 entspricht etwa Sonnet 4.6 auf "high".
      // temperature ist auf Sonnet 5 nicht erlaubt (400) — nicht wieder einbauen.
      max_tokens: 6000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: systemBlocks,
      messages: [{ role: 'user', content: userMsg }],
    }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`AI-Anbieter Fehler ${r.status}: ${t.slice(0, 200)}`)
  }
  const data = await r.json()
  let out = (data.content || []).map((c) => c.text || '').join('').trim()
  // Sicherung gegen abgeschnittene Mails: Wenn das Modell am Token-Limit
  // gestoppt hat, bis zum letzten vollständigen Absatz/Satz zurückschneiden —
  // ein halber Satz darf NIE im Entwurf landen.
  if (data.stop_reason === 'max_tokens') {
    const cut = Math.max(out.lastIndexOf('\n\n'), out.lastIndexOf('. '))
    if (cut > 200) out = out.slice(0, cut + 1).trim()
  }
  return embedTrackingLinks(out, opts.trackingLink, { number: opts.trackingNumber, carrier: opts.trackingCarrier })
}

// ════════════════════════════════════════════════════════════════════════════
// SECOND BRAIN (06.08.): Qualitäts-Pipeline — jeder Entwurf durchläuft
// (1) deterministische Normalisierung, (2) harte Regel-/Fakten-Guards,
// (3) LLM-Selbstkritik gegen die Regeln, (4) bei Verstoß EINE Neugenerierung
// mit den konkreten Fehlern als Auftrag. Ergebnis: Confidence Score 0-100.
// ════════════════════════════════════════════════════════════════════════════

// Gedankenstriche sind Samuels härteste Stilregel — deterministisch entfernen
// statt auf das Modell zu hoffen. Zahlenspannen werden zu "bis".
function stripDashes(s) {
  return String(s || '')
    .replace(/(\d)\s*[–—]\s*(\d)/g, '$1 bis $2')
    .replace(/\s*[—–]\s*/g, ', ')
}

// Harte Guards: deterministische Verstöße, die NIE durchgehen dürfen.
// Jeder Treffer drückt die Confidence unter die Rot-Schwelle und löst
// eine Neugenerierung aus.
function hardGuardIssues(draft, factsCtx, thread, outText = '') {
  const issues = []
  // GEMINI-GUARDS (12.08., Faelle #1670 und #1380 am ersten Gemini-Abend):
  // Gemini Flash ERFINDET vollzogene Handlungen (Erstattung veranlasst,
  // Geschenk beigelegt), und der Gemini-Kritiker bewertet sie mit 95-100.
  // Diese zwei Muster werden deterministisch geprueft, egal welches Modell schreibt:
  {
    const ctx0 = `${factsCtx || ''}\n${thread || ''}`.toLowerCase()
    const saetze0 = String(draft || '').split(/(?<=[.!?])\s+|\n+/)
    const vollzugRe = /\b(habe|haben|wurde|ist)\b[^.!?]{0,70}\b(erstattung|rückerstattung|rückzahlung|betrag|geld)\b[^.!?]{0,50}\b(veranlasst|angestoßen|angewiesen|ausgeführt|gutgeschrieben|zurücküberwiesen|erstattet)\b/i
    if (saetze0.some((z2) => vollzugRe.test(z2)) && !/(rückerstattung nötig|erstatt|refund|storniert)/.test(ctx0)) {
      issues.push('ERFUNDENER VOLLZUG: Der Entwurf behauptet, eine Erstattung sei bereits veranlasst/ausgefuehrt, ohne dass der Kontext das deckt. Richtig: ankuendigen, DASS erstattet wird, niemals behaupten, es sei schon geschehen.')
    }
    // 16.08. erweitert (Fall #1773): Sonnet formulierte 'lege ich dir eine
    // Überraschung mit in dein Paket' - das VERSPRECHEN eines Geschenks ohne
    // Freigabe ist genauso tabu wie die Behauptung, es liege schon drin.
    const geschenkRe = /\b(habe|haben|wurde|liegt|lege|legen|packe|packen|werde|werden)\b[^.!?]{0,120}(geschenk|überraschung|gratisflasche)[^.!?]{0,120}(beigelegt|dazugelegt|hinzugefügt|beilegen|dazulegen|ins? (?:dein|ihr)?\s?paket|mit bei|paket gelegt|mit in dein paket|mit ins paket)\b/i
    // STEHENDE FREIGABE (Samuel, 18.08.): Jede von der Lieferverzoegerung
    // betroffene Bestellung bekommt ein kostenloses Geschenk ins Paket, und
    // das SOLL in Verzoegerungs-Mails erwaehnt werden. Der Guard laesst die
    // Erwaehnung deshalb durch, wenn es im Verlauf um Lieferzeit/Verzoegerung
    // geht. Erfundene Geschenke in anderen Kontexten werden weiter gefangen.
    const verzoegerung = /(wie lange dauert|wann kommt|wo (ist|bleibt)|noch nicht (erhalten|angekommen|versendet|bekommen)|verzoeger|verzöger|dauert.{0,40}l(ä|ae)nger|hohe nachfrage|ausverkauft|wartet? (schon|seit)|liefer(zeit|ung).{0,30}(dauert|lange))/i.test(ctx0)
    if (saetze0.some((z2) => geschenkRe.test(z2)) && !/(geschenk|überraschung)/.test(ctx0) && !verzoegerung) {
      issues.push('ERFUNDENES GESCHENK: Der Entwurf behauptet, ein Geschenk liege bereits im Paket, ohne Freigabe im Kontext. Geschenke duerfen nur zugesagt werden, wenn Samuel sie fuer diesen Fall autorisiert hat.')
    }
    // FREMDE ODER ERFUNDENE BESTELLNUMMER (15.08., Faelle #1688/#1758): In zwei
    // Entwuerfen stand eine #S-Nummer als "Beispiel" - es war die echte Nummer
    // eines ANDEREN Kunden, eine davon ging raus. Regel: Jede #S-Nummer im
    // Entwurf muss im Verlauf oder in den Live-Daten vorkommen. Beispiel-
    // Nummern und erfundene Nummern sind tabu.
    {
      const sNummern = [...String(draft || '').matchAll(/#s\s*(\d{4,6})\b/gi)].map((m) => m[1])
      const fremd = sNummern.filter((n) => !ctx0.includes('s' + n))
      if (fremd.length) {
        issues.push('FREMDE BESTELLNUMMER: Der Entwurf nennt #S' + fremd[0] + ', diese Nummer kommt im Verlauf/Kontext nicht vor. Nur Bestellnummern aus den echten Daten dieser Kundin verwenden, niemals Beispiel-Nummern.')
      }
    }
    // ALTE SENDUNGSNUMMER IN NEUZUSENDUNGS-MAILS (Samuel, 15.08., Fall #1738):
    // Barbara bestaetigte eine kostenlose Neuzusendung und fuegte dabei die
    // Sendungsnummer der ALTEN, verlorenen Sendung wieder ein (die im Tracking
    // "zugestellt" zeigt - maximal verwirrend). Regel: Wird eine Neuzusendung
    // versprochen, hat KEINE bereits bekannte Sendungsnummer etwas in der Mail
    // verloren - die neue Nummer existiert noch nicht und kommt automatisch
    // mit der Versandbestaetigung. Deterministisch: Neuzusendungs-Wortlaut +
    // eine 11-22-stellige Nummer, die bereits im Kontext steht = Fehler.
    {
      const neuRe = /(neu zusenden|neu zuschicken|neu zusende|neu zuschicke|neuzusendung|ersatzlieferung|ersatzpaket|noch einmal kostenlos)/i
      const nummern = [...String(draft || '').matchAll(/\b(\d{11,22})\b/g)].map((m) => m[1])
      if (neuRe.test(String(draft || '')) && nummern.some((n) => ctx0.includes(n))) {
        issues.push('ALTE SENDUNGSNUMMER: Die Mail verspricht eine Neuzusendung und nennt gleichzeitig eine bereits bekannte Sendungsnummer der alten Sendung. In Neuzusendungs-Mails NIE die alte Nummer wiederholen - die neue Nummer kommt automatisch mit der Versandbestaetigung.')
      }
    }
    // KEIN PROAKTIVER RÜCKGABE-WEG (Samuel, 19.08., Fall #1873): Wenn wir eh
    // keine sofortige Erstattung mehr auszahlen (Paket schon unterwegs), wird
    // der Kundin NIEMALS von uns aus die Annahme-Verweigerung oder eine
    // Rücksendung als 'unkomplizierter Weg' angeboten. Wir wollen den Verkauf
    // halten (Einwandbehandlung: Paket kommt, Geschenk liegt bei, testen).
    // Rücksende-/Verweigerungs-Details erklären wir nur, wenn die Kundin
    // ausdruecklich nach dem Weg fragt. Vom Modell in dieser Form (Sonnet
    // schlug 'Annahme verweigern' als komfortabelsten Weg vor) wiederholt
    // ausgelöst - deshalb deterministisch.
    {
      const proaktivRe = /(annahme (verweigern|zu verweigern|nicht ann)|einfach die annahme|unkompliziert(e|er|sten|sten)?\s+weg|paket (nicht|einfach nicht) an|zur(ü|ue)ck(schicken|senden|zusenden|geben)|ruecksende(adresse|etikett|schein))/i
      const kundeWill = /(zur(ü|ue)ck(schick|send|geb|nehm)|ruecksende|annahme.{0,15}verweiger)/i.test(String(thread || ''))
      if (proaktivRe.test(String(draft || '')) && !kundeWill) {
        issues.push('PROAKTIVER RÜCKGABE-WEG: Der Entwurf bietet der Kundin von sich aus einen Ruecksende- oder Annahme-Verweigerungs-Weg an, obwohl sie danach nicht ausdruecklich gefragt hat. Regel: wir bieten sowas nie proaktiv an, sondern halten mit Einwandbehandlung dagegen (Paket kommt, Geschenk liegt bei, in Ruhe testen).')
      }
    }
    // ERSTATTUNG OHNE GRUND-FRAGE (Samuel, 17.08., Fall #1810): In der ERSTEN
    // Antwort auf einen Storno-/Widerrufs-/Erstattungswunsch wird NIEMALS die
    // Erstattung oder Stornierung akzeptiert. Immer zuerst: Grund erfragen
    // (Datensammlung!) plus Angebot (kostenlose Extra-Flasche). Die weiche
    // Lesson dazu hat auch Sonnet ueberfahren (gesetzliches Widerrufsrecht
    // wog fuer das Modell schwerer als die Regel), deshalb deterministisch:
    // keine frueheren Mails an die Kundin + Entwurf akzeptiert = Fehler.
    if (!String(outText || '').trim()) {
      const akzeptRe = /\b(storniere ich|stornierung ist.{0,25}best(ä|ae)tigt|widerruf ist.{0,25}best(ä|ae)tigt|akzeptiere (ich )?(das|den widerruf|die stornierung|ihren widerruf)|erstatte (ich|wir) (dir|ihnen)|(r(ü|ue)ckerstattung|kaufpreis|betrag) (ist|wird|geht).{0,40}(zur(ü|ue)ck|erstattet|veranlasst|ausgef(ü|ue)hrt))/i
      const kundeWill = /(storn|widerruf|r(ü|ue)ckerstatt|geld zur(ü|ue)ck)/i.test(String(thread || ''))
      if (kundeWill && akzeptRe.test(String(draft || ''))) {
        issues.push('ERSTATTUNG OHNE GRUND-FRAGE: Die erste Antwort auf einen Storno-/Widerrufswunsch darf die Erstattung nicht akzeptieren. Erst den Grund erfragen und ein Angebot machen (kostenlose Extra-Flasche), Regel vom 14. und 17.08.')
      }
    }
    // FALSCHE EINNAHME (Samuel, 22.08., Faelle #1809 und #2042): Gemini
    // erfindet wiederholt eine falsche Einnahme-Empfehlung ('zu einer Mahlzeit',
    // 'in ein Glas Wasser/Tee geben') - die offizielle Einnahme ist: unter die
    // Zunge, 15-20 Sekunden einwirken lassen, schlucken, morgens ideal
    // NUECHTERN. Der Gemini-Kritiker vergab dafuer 100/100, deshalb hart.
    // ('viel Wasser trinken' als allgemeiner Tipp bleibt erlaubt - gefangen
    // wird nur das MISCHEN der Tropfen in Getraenke / Einnahme zur Mahlzeit.)
    {
      const mischRe = /(tropfen|pipette)[^.!?]{0,80}(ins?|in ein(em)?)\s?(glas|wasser|tee|getr(ä|ae)nk|saft|smoothie)/i
      const mahlzeitRe = /(pipette|tropfen|einnahme|einnehmen)[^.!?]{0,60}(zu einer mahlzeit|zur mahlzeit|zum essen|mit dem essen)/i
      if (mischRe.test(String(draft || '')) || mahlzeitRe.test(String(draft || ''))) {
        issues.push('FALSCHE EINNAHME: Der Entwurf empfiehlt, die Tropfen in ein Getraenk zu mischen oder zur Mahlzeit zu nehmen. Offizielle Einnahme: 1-2 Pipetten taeglich, direkt unter die Zunge, 15-20 Sekunden einwirken lassen, dann schlucken, morgens ideal auf nuechternen Magen.')
      }
    }
    // SENDUNGSNUMMER-WIEDERHOLUNG (Samuel, 16.08., Faelle #1770 und #1783):
    // Eine Sendungsnummer, die der Kundin in einer frueheren Mail dieses
    // Verlaufs bereits genannt wurde, wird NIE wiederholt - schon gar nicht
    // als angehaengter Block in Dankes-, Abschluss- oder Erstattungs-Mails.
    // Die weiche Prompt-Regel dazu hat das Modell am selben Tag zweimal
    // ignoriert, deshalb jetzt deterministisch. outText = alle bereits
    // GESENDETEN Mails dieses Tickets (ohne Auto-Acks).
    if (outText) {
      const dNums = [...String(draft || '').matchAll(/\b(\d{11,22})\b/g)].map((m) => m[1])
      const wdh = dNums.find((n) => outText.includes(n))
      if (wdh) {
        issues.push('SENDUNGSNUMMER DOPPELT: Die Nummer ' + wdh + ' wurde der Kundin in einer frueheren Mail dieses Verlaufs bereits genannt. Bereits genannte Sendungsnummern nie wiederholen, die Kundin hat sie schon.')
      }
    }
    // CHINA NUR AUF NACHFRAGE (Samuel, 15.08., Fall #1748): Die Herkunfts-
    // Erklaerung (Verpackung/China/Hongkong) stand ungefragt in einem Entwurf
    // zu einer simplen Lieferzeit-Frage. Regel: Sie wird AUSSCHLIESSLICH
    // gegeben, wenn die Kundin selbst nach Herkunft/China/Hongkong/Zoll fragt.
    // (Umlaut-Falle beachtet: alle Woerter hier sind ASCII, \b ist sicher.)
    if (/(china|hongkong|hong\s*kong)/i.test(String(draft || ''))
        && !/(china|hongkong|hong\s*kong|asien|herkunft|zoll|woher|hergestellt|produziert|ausland|yun)/.test(ctx0)) {
      issues.push('CHINA UNGEFRAGT: Der Entwurf erwaehnt China/Hongkong, obwohl im Verlauf niemand nach Herkunft gefragt hat. Regel (15.08.): Diese Erklaerung gibt es AUSSCHLIESSLICH auf Nachfrage, niemals proaktiv.')
    }
  }
  const d = String(draft || '')
  const ctx = `${factsCtx || ''}\n${thread || ''}`
  // 1) INTERNE ABLÄUFE (präzisiert 08.08. auf Samuels Wunsch): Verboten ist das
  //    VERTRÖSTEN — die Kundin auf eine noch offene interne Klärung warten lassen
  //    ("ich frage nach und melde mich"). ERLAUBT ist der Verweis auf eine bereits
  //    ABGESCHLOSSENE Abstimmung, wenn direkt die fertige Antwort folgt
  //    ("Ich habe das intern abgestimmt, wir können das für Sie machen").
  //    Deshalb satzweise prüfen und Vergangenheitsformen ausnehmen.
  const internRe = /\brücksprache\b|\bintern\b|\bmit dem team\b|\bans? team\b|\bkolleg|unseren? (versand|logistik|lager)\b/i
  const offenRe = /\b(melde mich|sobald|werde ich|muss (ich|das) noch|lasse (ich )?(prüfen|nachsehen|nachschauen)|leite (ich|das|es) .{0,20}(weiter|intern)|gebe (ich|das|es) .{0,25}weiter|kläre ich|frage (ich )?(kurz )?nach|in kürze|zeitnah)/i
  const erledigtRe = /\b(habe|haben|hatte|hatten|wurde|wurden|ist|sind)\b[^.!?]{0,60}\b(abgestimmt|geklärt|besprochen|freigegeben|bestätigt|geprüft|entschieden|gesprochen)\b/i
  const arztRe = /(arzt|ärzt|apothek)/i
  const internSaetze = d.split(/(?<=[.!?])\s+|\n+/)
  if (internSaetze.some((satz) => internRe.test(satz) && offenRe.test(satz) && !erledigtRe.test(satz) && !arztRe.test(satz))) {
    issues.push('Verbotene Formulierung: die Kundin wird auf eine noch offene interne Klärung vertröstet ("ich leite das weiter und melde mich"). Barbara nennt JETZT die konkrete Lösung. Ein Hinweis auf eine bereits abgeschlossene Abstimmung ist dagegen erlaubt.')
  }
  // 1b) Nie eine konkrete Lieferzeit-Zahl nennen (Samuel, 06.08., #1519):
  //     "rund 10 Tage Lieferzeit" schreckt ab. Erlaubt ist nur "etwas länger
  //     als gewohnt". Widerrufsfristen ("14 Tage") sind davon nicht betroffen,
  //     deshalb nur im Lieferzeit-Kontext prüfen.
  if (/(lieferzeit|liefern|versand dauert|zustellung dauert)[^.!?]{0,60}\b\d{1,2}\s*(werk)?tage/i.test(d)
    || /\b(rund|ca\.?|etwa)\s*\d{1,2}\s*(werk)?tagen?\b[^.!?]{0,50}(lieferzeit|liefern|dauert)/i.test(d)) {
    issues.push('Konkrete Lieferzeit-Zahl genannt (z.B. "rund 10 Tage"). Verboten, das schreckt Kundinnen ab. Stattdessen: "etwas länger als gewohnt" plus ehrlicher Grund (hohe Nachfrage, zeitweise ausverkauft).')
  }
  // 2) Nie aktiv eine Rücksendung anbieten. Erwähnung nur erlaubt, wenn die
  //    Kundin selbst zuerst davon angefangen hat (steht dann im Verlauf).
  const returnRe = /(retourenlabel|rücksendeschein|rücksendeetikett|retoure|rücksendung|zurückschicken|zurücksenden|zurück schicken|zurück senden|an uns zurück senden)/i
  // FEHLALARM-SCHUTZ (07.08., Fall #1572): "Sie müssen nichts zurückschicken" und
  // "keine Rücksendung nötig" sind das GEGENTEIL eines Rücksende-Angebots — das ist
  // genau die gewünschte Formulierung. Deshalb satzweise prüfen und alle Sätze
  // verwerfen, in denen das Wort verneint vorkommt oder die Kundin selbst es nannte.
  const satzHatAngebot = (satz) => returnRe.test(satz)
    && !/(kein|keine|keinen|keinerlei|nicht|nichts|ohne|erspare|entfäll|brauchst du nicht|brauchen sie nicht|müssen sie nicht|musst du nicht)/i.test(satz)
  const saetze = d.split(/(?<=[.!?])\s+|\n+/)
  if (saetze.some(satzHatAngebot) && !returnRe.test(String(thread || ''))) {
    issues.push('Der Entwurf bietet aktiv eine Rücksendung an. Rücksendungen werden zu 100% vermieden — stattdessen Teilerstattung anbieten, Produkt darf behalten werden.')
  }
  // 3) Bestellnummern im Entwurf müssen in den echten Daten vorkommen.
  for (const m of new Set(d.match(/#S\d{4,6}\b/g) || [])) {
    if (!ctx.includes(m)) issues.push(`Bestellnummer ${m} kommt in den geprüften Daten nicht vor — möglicherweise erfunden. Nur Nummern aus den Live-Daten verwenden.`)
  }
  // 4) Sendungsnummern (11+ Ziffern) müssen aus den Daten stammen.
  for (const m of new Set(d.match(/\b\d{11,}\b/g) || [])) {
    if (!ctx.includes(m)) issues.push(`Sendungsnummer ${m} steht nicht in den geprüften Daten — nicht erfinden.`)
  }
  // 5) Euro-Beträge müssen sich aus echten Beträgen herleiten lassen
  //    (voller Betrag oder die Kulanz-Staffel 10/30/40/50/60 %).
  const ctxAmts = [...new Set((ctx.match(/\d{1,4}[.,]\d{2}/g) || []).map((a) => Number(a.replace(',', '.'))))]
  if (ctxAmts.length) {
    // AUSGEHANDELTE BETRÄGE SIND GÜLTIG (08.08., Fall #1570): Einigt man sich im
    // Verlauf auf eine Summe (Kundin bittet um 50 €, wir sagen 50 € zu), ist die
    // nicht aus der Kulanz-Staffel herleitbar, aber trotzdem korrekt.
    const allowed = [...new Set((String(thread || '').match(/\b\d{1,4}([.,]\d{2})?\s?(?=€|EUR|Euro)/gi) || [])
      .map((a) => Number(a.trim().replace(',', '.'))))]
    // RESTBETRAEGE UND STUECKPREISE (10.08., Faelle #1601 und #1599):
    // Ein Angebot nennt nicht nur die Erstattung, sondern auch, was die Kundin dann
    // noch zahlt (74,97 minus 22,49 = 52,48) und oft den Preis je Flasche. Beides ist
    // sauber hergeleitet, wurde vom Guard aber als erfunden gemeldet und hat gruene
    // Entwuerfe rot gefaerbt. Erlaubt sind jetzt zusaetzlich: Restbetrag nach Kulanz
    // und die Teilung eines erlaubten Betrages durch 2 bis 5 (Preis pro Flasche).
    for (const a of ctxAmts) {
      allowed.push(a)
      for (const q of [0.1, 0.3, 0.4, 0.5, 0.6]) {
        allowed.push(Math.round(a * q * 100) / 100)          // die Erstattung selbst
        allowed.push(Math.round(a * (1 - q) * 100) / 100)    // was die Kundin dann noch zahlt
      }
    }
    for (const a of [...allowed]) {
      for (const teiler of [2, 3, 4, 5]) allowed.push(Math.round((a / teiler) * 100) / 100)
    }
    for (const m of new Set((d.match(/\d{1,4}[.,]\d{2}(?=\s?(?:€|EUR|Euro))/g) || []))) {
      const v = Number(m.replace(',', '.'))
      if (!allowed.some((a) => Math.abs(a - v) <= 0.06)) {   // Toleranz für kaufmännische Rundung
        issues.push(`Betrag ${m} € lässt sich aus den echten Bestelldaten nicht herleiten (weder voller Betrag noch Kulanz-Staffel). Betrag prüfen.`)
      }
    }
  }
  return issues
}

// LLM-Selbstkritik: prüft den Entwurf als strenger Reviewer gegen Regeln,
// Fakten, Ton und Abschluss-Orientierung. Läuft auf dem Hauptmodell.
async function critiqueDraft(draft, factsCtx, thread, lastIn = '') {
  const apiKey = secrets.ai
  if (!apiKey) return null
  // Samuels Feedback-Lektionen sind für den Prüfer eine GÜLTIGE Faktenquelle —
  // sonst straft er Entwürfe ab, die auf Samuels Einzelfall-Entscheidungen
  // beruhen (Fall Monique: Zahlung von Samuel freigegeben, steht in keinem System).
  const lessons = readLessons()
  const lessonsCtx = lessons.length
    ? `\n\nINTERNE ANWEISUNGEN VON SAMUEL (Inhaber) — diese gelten als FAKTEN und dürfen NICHT als unbelegt gewertet werden:\n${lessons.map((l) => `- ${l.text}`).join('\n')}`
    : ''
  const sys = `Du bist der strenge Qualitätsprüfer für Kundenservice-Entwürfe von LEICHTKRAUT (Lymph-Tropfen, Nahrungsergänzung). Gib NUR JSON zurück: {"score": 0-100, "probleme": ["konkreter Fehler", ...], "erstattung_noetig": true/false}. Keine anderen Texte.

Prüfe den ENTWURF gegen die GEPRÜFTEN DATEN und diese verbindlichen Regeln:
1. FAKTEN: Jede Aussage über Bestellungen, Beträge, Zustellstatus, Zahlungsart muss von den Daten, dem Verlauf oder Samuels internen Anweisungen gedeckt sein. Erfundene Behauptungen = score unter 40.
2. KEINE voreilige Erstattungszusage: Erstattung nur zusichern, wenn die Bedingungen erfüllt sind (Ware nachweislich Rückläufer, nie zugestellt, fristgerechter Widerruf VOR Versand, oder von Samuel angewiesen). Sonst Bedingungen nennen.
3. KEINE aktive Rücksendungs-Option anbieten und NIE ein Retourenlabel/kostenlose Rücksendung. Besteht die Kundin selbst auf Rücksendung, trägt sie die Kosten selbst; besser ist immer die Teilerstattung mit Behalten.
4. Bei Widerruf/Beschwerde ohne bekannten Grund: ZUERST den Grund erfragen.
5. Wartezeiten ehrlich begründen (hohe Nachfrage, zeitweise ausverkauft), aber NIEMALS eine konkrete Lieferzeit-Zahl gegenüber der Kundin nennen ("rund 10 Tage", "10 Werktage" o.ä. ist VERBOTEN — das schreckt ab). Richtig ist "etwas länger als gewohnt" plus ehrlicher Grund plus Bestmöglich-Zusage. NIE eine Zustellung versprechen, die die Daten nicht hergeben.
6. NIE "Rücksprache mit dem Team" oder interne Abläufe erwähnen.
7. Bei Unverträglichkeit/Allergie: ernst nehmen, Fotos und Einnahme-Details erfragen, KEINE Erstattungszusage vor Faktenlage (außer sie wurde im Verlauf bereits gegeben, dann gilt Regel 10).
8. Ton: warm, ehrlich, Barbara-Stimme, keine Gedankenstriche, kein Hype, öffnet am Ende eine natürliche Rückkehr-Tür. Anredeform (Du/Sie) und Anrede-Name EXAKT wie im bisherigen Verlauf bzw. wie die Kundin selbst unterschreibt.
9. Abschluss-Orientierung: Die Antwort führt erkennbar Richtung Lösung. WICHTIG: Eine kurze Bestätigungs-Rückfrage vor dem Ausführen einer verhandelten Teilerstattung ist KORREKT und erwünscht (kein Vertrösten) — nur ziellose Vertröstung ohne Angebot ist ein Fehler.
10. EIGENE ZUSAGEN SIND BINDEND: Was Barbara in einer BEREITS GESENDETEN Nachricht im Verlauf zugesagt hat (Betrag, Erstattung, Angebot), gilt als Fakt und MUSS eingehalten werden. Das Einhalten ist korrekt; das Zurücknehmen oder Anzweifeln einer gesendeten Zusage wäre der Fehler.

Setze "erstattung_noetig" auf true NUR wenn JETZT eine Erstattung ausgeführt werden muss (fristgerechter Widerruf vor/trotz Versand und Kundin lehnt Ware ab, Ware nachweislich nie erhalten und Rückläufer, Doppelzahlung, oder eine bereits GESENDETE feste Erstattungszusage, die noch nicht ausgeführt wurde). NICHT true, wenn ein Angebot erst noch auf die Entscheidung oder Bestätigung der Kundin wartet. Sonst false.

score-Skala: 90-100 fehlerfrei und stark · 60-89 solide mit kleinen Schwächen · 40-59 Regelverstoß oder Faktenzweifel · unter 40 gravierend falsch.${lessonsCtx}`
  const r = await aiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      // Die Prüfung ist Checklisten-Arbeit ("verstößt der Text gegen Regel 1-10?"),
      // dafür reicht das Utility-Modell (Haiku 4.5, 1 $/5 $). Spart gegenüber dem
      // Hauptmodell rund 80 % der Prüfkosten. Haiku unterstützt KEIN output_config.effort.
      model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001',
      max_tokens: 2500,
      // ZWISCHENSPEICHER (05.09.2026): Der Pruefer-Systemprompt ist 2675 Token gross
      // und zwischen Tickets byte-stabil (einziger Platzhalter: lessonsCtx). Damit
      // liegt er ueber der Mindestgroesse von 2048 und wird zwischengespeichert.
      // 1 Stunde Haltbarkeit statt 5 Minuten: bei ~150 Pruefungen ueber den Tag
      // verteilt waeren die meisten Aufrufe sonst Fehlgriffe und wuerden neu schreiben.
      system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      // ANLIEGEN IMMER SICHTBAR (17.08., Fall #1808): thread.slice(-3000) schnitt
      // bei Mails mit langen Zitat-Anhaengen das eigentliche Kundenanliegen am
      // ANFANG ab - der Pruefer bewertete dann "es gibt kein Anliegen". Die
      // letzte Kundennachricht kommt jetzt separat und zuerst.
      messages: [{ role: 'user', content: `${lastIn ? `LETZTE KUNDENNACHRICHT (das Anliegen, dem der Entwurf antwortet):\n${String(lastIn).slice(0, 1500)}\n\n` : ''}GEPRÜFTE DATEN:\n${String(factsCtx || '(keine Live-Daten verfügbar)').slice(0, 4000)}\n\nVERLAUF (Ende):\n${String(thread || '').slice(-3000)}\n\nENTWURF:\n${draft}` }],
    }),
  })
  if (!r.ok) return null
  const data = await r.json()
  const txt = (data.content || []).map((c) => c.text || '').join('')
  try {
    const j = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || '{}')
    if (typeof j.score === 'number') return { score: Math.max(0, Math.min(100, Math.round(j.score))), probleme: Array.isArray(j.probleme) ? j.probleme.map((p) => String(p).slice(0, 200)).slice(0, 8) : [], erstattung_noetig: j.erstattung_noetig === true }
  } catch {}
  return null
}

// Gesamt-Pipeline: normalisieren → prüfen → ggf. EINMAL neu generieren → besser
// bewertete Fassung gewinnt. Gibt {text, score, issues} zurück.
async function qualityPipeline(genTicket, rawDraft, factsCtx, thread) {
  // Bereits an die Kundin GESENDETE Mails (ohne Auto-Acks) - fuer den
  // Doppelt-Guard bei Sendungsnummern (16.08.).
  const outText = ((genTicket && genTicket.messages) || [])
    .filter((m) => m.direction === 'out' && !m.auto_ack && !m.is_internal_note)
    .map((m) => m.body_text || '').join('\n')
  const lastIn = (((genTicket && genTicket.messages) || [])
    .filter((m) => m.direction === 'in' && !m.is_context)
    .slice(-1)[0] || {}).body_text || ''
  let text = stripDashes(rawDraft)
  let hard = hardGuardIssues(text, factsCtx, thread, outText)
  let crit = await critiqueDraft(text, factsCtx, thread, lastIn).catch(() => null)
  let score = crit ? crit.score : 70
  if (hard.length) score = Math.min(score, 35)
  let issues = [...hard, ...(crit?.probleme || [])]
  let erstattungNoetig = !!crit?.erstattung_noetig

  if (hard.length || score < 45) {
    try {
      const opts2 = { fixNotes: issues.slice(0, 6).join('\n- ') }
      const second = stripDashes(stripPreamble(await generateBarbaraReply(genTicket, opts2)))
      const hard2 = hardGuardIssues(second, opts2.factsCtx || factsCtx, thread, outText)
      const crit2 = await critiqueDraft(second, opts2.factsCtx || factsCtx, thread, lastIn).catch(() => null)
      let score2 = crit2 ? crit2.score : 70
      if (hard2.length) score2 = Math.min(score2, 35)
      if (score2 > score) {
        text = second
        score = score2
        issues = [...hard2, ...(crit2?.probleme || [])]
        erstattungNoetig = !!crit2?.erstattung_noetig
        console.log('[qualität] Neugenerierung hat gewonnen:', score, 'Punkte')
      }
    } catch (e) {
      console.log('[qualität] Neugenerierung fehlgeschlagen:', String(e?.message || e).slice(0, 80))
    }
  }
  return { text, score, issues: issues.slice(0, 8), erstattungNoetig }
}

// Auto-draft pipeline: for freshly synced inbound mails, Barbara writes the
// reply immediately and stores it as a draft on the record — the user only
// reviews and hits send.
let autoDraftRunning = false
// Konsequenz-Score 1-10: NICHT "wie wichtig klingt die Mail", sondern
// "wie gravierend wäre die Folge einer schlechten Antwort" (Rückerstattung,
// Kundin verloren, Anwalt, Rufschaden). Hohe Scores = besonders sorgfältig prüfen.
async function scoreConsequence(rec) {
  const apiKey = secrets.ai
  if (!apiKey) return null
  const r = await aiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      temperature: 0,
      system: 'Du bewertest Kundenservice-E-Mails eines Supplement-Shops. Gib NUR JSON zurück: {"score": 1-10, "reason": "<max 12 Wörter>"}. Der Score misst die KONSEQUENZ einer schlechten Antwort: 1-3 = harmlos (Info, Werbung, Smalltalk), 4-6 = mittel (Versandfrage, Produktfrage — schlechte Antwort nervt), 7-8 = hoch (unzufriedene Kundin, Rücksendewunsch, Wirkung ausgeblieben — schlechte Antwort führt zu Rückerstattung/Kundenverlust), 9-10 = kritisch (Anwalt, Widerruf, gesundheitliche Beschwerde, Eskalation, wütende Stammkundin).',
      messages: [{ role: 'user', content: `Betreff: ${rec.subject}\nVon: ${rec.customer_name || rec.customer_email}\n\n${(rec.body_text || '').slice(0, 1500)}` }],
    }),
  })
  if (!r.ok) return null
  const data = await r.json()
  const txt = (data.content || []).map((c) => c.text || '').join('')
  try {
    const j = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || '{}')
    if (j.score >= 1 && j.score <= 10) {
      // Der Klarna-/Chargeback-Alarm (Einhorn) im Frontend feuert allein anhand der
      // Trigger-Wörter /chargeback|klarna-fall|rückbuchung/ im risk.reason. Die KI
      // benutzt diese Wörter aber gern SPEKULATIV — etwa bei einer simplen Stornierung
      // ("… sonst droht Rückbuchung"), was einen Fehlalarm auslöst. Deshalb: die
      // Trigger-Wörter nur stehen lassen, wenn die Mail SELBST echte Zahlungs-/
      // Dispute-Hinweise enthält (Klarna/PayPal/Chargeback/Mahnung/eskalierte Anfrage).
      // Fehlt jeder solche Hinweis, neutralisieren — dann kann eine reine Storno-/
      // Erstattungsbitte nie fälschlich als Klarna-Fall erscheinen. Echte Shopify-
      // Disputes tragen ohnehin den separaten Override-Text "OFFENER KLARNA-FALL".
      let reason = String(j.reason || '').slice(0, 120)
      const evidence = `${rec.subject || ''} ${rec.body_text || ''} ${rec.customer_email || ''}`
      const hasDisputeContext = /klarna|charge\s?back|r[üu]ckbuchung|paypal|dispute|inquiry|escalat|eskaliert|mahnung|inkasso|zahlungsanbieter/i.test(evidence)
      if (!hasDisputeContext) {
        reason = reason
          .replace(/chargeback/gi, 'Eskalation')
          .replace(/r[üu]ckbuchung/gi, 'Storno-Ärger')
          .replace(/klarna[-\s]?fall/gi, 'Zahlungsärger')
      }
      return { score: Math.round(j.score), reason }
    }
  } catch {}
  return null
}

// Deterministische Phishing-/Scam-Erkennung. Ziel: gefälschte "Bestellbestätigungen"
// mit betrügerischen Links (z. B. sites.google.com/view/…) sofort als Spam flaggen,
// damit sie NIE eine Antwort erhalten und gar nicht erst im Posteingang auftauchen.
// Bewusst konservativ (starke Einzelsignale bzw. Kombis), um Fehlalarme zu vermeiden.
function looksLikePhishing(rec) {
  const text = `${rec.subject || ''}\n${rec.body_text || ''}`
  const subject = String(rec.subject || '')
  const from = String(rec.customer_email || '').toLowerCase()

  // SCHUTZ VOR FEHLALARM (04.08.): Antworten echter Kundinnen auf UNSERE Mails
  // zitieren unsere Shopify-Bestätigung mit — samt UUIDs wie
  // "_kaching_session_id: 4a5b9f20-8485-49f1-861e-de62cacca01c". Diese wurden
  // als "Hex-Rauschen" gewertet und die Kundin landete im Spam (drei echte
  // Fälle: Kundin A, Kundin C, Kunde G). Solche Mails sind per
  // Definition kein Phishing, deshalb hier früher Ausstieg.
  // Achtung: Scam-Mails nennen unsere Adresse selbst als "Referenz:
  // kontakt@leichtkraut.de". Ein bloßes Vorkommen von "leichtkraut.de" ist
  // deshalb KEIN Beweis für ein Zitat — es zählen nur echte Antwort-Spuren.
  // NEUER SCHUTZ (05.08.): Wenn die Mail eine echte Bestellnummer nennt (#S…),
  // ist es fast garantiert eine echte Kundin. eine Kundin (#S10015) landete im Spam,
  // weil ihre zitierte Bestellbestätigung 64-stellige Tracking-Hashes enthielt.
  const mentionsOrder = /#S\d{4,6}\b/.test(text)
  if (mentionsOrder) {
    try {
      const store = readInbound()
      const known = store.some((t) => String(t.customer_email || '').toLowerCase() === from)
      if (known || mentionsOrder) return false
    } catch { if (mentionsOrder) return false }
  }
  const isReply = /^\s*(aw|re|antw|antwort|fwd|wg)\s*:/i.test(subject)
  const quotesUs = /barbara@leichtkraut\.de|schrieb\s+Barbara|Barbara von Leichtkraut|Original-Nachricht|-----\s*Urspr|^\s*>/im.test(text)
  const knownCustomer = !!from && !/no-?reply|mailer|daemon|@leichtkraut\.de/i.test(from)
    && (readInbound().some((t) => String(t.customer_email || '').toLowerCase() === from
        && (t.messages || []).some((m) => m.direction !== 'in' && !m.auto_ack)))
  if (isReply || quotesUs || knownCustomer) return false

  // 1) Frei-Baukästen / URL-Shortener, die typischerweise für Phishing missbraucht werden
  const scamLink = /(sites\.google\.com\/view\/|\.weebly\.com|\.wixsite\.com|\.blogspot\.|forms\.gle\/|\.web\.app|\.firebaseapp\.com|telegra\.ph|bit\.ly\/|tinyurl\.com\/|cutt\.ly\/|is\.gd\/|rebrand\.ly\/)/i.test(text)
  // 2) Zufalls-Hex-Rauschen zur Spamfilter-Umgehung. UUIDs (mit Bindestrichen)
  //    und Sendungsnummern zählen NICHT — die stehen in legitimen Mails.
  const cleaned = text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ') // UUIDs
    .replace(/\b\d{10,}\b/g, ' ')                                                        // reine Zahlen (Tracking)
    .replace(/\b[0-9a-f]{40,}\b/gi, ' ')                                                 // SHA-1/SHA-256 aus Newsletter-Trackern
  const hexNoise = (cleaned.match(/\b(?=[0-9a-f]{12,}\b)(?=.*\d)(?=.*[a-f])[0-9a-f]+\b/gi) || []).length >= 3
  // 3) Gefälschte Bestell-/Rechnungsbestätigung: wir hätten angeblich etwas bestellt
  const fakeOrder = /(bestellbest[äa]tigung|bestellnummer|auftragsstatus|gesamtsumme|auftragsdatum|order confirmation|rechnung|invoice)/i.test(text.toLowerCase())
    && /(\d{2,}[.,]\d{2}\s?€|€\s?\d{2,})/.test(text)
  // Flag bei sehr starkem Einzelsignal (Hex-Rauschen) oder der Kombi Fake-Order + Scam-Link.
  return hexNoise || (scamLink && fakeOrder)
}

async function autoDraftNewRecords() {
  if (autoDraftRunning || (!secrets.ai && !process.env.KIE_API_KEY) || connections.ai.autoDraft === false) return
  autoDraftRunning = true
  try {
    // ai_draft_sent: nach Versand KEINEN neuen Entwurf generieren, bis die
    // Kundin antwortet (sonst landet eine überflüssige Zweitmail im Composer).
    // SELBSTHEILUNG BEI LEEREM API-GUTHABEN (12.08., zweiter Vorfall nach dem
    // 06.08.): Ein Ticket mit ai_draft_error wurde bisher fuer immer uebersprungen.
    // Bei einem Guthaben-Fehler ist das falsch — sobald Samuel auflaedt, sollen
    // alle liegengebliebenen Tickets von selbst nachgeholt werden. Deshalb gelten
    // Guthaben-Fehler nach 10 Minuten als erneut versuchbar. Echte Fehler
    // (kaputter Prompt o.ae.) bleiben dauerhaft geparkt wie bisher.
    const wiederVersuchbar = (r) => /credit balance|billing|rate.?limit|overloaded|529|too low/i.test(String(r.ai_draft_error || ''))
      && Date.now() - (Date.parse(r.ai_draft_error_at || 0) || 0) > 10 * 60_000
    // ENTWURFS-SPERRE (13.08.): Von Hand geschriebene oder von Samuel freigegebene
    // Entwuerfe tragen ai_draft_locked. Sie werden vom Auto-Entwurf NIE angefasst
    // und auch von Wartungs-Resets uebersprungen. Ursache: Beim Modellwechsel auf
    // Gemini habe ich offene Entwuerfe zurueckgesetzt und dabei drei sorgfaeltig
    // abgestimmte Faelle (#1439, #1615, #1633) ueberschreiben lassen.
    // Aufraeumen (05.09.): Tickets, deren Entwurf JUENGER ist als ihr Fehlermarker,
    // tragen den Marker nur noch aus Versehen (Guthaben-Ausfall 04./05.09.).
    { const cur0 = readInbound(); let n0 = 0
      for (const r of cur0) if (r.ai_draft_error && r.ai_draft && String(r.ai_draft_at || '') > String(r.ai_draft_error_at || '')) { delete r.ai_draft_error; delete r.ai_draft_error_at; n0++ }
      if (n0) { writeInbound(cur0); console.log(`[barbara] ${n0} veraltete Fehlermarker entfernt (Entwurf war laengst da)`) } }
    const pending = readInbound().filter((r) => !r.ai_draft && !r.ai_draft_locked && (!r.ai_draft_error || wiederVersuchbar(r)) && !r.ai_draft_sent && (r.body_text || betreffAlsText(r)))
    // TEMPO (15.09.2026): Nach dem Guthaben-Ausfall lagen 144 Tickets ohne
    // Entwurf. Nacheinander abgearbeitet waren das rund 70 Minuten, in denen
    // Mitarbeiterin A ohne Antwortvorschlaege arbeiten musste. Jetzt laufen mehrere
    // Entwuerfe gleichzeitig. Das ist sicher, weil jeder Schreibblock im
    // Rumpf ein readInbound() direkt gefolgt von writeInbound() ist, ohne
    // await dazwischen - Node kann da nicht unterbrechen, also kann sich
    // nichts gegenseitig ueberschreiben. Bei Rate-Limits greift die
    // bestehende Wiederholungsregel (wiederVersuchbar).
    const GLEICHZEITIG = Math.max(1, Number(process.env.DRAFT_PARALLEL || 4))
    const warteschlange = pending.slice(0, 32)
    const einEntwurf = async (rec) => {
      try {
        // Phishing/Scam zuerst: als Spam flaggen, KEINE KI-Antwort verschwenden.
        if (looksLikePhishing(rec)) {
          const cur = readInbound()
          const hit = cur.find((x) => x.id === rec.id)
          if (hit && !hit.ai_draft_sent) {
            hit.is_spam = true
            hit.ai_draft = 'Interne Notiz: Phishing-/Scam-Mail automatisch erkannt (gefälschte Bestellbestätigung bzw. betrügerischer Link). Kein echter Kunde — nicht antworten, Ticket bleibt in Spam.'
            hit.ai_draft_at = new Date().toISOString()
            hit.ai_draft_sent = true
            hit.ai_risk = { score: 9, reason: 'Phishing/Scam automatisch erkannt — nicht antworten' }
            writeInbound(cur)
            console.log(`[barbara] 🚫 Phishing/Scam erkannt für #${rec.ticket_number} → als Spam geflaggt`)
          }
          return
        }
        // Bilder zuerst auslesen: Screenshots enthalten oft die Bestellnummer
        // und eine ABWEICHENDE E-Mail-Adresse, unter der die Bestellung liegt.
        let vision = rec.vision?.results || null
        if (!vision) { try { vision = await analyzeTicketImages(rec) } catch { /* optional */ } }
        const thread = Array.isArray(rec.messages) && rec.messages.length
          ? rec.messages.map((m) => ({ direction: m.direction, from_name: m.from_name || rec.customer_name, body_text: nachrichtText(m, rec), is_internal_note: !!m.is_internal_note, auto_ack: !!m.auto_ack }))
          : [{ direction: 'in', from_name: rec.customer_name, body_text: rec.body_text || betreffAlsText(rec), is_internal_note: false }]
        // Bilddaten als sichtbaren Kontext an Barbara übergeben. Wichtig: NICHT
        // als is_internal_note, weil generateBarbaraReply diese wegfiltert.
        let visionContext = ''
        if (vision && vision.length) {
          const v = vision[0]
          const lines = [
            v.order_number ? `Bestellnummer: ${v.order_number}` : null,
            v.email && v.email.toLowerCase() !== String(rec.customer_email || '').toLowerCase()
              ? `ACHTUNG: Bestellung liegt unter einer ANDEREN E-Mail-Adresse: ${v.email}` : null,
            v.name ? `Name auf der Bestellung: ${v.name}` : null,
            v.address ? `Lieferadresse: ${v.address}` : null,
            v.amount ? `Betrag: ${v.amount}` : null,
            v.tracking ? `Sendungsnummer: ${v.tracking}` : null,
            v.items ? `Artikel: ${v.items}` : null,
            v.date ? `Datum: ${v.date}` : null,
          ].filter(Boolean)
          if (lines.length) visionContext = `\n\nDIE KUNDIN HAT EIN BILD MITGESCHICKT. Wir haben es ausgelesen, das steht darauf:\n- ${lines.join('\n- ')}\nBezieh dich in deiner Antwort AKTIV darauf (z.B. "auf dem Screenshot sehe ich…"), sag NIE, dass kein Bild angekommen ist.`
        }
        const genTicket = {
          subject: rec.subject,
          customer_name: rec.customer_name,
          customer_email: rec.customer_email,
          messages: thread,
          visionContext,
        }
        const genOpts = {}
        const rawDraft = await generateBarbaraReply(genTicket, genOpts)
        // Second Brain: jeder Auto-Entwurf durchläuft die Qualitäts-Pipeline
        // (Guards + Selbstkritik + ggf. Neugenerierung) und bekommt einen Score.
        const threadPlain = thread
          .map((m) => (m.is_internal_note ? `[INTERNE NOTIZ, gilt als gesicherter Fakt] ${m.body_text || ''}` : (m.body_text || '')))
          .join('\n')
        const q = await qualityPipeline(genTicket, stripPreamble(rawDraft), genOpts.factsCtx || '', threadPlain)
        let risk = await scoreConsequence(rec).catch(() => null)
        // Offener Klarna-/Payment-Fall → Konsequenz IMMER maximal (Chargeback-Gefahr!)
        try {
          const ctx = await fetchShopifyContext(rec.customer_email, { name: rec.customer_name, text: `${rec.subject || ''}\n${rec.body_text || ''}`.slice(0, 3000) })
          if (ctx?.found && (ctx.orders || []).some((o) => o.dispute?.open)) {
            risk = { score: 10, reason: 'OFFENER KLARNA-FALL — Chargeback unbedingt verhindern!' }
          }
        } catch { /* optional */ }
        const cur = readInbound()
        const hit = cur.find((x) => x.id === rec.id)
        // WICHTIG: frisch nachladen und NUR schreiben, wenn inzwischen nicht schon
        // ein Entwurf existiert (z.B. manuell gesetzt während der KI-Aufruf lief).
        // Verhindert das Read-Modify-Write-Rennen, das manuelle Entwürfe überschrieb.
        if (hit && !hit.ai_draft && !hit.ai_draft_sent) {
          hit.ai_draft = q.text
          hit.ai_draft_at = new Date().toISOString()
          // Fehlermarker eines frueheren Versuchs (z.B. leeres Guthaben) loeschen —
          // sonst zeigt das Ticket ewig "Fehler 400", obwohl der Entwurf laengst da ist.
          delete hit.ai_draft_error
          delete hit.ai_draft_error_at
          hit.ai_confidence = q.score
          if (q.issues.length) hit.ai_confidence_issues = q.issues
          else delete hit.ai_confidence_issues
          // Erstattungs-Pflicht-Fälle (Samuel, 06.08.): unübersehbar markieren
          if (q.erstattungNoetig) hit.action_required = 'Rückerstattung nötig'
          if (risk && !hit.ai_risk) hit.ai_risk = risk
          writeInbound(cur)
          appendOutcome({ event: 'draft', ticket: rec.ticket_number, confidence: q.score, issues: q.issues.length })
          console.log(`[barbara] ✍️ Entwurf erstellt für #${rec.ticket_number} (${(rec.subject || '').slice(0, 40)}) · Confidence ${q.score}/100${risk ? ` · Konsequenz ${risk.score}/10` : ''}`)
        } else {
          console.log(`[barbara] ⏭️  #${rec.ticket_number}: Entwurf existiert bereits — nicht überschrieben`)
        }
      } catch (e) {
        const cur = readInbound()
        const hit = cur.find((x) => x.id === rec.id)
        if (hit) { hit.ai_draft_error = String(e?.message || e).slice(0, 150); hit.ai_draft_error_at = new Date().toISOString(); writeInbound(cur) }
        console.log('[barbara] Entwurf fehlgeschlagen:', String(e?.message || e).slice(0, 100))
      }
    }
    await Promise.all(Array.from({ length: Math.min(GLEICHZEITIG, warteschlange.length) }, async () => {
      for (let rec; (rec = warteschlange.shift()); ) await einEntwurf(rec)
    }))
  } finally { autoDraftRunning = false }
}

app.post('/api/ai/reply', async (req, res) => {
  const ticket = req.body?.ticket
  if (!ticket) return res.status(400).json({ error: 'Ticket fehlt.' })
  try {
    const draft = await generateBarbaraReply(ticket)
    res.json({ draft, model: connections.ai.model })
  } catch (err) {
    if (err?.code === 'no_key') return res.status(400).json({ error: 'AI nicht verbunden. Hinterlege einen Anthropic-API-Key unter Integrationen.', code: 'no_key' })
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// ---- Shopify OAuth (Dev-Dashboard apps — no legacy shpat available) --------
const SHOPIFY_REDIRECT = process.env.SHOPIFY_REDIRECT || `http://localhost:${PORT}/api/shopify/oauth/callback`
const SHOPIFY_SCOPES = 'read_all_orders,read_customers,read_orders,read_fulfillments,read_products'


// ═════════════════════════════════════════════════════════════════════════════
// META (Facebook-Seite + Instagram-Business): OAuth, Token-Ablage, Webhook.
// Vorbereitung fuer das Kommentar-Management (Samuel, 05.09.2026).
// Ablauf: Karte "Meta Business" → App-ID + App-Secret speichern → "Mit Meta
// anmelden" → Facebook-Login-Dialog → Callback tauscht Code gegen langlebiges
// User-Token → holt alle Seiten inkl. verknuepftem Instagram-Konto → Seiten-
// Tokens (laufen nicht ab) landen in connections.meta._pageTokens.
// Webhook: GET = Meta-Verifizierung (verifyToken), POST = Ereignisse
// (Kommentare etc.), Signatur wird gegen das App-Secret geprueft, Rohdaten
// landen in data/meta-events.jsonl — Verarbeitung folgt mit Samuels Anweisungen.
// ═════════════════════════════════════════════════════════════════════════════
const META_API = 'https://graph.facebook.com/v21.0'
const META_REDIRECT = process.env.META_REDIRECT || 'https://topg.leichtkraut.de/api/meta/oauth/callback'
const META_SCOPES = process.env.META_SCOPES || [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_engagement', 'pages_read_user_content',
  'pages_manage_metadata', 'pages_messaging', 'instagram_basic', 'instagram_manage_comments',
  'instagram_manage_messages', 'business_management',
].join(',')
const META_EVENTS_FILE = path.join(DATA_DIR, 'meta-events.jsonl')
const __metaStates = new Map()   // state → { host, exp }  (CSRF-Schutz fuer den OAuth-Ruecklauf)

function metaVerifyTokenSicherstellen() {
  if (!connections.meta) connections.meta = { connected: false }
  if (!connections.meta.verifyToken) { connections.meta.verifyToken = crypto.randomBytes(12).toString('hex'); saveConnections(connections) }
  return connections.meta.verifyToken
}
metaVerifyTokenSicherstellen()

async function metaGet(pfad, params) {
  const u = new URL(META_API + pfad)
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v))
  const r = await fetch(u)
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.error) throw new Error(`Meta ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 200)}`)
  return j
}
async function metaPost(pfad, params) {
  const r = await fetch(META_API + pfad, { method: 'POST', body: new URLSearchParams(params || {}) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.error) throw new Error(`Meta ${r.status}: ${(j.error && j.error.message) || JSON.stringify(j).slice(0, 200)}`)
  return j
}
function metaPageToken(pageId) {
  const m = connections.meta || {}
  return (m._pageTokens || {})[pageId || m.pageId] || ''
}

app.get('/api/meta/oauth/start', (req, res) => {
  const cid = connections.meta && connections.meta.clientId
  if (!cid || !secrets.metaClientSecret) return res.status(400).send('Bitte zuerst App-ID und App-Secret in der Meta-Karte speichern.')
  const state = crypto.randomBytes(16).toString('hex')
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'topg.leichtkraut.de').split(',')[0].trim()
  __metaStates.set(state, { host, exp: Date.now() + 15 * 60_000 })
  for (const [k, v] of __metaStates) if (v.exp < Date.now()) __metaStates.delete(k)
  const u = new URL('https://www.facebook.com/v21.0/dialog/oauth')
  u.searchParams.set('client_id', cid)
  u.searchParams.set('redirect_uri', META_REDIRECT)
  u.searchParams.set('scope', META_SCOPES)
  u.searchParams.set('state', state)
  u.searchParams.set('response_type', 'code')
  res.redirect(u.toString())
})

app.get('/api/meta/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query
  const st = __metaStates.get(String(state || ''))
  const zurueck = (q) => res.redirect(`https://${(st && st.host) || 'topg.leichtkraut.de'}/workspace/${APP_WORKSPACE}/organization/integrations?meta=${q}`)
  if (!st || Date.now() > st.exp) { console.log('[meta] OAuth: unbekannter/abgelaufener state'); return zurueck('error') }
  __metaStates.delete(String(state))
  if (error || !code) { console.log('[meta] OAuth abgelehnt:', error, error_description || ''); return zurueck('error') }
  try {
    const cid = connections.meta.clientId, sec = secrets.metaClientSecret
    const t1 = await metaGet('/oauth/access_token', { client_id: cid, client_secret: sec, redirect_uri: META_REDIRECT, code: String(code) })
    if (!t1.access_token) throw new Error('kein access_token im Code-Tausch')
    // Langlebiges User-Token (60 Tage) — daraus abgeleitete Seiten-Tokens laufen nicht ab.
    let userToken = t1.access_token
    try { const t2 = await metaGet('/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: cid, client_secret: sec, fb_exchange_token: t1.access_token }); if (t2.access_token) userToken = t2.access_token } catch (e) { console.log('[meta] Langzeit-Token fehlgeschlagen (nehme kurzlebiges):', String(e.message)) }
    const me = await metaGet('/me', { fields: 'id,name', access_token: userToken }).catch(() => ({}))
    const perms = await metaGet('/me/permissions', { access_token: userToken }).then((j) => (j.data || []).filter((p) => p.status === 'granted').map((p) => p.permission)).catch(() => [])
    const acc = await metaGet('/me/accounts', { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: 50, access_token: userToken })
    const roh = Array.isArray(acc.data) ? acc.data : []
    const pages = roh.map((p) => ({ id: p.id, name: p.name, igId: (p.instagram_business_account && p.instagram_business_account.id) || null, igUsername: (p.instagram_business_account && p.instagram_business_account.username) || null }))
    const tokens = {}; for (const p of roh) if (p.access_token) tokens[p.id] = p.access_token
    const alt = connections.meta || {}
    connections.meta = {
      ...alt, connected: pages.length > 0, user: me.name || null, userId: me.id || null, pages, grantedScopes: perms,
      pageId: (alt.pageId && pages.some((p) => p.id === alt.pageId)) ? alt.pageId : (pages[0] ? pages[0].id : null),
      connectedAt: new Date().toISOString(), _userToken: userToken, _pageTokens: tokens,
    }
    saveConnections(connections)
    // Webhook-Abo pro Seite (feed = Posts/Kommentare). Greift erst, wenn der Webhook
    // in der Meta-App eingetragen ist; scheitert sonst leise.
    for (const p of roh) { try { await metaPost(`/${p.id}/subscribed_apps`, { subscribed_fields: 'feed', access_token: p.access_token }) } catch (e) { console.log('[meta] subscribed_apps', p.name, ':', String(e.message).slice(0, 120)) } }
    console.log('[meta] ✅ verbunden als', me.name || '?', '· Seiten:', pages.map((p) => p.name + (p.igUsername ? ' / @' + p.igUsername : '')).join(', ') || '(keine)', '· Scopes:', perms.join(','))
    return zurueck(pages.length ? 'ok' : 'nopages')
  } catch (e) { console.log('[meta] OAuth-Fehler:', String(e && e.message || e)); return zurueck('error') }
})

// Verbindung per System-User-Token (Samuel, 05.09.): Der Token aus dem
// BOF-Ordner ist im Business Manager allen Seiten zugewiesen. Damit holen wir
// die Seiten-Tokens direkt — kein Login-Dialog noetig. Der Token kommt nur per
// POST-Body an (nie in Logs, nie in Antworten).
app.post('/api/meta/connect-token', async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim()
  if (!token) return res.status(400).json({ ok: false, error: 'token fehlt' })
  try {
    const me = await metaGet('/me', { fields: 'id,name', access_token: token })
    const acc = await metaGet('/me/accounts', { fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: 50, access_token: token })
    const roh = Array.isArray(acc.data) ? acc.data : []
    if (!roh.length) return res.status(400).json({ ok: false, error: 'Dem Token sind keine Seiten zugewiesen.' })
    const pages = roh.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks || [], igId: (p.instagram_business_account && p.instagram_business_account.id) || null, igUsername: (p.instagram_business_account && p.instagram_business_account.username) || null }))
    const tokens = {}; for (const p of roh) if (p.access_token) tokens[p.id] = p.access_token
    const alt = connections.meta || {}
    const brand = pages.find((p) => /leichtkraut/i.test(p.name)) || pages[0]
    connections.meta = {
      ...alt, connected: true, quelle: 'system-user', user: me.name || null, userId: me.id || null, pages,
      pageId: (alt.pageId && pages.some((p) => p.id === alt.pageId)) ? alt.pageId : brand.id,
      adAccount: (req.body && req.body.adAccount) || alt.adAccount || null,
      connectedAt: new Date().toISOString(), _systemToken: token, _pageTokens: tokens,
    }
    saveConnections(connections)
    console.log('[meta] ✅ per System-User verbunden als', me.name, '·', pages.length, 'Seite(n):', pages.map((p) => p.name + (p.igUsername ? ' / @' + p.igUsername : '')).join(', '))
    res.json({ ok: true, user: me.name, pages, pageId: connections.meta.pageId })
  } catch (e) { console.log('[meta] connect-token Fehler:', String(e && e.message || e)); res.status(400).json({ ok: false, error: String(e && e.message || e) }) }
})

// Meta-Verifizierung des Webhooks (einmalig beim Eintragen in der App).
app.get('/api/meta/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === metaVerifyTokenSicherstellen()) {
    console.log('[meta] Webhook verifiziert'); return res.status(200).send(String(req.query['hub.challenge'] || ''))
  }
  res.sendStatus(403)
})
// Ereignisse (Kommentare, Posts, DMs …): Signatur pruefen, roh ablegen, 200 antworten.
app.post('/api/meta/webhook', (req, res) => {
  const sig = String(req.headers['x-hub-signature-256'] || '')
  if (secrets.metaClientSecret && req.rawBody) {
    const erwartet = 'sha256=' + crypto.createHmac('sha256', secrets.metaClientSecret).update(req.rawBody).digest('hex')
    const okSig = sig.length === erwartet.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(erwartet))
    if (!okSig) { console.log('[meta] Webhook: ungueltige Signatur'); return res.sendStatus(403) }
  }
  try { fs.appendFileSync(META_EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), body: req.body }) + '\n') } catch {}
  const n = ((req.body && req.body.entry) || []).reduce((a, e) => a + ((e.changes || []).length + (e.messaging || []).length), 0)
  console.log(`[meta] Webhook: ${n} Ereignis(se) (${(req.body && req.body.object) || '?'})`)
  res.sendStatus(200)
})
// Kommentar-Management (Uebersicht /kommentare + API), eigenes Modul.
// Kommentar-Manager komplett abgeschaltet (Sam, 04.10.2026): keine Timer, keine Scans, keine Meta-Abfragen, keine Antwort-/Verbergen-/Loeschen-Routen.
// Chat 5 ist jetzt „To-Do & Planung“. Code (meta-kommentare.js) und Daten (data/meta-kommentar*.json, meta-pause.json) bleiben unangetastet.
// Wieder einschalten nur auf Sams Wort: KOMMENTARE_AN=1 in .env und Dienst neu starten.
if (process.env.KOMMENTARE_AN === '1') {
  registerMetaKommentare(app, {
    getConnections: () => connections, secrets, DATA_DIR, sessionUser, aiFetch,
    seitenHtml: () => fs.readFileSync(path.join(__dirname, 'pages', 'kommentare.html'), 'utf8'),
  })
} else {
  app.all(['/api/meta/kommentare', '/api/meta/kommentare/*'], (req, res) => res.status(410).json({ error: 'Kommentar-Manager abgeschaltet seit 04.10.2026 (Sam). Chat 5 ist jetzt To-Do & Planung.' }))
  app.get(['/kommentare', '/kommentare/'], (req, res) => res.status(410).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Abgeschaltet</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#08070d;color:#d9d3ea;font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"><div style="text-align:center"><b style="font-size:18px;color:#f3f0fb">Kommentar-Manager abgeschaltet</b><p>Seit 04.10.2026. Chat 5 ist jetzt To-Do &amp; Planung.</p><a href="/os" style="color:#c4b5fd">Zum Leichtkraut OS</a></div>'))
  console.log('[kommentare] abgeschaltet (KOMMENTARE_AN nicht gesetzt)')
}

// Kleine Status-Auskunft fuer die Oberflaeche / Debugging (ohne Tokens).
app.get('/api/meta/status', (_req, res) => {
  const m = connections.meta || {}
  res.json({ connected: !!m.connected, user: m.user || null, pages: m.pages || [], pageId: m.pageId || null, grantedScopes: m.grantedScopes || [], verifyToken: m.verifyToken, redirectUri: META_REDIRECT, webhookUrl: META_REDIRECT.replace('/oauth/callback', '/webhook'), connectedAt: m.connectedAt || null })
})

app.get('/api/shopify/oauth/start', (req, res) => {
  const shop = String(req.query.shop || connections.shopify.store || '').replace(/^https?:\/\//, '').replace(/\/$/, '')
  const cid = connections.shopify.clientId
  if (!shop || !cid || !secrets.shopifyClientSecret) return res.status(400).send('Bitte zuerst Store-Domain, Client-ID und Client-Secret in der Shopify-Karte speichern.')
  const u = new URL(`https://${shop}/admin/oauth/authorize`)
  u.searchParams.set('client_id', cid)
  u.searchParams.set('scope', SHOPIFY_SCOPES)
  u.searchParams.set('redirect_uri', SHOPIFY_REDIRECT)
  u.searchParams.set('state', 'topg-leichtkraut')
  res.redirect(u.toString())
})

app.get('/api/shopify/oauth/callback', async (req, res) => {
  const { code, shop } = req.query
  if (!code || !shop) return res.redirect(APP_INTEGRATIONS_URL + '?shopify=error')
  try {
    const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: connections.shopify.clientId, client_secret: secrets.shopifyClientSecret, code }),
    })
    const t = await r.json()
    if (!t.access_token) throw new Error(JSON.stringify(t).slice(0, 200))
    secrets.shopify = t.access_token
    connections.shopify._token = t.access_token
    const info = await fetch(`https://${shop}/admin/api/2024-01/shop.json`, { headers: { 'X-Shopify-Access-Token': t.access_token } }).then((x) => x.json()).catch(() => null)
    connections.shopify = { ...connections.shopify, connected: true, store: String(shop), shopName: info?.shop?.name || String(shop), hasToken: true }
    saveConnections(connections)
    console.log('[shopify] ✅ OAuth verbunden:', shop, '· Scopes:', t.scope || SHOPIFY_SCOPES)
    res.redirect(APP_INTEGRATIONS_URL + '?shopify=ok')
  } catch (err) {
    console.log('[shopify] OAuth-Fehler:', String(err?.message || err))
    res.redirect(APP_INTEGRATIONS_URL + '?shopify=error')
  }
})

// ---- live Shopify customer lookup -----------------------------------------
app.get('/api/shopify/customer', async (req, res) => {
  const email = req.query.email
  if (!secrets.shopify || !connections.shopify.store) return res.status(400).json({ error: 'Shopify nicht verbunden.' })
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich.' })
  try {
    const store = connections.shopify.store
    const r = await fetch(`https://${store}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(email)}`, {
      headers: { 'X-Shopify-Access-Token': secrets.shopify, 'Content-Type': 'application/json' },
    })
    if (!r.ok) return res.status(400).json({ error: `Shopify ${r.status}` })
    const data = await r.json()
    const cust = data.customers?.[0]
    // PROFIL-DUPLIKAT-REGEL (15.08.): Ein E-Mail-Treffer OHNE Bestellungen ist
    // kein Endpunkt. Erst die volle Kaskade fragen, danach ggf. zurueckfallen.
    if (cust && Number(cust.orders_count) > 0) {
      return res.json({
        found: true,
        name: `${cust.first_name || ''} ${cust.last_name || ''}`.trim(),
        email: cust.email,
        orders_count: cust.orders_count,
        total_spent: cust.total_spent,
      })
    }
    const ctx = await fetchShopifyContext(String(email), shopifyHintsFuer(email))
    if (ctx && ctx.found !== false) {
      const k = ctx.customer || {}
      return res.json({
        found: true,
        name: k.name || '',
        email: k.email || String(email),
        orders_count: k.orders_count ?? (Array.isArray(ctx.orders) ? ctx.orders.length : null),
        total_spent: k.total_spent ?? null,
        matched_via: ctx.matched_via || null,
      })
    }
    if (cust) {
      return res.json({
        found: true,
        name: `${cust.first_name || ''} ${cust.last_name || ''}`.trim(),
        email: cust.email,
        orders_count: cust.orders_count,
        total_spent: cust.total_spent,
      })
    }
    res.json({ found: false })
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// ---- full live Shopify context: customer + orders + items + address --------
// Mehrstufige Kunden-Zuordnung: (1) exakte E-Mail → (2) Tippfehler-E-Mail
// (gleicher lokaler Teil, andere Domain, z.B. gmai.com statt gmail.com) →
// (3) Bestellnummer im Mail-Text (#S12345, "S 14846") → (4) eindeutiger Name.
// ─────────────────────────────────────────────────────────────────────────────
// BILDER AUSLESEN (04.08.)
// Kundinnen schicken oft einen Screenshot ihrer Bestellbestätigung statt Daten
// zu tippen — und schreiben dabei häufig von einer ANDEREN Adresse als der, mit
// der sie bestellt haben (Ticket #1464: Mail von hotmail.de, Bestellung unter
// yahoo.com). Ohne Bildauswertung findet das Tool die Bestellung nie.
// Wir lassen das Bild einmalig auslesen und hängen das Ergebnis ans Ticket.
// ─────────────────────────────────────────────────────────────────────────────
const VISION_MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }

async function readImageAttachment(att) {
  const apiKey = secrets.ai
  if (!apiKey || !att?.url) return null
  const name = decodeURIComponent(String(att.url).split('/').pop() || '')
  const file = path.join(ATT_DIR, name)
  if (!fs.existsSync(file)) return null
  const ext = (name.split('.').pop() || '').toLowerCase()
  const mime = VISION_MIME[ext] || (String(att.content_type || '').startsWith('image/') ? att.content_type : null)
  if (!mime) return null
  const buf = fs.readFileSync(file)
  if (buf.length > 4.5 * 1024 * 1024) return null // Anthropic-Limit für Bilder
  const r = await aiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      // Bild-Auswertung auf dem Utility-Modell: Haiku 4.5 kann Vision, ist 5x
      // günstiger und erlaubt temperature (Sonnet 5 wirft dabei einen 400er).
      model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      temperature: 0,
      system: `Du liest Screenshots aus dem Kundenservice eines Onlineshops (Leichtkraut).
Extrahiere ALLE erkennbaren Bestelldaten und gib AUSSCHLIESSLICH ein JSON-Objekt zurück, ohne Erklärung, ohne Markdown:
{"order_number":"#S… oder null","email":"E-Mail-Adresse im Bild oder null","name":"Name oder null","address":"Strasse Hausnummer, PLZ Ort oder null","amount":"Betrag mit Währung oder null","tracking":"Sendungsnummer oder null","items":"kurze Beschreibung der Artikel oder null","date":"Datum oder null","summary":"ein Satz, was das Bild zeigt"}
Regeln: Nichts erfinden. Was nicht klar lesbar ist, ist null. E-Mail-Adressen exakt übernehmen, auch wenn sie ungewöhnlich aussehen.`,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } },
        { type: 'text', text: 'Lies alle Bestelldaten aus diesem Bild.' },
      ] }],
    }),
  })
  if (!r.ok) throw new Error(`Bildauswertung fehlgeschlagen (${r.status})`)
  const data = await r.json()
  const raw = (data.content || []).map((c) => c.text || '').join('').trim()
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

// Alle Bild-Anhänge eines Tickets auswerten und das Ergebnis persistieren.
async function analyzeTicketImages(rec) {
  if (!secrets.ai || !rec || rec.vision) return null
  const atts = (rec.messages || []).flatMap((m) => m.attachments || [])
    .filter((a) => String(a.content_type || '').startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(a.filename || ''))
  if (!atts.length) return null
  const results = []
  for (const a of atts.slice(0, 3)) {
    try {
      const v = await readImageAttachment(a)
      if (v) results.push({ file: a.filename, ...v })
    } catch (e) { console.log('[vision]', String(e?.message || e).slice(0, 70)) }
  }
  if (!results.length) return null
  // Frisch nachladen und sofort schreiben (kein await dazwischen)
  const cur = readInbound()
  const hit = cur.find((x) => x.id === rec.id)
  if (hit) {
    hit.vision = { at: new Date().toISOString(), results }
    writeInbound(cur)
  }
  console.log(`[vision] 🖼️  Bild ausgelesen für #${rec.ticket_number}: ${results.map((r) => r.order_number || r.email || r.summary || '?').join(' · ').slice(0, 90)}`)
  return results
}

async function fetchShopifyContext(email, extra = {}) {
  if (!secrets.shopify || !connections.shopify.store) return null
  const store = connections.shopify.store
  const H = { 'X-Shopify-Access-Token': secrets.shopify, 'Content-Type': 'application/json' }
  const searchCust = async (q) => {
    const r = await fetch(`https://${store}/admin/api/2024-01/customers/search.json?query=${encodeURIComponent(q)}`, { headers: H })
    if (!r.ok) return []
    return (await r.json()).customers || []
  }

  let cust = null
  let matchedVia = null

  // Kandidaten-Adressen: Absender + im Mail-Text gefundene Adressen
  // (Shopify-Kontaktformular: "E-Mail: kundin@...") — ohne Relay-/eigene Domains
  const textEmails = [...String(extra.text || '').matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)]
    .map((m) => m[0].toLowerCase())
    .filter((e) => !/leichtkraut\.de|shopify\.com|klarna|dhl\.|no-?reply|ionos/.test(e))
  const candidates = [...new Set([email, ...textEmails].filter((e) => e && e.includes('@')))]

  // (1) exakte E-Mail (alle Kandidaten)
  for (const cand of candidates) {
    const hits = await searchCust(`email:${cand}`)
    cust = hits.find((c) => (c.email || '').toLowerCase() === cand.toLowerCase()) || hits[0] || null
    if (cust) { matchedVia = 'email'; break }
  }
  // PROFIL-DUPLIKAT-REGEL (Samuel, 15.08., Fall #1750 Kundin K): Kundinnen
  // bestellen mit Gmail und schreiben vom web.de-/GMX-Konto. Newsletter- und
  // Checkout-Flows legen fuer die Zweitadresse ein KUNDENPROFIL OHNE BESTELLUNGEN
  // an. So ein Treffer ist KEIN Endpunkt: Die Kaskade laeuft weiter (Bestell-
  // nummer im Text, Sendungsnummer, Name, Signatur). Erst wenn keine spaetere
  // Stufe ein Profil MIT Bestellungen findet, fallen wir auf das leere Profil
  // zurueck, damit Interessentinnen ohne Kauf weiterhin angezeigt werden.
  let leeresEmailProfil = null
  if (cust && cust.orders_count !== undefined && !(Number(cust.orders_count) > 0)) { // undefined = Bestell-Treffer (eingebettetes customer-Objekt traegt kein orders_count) -> zaehlt als Kaeuferin
    leeresEmailProfil = cust
    cust = null
    matchedVia = null
  }

  // (2) Tippfehler-Domain: Suche nach dem lokalen Teil (alle Kandidaten)
  if (!cust) {
    for (const cand of candidates) {
      const local = cand.split('@')[0]
      if (local.length < 5) continue
      const cands2 = (await searchCust(local)).filter((c) => (c.email || '').split('@')[0].toLowerCase() === local.toLowerCase())
      if (cands2.length === 1) { cust = cands2[0]; matchedVia = 'email-typo'; break }
    }
  }
  // Leere Profile (0 Bestellungen) sind auch hier kein Endpunkt (15.08.):
  if (cust && cust.orders_count !== undefined && !(Number(cust.orders_count) > 0)) { // undefined = Bestell-Treffer (eingebettetes customer-Objekt traegt kein orders_count) -> zaehlt als Kaeuferin
    if (!leeresEmailProfil) leeresEmailProfil = cust
    cust = null
    matchedVia = null
  }

  // (3) Bestellnummer im Betreff/Text
  if (!cust && extra.text) {
    const nums = [...String(extra.text).matchAll(/#?\s*S\s*-?\s*(\d{4,6})\b/gi)].map((m) => 'S' + m[1]).slice(0, 3)
    for (const n of nums) {
      const r = await fetch(`https://${store}/admin/api/2024-01/orders.json?name=${encodeURIComponent('#' + n)}&status=any`, { headers: H })
      if (r.ok) {
        const o = (await r.json()).orders?.[0]
        if (o?.customer) { cust = o.customer; matchedVia = 'order-number'; break }
      }
    }
  }

  // (3b) Sendungsnummer im Text → Bestellung über Fulfillment-Tracking finden
  // (durchsucht die letzten ~1000 Bestellungen seitenweise)
  if (!cust && extra.text) {
    const tracks = [...String(extra.text).matchAll(/\b(\d{11,22})\b/g)].map((m) => m[1]).slice(0, 3)
    if (tracks.length) {
      let url = `https://${store}/admin/api/2024-01/orders.json?status=any&limit=250&fields=id,name,email,customer,fulfillments`
      outer:
      for (let page = 0; page < 4 && url; page++) {
        const r = await fetch(url, { headers: H })
        if (!r.ok) break
        const os = (await r.json()).orders || []
        for (const o of os) {
          for (const f of o.fulfillments || []) {
            const tn = String(f.tracking_number || '')
            if (tn.length >= 10 && tracks.some((t) => tn === t || tn.includes(t) || t.includes(tn))) {
              if (o.customer) { cust = o.customer; matchedVia = 'tracking' }
              break outer
            }
          }
        }
        const link = r.headers.get('link') || ''
        const m = link.match(/<([^>]+)>;\s*rel="next"/)
        url = m ? m[1] : null
      }
    }
  }

  // (4) Voller Name — nur bei EINDEUTIGEM Treffer
  if (!cust && extra.name && String(extra.name).trim().includes(' ')) {
    const nm = String(extra.name).trim().toLowerCase()
    const cands = await searchCust(String(extra.name).trim())
    const exactName = cands.filter((c) => {
      const a = `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase()
      const b = `${c.last_name || ''} ${c.first_name || ''}`.trim().toLowerCase()
      return a === nm || b === nm
    })
    if (exactName.length === 1) { cust = exactName[0]; matchedVia = 'name' }
  }
  // Leere Profile (0 Bestellungen) sind auch hier kein Endpunkt (15.08.):
  if (cust && cust.orders_count !== undefined && !(Number(cust.orders_count) > 0)) { // undefined = Bestell-Treffer (eingebettetes customer-Objekt traegt kein orders_count) -> zaehlt als Kaeuferin
    if (!leeresEmailProfil) leeresEmailProfil = cust
    cust = null
    matchedVia = null
  }

  // (4b) Name aus der GRUSSFORMEL im Mailtext (11.08., Fall #1645
  // Weickart): Die Kundin schrieb von einer anderen Adresse (gmail) als der
  // Bestell-Adresse (outlook), ohne Absendernamen — aber mit "MfG Kundin
  // Weickart" am Ende. Stufe 4 griff nicht, weil extra.name leer war. Jetzt
  // ziehen wir Namens-Kandidaten aus den ueblichen Grussformeln und suchen sie
  // wie in Stufe 4: NUR ein eindeutiger Volltreffer zaehlt.
  if (!cust && extra.text) {
    const STOP = new Set(['von', 'gesendet', 'am', 'ihre', 'ihr', 'dein', 'deine', 'team', 'mail', 'app', 'iphone', 'android'])
    const sigRe = /(?:mfg|mit freundliche[nm] gr(?:\u00fc|ue)(?:\u00df|ss)en|mit freundlichem gru(?:\u00df|ss)|viele gr(?:\u00fc|ue)(?:\u00df|ss)e|liebe gr(?:\u00fc|ue)(?:\u00df|ss)e|freundliche gr(?:\u00fc|ue)(?:\u00df|ss)e|beste gr(?:\u00fc|ue)(?:\u00df|ss)e|lg|gru(?:\u00df|ss))[,.:]?\s+((?:[A-Z\u00c4\u00d6\u00dc][\w\u00e4\u00f6\u00fc\u00df-]+\s*){2,3})/gi
    const kandNamen = []
    for (const m of String(extra.text).matchAll(sigRe)) {
      const woerter = m[1].trim().split(/\s+/).filter((w) => !STOP.has(w.toLowerCase()))
      if (woerter.length >= 2) kandNamen.push(woerter.slice(0, 2).join(' '))
    }
    for (const kandName of [...new Set(kandNamen)].slice(0, 3)) {
      const nm = kandName.toLowerCase()
      const cands = await searchCust(kandName)
      const exact = cands.filter((c) => {
        const a = `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase()
        const b = `${c.last_name || ''} ${c.first_name || ''}`.trim().toLowerCase()
        return a === nm || b === nm
      })
      if (exact.length === 1) { cust = exact[0]; matchedVia = 'name-signatur'; break }
    }
  }
  // Leere Profile (0 Bestellungen) sind auch hier kein Endpunkt (15.08.):
  if (cust && cust.orders_count !== undefined && !(Number(cust.orders_count) > 0)) { // undefined = Bestell-Treffer (eingebettetes customer-Objekt traegt kein orders_count) -> zaehlt als Kaeuferin
    if (!leeresEmailProfil) leeresEmailProfil = cust
    cust = null
    matchedVia = null
  }

  if (!cust && leeresEmailProfil) { cust = leeresEmailProfil; matchedVia = 'email' }
  if (!cust) return { found: false }
  const or = await fetch(`https://${store}/admin/api/2024-01/orders.json?customer_id=${cust.id}&status=any&limit=5`, { headers: H })
  const orders = or.ok ? (await or.json()).orders || [] : []
  // Offene Payment-Disputes (Klarna-Anfragen/Rückbuchungen) per GraphQL abfragen —
  // höchste Priorität: ein Chargeback muss um jeden Preis verhindert werden.
  const disputesByOrder = {}
  const paymentByOrder = {}
  try {
    if (orders.length) {
      const ids = orders.map((o) => `"gid://shopify/Order/${o.id}"`).join(',')
      const gql = { query: `{ nodes(ids: [${ids}]) { ... on Order { id disputes { id status initiatedAs } transactions(first: 10) { gateway status kind paymentDetails { __typename ... on CardPaymentDetails { company wallet } ... on LocalPaymentMethodsPaymentDetails { paymentMethodName } } } } } }` }
      const gr = await fetch(`https://${store}/admin/api/2024-01/graphql.json`, { method: 'POST', headers: H, body: JSON.stringify(gql) })
      if (gr.ok) {
        const gd = await gr.json()
        for (const node of gd.data?.nodes || []) {
          if (!node?.id) continue
          const numId = node.id.split('/').pop()
          const open = (node.disputes || []).find((x) => ['NEEDS_RESPONSE', 'UNDER_REVIEW'].includes(x.status))
          if (open) disputesByOrder[numId] = { open: true, status: open.status, type: open.initiatedAs, _did: String(open.id || '').split('/').pop() }
          // Echte Zahlungsart aus den Transaktions-Details (Shopify Payments
          // bündelt Klarna/Sofort/Apple Pay/Karte — Gateway-Name reicht nicht):
          for (const t of node.transactions || []) {
            const pd = t?.paymentDetails
            if (!pd) continue
            // Gescheiterte Versuche überspringen: maßgeblich ist, WOMIT wirklich
            // bezahlt wurde, nicht womit es zuerst probiert wurde.
            if (String(t.status || '').toUpperCase() !== 'SUCCESS') continue
            if (!['SALE', 'CAPTURE', 'AUTHORIZATION'].includes(String(t.kind || '').toUpperCase())) continue
            if (pd.paymentMethodName) {
              const n = String(pd.paymentMethodName).toLowerCase()
              paymentByOrder[numId] = n === 'klarna' ? 'Klarna' : n === 'sofort' ? 'Sofort' : n === 'ideal' ? 'iDEAL' : pd.paymentMethodName[0].toUpperCase() + pd.paymentMethodName.slice(1)
            } else if (pd.wallet) {
              paymentByOrder[numId] = pd.wallet === 'APPLE_PAY' ? 'Apple Pay' : pd.wallet === 'GOOGLE_PAY' ? 'Google Pay' : 'Shop Pay'
            } else if (pd.__typename === 'CardPaymentDetails') {
              paymentByOrder[numId] = pd.company ? `Kreditkarte (${pd.company})` : 'Kreditkarte'
            }
            if (paymentByOrder[numId]) break
          }
        }
        // Beweis-Fristen der offenen Fälle nachladen — fürs Countdown im Panel
        const dids = Object.values(disputesByOrder).map((x) => x._did).filter(Boolean)
        if (dids.length) {
          const gq2 = { query: `{ nodes(ids: [${dids.map((x) => `"gid://shopify/ShopifyPaymentsDispute/${x}"`).join(',')}]) { ... on ShopifyPaymentsDispute { id evidenceDueBy } } }` }
          const gr2 = await fetch(`https://${store}/admin/api/2024-01/graphql.json`, { method: 'POST', headers: H, body: JSON.stringify(gq2) })
          if (gr2.ok) {
            const gd2 = await gr2.json()
            for (const nd of gd2.data?.nodes || []) {
              if (!nd?.id) continue
              const num = String(nd.id).split('/').pop()
              for (const x of Object.values(disputesByOrder)) if (x._did === num) x.dueBy = nd.evidenceDueBy || null
            }
          }
        }
        for (const x of Object.values(disputesByOrder)) delete x._did
      }
    }
  } catch { /* Dispute-/Zahlungs-Daten optional */ }
  return {
    found: true,
    matched_via: matchedVia,
    // Bei Namens-Treffern weicht die Schreib-Adresse von der Bestell-Adresse ab.
    // Barbara bekommt das als Hinweis, damit sie im Zweifel die Bestellnummer
    // bestaetigen laesst, statt Daten an die falsche Person zu schicken.
    ...(matchedVia === 'name' || matchedVia === 'name-signatur'
      ? { hinweis: `Kundin wurde ueber den NAMEN gefunden, nicht ueber die E-Mail-Adresse. Die Schreib-Adresse weicht von der Bestell-Adresse (${cust.email || 'unbekannt'}) ab — vermutlich zwei Postfaecher derselben Person. Keine sensiblen Details nennen, die nur zur Bestell-Adresse gehoeren, und bei Unsicherheit freundlich die Bestellnummer bestaetigen lassen.` }
      : {}),
    customer: {
      name: `${cust.first_name || ''} ${cust.last_name || ''}`.trim(),
      email: cust.email,
      orders_count: cust.orders_count,
      total_spent: cust.total_spent,
      created_at: cust.created_at,
    },
    orders: orders.map((o) => {
      const f = (o.fulfillments || []).find((x) => x.tracking_number) || (o.fulfillments || [])[0] || null
      const a = o.shipping_address || null
      // Zahlungsart: echte Transaktions-Details haben Vorrang (Shopify Payments
      // bündelt Klarna/Sofort/Wallets/Karte); Gateway-Name nur als Fallback.
      const gateways = (o.payment_gateway_names || []).map((g) => String(g).toLowerCase())
      const payment = paymentByOrder[String(o.id)]
        || (gateways.some((g) => g.includes('paypal')) ? 'PayPal'
        : gateways.some((g) => g.includes('klarna')) ? 'Klarna'
        : gateways.length ? 'Kreditkarte' : null)
      const delivered = (o.fulfillments || []).some((x) => x.shipment_status === 'delivered')
      return {
        payment,
        delivered,
        dispute: disputesByOrder[String(o.id)] || null,
        name: o.name,
        created_at: o.created_at,
        total: o.total_price,
        subtotal: o.subtotal_price,
        discount: o.total_discounts,
        shipping: o.total_shipping_price_set?.shop_money?.amount ?? null,
        currency: o.currency,
        financial_status: o.financial_status,
        fulfillment_status: o.fulfillment_status,
        items: (o.line_items || []).map((li) => ({ title: li.title, qty: li.quantity, price: li.price, sku: li.sku })),
        address: a ? { name: a.name, street: `${a.address1 || ''}${a.address2 ? ' ' + a.address2 : ''}`, zip: a.zip, city: a.city, country: a.country } : null,
        // Tracking-Link IMMER selbst aus der Carrier-Erkennung bauen — die von
        // Shopify/Fulfillment-Apps gelieferten URLs sind oft kaputt (dhl.com,
        // "%!s(MISSING)"-Templates) und würden Kunden/uns ins Leere schicken.
        // company: Shopify trägt oft pauschal "DHL" ein, auch bei Fremdcarriern.
        // Deshalb den am Nummernformat erkannten Carrier anzeigen und die Shopify-
        // Angabe nur übernehmen, wenn sie zur Erkennung passt.
        tracking: f?.tracking_number ? (() => {
          const c = detectCarrier(f.tracking_number, f.tracking_url)
          return {
            number: f.tracking_number,
            company: c === 'unknown' ? (f.tracking_company ? `${f.tracking_company} (unbestätigt)` : 'unbekannt') : CARRIER_META[c].name,
            url: CARRIER_META[c].link(f.tracking_number),
          }
        })() : null,
        admin_url: `https://admin.shopify.com/store/${String(store).split('.')[0]}/orders/${o.id}`,
      }
    }),
  }
}

// Zuordnungs-Indizien fuer die Kundensuche: Das Frontend kennt nur die E-Mail.
// Schreibt eine Kundin von einer anderen Adresse als beim Kauf, lief die Suche
// ins Leere und das Panel zeigte "keine Bestellungen" (Samuel, 14.08., sechs
// Faelle an einem Tag). Der Server kennt aber das Ticket zur Adresse - Name,
// Betreff und Mailtext enthalten fast immer Bestellnummer oder Klarnamen.
// Diese Indizien werden jetzt automatisch mitgegeben, damit die mehrstufige
// Suche (E-Mail -> Tippfehler -> Bestellnr. -> Sendungsnr. -> Name -> Signatur)
// auch im Panel greift, nicht nur in Barbaras Pipeline.
function shopifyHintsFuer(email) {
  try {
    const passend = readInbound().filter((t) => String(t.customer_email || '').toLowerCase() === String(email || '').toLowerCase())
    if (!passend.length) return {}
    const t = passend.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')))[0]
    const ein = (t.messages || []).filter((m) => m.direction === 'in' && !m.is_context)
    // NEUESTE ZUERST (15.08., Fall #1750 Kundin K): Die juengste Kundenmail
    // traegt fast immer die entscheidende Info, z. B. die nachgereichte Bestell-
    // nummer. Vorher wurde chronologisch gejoint und auf 3000 Zeichen gekappt -
    // eine lange zitierte Werbe-Mail in der ERSTEN Nachricht hat dann die
    // Bestellnummer aus der NEUESTEN Nachricht abgeschnitten, und die Suche
    // fiel faelschlich auf das leere Newsletter-Profil zurueck.
    const text = `${t.subject || ''}\n${ein.slice().reverse().map((m) => m.body_text || '').join('\n')}`.slice(0, 3000)
    return { name: t.customer_name || undefined, text }
  } catch { return {} }
}

app.get('/api/shopify/context', async (req, res) => {
  const email = req.query.email
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich.' })
  try {
    const ctx = await fetchShopifyContext(String(email), shopifyHintsFuer(email))
    if (!ctx) return res.status(400).json({ error: 'Shopify nicht verbunden.' })
    res.json(ctx)
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// POST-Variante mit allen Zuordnungs-Indizien (Name + Mail-Text für Bestellnr.-Suche)
app.post('/api/shopify/context', async (req, res) => {
  const { email, name, text } = req.body || {}
  if (!email) return res.status(400).json({ error: 'E-Mail erforderlich.' })
  try {
    const ctx = await fetchShopifyContext(String(email), { name, text: String(text || '').slice(0, 3000) })
    if (!ctx) return res.status(400).json({ error: 'Shopify nicht verbunden.' })
    res.json(ctx)
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// ---- DHL live tracking (Shipment Tracking - Unified API) --------------------
// RETOUREN-INDIKATOREN (26.08. geschaerft): "zurückgesandt"/"rückgeführt"
// matchten vorher NICHT (/rücksend/ deckt "zurückgesandt" nicht ab) - genau
// solche Sendungen standen dann faelschlich als "zugestellt" im Tool, obwohl
// die Zustellung AN UNS (Absender) ging, nicht an die Kundin. Gilt jetzt fuer
// ALLE Carrier (DHL/AT/CH), deutsch + englisch.
const RETOUR_RE = /r(ü|ue)cksend|r(ü|ue)ckgesand|zur(ü|ue)ckgesand|zur(ü|ue)ckgeschickt|r(ü|ue)ckf(ü|ue)hr|zur(ü|ue)ck (zum|an den) absender|an den absender|urspr(ü|ue)nglichen absender|retoure|retourniert|annahme verweigert|return(ed)? to (the )?sender|return shipment|being returned|parcel (is |was )?returned/i
// Deterministische EN-Texte fuer Carrier ohne englische API (post.at) bzw. als
// Fallback - bewusst OHNE KI-Aufruf (Kostenregel), geschlossene Phrasen-Map.
const TRACK_PHRASEN_EN = [
  [/abholstation|abholbereit|zur abholung/i, 'Ready for pickup at a pickup point'],
  [/wurde (erfolgreich )?zugestellt|zustellung erfolgt/i, 'The parcel has been delivered'],
  [/wird zugestellt|in zustellung|beim zusteller|zustellfahrzeug|f(ü|ue)r die zustellung/i, 'Out for delivery'],
  [/(ü|ue)bernommen|aufgegeben|elektronisch angek(ü|ue)ndigt|avisiert|daten (ü|ue)bermittelt/i, 'Announced / handed over to the carrier'],
  [/verlassen/i, 'Has left the parcel center'],
  [/logistikzentrum|verteilzentrum|paketzentrum|briefzentrum|sortier/i, 'At the parcel center - moving through the network'],
  [/grenz|zoll/i, 'In customs / border processing'],
  [/verz(ö|oe)ger/i, 'Delayed in transit'],
]
function trackTextEn(txt, statusCode) {
  if (statusCode === 'returned') return 'RETURN to sender - the customer did NOT receive this parcel'
  const t = String(txt || '')
  for (const [re, en] of TRACK_PHRASEN_EN) if (re.test(t)) return en
  // Text schon englisch (DHL/CH mit language=en)? Dann unveraendert lassen.
  if (t && !/[äöüß]|zustell|sendung|paket|empf(ä|ae)nger/i.test(t)) return t
  return statusCode === 'delivered' ? 'The parcel has been delivered' : 'In transit'
}
async function dhlTrackNumber(number, lang) {
  const key = process.env.DHL_API_KEY
  if (!key || !number) return null
  const r = await fetch(`https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(String(number))}&language=${lang === 'en' ? 'en' : 'de'}`, {
    headers: { 'DHL-API-Key': key, Accept: 'application/json' },
  })
  if (!r.ok) return null
  const data = await r.json()
  const sh = data.shipments?.[0]
  if (!sh) return null
  const ev = sh.status || sh.events?.[0] || null
  // RETOURE ERKENNEN: Bei Rücksendungen meldet die DHL-API das finale Event als
  // "delivered" — gemeint ist aber die Zustellung AN DEN ABSENDER (an uns!), nicht
  // an die Kundin. Ohne diese Prüfung behauptet Barbara der Kundin fälschlich, ihr
  // Paket sei zugestellt (passiert bei Kundin H #1222). Deshalb: kompletten
  // Event-Verlauf auf Rücksendungs-Indikatoren scannen und dann 'returned' melden.
  const evBlob = [ev?.description, ...(sh.events || []).map((e) => e?.description)].filter(Boolean).join(' ')
  const returned = RETOUR_RE.test(evBlob)
  return {
    found: true,
    status: returned ? 'returned' : (ev?.status || ev?.statusCode || null),
    statusCode: returned ? 'returned' : (ev?.statusCode || null),
    description: returned
      ? (lang === 'en'
        ? `RETURN to sender - the customer did NOT receive this parcel (${ev?.description || ''})`.trim()
        : `RÜCKSENDUNG an Absender — Kundin hat das Paket NICHT erhalten (${ev?.description || ''})`.trim())
      : (lang === 'en' ? trackTextEn(ev?.description, ev?.statusCode || null) : (ev?.description || null)),
    location: ev?.location?.address?.addressLocality || null,
    timestamp: ev?.timestamp || null,
    estimatedDelivery: sh.estimatedTimeOfDelivery || null,
  }
}

// ---- Österreichische Post live tracking (öffentliche GraphQL-API, kein Key) --
async function postAtTrackNumber(number, lang) {
  if (!number) return null
  const r = await fetch('https://api.post.at/sendungen/sv/graphqlPublic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://www.post.at', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({
      query: `{ einzelsendung(sendungsnummer: ${JSON.stringify(String(number))}) { status estimatedDeliveryDateText sendungsEvents { timestamp text eventPlaceName } } }`,
    }),
  })
  if (!r.ok) return null
  const data = await r.json()
  const s = data?.data?.einzelsendung
  if (!s || (!s.status && !(s.sendungsEvents || []).length)) return null
  const ev = (s.sendungsEvents || [])[s.sendungsEvents.length - 1] || null
  // Retoure: post.at meldet auch Ruecksendungen am Ende als zugestellt ("ZU") -
  // zugestellt an den ABSENDER. Kompletten Event-Verlauf scannen.
  const atBlob = (s.sendungsEvents || []).map((e) => e?.text || '').join(' ')
  const atReturned = RETOUR_RE.test(atBlob)
  const atCode = atReturned ? 'returned' : (s.status === 'ZU' ? 'delivered' : 'transit')
  return {
    found: true,
    status: atReturned ? 'returned' : (s.status || null),
    statusCode: atCode,
    description: lang === 'en'
      ? trackTextEn(ev?.text, atCode)
      : (atReturned ? `RÜCKSENDUNG an Absender — Kundin hat das Paket NICHT erhalten (${ev?.text || ''})`.trim() : (ev?.text || null)),
    location: ev?.eventPlaceName || null,
    timestamp: ev?.timestamp || null,
    estimatedDelivery: (s.estimatedDeliveryDateText || '').replace(/\*\*/g, '').trim() || null,
  }
}

// ---- Schweizer Post live tracking (öffentliche ekp-web-API, kein Key) --------
// CH-Sendungen laufen über die Schweizer Post (S10-Format: 2 Buchstaben +
// 9 Ziffern + "CH", z.B. LW000000000CH; oder inländisch 99.xx.xxxxxx.xxxxxxxx).
async function swissPostTrackNumber(number, lang) {
  if (!number) return null
  const r = await fetch(`https://service.post.ch/ekp-web/api/history?trackingId=${encodeURIComponent(String(number))}`, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0', 'Accept-Language': lang === 'en' ? 'en' : 'de-CH' },
  }).catch(() => null)
  if (!r || !r.ok) return null
  const data = await r.json().catch(() => null)
  // Antwort ist ein Array von Sendungen bzw. Events; leeres Array = keine Historie
  const entry = Array.isArray(data) ? data[0] : data
  const events = entry?.events || entry?.history || (Array.isArray(data) && data[0]?.timestamp ? data : null)
  if (!events || !events.length) return null
  const ev = events[0] // Schweizer Post liefert neuestes Event zuerst
  const txt = ev.description || ev.text || ev.eventText || null
  const chBlob = events.map((e) => String(e?.description || e?.text || e?.eventText || '') + ' ' + String(e?.status || '')).join(' ')
  const chReturned = RETOUR_RE.test(chBlob)
  const delivered = /zugestellt|delivered|abgeholt/i.test(String(txt || '') + String(ev.status || ''))
  const chCode = chReturned ? 'returned' : (delivered ? 'delivered' : 'transit')
  return {
    found: true,
    status: chReturned ? 'returned' : (ev.status || (delivered ? 'delivered' : 'transit')),
    statusCode: chCode,
    description: lang === 'en'
      ? trackTextEn(txt, chCode)
      : (chReturned ? `RÜCKSENDUNG an Absender — Kundin hat das Paket NICHT erhalten (${txt || ''})`.trim() : txt),
    location: ev.city || ev.location || ev.zip || null,
    timestamp: ev.timestamp || ev.date || null,
    estimatedDelivery: entry?.estimatedDelivery || null,
  }
}

// Carrier-Erkennung nach Nummern-Format + Shopify-URL (zuverlässiger als das
// Zielland): DE → DHL (00…, 20-stellig), AT → Österreichische Post (10…,
// 22-stellig), CH → Schweizer Post (S10-Format ..CH oder 99.xx…-Inlandsformat).
function detectCarrier(number, urlHint) {
  const u = String(urlHint || '').toLowerCase()
  if (u.includes('post.at')) return 'post-at'
  if (u.includes('post.ch')) return 'swiss-post'
  const n = String(number || '').trim()
  if (/^[A-Za-z]{2}\d{9}CH$/i.test(n)) return 'swiss-post'   // UPU S10 mit CH-Suffix
  if (/^99\.\d{2}\.\d{6}\.\d{8}$/.test(n)) return 'swiss-post' // CH-Inlandsformat
  if (/^9[89]\d{16}$/.test(n)) return 'swiss-post'           // CH-Inlandsformat ohne Punkte, 18-stellig (98…/99…)
  if (/^10\d{20}$/.test(n)) return 'post-at'                 // AT-Post, 22-stellig
  if (/^00\d{18}$/.test(n)) return 'dhl'                     // DHL Paket, 20-stellig (003…)
  if (/^JJD\d+$/i.test(n)) return 'dhl'                      // DHL JJD-Format
  if (/^YT\d{10,}$/i.test(n)) return 'yunexpress'            // YunExpress
  // Eine dhl.de-URL von Shopify zählt nur, wenn das Nummernformat nicht dagegen
  // spricht — Shopify trägt oft pauschal "DHL" ein, auch bei Fremdcarriern.
  if (u.includes('dhl') && /^00\d{18}$/.test(n)) return 'dhl'
  return 'unknown'
}

const CARRIER_META = {
  'dhl': { name: 'DHL', link: (n) => `https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=${n}` },
  'post-at': { name: 'Österreichische Post', link: (n) => `https://www.post.at/s/sendungsdetails?snr=${n}` },
  'swiss-post': { name: 'Schweizerische Post', link: (n) => `https://www.post.ch/de/sendungen-empfangen/sendungen-verfolgen?formattedParcelCodes=${n}` },
  // parcelsapp statt 17track: sauberer Deep-Link im Pfad (17track übernimmt die
  // Nummer aus dem #hash nicht zuverlässig und zeigt dann eine Demo-Sendung).
  'yunexpress': { name: 'YunExpress', link: (n) => `https://parcelsapp.com/de/tracking/${n}` },
  // Universal-Tracker für alles, was keinem eindeutigen Format entspricht
  // (DPD/Hermes/GLS/Warenpost/Partner): erkennt den Carrier selbst, statt die
  // Kundin auf eine falsche DHL-Seite zu schicken.
  'unknown': { name: 'Sendungsverfolgung', link: (n) => `https://parcelsapp.com/de/tracking/${n}` },
}

// Einheitliches Tracking über alle Carrier; probiert zuerst den erkannten
// Carrier, dann die anderen als Fallback (falls die Nummer dort unbekannt ist).
async function trackShipment(number, urlHint, lang) {
  const fns = { 'dhl': dhlTrackNumber, 'post-at': postAtTrackNumber, 'swiss-post': swissPostTrackNumber }
  const primary = detectCarrier(number, urlHint)
  // Für Carrier ohne eigene Live-API (yunexpress/unknown) trotzdem die vorhandenen
  // Dienste durchprobieren — liefert einer echte Daten, nehmen wir sie.
  const order = [primary, ...Object.keys(fns).filter((c) => c !== primary)].filter((c) => fns[c])
  for (const carrier of order) {
    const st = await fns[carrier](number, lang).catch(() => null)
    if (st?.found) return { ...st, carrier, carrierName: CARRIER_META[carrier].name, trackingLink: CARRIER_META[carrier].link(number) }
  }
  // Kein Live-Status auffindbar → wenigstens den korrekten Carrier + Link liefern,
  // damit Barbara den richtigen Verfolgungslink einbetten kann.
  return { found: false, carrier: primary, carrierName: CARRIER_META[primary].name, trackingLink: CARRIER_META[primary].link(number) }
}

// Bild-/Datei-Upload aus dem Composer (Base64) — landet im Anhang-Ordner
app.post('/api/upload', (req, res) => {
  try {
    const { filename, content_type, data } = req.body || {}
    if (!data) return res.status(400).json({ error: 'data (Base64) erforderlich.' })
    const buf = Buffer.from(String(data).replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Datei zu groß (max. 15 MB).' })
    const safe = String(filename || 'bild').replace(/[^\w.\-äöüÄÖÜß ]+/g, '_').slice(0, 80) || 'bild'
    const fname = `up-${Date.now()}-${safe}`
    fs.writeFileSync(path.join(ATT_DIR, fname), buf)
    res.json({ ok: true, fname, filename: safe, content_type: content_type || 'application/octet-stream', size: buf.length, url: `/api/attachments/${encodeURIComponent(fname)}` })
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// Anhänge ausliefern (Dateiname wird gegen Pfad-Tricks abgesichert)
app.get('/api/attachments/:file', (req, res) => {
  const f = path.basename(decodeURIComponent(req.params.file))
  const p = path.join(ATT_DIR, f)
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Anhang nicht gefunden.' })
  res.sendFile(p)
})

app.get('/api/dhl/track', async (req, res) => {
  const number = req.query.number
  if (!number) return res.status(400).json({ error: 'Trackingnummer erforderlich.' })
  try {
    const st = await trackShipment(number, req.query.url, req.user && req.user.uiLang === 'en' ? 'en' : 'de')
    res.json(st || { found: false })
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) })
  }
})

// ---- inbound e-mail webhook (turns real incoming mail into a ticket) -------
app.post('/api/inbound/email', (req, res) => {
  const { from: rawFrom, from_name, subject, text } = req.body || {}
  if (!rawFrom || !text) return res.status(400).json({ error: 'from und text erforderlich.' })
  const realWh = extractRealCustomer(rawFrom, from_name, text)
  const from = realWh.email
  let store = []
  store = readInbound()
  if (threadIntoExisting(store, { email: from, subject, text, date: new Date().toISOString() })) {
    writeInbound(store)
    autoDraftNewRecords().catch(() => {})
    return res.json({ ok: true, threaded: true, ticket: store[0] })
  }
  const ticket = {
    id: Date.now(),
    ticket_number: nextTicketNumber(store),
    subject: subject || '(Kein Betreff)',
    customer_email: from,
    customer_name: realWh.name,
    channel: 'email',
    status: 'open',
    received_at: new Date().toISOString(),
    body_text: text,
  }
  store.unshift(ensureMessages(ticket))
  writeInbound(store)
  autoDraftNewRecords().catch(() => {})
  res.json({ ok: true, ticket })
})

// AUSLIEFER-STATUS (Samuel, 11.08.): Ein Ticket, bei dem WIR zuletzt geantwortet
// haben, darf NIE als offen im Posteingang erscheinen — auch nicht in dem kurzen
// Fenster, in dem ein Versand noch nicht persistiert ist oder ein paralleler
// Vorgang den Status kurz auf 'open' gesetzt hat. enforceFolderRules korrigiert
// das erst nach 60 s (mit 30-s-Puffer); DAS liess gesendete Mails wieder im
// Posteingang aufploppen. Hier wird bei JEDER Auslieferung sofort korrigiert.
// auto_ack (Eingangsbestaetigung) und interne Notizen zaehlen NICHT als Antwort,
// ein blosser Entwurf (ai_draft) ist keine gesendete Nachricht — solche Tickets
// bleiben korrekt offen.
function auslieferStatus(rec) {
  if (rec.is_spam) return rec.status
  if (!['open', 'new', 'pending'].includes(rec.status)) return rec.status
  const msgs = rec.messages || []
  const outs = msgs.filter((m) => m.direction !== 'in' && !m.is_internal_note && !m.auto_ack)
  if (!outs.length) return rec.status
  const lastOut = Math.max(...outs.map((m) => Date.parse(m.created_at || 0) || 0))
  const ins = msgs.filter((m) => m.direction === 'in')
  const lastIn = ins.length ? Math.max(...ins.map((m) => Date.parse(m.created_at || 0) || 0)) : 0
  return lastOut > lastIn ? 'answered' : rec.status
}

// SCHLANKE LISTE FUER DIE ERWEITERUNGSSCHICHT (14.08.): /api/inbound liefert
// alle 500 Tickets MIT vollstaendigen Verlaeufen, rund 2,8 MB. 89 Prozent davon
// sind Nachrichtentexte. Mein Overlay braucht davon nichts - es will nur wissen,
// welchen Status, Score und Hinweis ein Ticket hat. Es dafuer 2,8 MB auswerten
// zu lassen, hat den Browser lahmgelegt. Diese Route liefert dieselbe Information
// in rund einem Prozent der Groesse. Der Vertrag von /api/inbound bleibt dabei
// voellig unangetastet, das Frontend-Bundle merkt von dieser Route nichts.
// FLAG-UEBERSETZUNG (Samuel, 22.08.): Die roten action_required-Badges sind
// intern deutsch ("Achtung: X"). EN-Mitarbeiterinnen bekommen sie uebersetzt -
// deterministisch per Mapping (geschlossenes Set), ohne API-Kosten.
const FLAG_EN = {
  'Achtung: Rückerstattung': 'Alert: Refund',
  'Rückerstattung nötig': 'Refund needed',
  'Nachsendung nötig': 'Reshipment needed',
  'Achtung: Nachsendung': 'Alert: Reshipment',
  'Achtung: Nachforschung': 'Alert: Parcel investigation',
  'Achtung: Rechnung offen': 'Alert: Unpaid invoice',
  'Achtung: Jetzt versenden': 'Alert: Ship now',
  'Achtung: Klaviyo-Abmeldung': 'Alert: Klaviyo unsubscribe',
  'Achtung: Klaviyo-Merge': 'Alert: Klaviyo merge',
  'Achtung: Erst erstatten!': 'Alert: Refund first!',
  'Achtung: Adresse bestätigen': 'Alert: Confirm address',
}
function flagAufEnglisch(f) {
  if (!f) return f
  if (FLAG_EN[f]) return FLAG_EN[f]
  return String(f)
    .replace(/^Achtung:\s*/, 'Alert: ')
    .replace(/Rückerstattung/g, 'Refund')
    .replace(/Nachsendung/g, 'Reshipment')
    .replace(/Rücksendung/g, 'Return')
    .replace(/nötig/g, 'needed')
}

// SUCHE UEBER ALLES (30.08., Samuels Wunsch "auch nach alten Tickets suchen"):
// Die App-Suche im Bundle filtert nur die 500 geladenen Tickets und nur ueber
// Betreff, Name, E-Mail und Ticketnummer. Eine BESTELLNUMMER (#S10013) steht
// aber im Mailtext, nicht im Betreff - deshalb fand Samuel nichts, obwohl das
// Ticket existierte (#1439). Diese Route durchsucht Arbeitssatz UND Archiv und
// schaut dabei auch in jeden Nachrichtentext.
function suchTreffer(t, q) {
  const felder = [t.ticket_number, t.archiv_id, t.subject, t.customer_name, t.customer_email, t.body_text]
  for (const f of felder) if (String(f == null ? '' : f).toLowerCase().includes(q)) return true
  for (const m of t.messages || []) {
    if (m.auto_ack) continue
    if (String(m.body_text || '').toLowerCase().includes(q)) return true
  }
  if (String(t.ai_draft || '').toLowerCase().includes(q)) return true
  return false
}
function fundstelle(t, q) {
  // Kurzer Textausschnitt rund um den Fund, damit die Trefferliste zeigt WARUM
  // etwas passt (z.B. die Bestellnummer mitten im Mailtext).
  const quellen = [String(t.body_text || ''), ...(t.messages || []).filter((m) => !m.auto_ack).map((m) => String(m.body_text || '')), String(t.ai_draft || '')]
  for (const txt of quellen) {
    const i = txt.toLowerCase().indexOf(q)
    if (i < 0) continue
    const von = Math.max(0, i - 60)
    return (von > 0 ? '…' : '') + txt.slice(von, i + q.length + 90).replace(/\s+/g, ' ').trim() + '…'
  }
  return String(t.subject || '')
}
app.get('/api/suche', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^#/, '')
  if (q.length < 2) return res.json({ treffer: [], gesamt: 0, hinweis: 'Mindestens 2 Zeichen.' })
  const limit = Math.min(Number(req.query.limit) || 60, 200)
  const enUser = !!(req.user && req.user.uiLang === 'en')
  const arbeit = readInbound()
  const imArbeitssatz = new Set(arbeit.map((t) => String(t.ticket_number)))
  const archiv = readArchiv().filter((t) => !imArbeitssatz.has(String(t.ticket_number)))
  const treffer = []
  for (const [liste, archiviert] of [[arbeit, false], [archiv, true]]) {
    for (const t of liste) {
      if (!suchTreffer(t, q)) continue
      treffer.push({
        ticket_number: t.ticket_number || null,
        // Aus dem Postfach nachgeholte Mails haben keine Ticketnummer mehr
        // (die Zuordnung ging beim Loeschen verloren, Raten waere gefaehrlich).
        // Sie werden ueber archiv_id geoeffnet und als "Archivmail" angezeigt.
        archiv_id: t.archiv_id || null,
        id: t.id,
        subject: (enUser && t._en && t._en.subject) ? t._en.subject : (t.subject || '(Kein Betreff)'),
        customer_name: t.customer_name || null,
        customer_email: t.customer_email || null,
        received_at: t.received_at || null,
        status: auslieferStatus(t),
        is_spam: !!t.is_spam,
        archiviert,
        fundstelle: fundstelle(t, q).slice(0, 200),
      })
    }
  }
  treffer.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')))
  res.json({ treffer: treffer.slice(0, limit), gesamt: treffer.length, durchsucht: arbeit.length + archiv.length })
})

// Ein archiviertes Ticket vollstaendig ausliefern (Leseansicht im Overlay).
app.get('/api/archiv/:nr', (req, res) => {
  const nr = String(req.params.nr)
  const t = readArchiv().find((x) => String(x.ticket_number) === nr || String(x.archiv_id) === nr)
  if (!t) return res.status(404).json({ error: 'Nicht im Archiv.' })
  const { _en, ...rest } = t
  res.json({ ticket: { ...rest, messages: (rest.messages || []).filter((m) => !m.auto_ack) } })
})

app.get('/api/inbound/kurz', (req, res) => {
  const enUser = !!(req.user && req.user.uiLang === 'en')
  const store = readInbound()
  res.json({
    tickets: store.map((t) => ({
      id: t.id,
      ticket_number: t.ticket_number,
      status: auslieferStatus(t),
      is_spam: !!t.is_spam,
      imap_uid: t.imap_uid || null,
      manual_draft: !!t.manual_draft,
      hat_entwurf: !!String(t.ai_draft || '').trim(),
      ai_confidence: typeof t.ai_confidence === 'number' ? t.ai_confidence : null,
      action_required: enUser ? (flagAufEnglisch(t.action_required) || null) : (t.action_required || null),
      reaction: t.reaction ? t.reaction.wert : null,
      reaction_at: t.reaction ? (t.reaction.at || null) : null,
      snooze_until: (t.snooze_until && t.snooze_until > new Date().toISOString()) ? t.snooze_until : null,
      customer_name: t.customer_name || null,
      subject: (enUser && t._en && t._en.subject) ? t._en.subject : (t.subject || null),
    })),
  })
})

app.get('/api/inbound', async (req, res) => {
  let store = []
  store = readInbound()
  // ON-DEMAND UEBERSETZUNG (Samuel, 21.08.): Wenn ein en-User anfragt, holen
  // wir fuer sichtbare Tickets ohne Uebersetzung SOFORT die Uebersetzung
  // (max 12 pro Request, damit die Antwort nicht traege wird). Damit sieht
  // Mitarbeiterin C nie wieder deutsche Betreffe/Bodies, wenn sie ein Ticket oeffnet.
  // NICHT-BLOCKIEREND (korrigiert 22.08.): Die erste Fassung wartete die
  // Uebersetzungen IM Request ab - bei 10+ fehlenden Tickets lief Mitarbeiterin Cs
  // /api/inbound in den 30s-Timeout und das ganze Tool wirkte tot. Jetzt:
  // Antwort geht sofort raus (mit dem was uebersetzt ist), die fehlenden
  // Uebersetzungen laufen im Hintergrund und sind beim naechsten 4s-Poll da.
  if (req.user && req.user.uiLang === 'en' && secrets.ai && Date.now() > (globalThis.__i18nPauseBis || 0)) {
    setImmediate(() => translateInboxBatch(12).catch((e) => {
      console.log('[i18n on-demand]', String(e && e.message || e).slice(0, 80))
      globalThis.__i18nPauseBis = Date.now() + 5 * 60_000
    }))
  }
  // Arbeitet die angemeldete Person auf Englisch, wird die bereits beim Eingang
  // erzeugte Uebersetzung ausgeliefert. Fehlt sie noch, kommt das Original und
  // die Uebersetzung laeuft im Hintergrund nach.
  // VERTRAG MIT DEM BUNDLE: Das Frontend destrukturiert `const{tickets}=...` —
  // die Antwort MUSS also { tickets: [...] } sein. Form nie wieder ändern!
  // _en (interner Übersetzungscache) wird nie mitgeschickt: spart ~20% Payload.
  const lang = req.user && req.user.uiLang === 'en' ? 'en' : 'de'
  // _en (interner Übersetzungscache) und automatische Eingangsbestätigungen
  // (auto_ack) werden nicht mit ausgeliefert: Die Bestätigungen gehen zwar raus
  // und bleiben in der Datei, würden aber jeden Ticket-Verlauf zumüllen.
  // Für Nicht-Admins zusätzlich: sentBy/sentByName entfernen — Samuels Name
  // darf im Mitarbeiter-Tool nirgends auftauchen, auch nicht im Payload.
  const isAdmin = req.user && req.user.role === 'admin'
  const adminIds = new Set(readUsers().filter((u) => u.role === 'admin').map((u) => String(u.id)))
  const strip = ({ _en, ...rest }) => ({
    ...rest,
    // Beantwortete Tickets nie als offen ausliefern (siehe auslieferStatus).
    status: auslieferStatus(rest),
    // Grußformel beim Ausliefern an die AKTUELLE Tageszeit anpassen (05.08.):
    // Ein gestern Abend erzeugter Entwurf sagte morgens um 8:50 immer noch
    // "Guten Abend". Der gespeicherte Text bleibt unberührt, nur die Anzeige
    // wird frisch gerechnet — so stimmt die Anrede immer beim Öffnen.
    ...(String(rest.ai_draft || '').trim() ? { ai_draft: refreshGreeting(rest.ai_draft) } : {}),
    ...(Array.isArray(rest.messages) ? {
      messages: rest.messages.filter((m) => !m.auto_ack).map((m) => {
        if (isAdmin) return m
        // ABSENDER-KENNUNG (22.09.2026, Mitarbeiterin As Frage "how will I know if
        // Mitarbeiterin B responded or I responded"): Mitarbeiterinnen bekommen den
        // Namen der Kollegin mit. Samuels Name bleibt draussen: Sendungen von
        // Admins erscheinen als "Team".
        const { sentBy, sentByName, ...mm } = m
        if (m.direction === 'out' && !m.is_internal_note) {
          const wer = String(sentByName || '')
          const admin = sentBy && adminIds.has(String(sentBy))
          mm.gesendetVon = admin ? 'Team' : (wer || null)
        }
        return mm
      }),
    } : {}),
  })
  // NUR SCHICKEN, WAS SICH GEAENDERT HAT (16.09.2026)
  // Mitarbeiterin As Browser lud alle 4 Sekunden 1,2 MB (bereits gzip-komprimiert)
  // herunter, rund 18 MB pro Minute, auf einer Leitung in Manila. Das war ihr
  // "delay due to refreshing". Jetzt bekommt jede Antwort einen Fingerabdruck
  // ueber genau den Text, der rausgeht. Schickt der Browser denselben zurueck,
  // antworten wir mit 304 und ein paar hundert Byte statt mit allem.
  //
  // WARUM DAS NICHT DER ALTE 304-FEHLER IST (damals tauchten gesendete Mails
  // wieder im Posteingang auf): Der Fingerabdruck wird aus dem FERTIGEN Text
  // gebildet, nicht aus einem Zeitstempel. Ein 304 ist also nur moeglich, wenn
  // die Antwort Byte fuer Byte dieselbe waere. Aendert sich irgendetwas an
  // irgendeinem Ticket, aendert sich der Fingerabdruck. Veraltete Daten sind
  // dadurch ausgeschlossen. Deshalb bleibt etag global aus und steht nur hier.
  const sendeWennGeaendert = (nutzlast) => {
    const text = JSON.stringify(nutzlast)
    const fp = '"' + crypto.createHash('sha1').update(text).digest('base64') + '"'
    const nackt = (v) => String(v || '').replace(/^W\//, '').trim()
    res.set('Cache-Control', 'no-cache')   // immer nachfragen, nie blind aus dem Cache
    res.set('ETag', fp)
    if (nackt(req.headers['if-none-match']) === nackt(fp)) return res.status(304).end()
    return res.type('application/json; charset=utf-8').send(text)
  }
  if (lang === 'en') {
    translateInboxBatch(6).catch(() => {})
    return sendeWennGeaendert({ tickets: store.map((t) => strip(viewTicket(t, 'en'))) })
  }
  return sendeWennGeaendert({ tickets: store.map(strip) })
})

// Feedback-Lektionen: pro Fall gelerntes Wissen (fließt in jede Barbara-Antwort ein).
app.get('/api/lessons', (_req, res) => res.json({ lessons: readLessons() }))
app.post('/api/lessons', (req, res) => {
  const { text, tags } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text erforderlich.' })
  const list = readLessons()
  const lesson = { id: Date.now(), text: String(text).slice(0, 1000), tags: Array.isArray(tags) ? tags.slice(0, 6) : [], created_at: new Date().toISOString() }
  list.unshift(lesson)
  writeLessons(list.slice(0, 200))
  res.json({ ok: true, lesson })
})
app.delete('/api/lessons/:id', (req, res) => {
  const list = readLessons().filter((l) => String(l.id) !== String(req.params.id))
  writeLessons(list)
  res.json({ ok: true })
})

// ── Vorlagen (Templates): wiederverwendbare Antwort-Bausteine ────────────────
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json')
const DEFAULT_TEMPLATES = [
  { id: 1, title: 'Adresse ungültig — korrekte Adresse anfragen', text: 'Hallo {Vorname},\n\nhier ist Barbara vom Leichtkraut-Team. Bei der Bearbeitung Ihrer Bestellung {Bestellnummer} ist uns aufgefallen, dass die hinterlegte Lieferadresse leider ungültig bzw. unvollständig ist.\n\nDamit Ihr Paket Sie sicher erreicht, benötigen wir einmal Ihre korrekte Lieferadresse:\n- Vor- und Nachname\n- Straße + Hausnummer\n- Postleitzahl und Ort\n\nAntworten Sie einfach direkt auf diese E-Mail — ich kümmere mich dann sofort persönlich darum. 🌿' },
  { id: 2, title: 'Rücksendung — Grund & Zustand erfragen', text: 'Liebe {Vorname},\n\nvielen Dank für Ihre Nachricht — natürlich helfe ich Ihnen gern weiter.\n\nDamit ich alles richtig für Sie vorbereiten kann, zwei kurze Fragen:\n1. Was ist der Grund für die Rücksendung? (Falls die Tropfen noch nicht wie erhofft gewirkt haben, habe ich vielleicht noch einen Tipp für Sie.)\n2. Ist die Sendung noch ungeöffnet und originalversiegelt?\n\nSobald ich das weiß, bekommen Sie umgehend alle Infos von mir. 💚' },
  { id: 3, title: 'Wo ist mein Paket? — mit Tracking', text: 'Liebe {Vorname},\n\nvielen Dank für Ihre Geduld — ich habe direkt für Sie nachgeschaut:\n\nIhre Bestellung {Bestellnummer} ist unterwegs. Den aktuellen Stand können Sie hier live verfolgen: {Trackinglink}\n\nFalls sich in den nächsten 2–3 Werktagen nichts tut, melden Sie sich gern direkt bei mir — dann hake ich persönlich beim Versanddienstleister nach.' },
  { id: 4, title: 'Wirkung noch nicht spürbar — Routine-Tipps', text: 'Liebe {Vorname},\n\ndanke für Ihre ehrliche Rückmeldung — und ich verstehe gut, dass Sie sich schneller etwas erhofft hatten. Jeder Körper nimmt die Kräuter unterschiedlich auf; die 4–6 Wochen, die wir oft nennen, sind ein Durchschnitt, keine feste Regel.\n\nDamit Ihr Körper bestmöglich mitzieht, haben sich drei kleine Routinen bewährt:\n- Die Tropfen täglich zur gleichen Zeit nehmen (z. B. morgens, direkt vor dem ersten großen Glas Wasser)\n- Täglich 20 Minuten spazieren — die Wadenmuskulatur ist die Pumpe der Lymphe\n- Abends 90 Sekunden die Beine an die Wand + Fußgelenke kreisen\n\nSchreiben Sie mir gern in einer Woche, wie es sich anfühlt — ich lese jede Mail selbst. 💚' },
]
function readTemplates() {
  try { return JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')) } catch {
    fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(DEFAULT_TEMPLATES, null, 2))
    return DEFAULT_TEMPLATES
  }
}
app.get('/api/templates', (_req, res) => res.json({ templates: readTemplates() }))
app.post('/api/templates', (req, res) => {
  const { title, text } = req.body || {}
  if (!title || !text) return res.status(400).json({ error: 'title und text erforderlich.' })
  const list = readTemplates()
  const tpl = { id: Date.now(), title: String(title).slice(0, 80), text: String(text).slice(0, 4000) }
  list.unshift(tpl)
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(list.slice(0, 100), null, 2))
  res.json({ ok: true, template: tpl })
})
app.delete('/api/templates/:id', (req, res) => {
  const list = readTemplates().filter((t) => String(t.id) !== String(req.params.id))
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(list, null, 2))
  res.json({ ok: true })
})

// Neue E-Mail verfassen (ohne eingehende Mail) — landet als Entwurf im Tool.
// BCC (19.09.2026, Samuel): Im Fenster "New email" gibt es ein BCC-Feld.
// Die Adresse wird am Ticket gespeichert und beim Senden mitgeschickt, danach
// wieder entfernt (gilt fuer genau eine Mail). Admins duerfen jede Adresse
// eintragen, alle anderen nur die Trustpilot-Einladungsadresse - damit ueber
// diesen Weg niemand Kundenmails heimlich an Dritte weiterleiten kann.
function bccPruefen(roh, user) {
  const bcc = String(roh || '').trim()
  if (!bcc) return { ok: true, bcc: '' }
  if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(bcc)) return { ok: false, error: 'BCC ist keine gueltige E-Mail-Adresse.' }
  const admin = user && user.role === 'admin'
  if (!admin && !/@invite\.trustpilot\.com$/i.test(bcc)) return { ok: false, error: 'BCC ist nur fuer die Trustpilot-Einladungsadresse erlaubt.' }
  return { ok: true, bcc }
}

app.post('/api/compose', (req, res) => {
  const { to, name, subject, text, context } = req.body || {}
  if (!to || !subject) return res.status(400).json({ error: 'to und subject erforderlich.' })
  const bccCheck = bccPruefen((req.body || {}).bcc, req.user)
  if (!bccCheck.ok) return res.status(400).json({ error: bccCheck.error })
  let store = []
  store = readInbound()
  // BUG 1 (08.08.): Compose-Tickets hatten gar keine imap_uid. Dadurch griff die
  // Ordner-Regel R2 nicht ("Kundenantwort auf Compose → Posteingang") und eine
  // Antwort der Kundin wäre nicht sauber im Posteingang gelandet.
  const uid = 'compose:' + Date.now()
  // BUG 2 (08.08., Samuel): Ein Compose-Ticket zeigte im Verlauf gar nichts an,
  // weil es keine Nachrichten hatte. Samuel sah eine Mail ohne jeden Kontext und
  // konnte nicht erkennen, warum sie existiert. Deshalb wird der Auslöser jetzt
  // als erster sichtbarer Eintrag in den Verlauf geschrieben.
  const messages = []
  if (String(context || '').trim()) {
    messages.push({
      direction: 'in',
      body_text: String(context).slice(0, 8000),
      created_at: new Date().toISOString(),
      from_name: 'Anlass dieser Nachricht',
      is_context: true,
    })
  }
  const rec = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    ticket_number: nextTicketNumber(store),
    subject: String(subject).slice(0, 200),
    customer_email: String(to),
    customer_name: name || null,
    channel: 'email', status: 'draft',
    imap_uid: uid,
    received_at: new Date().toISOString(),
    body_text: '',
    messages,
    ai_draft: String(text || ''),
    ...(bccCheck.bcc ? { bcc: bccCheck.bcc } : {}),
  }
  store.unshift(rec)
  writeInbound(store)
  res.json({ ok: true, ticket: rec })
})

// Gesendete Antworten / Notizen im Gespräch persistieren (übersteht Reloads).

// ─────────────────────────────────────────────────────────────────────────────
// ÜBERSETZUNG FÜR MITARBEITENDE
// Der Mitarbeiter kann auf Englisch lesen und schreiben, die Kundin bekommt die
// Mail trotzdem in IHRER Sprache. Zwei Bausteine:
//   /api/translate  → übersetzt Text für die Anzeige im Tool
//   Beim Versand    → erkennt Sprachdifferenz und übersetzt automatisch zurück
// ─────────────────────────────────────────────────────────────────────────────
// BETREFF-SCHUTZ (02.10.2026): translateText machte aus kurzen Betreffzeilen
// regelmaessig eine komplett ERFUNDENE E-Mail ("Guten Morgen, deine Bestellung
// #S12345 ist endlich da ... TRK987654321 ... Hauptstrasse 42, 10115 Berlin ...
// support@example.com"). 369 Tickets hatten so einen aufgeblaehten Betreff,
// und beim Antworten ging er an die Kundin raus. Mindestens 29 Kundinnen haben
// auf solche Mails geantwortet (Fall Kundin F #5808). Deshalb:
// Betreffs nur noch ueber uebersetzeBetreff(), Ergebnis wird geprueft, und
// ausgehende Betreffs kommen aus dem Original-Ticket statt aus der Uebersetzung.
const BETREFF_MUELL = /#S12345\b|TRK987654321|example\.(com|org)|Hauptstra(ss|ß)e 42|\[(Sendungsnummer|Tracking-?Link|Bestellnummer)\]/i
function betreffSauber(roh) {
  let x = String(roh || '').replace(/\r/g, '').split('\n')[0]
  const cut = x.indexOf(' --- ')
  if (cut > 0) x = x.slice(0, cut)
  x = x.replace(/\s+/g, ' ').trim()
  if (BETREFF_MUELL.test(x) || x.length > 150) {
    const re = /^\s*((re|aw|wg|fwd?|antw)\s*:\s*)+/i.test(x)
    return (re ? 'Re: ' : '') + 'Ihre Nachricht an Leichtkraut'
  }
  return x
}
function betreffPlausibel(orig, neu) {
  const o = String(orig || ''), n = String(neu || '')
  if (!n.trim() || /\n/.test(n) || n.length > 150) return false
  if (n.length > Math.max(60, o.length * 1.8 + 30)) return false
  if (BETREFF_MUELL.test(n) && !BETREFF_MUELL.test(o)) return false
  return true
}
async function uebersetzeBetreff(subject, target) {
  const s = betreffSauber(subject)
  if (!s) return null
  const r = await translateText(s, target, 'WICHTIG: Das ist NUR eine einzelne E-Mail-Betreffzeile. Gib genau eine Zeile zurueck, nur die Uebersetzung dieser Zeile. Schreibe KEINE E-Mail, ergaenze nichts, erfinde keine Bestellnummern, Sendungsnummern, Adressen oder Kontaktdaten. "(Ticket #1234)" unveraendert lassen.').catch(() => null)
  return betreffPlausibel(s, r) ? String(r).trim() : null
}

async function translateText(text, targetLang, hint) {
  // SICHERUNG (22.08.): Nach einem API-Fehler 5 Minuten lang gar nicht erst
  // versuchen - sonst hämmern Batch + On-Demand eine tote API und bremsen alles.
  if (Date.now() < (globalThis.__i18nPauseBis || 0)) throw new Error('i18n pausiert (API-Fehler, Schutzschalter aktiv)')
  const apiKey = secrets.ai
  if (!apiKey || !String(text || '').trim()) return null
  const names = { de: 'Deutsch', en: 'Englisch', fr: 'Französisch', it: 'Italienisch', es: 'Spanisch', nl: 'Niederländisch', tr: 'Türkisch', ar: 'Arabisch', pl: 'Polnisch' }
  const target = names[targetLang] || targetLang
  const r = await aiFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      temperature: 0,
      system: `Du bist ein Fachübersetzer für Kundenservice-E-Mails. Übersetze den Text vollständig und natürlich nach ${target}.
REGELN:
- Gib AUSSCHLIESSLICH die Übersetzung zurück, keine Einleitung, keine Anführungszeichen, keine Erklärung.
- Behalte Absätze, Zeilenumbrüche, Aufzählungen und Markdown-Links [Text](URL) exakt bei.
- Übersetze NICHT: Bestellnummern (#S…), Sendungsnummern, URLs, E-Mail-Adressen, Eigennamen, Produktnamen (Leichtkraut), Beträge und Zahlen.
- Der Name der Absenderin ("Barbara") und der Firmenname bleiben unverändert.
- Ton beibehalten: warm, persönlich, höflich. Anreden und Grußformeln idiomatisch übertragen (z. B. "Guten Morgen, liebe Anna" → "Good morning, dear Anna").${hint ? '\n- ' + hint : ''}`,
      messages: [{ role: 'user', content: String(text).slice(0, 12000) }],
    }),
  })
  if (!r.ok) { globalThis.__i18nPauseBis = Date.now() + 5 * 60_000; throw new Error(`Übersetzung fehlgeschlagen (${r.status})`) }
  const data = await r.json()
  const out = (data.content || []).map((c) => c.text || '').join('').trim() || null
  // SCHUTZ (31.07.): Das Modell antwortet bei dünnem Input manchmal mit Meta-Text
  // ("I'm ready to translate... but I don't see the email") statt zu übersetzen.
  // Solche Antworten wurden als Übersetzung gecacht und standen dann als BETREFF
  // im Tool. Meta-Antworten erkennen -> null zurück -> Original bleibt stehen.
  if (out && isMetaTranslationReply(out)) {
    console.log('[i18n] Meta-Antwort verworfen fuer Input:', String(text).slice(0, 50))
    return null
  }
  return out
}

function isMetaTranslationReply(s) {
  const t = String(s || '')
  return /i('|’)?m ready to translate|i don('|’)?t see (the|an|any)|please provide (the|me)|i only see|there (is|was) no (text|content|email)|no (email|text|message) (content|body|provided)|i need the (text|email|content)|could you (please )?(provide|share)|ich sehe kein|bitte (stelle|geben Sie).*(text|inhalt)|kein text zum übersetzen/i.test(t)
}

// Sprache eines Textes bestimmen (leichtgewichtig, ohne API-Aufruf)
function guessLang(text) {
  const t = String(text || '').toLowerCase()
  if (!t.trim()) return null
  if (/[؀-ۿ]/.test(t)) return 'ar'
  if (/[一-鿿]/.test(t)) return 'zh'
  const score = (words) => words.reduce((a, w) => a + (new RegExp(`\\b${w}\\b`, 'g').test(t) ? 1 : 0), 0)
  const de = score(['und', 'ich', 'nicht', 'ist', 'die', 'der', 'mit', 'für', 'sie', 'wir', 'bitte', 'sehr', 'schönen', 'liebe', 'guten', 'bestellung', 'wurde', 'haben'])
  const en = score(['and', 'the', 'you', 'your', 'we', 'is', 'not', 'please', 'order', 'have', 'with', 'for', 'dear', 'kind', 'regards', 'best', 'thanks'])
  const fr = score(['bonjour', 'merci', 'votre', 'nous', 'commande', 'cordialement', 'vous'])
  const it = score(['grazie', 'ordine', 'saluti', 'vostro', 'buongiorno', 'cordiali'])
  const es = score(['hola', 'gracias', 'pedido', 'saludos', 'usted', 'nosotros'])
  const best = [['de', de], ['en', en], ['fr', fr], ['it', it], ['es', es]].sort((a, b) => b[1] - a[1])[0]
  return best[1] === 0 ? null : best[0]
}

// Sprache der Kundin aus ihren eingegangenen Nachrichten ableiten
function customerLang(rec) {
  const ins = (rec?.messages || []).filter((m) => m.direction === 'in' && !m.is_internal_note)
  for (let i = ins.length - 1; i >= 0; i--) {
    // Zitierte Verläufe abschneiden, sonst verfälschen alte Mails die Erkennung
    const body = String(ins[i].body_text || '').split(/\n\s*(?:>|Am .{0,40}schrieb|On .{0,40}wrote)/)[0]
    const l = guessLang(body)
    if (l) return l
  }
  return guessLang(rec?.body_text) || 'de'
}


// ─────────────────────────────────────────────────────────────────────────────
// ZWISCHENSTATION: Postfach-Inhalte für englischsprachige Mitarbeitende
// Prinzip: Übersetzt wird EINMAL beim Eingang (nicht bei jedem Aufruf) und im
// Ticket zwischengespeichert. Das Original bleibt immer erhalten — gesendet wird
// ausschließlich in der Sprache der Kundin.
// ─────────────────────────────────────────────────────────────────────────────
function shortHash(s) { return crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12) }

async function ensureEnglish(rec) {
  if (!secrets.ai || !rec) return false
  const src = String(rec.subject || '') + ' ' + String(rec.body_text || '')
  // KRISSA-BUG 26.08. ("inbox messages are in Dutch" = Deutsch): Bisher wurden
  // nur die letzten 12 Nachrichten uebersetzt UND en.msgs dabei jedes Mal neu
  // aufgebaut - aeltere, laengst uebersetzte Nachrichten flogen wieder raus.
  // In langen Verlaeufen (#1439: 26 Nachrichten) stand der Anfang des Threads
  // deshalb dauerhaft auf Deutsch. Jetzt: alle Nachrichten (Kappe 40), alte
  // Uebersetzungen IMMER behalten, Luecken auch bei unveraenderter sig fuellen.
  const msgs = (rec.messages || []).slice(-40)
  const sig = shortHash(src + (rec.messages || []).slice(-12).map((m) => m.created_at + (m.body_text || '').length).join('|') + (rec.ai_draft || '').length)
  const keyVon = (m) => shortHash((m.created_at || '') + (m.body_text || '').slice(0, 60))
  const vorhanden = (rec._en && rec._en.msgs) || {}
  const gleicheBasis = !!(rec._en && rec._en.sig === sig)
  const fehlt = msgs.some((m) => String(m.body_text || '').trim() && !vorhanden[keyVon(m)])
  if (gleicheBasis && !fehlt) return false
  // KOSTENBREMSE (29.08.): Bisher wurden Betreff/Body/Entwurf bei JEDER
  // sig-Aenderung neu uebersetzt - also z.B. nach jeder gesendeten Mail,
  // obwohl sich Betreff und Body gar nicht geaendert hatten (1012 Ticket-
  // Updates in 3 Tagen). Jetzt merkt sich _en.feld je Feld einen Hash des
  // Quelltexts: uebersetzt wird NUR, was sich wirklich geaendert hat.
  // Fehlschlaege (Meta-Antwort) speichern das Original als Endzustand,
  // englische/triviale Texte kosten gar keinen API-Call mehr.
  const alt = rec._en || {}
  const en = { sig, msgs: { ...vorhanden }, feld: { ...(alt.feld || {}) } }
  if (alt.subject !== undefined) en.subject = alt.subject
  if (alt.body_text !== undefined) en.body_text = alt.body_text
  if (alt.ai_draft !== undefined) en.ai_draft = alt.ai_draft
  async function uebersetzeFeld(name, wert, hint) {
    const w = String(wert || '')
    if (!w.trim()) { delete en[name]; delete en.feld[name]; return }
    const h = shortHash(w)
    if (en.feld[name] === h && en[name] && (name !== 'subject' || betreffPlausibel(w, en[name]))) return          // Quelltext unveraendert -> Cache behalten (kaputte Betreffs neu)
    const sp = guessLang(w)
    en[name] = (w.length < 8 || sp === 'en' || sp === null)
      ? w
      : (name === 'subject'
        ? ((await uebersetzeBetreff(w, 'en')) || betreffSauber(w))
        : ((await translateText(w.slice(0, 4000), 'en', hint)) || w))
    en.feld[name] = h
  }
  try {
    await uebersetzeFeld('subject', rec.subject, 'Es ist eine E-Mail-Betreffzeile.')
    await uebersetzeFeld('body_text', rec.body_text)
    for (const m of msgs) {
      if (!String(m.body_text || '').trim()) continue
      const key = keyVon(m)
      if (en.msgs[key]) continue
      const quell = String(m.body_text || '').slice(0, 4000)
      // KOSTENFALLE (26.08.): Bei Trivial-Inputs ("--", "Hello") antwortet das
      // Modell mit Meta-Text, translateText liefert null, der Eintrag blieb
      // leer - und JEDER Batch-Lauf versuchte es erneut. Deshalb: kurze,
      // englische oder sprachlich nicht erkennbare Texte direkt uebernehmen,
      // und ein Fehlschlag speichert das Original als Endzustand.
      const sprache = guessLang(quell)
      if (quell.length < 8 || sprache === 'en' || sprache === null) { en.msgs[key] = quell; continue }
      en.msgs[key] = (await translateText(quell, 'en')) || quell
    }
    await uebersetzeFeld('ai_draft', rec.ai_draft)
    rec._en = en
    return true
  } catch (e) {
    console.log('[i18n] Uebersetzung fehlgeschlagen:', String(e && e.message ? e.message : e).slice(0, 70))
    return false
  }
}

// Ticket in der Anzeige-Sprache ausliefern (Original bleibt unangetastet)
function viewTicket(rec, lang) {
  if (lang !== 'en' || !rec._en) {
    if (lang === 'en' && rec && rec.action_required) return { ...rec, action_required: flagAufEnglisch(rec.action_required) }
    return rec
  }
  const en = rec._en
  const out = { ...rec }
  if (en.subject && betreffPlausibel(rec.subject, en.subject)) out.subject = en.subject
  else if (rec.subject) out.subject = betreffSauber(rec.subject)
  if (en.body_text) out.body_text = en.body_text
  if (en.ai_draft) { out.ai_draft = en.ai_draft; out.ai_draft_original = rec.ai_draft }
  if (out.action_required) out.action_required = flagAufEnglisch(out.action_required)
  out.messages = (rec.messages || []).map((m) => {
    const key = shortHash((m.created_at || '') + (m.body_text || '').slice(0, 60))
    return en.msgs && en.msgs[key] ? { ...m, body_text: en.msgs[key], body_text_original: m.body_text } : m
  })
  out._translated = true
  return out
}

// Hintergrund-Uebersetzer: arbeitet die neuesten Tickets nach und nach ab, damit
// beim Oeffnen im Tool schon alles auf Englisch bereitliegt.
let i18nRunning = false
async function translateInboxBatch(limit = 6) {
  if (i18nRunning || !secrets.ai) return 0
  if (!readUsers().some((u) => u.uiLang === 'en')) return 0
  i18nRunning = true
  let done = 0
  try {
    const store = readInbound()
    const todo = store
      .filter((r) => (r.subject || r.body_text))   // 21.08.: is_spam nicht mehr ausschliessen (auch Spam wird uebersetzt, falls Mitarbeiterin C reinsieht)
      .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')))
      // 26.08.: kein slice(0, 60) mehr - der sig/fehlt-Check in ensureEnglish
      // ist billig (nur Hashing), so werden auch alte lange Threads nach und
      // nach rueckwirkend vervollstaendigt (Kappe pro Lauf bleibt `limit`).
    // LUECKEN ZUERST (26.08.): Sonst frisst der laufende Betrieb (neue Mails,
    // Drafts -> sig-Aenderungen bei den neuesten Tickets) das Budget jedes
    // Laufs auf, und ein altes Ticket mit fehlender Nachricht (#1615, Position
    // ~300) kommt NIE dran. Tickets mit fehlenden Nachrichten-Uebersetzungen
    // werden deshalb an den Anfang gezogen (Check ist reines Hashing).
    const hatLuecke = (r) => {
      try {
        const vor = (r._en && r._en.msgs) || {}
        return (r.messages || []).slice(-40).some((m) => String(m.body_text || '').trim() && !vor[shortHash((m.created_at || '') + (m.body_text || '').slice(0, 60))])
      } catch (e) { return false }
    }
    const luecken = todo.filter(hatLuecke)
    const lueckenSet = new Set(luecken)
    const geordnet = [...luecken, ...todo.filter((r) => !lueckenSet.has(r))]
    for (const rec of geordnet) {
      if (done >= limit) break
      const changed = await ensureEnglish(rec)
      // 26.08.: frueher wurde nur bei GEAENDERTER sig gespeichert - reines
      // Luecken-Fuellen (sig bleibt gleich) ging verloren und derselbe
      // API-Call lief bei jedem Lauf erneut (#1615). Jetzt zaehlt allein
      // der Rueckgabewert von ensureEnglish.
      if (changed && rec._en) {
        const cur = readInbound()
        const hit = cur.find((x) => x.id === rec.id)
        if (hit) { hit._en = rec._en; writeInbound(cur) }
        done++
      }
    }
    if (done) console.log('[i18n] ' + done + ' Ticket(s) ins Englische uebersetzt')
  } finally { i18nRunning = false }
  return done
}

// SOFORT-UEBERSETZUNG (Samuel, 21.08.): Wenn ein en-User existiert und
// gerade ein neues Ticket / ein neuer Auto-Draft entsteht, wird die Uebersetzung
// nicht erst beim naechsten 90s-Interval nachgezogen, sondern sofort.
async function uebersetzeSofortWennNoetig(id) {
  try {
    if (!secrets.ai || !readUsers().some((u) => u.uiLang === 'en')) return
    const cur = readInbound()
    const rec = cur.find((x) => x.id === id)
    if (!rec || rec.is_spam === undefined) return
    await ensureEnglish(rec)
    const now = readInbound()
    const hit = now.find((x) => x.id === id)
    if (hit && rec._en) { hit._en = rec._en; writeInbound(now) }
  } catch (e) { console.log('[i18n sofort]', String(e && e.message || e).slice(0, 80)) }
}

// Anzeige-Sprache pro Benutzer speichern
app.post('/api/auth/lang', (req, res) => {
  const lang = req.body && req.body.lang === 'en' ? 'en' : 'de'
  const users = readUsers()
  const u = users.find((x) => x.id === (req.user && req.user.id))
  if (!u) return res.status(404).json({ error: 'Benutzer nicht gefunden.' })
  // SPRACH-PIN (Samuel, 21.08.): Agents (nicht-admin) koennen ihre Anzeige-Sprache
  // NICHT selbst umstellen. Fuer Mitarbeiterin C und alle kuenftigen Nicht-DE-Mitarbeiter
  // muss das Tool ausnahmslos in ihrer festgelegten Sprache laufen. Nur der
  // Admin kann die Sprache eines Users aendern (ueber /api/users/:id, spaeter).
  if (u.role !== 'admin') return res.status(403).json({ error: 'Language is pinned for your account. Please contact the admin.', lang: u.uiLang || 'en' })
  u.uiLang = lang
  writeUsers(users)
  if (lang === 'en') translateInboxBatch(10).catch(() => {})
  res.json({ ok: true, lang })
})

app.post('/api/translate', async (req, res) => {
  const { text, to, ticketId } = req.body || {}
  if (!String(text || '').trim()) return res.status(400).json({ error: 'text erforderlich.' })
  try {
    let target = to
    if (!target && ticketId) {
      const rec = readInbound().find((t) => String(t.id) === String(ticketId))
      target = rec ? customerLang(rec) : 'de'
    }
    target = target || 'de'
    const src = guessLang(text)
    if (src && src === target) return res.json({ text, unchanged: true, lang: target })
    const out = await translateText(text, target)
    res.json({ text: out || text, lang: target, from: src })
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) })
  }
})

app.post('/api/inbound/:id/message', async (req, res) => {
  const { text, direction, internal, attachments } = req.body || {}
  if (!text) return res.status(400).json({ error: 'text erforderlich.' })
  // 1) Erst nur lesen, um Sprache/Kontext des Tickets zu bestimmen. Der
  //    schreibende Zugriff kommt weiter unten, NACH allen await-Schritten.
  let rec = readInbound().find((t) => String(t.id) === String(req.params.id))
  if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
  ensureMessages(rec)
  // WICHTIG: Im Verlauf steht immer der Text, den die Kundin TATSAECHLICH bekommt.
  // Schreibt ein Mitarbeiter auf Englisch, wird hier dieselbe Uebersetzung wie beim
  // Versand angewendet — so sieht Sam im Postfach exakt die gesendete Fassung,
  // waehrend der Mitarbeiter ueber die Anzeige-Uebersetzung sein Englisch behaelt.
  let finalText = String(text)
  let originalText = null
  if (direction !== 'in' && !internal) {
    try {
      const target = customerLang(rec)
      const srcLang = guessLang(finalText)
      if (srcLang && target && srcLang !== target) {
        const tr = await translateText(finalText, target)
        if (tr) { originalText = finalText; finalText = tr
          console.log('[mail] Verlauf gespeichert in Kundensprache (' + srcLang + ' -> ' + target + ')') }
      }
    } catch (e) { console.log('[mail] Verlaufs-Uebersetzung uebersprungen:', String(e && e.message ? e.message : e).slice(0, 60)) }
  }
  // 2) JETZT frisch lesen und ab hier in EINEM synchronen Block (kein await mehr)
  //    modifizieren + schreiben. So kann kein paralleler Vorgang (Ordnungs-
  //    Waechter, IMAP-Import, Status-Update) dazwischenfunken und den Stand
  //    ueberschreiben — genau das liess gesendete Mails wieder im Posteingang
  //    auftauchen (11.08.).
  const store = readInbound()
  rec = store.find((t) => String(t.id) === String(req.params.id))
  if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
  ensureMessages(rec)
  rec.messages.push({
    direction: direction === 'in' ? 'in' : 'out',
    body_text: embedTrackingLinks(finalText).slice(0, 8000),
    ...(originalText ? { body_text_agent: originalText.slice(0, 8000) } : {}),
    created_at: new Date().toISOString(),
    from_name: internal ? 'Interne Notiz' : 'Barbara von Leichtkraut',
    is_internal_note: !!internal,
    // Wer hat gesendet? Grundlage für die Mitarbeiter-Statistik.
    ...(req.user && req.user.id !== 'service' ? { sentBy: req.user.id, sentByName: req.user.name } : {}),
    ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
  })
  // Nach echtem Versand den Entwurf löschen, damit dieselbe Mail nicht ein
  // zweites Mal rausgeht (kein doppelter Empfang beim Kunden).
  if (direction !== 'in' && !internal) {
    // Diff-Learning (Second Brain): Was Samuel vor dem Senden am Entwurf
    // geändert hat, ist das wertvollste Trainingssignal. Draft + gesendete
    // Fassung landen im Outcome-Log; die Wochen-Auswertung clustert daraus
    // Regel-Vorschläge.
    try {
      // SPRACHRICHTIGER VERGLEICH (30.08.): Verglichen wird die Fassung, die der
      // Mitarbeiter WIRKLICH vor sich hatte. Bei einer englischen Oberflaeche ist
      // das die uebersetzte Entwurfsfassung (_en.ai_draft), sonst das deutsche
      // Original. Vorher wurde Deutsch gegen Englisch gehalten - dadurch galten
      // 95 % aller Mails als "bearbeitet" und das Lernmaterial war unbrauchbar.
      const enUser = !!(req.user && req.user.uiLang === 'en')
      const enDraft = String((rec._en && rec._en.ai_draft) || '').trim()
      const basis = (enUser && enDraft) ? 'en' : 'de'
      const draftBefore = basis === 'en' ? enDraft : String(rec.ai_draft || '').trim()
      const gesendet = String(text).trim()
      const geaendert = !!draftBefore && draftBefore !== gesendet
      appendOutcome({
        event: 'sent', ticket: rec.ticket_number,
        had_draft: !!draftBefore,
        edited: geaendert,
        // Womit wurde verglichen? Ohne dieses Feld ist eine spaetere Auswertung
        // wieder blind fuer den Sprachunterschied.
        vergleich: basis,
        by: (req.user && req.user.name) || null,
        confidence: rec.ai_confidence ?? null,
        ...(geaendert ? { draft: draftBefore.slice(0, 4000), sent: gesendet.slice(0, 4000) } : {}),
      })
    } catch {}
    rec.ai_draft = ''
    rec.ai_draft_sent = true
    // STATUS HIER SETZEN (04.08.): Das Frontend schickt Nachricht und Status als
    // ZWEI getrennte Aufrufe. Scheiterte der zweite (Timeout, Neustart, kein
    // Status übergeben), blieb das beantwortete Ticket im Posteingang stehen.
    // Der Server entscheidet das jetzt selbst: Antwort raus → "Meine Erstellten".
    // Nur 'resolved'/'closed' bleiben unangetastet, die sind bewusst gesetzt.
    if (!['resolved', 'closed'].includes(rec.status)) rec.status = 'answered'
    // Versand = neueste Aktivität → Ticket rotiert in der Liste nach oben
    // (received_at ist das Sortierfeld) und bleibt auch nach dem Poll oben.
    rec.received_at = new Date().toISOString()
    store.splice(store.indexOf(rec), 1)
    store.unshift(rec)
  }
  writeInbound(store)
  res.json({ ok: true })
})

// Ticket-Status persistieren (open → answered → resolved), übersteht Reloads.
// ZUFRIEDENHEITS-CHECK (Samuel, 23.08.): Wie reagieren Kundinnen auf unsere
// Antworten? Jede Kundennachricht, die NACH einer Antwort von uns eingeht,
// wird einmalig per Utility-Modell als positiv/neutral/negativ bewertet und
// im Ticket gecacht (msgKey verhindert Doppelbewertung). Schutzschalter bei
// API-Fehlern, Limit pro Lauf - Kosten bleiben minimal (Haiku, 5 Tokens raus).
let reaktionLaeuft = false
function antwortKern(text) {
  const t = String(text || '')
  return t.split(/\n\s*(?:>|Am .{0,60}schrieb|On .{0,60}wrote)/)[0].slice(0, 1200)
}
async function bewerteKundenreaktionen(limit = 20) {
  if (reaktionLaeuft || !secrets.ai) return 0
  if (Date.now() < (globalThis.__reaktionPauseBis || 0)) return 0
  reaktionLaeuft = true
  let done = 0
  try {
    const store = readInbound()
    const seit = Date.now() - 14 * 86400_000
    for (const rec of store) {
      if (done >= limit) break
      if (rec.is_spam) continue
      const msgs = (rec.messages || []).filter((m) => !m.is_internal_note && !m.is_context)
      let idx = -1
      for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i].direction === 'in') { idx = i; break } }
      if (idx <= 0) continue
      if (!msgs.slice(0, idx).some((m) => m.direction === 'out')) continue
      const m = msgs[idx]
      if (new Date(m.created_at || 0).getTime() < seit) continue
      const key = shortHash((m.created_at || '') + String(m.body_text || '').slice(0, 60))
      if (rec.reaction && rec.reaction.msgKey === key) continue
      const kern = antwortKern(m.body_text)
      if (!kern.trim()) continue
      try {
        const r = await aiFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': secrets.ai, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            temperature: 0,
            system: 'Du bewertest die Reaktion einer Kundin auf eine Support-Antwort unseres Teams. Antworte mit GENAU EINEM Wort: positiv, neutral oder negativ. positiv = dankbar, zufrieden, Problem gelöst, freundlicher Abschluss. negativ = verärgert, enttäuscht, droht, will weiterhin Geld zurück, Problem ungelöst. Alles andere = neutral (reine Rückfrage, Information, automatische Antwort).',
            messages: [{ role: 'user', content: 'Kundennachricht:\n' + kern }],
          }),
        })
        if (!r.ok) { globalThis.__reaktionPauseBis = Date.now() + 10 * 60_000; break }
        const data = await r.json()
        const out = ((data.content || []).map((c) => c.text || '').join('') || '').toLowerCase()
        const wert = /positiv/.test(out) ? 'positiv' : /negativ/.test(out) ? 'negativ' : /neutral/.test(out) ? 'neutral' : null
        if (!wert) continue
        const cur = readInbound()
        const hit = cur.find((x) => x.id === rec.id)
        if (hit) { hit.reaction = { wert, msgKey: key, at: m.created_at || null }; writeInbound(cur) }
        done++
      } catch (e) { globalThis.__reaktionPauseBis = Date.now() + 10 * 60_000; break }
    }
    if (done) console.log('[zufriedenheit] ' + done + ' Kundenreaktion(en) bewertet')
  } finally { reaktionLaeuft = false }
  return done
}

// HAUSNUMMER-AUTOMATIK (Samuel, 24.08.): Bestellungen mit Shopify-Tag
// "missing_house_number" bekommen automatisch eine personalisierte Mail mit
// der Bitte um die vollstaendige Adresse. SICHERHEITSNETZ: Das Tag ist
// nachweislich unscharf (markierte am 23.08. auch komplette Adressen wie
// "Brunnengasse 5") - gesendet wird NUR, wenn unsere eigene Pruefung
// bestaetigt, dass wirklich keine Hausnummer da ist. Sonst entsteht ein
// Entwurf mit Warn-Flag zur manuellen Kontrolle. Dedup: hausnummer-log.json
// (jede Bestellung wird genau EINMAL behandelt, egal mit welchem Ausgang).
const HAUSNR_LOG = path.join(DATA_DIR, 'hausnummer-log.json')
function readHausnrLog() {
  try { return JSON.parse(fs.readFileSync(HAUSNR_LOG, 'utf8')) } catch (e) { return {} }
}
function writeHausnrLog(log) {
  fs.writeFileSync(HAUSNR_LOG, JSON.stringify(log, null, 2))
}
function hausnummerFehltWirklich(addr1) {
  const bereinigt = String(addr1 || '').replace(/stra?(ss|ß)e|str\.|weg|gasse|platz|allee|ring/gi, '')
  return !/\d/.test(bereinigt)
}
function hausnrMailText(vorname, order, adresse, englisch) {
  if (englisch) {
    return 'Dear ' + vorname + ',\n\n' +
      'thank you for your order ' + order + ', it has safely arrived in our system! While preparing the shipment, our team noticed that your shipping address seems to be incomplete. It currently shows:\n\n' +
      adresse + '\n\n' +
      'Unfortunately the house number is missing, so the carrier cannot deliver your parcel. Could you simply reply to this email with your complete address (street and house number)? Your parcel will then be on its way immediately.\n\n' +
      'Warm regards,\nBarbara from the Leichtkraut team 💚'
  }
  return 'Hallo ' + vorname + ',\n\n' +
    'vielen Dank für deine Bestellung ' + order + ', sie ist sicher bei uns eingegangen! Beim Vorbereiten des Versands ist unserem Team aufgefallen, dass in deiner Lieferadresse die Hausnummer fehlt. Hinterlegt ist bisher:\n\n' +
    adresse + '\n\n' +
    'Ohne Hausnummer kann DHL das Paket leider nicht zustellen. Antworte einfach kurz auf diese E-Mail mit deiner vollständigen Adresse (Straße mit Hausnummer), dann bringen wir dein Paket sofort auf den Weg.\n\n' +
    'Alles Liebe,\nDeine Barbara vom Leichtkraut-Team 💚'
}
let hausnrLaeuft = false
async function hausnummerAutomatik() {
  if (hausnrLaeuft) return
  const token = secrets.shopify
  const shop = connections.shopify && connections.shopify.store
  if (!token || !shop) return
  hausnrLaeuft = true
  try {
    const seit = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
    const q = `{ orders(first: 30, query: "tag:missing_house_number created_at:>=${seit}") { edges { node { name createdAt displayFulfillmentStatus email shippingAddress { firstName lastName address1 zip city country } } } } }`
    const r = await fetch(`https://${shop}/admin/api/2024-07/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    })
    if (!r.ok) { console.log('[hausnr] Shopify-Abfrage fehlgeschlagen: HTTP ' + r.status); return }
    const data = await r.json()
    const edges = data?.data?.orders?.edges || []
    const log = readHausnrLog()
    let geaendert = false
    const jetzt = () => new Date().toISOString()
    for (const e of edges) {
      const n = e && e.node
      if (!n || log[n.name]) continue
      if (n.displayFulfillmentStatus !== 'UNFULFILLED') {
        log[n.name] = { status: 'uebersprungen-schon-versendet', at: jetzt() }
        geaendert = true
        continue
      }
      const sa = n.shippingAddress || {}
      const mailAdresse = String(n.email || '').trim()
      if (!mailAdresse) {
        log[n.name] = { status: 'keine-email', at: jetzt() }
        geaendert = true
        continue
      }
      const adresse = ((sa.address1 || '') + ', ' + (sa.zip || '') + ' ' + (sa.city || '')).trim()
      const fehlt = hausnummerFehltWirklich(sa.address1)
      const englisch = !/germany|deutschland|austria|österreich|switzerland|schweiz|liechtenstein/i.test(String(sa.country || 'Germany'))
      const vorname = sa.firstName || sa.lastName || (englisch ? 'customer' : 'liebe Kundin, lieber Kunde')
      const betreff = englisch
        ? ('Your order ' + n.name + ' - we need your complete shipping address')
        : ('Deine Bestellung ' + n.name + ': Wir brauchen noch deine Hausnummer')
      const text = hausnrMailText(vorname, n.name, adresse, englisch)
      const store = readInbound()
      const rec = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        ticket_number: nextTicketNumber(store),
        subject: betreff,
        customer_email: mailAdresse,
        customer_name: ((sa.firstName || '') + ' ' + (sa.lastName || '')).trim() || null,
        channel: 'email',
        status: 'draft',
        imap_uid: 'compose:' + Date.now(),
        received_at: jetzt(),
        body_text: '',
        messages: [{
          direction: 'in',
          body_text: 'Hausnummer-Automatik: Shopify-Tag missing_house_number auf Bestellung ' + n.name + '. Adresse laut Bestellung: ' + adresse + '. Eigene Prüfung: Hausnummer ' + (fehlt ? 'FEHLT' : 'scheint VORHANDEN (Tag vermutlich falsch)') + '.',
          created_at: jetzt(),
          from_name: 'Anlass dieser Nachricht',
          is_context: true,
        }],
        ai_draft: text,
        ai_draft_locked: true,
        hausnr_auto: true,
      }
      if (!fehlt) {
        rec.action_required = 'Achtung: Adresse prüfen'
        store.unshift(rec)
        writeInbound(store)
        log[n.name] = { status: 'entwurf-tag-zweifelhaft', ticket: rec.ticket_number, at: jetzt() }
        console.log('[hausnr] ' + n.name + ': Tag zweifelhaft (Adresse "' + (sa.address1 || '') + '"), nur Entwurf #' + rec.ticket_number)
        geaendert = true
        continue
      }
      try {
        await smtpSend({ to: mailAdresse, subject: betreff, text })
        rec.status = 'answered'
        rec.ai_draft = ''
        delete rec.ai_draft_locked
        rec.messages.push({
          direction: 'out',
          body_text: text,
          created_at: jetzt(),
          from_name: 'Barbara (Automatik)',
          sentByName: 'Barbara (Automatik)',
        })
        log[n.name] = { status: 'gesendet', ticket: rec.ticket_number, an: mailAdresse, at: jetzt() }
        console.log('[hausnr] ' + n.name + ': Hausnummer-Mail an ' + mailAdresse + ' GESENDET, Ticket #' + rec.ticket_number)
      } catch (err) {
        rec.action_required = 'Achtung: Mail senden'
        log[n.name] = { status: 'entwurf-versandfehler', ticket: rec.ticket_number, at: jetzt() }
        console.log('[hausnr] ' + n.name + ': Versand fehlgeschlagen, Entwurf #' + rec.ticket_number + ' bleibt liegen (' + String((err && err.message) || err).slice(0, 60) + ')')
      }
      store.unshift(rec)
      writeInbound(store)
      geaendert = true
    }
    if (geaendert) writeHausnrLog(log)
  } catch (e) {
    console.log('[hausnr] Fehler: ' + String((e && e.message) || e).slice(0, 80))
  } finally {
    hausnrLaeuft = false
  }
}

// ENTWURF SPEICHERN (Samuel, 22.08.): Bisher gab es KEINEN Weg, bearbeiteten
// Entwurfstext zu persistieren - das Compose-Modal legte das Ticket an, aber
// Text, den Samuel danach im Ticket-Editor schrieb, ging beim Navigieren
// verloren (#2059/#2060). Dieser Endpunkt speichert den Editor-Stand.
// ai_draft_locked = manuell bearbeitet, Auto-Entwurf fasst das Ticket nie an.
app.post('/api/inbound/:id/draft', (req, res) => {
  const text = String((req.body && req.body.text) || '')
  const store = readInbound()
  const key = String(req.params.id)
  const rec = store.find((r) => String(r.id) === key || String(r.ticket_number) === key)
  if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
  rec.ai_draft = text
  rec.ai_draft_locked = true
  rec.ai_draft_manual_at = new Date().toISOString()
  // Alter Confidence-Score gehoert zum alten Text - nicht mehr anzeigen.
  rec.ai_confidence = null
  delete rec.ai_draft_error
  writeInbound(store)
  res.json({ ok: true })
})

// FRUEHERE GESPRAECHE (Wunsch aus dem Team, 23.08.): Liefert alle anderen Tickets
// derselben Kundin (per E-Mail-Adresse), damit das Overlay am Ticket einen
// Hinweis auf fruehere Konversationen zeigen kann. Betreff sprachbewusst.
app.get('/api/inbound/:id/related', (req, res) => {
  const store = readInbound()
  const key = String(req.params.id)
  const rec = store.find((r) => String(r.id) === key || String(r.ticket_number) === key)
  if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
  const mail = String(rec.customer_email || '').trim().toLowerCase()
  if (!mail) return res.json({ related: [] })
  const en = !!(req.user && req.user.uiLang === 'en')
  const related = store
    .filter((r) => r.id !== rec.id && String(r.customer_email || '').trim().toLowerCase() === mail)
    .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')))
    .slice(0, 12)
    .map((r) => ({
      ticket_number: r.ticket_number,
      subject: (en && r._en && r._en.subject) ? r._en.subject : (r.subject || ''),
      status: auslieferStatus(r),
      received_at: r.received_at || null,
      is_spam: !!r.is_spam,
    }))
  res.json({ related })
})

// VORGESCHICHTE IN KURZ (23.09.2026, Mitarbeiterin Bs Vorschlag): "We have to open
// several tickets just to figure out when an issue was first reported, what
// was already discussed, and what follow-ups have been made." 60 von 78
// offenen Tickets hatten eine Vorgeschichte. Diese Route sammelt ALLE Tickets
// der Kundin (aktuell + Archiv), schneidet zitierte Altmails ab und laesst
// Haiku eine kurze Zusammenfassung schreiben. Zwischengespeichert pro Ticket
// und Stand des Verlaufs: neu gerechnet wird nur, wenn etwas dazukam.
const ZUSAMMENFASSUNG_FILE = path.join(DATA_DIR, 'zusammenfassungen.json')
function ohneZitat(t) {
  let s = String(t || '').replace(/\r/g, '')
  const marker = [
    /\n[^\n]{0,120}(schrieb|wrote|a écrit|ha scritto|escribió)[^\n]{0,40}:\s*\n/i,
    /\n-{2,}\s*(Original|Ursprüngliche|Weitergeleitete|Forwarded)/i,
    /\n(Von|From):\s[^\n]+\n(Gesendet|Sent|Datum|Date):/i,
    /\n>/,
  ]
  let cut = s.length
  for (const m of marker) { const x = s.search(m); if (x > 0 && x < cut) cut = x }
  return s.slice(0, cut).replace(/\n{3,}/g, '\n\n').trim()
}
function kurzDatum(iso) {
  try { return new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit' }) } catch { return '' }
}
app.get('/api/inbound/:id/zusammenfassung', async (req, res) => {
  try {
    const store = readInbound()
    const key = String(req.params.id)
    const rec = store.find((r) => String(r.id) === key || String(r.ticket_number) === key)
    if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
    const mail = String(rec.customer_email || '').trim().toLowerCase()
    const en = !(req.user && req.user.uiLang === 'de')
    const adminIds = new Set(readUsers().filter((u) => u.role === 'admin').map((u) => String(u.id)))
    const gesehen = new Set()
    const tickets = [...store, ...(readArchiv() || [])]
      .filter((r) => r && (r.id === rec.id || (mail && String(r.customer_email || '').trim().toLowerCase() === mail)))
      .filter((r) => { if (gesehen.has(String(r.id))) return false; gesehen.add(String(r.id)); return !r.is_spam || r.id === rec.id })
      .sort((a, b) => String(a.received_at || '').localeCompare(String(b.received_at || '')))
    const nachrichten = []
    for (const t of tickets) {
      const ms = (Array.isArray(t.messages) && t.messages.length) ? t.messages : [{ direction: 'in', body_text: t.body_text, created_at: t.received_at }]
      for (const m of ms) {
        if (m.auto_ack || m.is_context) continue
        const text = ohneZitat(m.body_text).slice(0, 900)
        if (!text) continue
        let wer = 'CUSTOMER'
        if (m.is_internal_note) wer = 'INTERNAL NOTE'
        else if (m.direction === 'out') wer = 'US' + ((m.sentBy && adminIds.has(String(m.sentBy))) ? '' : (m.sentByName && !/Automatik|Barbara/i.test(m.sentByName) ? ' (' + m.sentByName + ')' : ''))
        nachrichten.push({ t, datum: m.created_at || t.received_at, wer, text })
      }
    }
    const anzahlTickets = tickets.length
    if (anzahlTickets < 2 && nachrichten.length < 3) return res.json({ noetig: false })
    // Zu lang? Aelteste zuerst kuerzen, die juengsten Nachrichten bleiben voll.
    let zeilen = nachrichten.map((n) => `[${kurzDatum(n.datum)} · #${n.t.ticket_number} "${String(n.t.subject || '').slice(0, 60)}"] ${n.wer}: ${n.text.replace(/\n+/g, ' ')}`)
    while (zeilen.join('\n').length > 22000 && zeilen.length > 6) zeilen.shift()
    const verlauf = zeilen.join('\n')
    const fp = crypto.createHash('sha1').update((en ? 'en' : 'de') + '\n' + verlauf).digest('hex')
    let cache = {}
    try { cache = JSON.parse(fs.readFileSync(ZUSAMMENFASSUNG_FILE, 'utf8')) } catch {}
    const cKey = String(rec.id) + ':' + (en ? 'en' : 'de')
    if (cache[cKey] && cache[cKey].fp === fp && req.query.neu !== '1') {
      return res.json({ noetig: true, text: cache[cKey].text, tickets: anzahlTickets, nachrichten: nachrichten.length, erster: kurzDatum(nachrichten[0] && nachrichten[0].datum), stand: cache[cKey].at, aus_cache: true })
    }
    if (!secrets.ai) return res.status(503).json({ error: 'KI nicht verbunden.' })
    const sys = en
      ? `You summarize a customer's full support history for a support agent of Leichtkraut (German herbal lymph drops, 60 ml). The agent reads this right before answering the newest message. Be factual and short. Never invent anything that is not in the history.
Format exactly like this, plain text, no markdown headings, no bold:
Situation: one sentence on what the customer wants right now.
History:
- DD.MM: what happened (first contact, what we said, what we promised, what the customer answered). One line each, max 6 lines, oldest first.
Open / promised: what we promised and have not visibly done yet, or "nothing open".
Watch out: one line only if there is something important (angry customer, repeated issue, refund already given, Klarna dispute, address changed, asked the same thing twice). Otherwise leave this line out.
Write in English. Keep order numbers, tracking numbers and amounts exactly as they are. Do not use the long dash character.`
      : `Du fasst die komplette Support-Vorgeschichte einer Kundin fuer eine Mitarbeiterin von Leichtkraut zusammen (Kraeuter-Lymphtropfen, 60 ml). Sie liest das direkt bevor sie auf die neueste Nachricht antwortet. Sachlich und kurz, nichts erfinden.
Format genau so, reiner Text, keine Ueberschriften, kein Fettdruck:
Lage: ein Satz, was die Kundin gerade will.
Verlauf:
- TT.MM: was passiert ist (Erstkontakt, was wir gesagt oder zugesagt haben, was sie geantwortet hat). Je eine Zeile, max. 6 Zeilen, aelteste zuerst.
Offen / zugesagt: was wir zugesagt und noch nicht sichtbar erledigt haben, sonst "nichts offen".
Achtung: nur eine Zeile, wenn etwas Wichtiges ist (veraergert, Problem wiederholt, schon erstattet, Klarna-Streitfall, Adresse geaendert, zweimal dasselbe gefragt). Sonst weglassen.
Bestellnummern, Sendungsnummern und Betraege exakt uebernehmen. Keinen langen Gedankenstrich verwenden.`
    const r = await aiFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': secrets.ai, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        temperature: 0,
        system: sys,
        messages: [{ role: 'user', content: `Customer: ${rec.customer_name || ''} <${rec.customer_email || ''}>\nTickets: ${anzahlTickets}\nThe newest message is the one the agent is answering now (ticket #${rec.ticket_number}).\n\nFULL HISTORY, oldest first:\n${verlauf}` }],
      }),
    })
    if (!r.ok) return res.status(502).json({ error: 'Zusammenfassung fehlgeschlagen (' + r.status + ').' })
    const d = await r.json()
    const text = stripDashes(((d.content || []).map((c) => c.text || '').join('') || '').trim())
    cache[cKey] = { fp, text, at: new Date().toISOString() }
    const keys = Object.keys(cache)
    if (keys.length > 3000) for (const k of keys.sort((a, b) => String(cache[a].at).localeCompare(String(cache[b].at))).slice(0, keys.length - 3000)) delete cache[k]
    fs.writeFileSync(ZUSAMMENFASSUNG_FILE + '.tmp', JSON.stringify(cache))
    fs.renameSync(ZUSAMMENFASSUNG_FILE + '.tmp', ZUSAMMENFASSUNG_FILE)
    res.json({ noetig: true, text, tickets: anzahlTickets, nachrichten: nachrichten.length, erster: kurzDatum(nachrichten[0] && nachrichten[0].datum), stand: cache[cKey].at, aus_cache: false })
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) })
  }
})

// SNOOZE (Wunsch aus dem Team, 23.08.): Ticket fuer eine gewaehlte Zeit
// aus dem Posteingang legen; nach Ablauf taucht es automatisch wieder auf
// (dynamischer Filter, kein Cron noetig). hours: 0 = sofort aufwecken.
// Obergrenze 14 Tage als Schutz vor Tippfehlern.
app.post('/api/inbound/:id/snooze', (req, res) => {
  const stunden = Number((req.body && req.body.hours) || 0)
  const store = readInbound()
  const key = String(req.params.id)
  const rec = store.find((r) => String(r.id) === key || String(r.ticket_number) === key)
  if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
  if (!stunden || stunden <= 0) {
    delete rec.snooze_until
    delete rec.snoozed_by
    writeInbound(store)
    return res.json({ ok: true, snooze_until: null })
  }
  const bis = new Date(Date.now() + Math.min(stunden, 24 * 14) * 3600_000).toISOString()
  rec.snooze_until = bis
  rec.snoozed_by = (req.user && req.user.name) || null
  writeInbound(store)
  console.log('[snooze] #' + rec.ticket_number + ' schlummert bis ' + bis + ' (' + (rec.snoozed_by || '?') + ')')
  res.json({ ok: true, snooze_until: bis })
})

// BETREFF EINES ENTWURFS AENDERN (21.09.2026): Bisher liess sich der Betreff
// einer selbst verfassten Mail nach dem Anlegen nicht mehr aendern. Bewusst
// eng: nur Admins, nur unversendete Compose-Entwuerfe. Der Betreff einer
// Kundenmail bleibt unantastbar, sonst reisst die Zuordnung der Antworten.
app.patch('/api/inbound/:id/subject', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur fuer Admins.' })
  const subject = String((req.body || {}).subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200)
  if (!subject) return res.status(400).json({ error: 'Betreff fehlt.' })
  const store = readInbound()
  const rec = store.find((t) => String(t.id) === String(req.params.id))
  if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
  const hatAusgang = (rec.messages || []).some((m) => m.direction === 'out')
  if (rec.status !== 'draft' || !String(rec.imap_uid || '').startsWith('compose:') || hatAusgang) return res.status(400).json({ error: 'Betreff laesst sich nur bei unversendeten Entwuerfen aendern.' })
  const alt = rec.subject
  rec.subject = subject
  writeInbound(store)
  console.log('[entwurf] Betreff #' + rec.ticket_number + ' geaendert: "' + alt + '" -> "' + subject + '"')
  res.json({ ok: true, ticket_number: rec.ticket_number, subject })
})

app.patch('/api/inbound/:id/status', (req, res) => {
  const { status } = req.body || {}
  if (!['open', 'answered', 'resolved', 'closed', 'draft'].includes(status)) return res.status(400).json({ error: 'Ungültiger Status.' })
  let store = []
  store = readInbound()
  const rec = store.find((t) => String(t.id) === String(req.params.id))
  if (!rec) return res.status(404).json({ error: 'Ticket nicht gefunden.' })
  if (rec.status !== status) appendOutcome({ event: 'status', ticket: rec.ticket_number, from: rec.status, to: status })
  rec.status = status
  // Beantwortet/gelöst → offenen Entwurf entfernen, damit keine Karteileichen
  // im Entwürfe-Ordner zurückbleiben.
  if (status === 'answered' || status === 'resolved' || status === 'closed') {
    rec.ai_draft = ''
    rec.ai_draft_sent = true
  }
  writeInbound(store)
  res.json({ ok: true })
})

app.post('/api/gmail/sync', async (_req, res) => {
  try {
    const added = secrets.gmailRefresh ? await syncGmailApi({ limit: 25 }) : await syncGmail({ limit: 25 })
    res.json({ ok: true, added, connections: publicConnections() })
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err?.message || err) })
  }
})

// --- Gmail OAuth flow ---
app.get('/api/gmail/oauth/start', (req, res) => {
  const cid = connections.gmail.clientId
  if (!cid || !secrets.gmailClientSecret) return res.status(400).send('Client-ID/Secret fehlen — erst in der App speichern.')
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  u.searchParams.set('client_id', cid)
  u.searchParams.set('redirect_uri', GMAIL_REDIRECT)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', GMAIL_SCOPES)
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  res.redirect(u.toString())
})

app.get('/api/gmail/oauth/callback', async (req, res) => {
  const code = req.query.code
  if (!code) return res.redirect(APP_INTEGRATIONS_URL + '?gmail=error')
  try {
    const body = new URLSearchParams({
      code: String(code), client_id: connections.gmail.clientId, client_secret: secrets.gmailClientSecret,
      redirect_uri: GMAIL_REDIRECT, grant_type: 'authorization_code',
    })
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    const t = await r.json()
    if (!t.access_token) throw new Error(JSON.stringify(t).slice(0, 200))
    if (t.refresh_token) { secrets.gmailRefresh = t.refresh_token; connections.gmail._refresh = t.refresh_token }
    secrets.gmailAccess = { token: t.access_token, exp: Date.now() + (t.expires_in || 3500) * 1000 }
    const prof = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + t.access_token } }).then((x) => x.json())
    connections.gmail = { ...connections.gmail, email: prof.emailAddress || connections.gmail.email, authMethod: 'oauth', oauthConnected: true, connected: true }
    saveConnections(connections)
    console.log('[gmail] OAuth verbunden:', connections.gmail.email)
    await syncGmailApi({ limit: 25 }).catch((e) => console.log('[gmail] Erst-Sync:', String(e?.message || e)))
    res.redirect(APP_INTEGRATIONS_URL + '?gmail=ok')
  } catch (err) {
    console.log('[gmail] OAuth-Fehler:', String(err?.message || err))
    res.redirect(APP_INTEGRATIONS_URL + '?gmail=error')
  }
})

app.post('/api/gmail/send', async (req, res) => {
  try {
    const { to, subject, text } = req.body || {}
    if (!to || !text) return res.status(400).json({ error: 'to und text erforderlich.' })
    await gmailSend({ to, subject: subject || '(Kein Betreff)', text })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err?.message || err) })
  }
})

// Unified send — routes through whichever mailbox is connected (IONOS SMTP or Gmail).
app.post('/api/mail/send', async (req, res) => {
  try {
    const { to, subject, text, attachments, ticketId } = req.body || {}
    if (!to || !text) return res.status(400).json({ error: 'to und text erforderlich.' })
    // BCC NUR FUER TRUSTPILOT (19.09.2026): Trustpilot liest Einladungen ueber
    // eine persoenliche BCC-Adresse mit. Bewusst auf *@invite.trustpilot.com
    // beschraenkt, damit ueber diesen Weg niemand heimlich Dritte mitlesen
    // lassen kann.
    const bccCheck = bccPruefen((req.body || {}).bcc, req.user)
    if (!bccCheck.ok) return res.status(400).json({ error: bccCheck.error })
    let bcc = bccCheck.bcc
    // Kein BCC im Aufruf? Dann das am Ticket hinterlegte nehmen (aus "New email").
    let bccTicketId = null
    if (!bcc) {
      const st = readInbound()
      const an = String(to).toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1')
      const hit = ticketId
        ? st.find((t) => String(t.id) === String(ticketId) && t.bcc)
        : st.find((t) => t.bcc && String(t.customer_email || '').toLowerCase() === an)
      if (hit) { bcc = hit.bcc; bccTicketId = hit.id }
    }
    // SICHERHEITSNETZ SPRACHE: Arbeitet jemand auf Englisch, darf die Kundin die
    // Mail trotzdem nur in IHRER Sprache bekommen. Weicht die Sprache des Textes
    // von der Sprache der Kundin ab, wird vor dem Versand automatisch übersetzt.
    let body = text
    let subj = subject
    let recSend = null
    try {
      const store = readInbound()
      const rec = ticketId
        ? store.find((t) => String(t.id) === String(ticketId))
        : store.find((t) => String(t.customer_email || '').toLowerCase() === String(to).toLowerCase())
      const target = rec ? customerLang(rec) : 'de'
      // Das Bundle schickt bei englischer Oberflaeche den UEBERSETZTEN Betreff.
      // Passendes Ticket derselben Kundin ueber den Betreff suchen und dessen
      // Original verwenden, statt erneut zu uebersetzen.
      const ohneRe = (x) => String(x || '').replace(/^\s*((re|aw|wg|fwd?|antw)\s*:\s*)+/i, '').trim()
      const ein = ohneRe(subject)
      const an = String(to).toLowerCase().replace(/^.*<([^>]+)>.*$/, '$1')
      recSend = (ticketId && rec) || store.find((t) => String(t.customer_email || '').toLowerCase() === an
        && ein && (ohneRe(t.subject) === ein || (t._en && ohneRe(t._en.subject) === ein))) || null
      const src = guessLang(text)
      if (src && target && src !== target) {
        const translated = await translateText(text, target)
        if (translated) {
          body = translated
          console.log(`[mail] 🌍 Text vor Versand ${src} → ${target} übersetzt (an ${to})`)
          if (subject && !recSend) {
            const sSrc = guessLang(subject)
            if (sSrc && sSrc !== target) subj = (await uebersetzeBetreff(subject, target)) || subject
          }
        }
      }
    } catch (e) { console.log('[mail] Übersetzung übersprungen:', String(e?.message || e).slice(0, 80)) }
    if (subject) {
      if (recSend) {
        const b = betreffSauber(recSend.subject)
        subj = (/^\s*re\s*:/i.test(String(subject)) && !/^\s*re\s*:/i.test(b)) ? 'Re: ' + b : b
      }
      const vorher = subj
      subj = betreffSauber(subj)
      if (subj !== String(subject).trim() && subj !== vorher) console.log('[mail] Betreff bereinigt (an ' + to + ')')
    }
    const outText = body, outSubject = subj
    // Anhänge: Dateinamen aus dem Upload-Ordner (gegen Pfad-Tricks abgesichert)
    const atts = (Array.isArray(attachments) ? attachments : [])
      .map((f) => path.basename(String(f)))
      .filter((f) => fs.existsSync(path.join(ATT_DIR, f)))
      .map((f) => ({ filename: f.replace(/^up-\d+-/, ''), path: path.join(ATT_DIR, f) }))
    if (secrets.imap && connections.imap.email) {
      await smtpSend({ to, subject: outSubject, text: outText, attachments: atts, bcc: bcc || undefined })
      // Das hinterlegte BCC gilt fuer genau eine Mail: danach entfernen, aber
      // festhalten, wohin es ging.
      if (bccTicketId) {
        const st2 = readInbound()
        const h2 = st2.find((t) => t.id === bccTicketId)
        if (h2) { h2.bcc_gesendet = { an: h2.bcc, am: new Date().toISOString() }; delete h2.bcc; writeInbound(st2) }
      }
      if (bcc) console.log('[mail] BCC an ' + bcc + ' (Mail an ' + to + ')')
      return res.json({ ok: true, via: 'ionos', translated: outText !== text, bcc: !!bcc })
    }
    if (secrets.gmailRefresh) { await gmailSend({ to, subject: outSubject, text: outText }); return res.json({ ok: true, via: 'gmail', translated: outText !== text }) }
    return res.status(400).json({ error: 'Kein Postfach zum Senden verbunden.' })
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err?.message || err) })
  }
})

app.post('/api/imap/sync', async (_req, res) => {
  try { const added = await syncImapMailbox({ limit: 25 }); res.json({ ok: true, added }) }
  catch (err) { res.status(400).json({ ok: false, error: String(err?.message || err) }) }
})

// Poll mailboxes every 60s once connected (IONOS IMAP, Gmail OAuth, or Gmail IMAP).
// Auth-failure backoff: repeated failed logins trigger IONOS' brute-force lock —
// after 2 consecutive auth failures we pause polling for 20 minutes.
let imapFailStreak = 0
let imapPausedUntil = 0
setInterval(() => {
  if (process.env.IMAP_PAUSE === '1') return
  if (connections.imap?.connected && secrets.imap && Date.now() > imapPausedUntil) {
    syncImapMailbox({ limit: 15 })
      .then((n) => { imapFailStreak = 0; if (n) { console.log(`[imap] ${n} neue Mail(s) (IONOS)`); translateInboxBatch(20).catch(() => {}) } })
      .catch((e) => {
        // Nur ECHTE Anmeldefehler duerfen den Abruf pausieren. Vorher zaehlte
        // jeder beliebige Fehler mit, und ein kaputter Mailinhalt legte den
        // Abruf 20 Minuten lahm - gemeldet als IONOS-Sperre, was in die
        // voellig falsche Richtung ermittelt.
        const txt = String((e && e.message) || e)
        const istLogin = /auth|login|credential|password|invalid|denied|LOGIN failed|NO \[AUTHENTICATIONFAILED\]/i.test(txt)
        if (!istLogin) {
          console.log(`[imap] ⚠ Abruf-Fehler (KEIN Login-Problem, Abruf laeuft weiter): ${txt.slice(0, 110)}`)
          return
        }
        imapFailStreak++
        if (imapFailStreak >= 2) {
          imapPausedUntil = Date.now() + 20 * 60_000
          console.log(`[imap] ⏸ 2× Login abgelehnt — Polling pausiert 20 Min (IONOS-Sperre abkuehlen lassen). ${txt.slice(0, 60)}`)
        }
      })
  }
  if (connections.gmail?.oauthConnected && secrets.gmailRefresh) {
    syncGmailApi({ limit: 15 }).then((n) => { if (n) console.log(`[gmail] ${n} neue Mail(s) (OAuth)`) }).catch(() => {})
  } else if (connections.gmail?.connected && secrets.gmail) {
    syncGmail({ limit: 15 }).then((n) => { if (n) console.log(`[gmail] ${n} neue Mail(s) (IMAP)`) }).catch(() => {})
  }
}, 20_000) // 20s: neue Kundenmails erscheinen quasi sofort im Tool

// On startup, if IONOS creds are in .env, connect automatically — trying both
// IONOS IMAP hosts so we don't have to guess the right one.
async function autoConnectImap() {
  if (process.env.IMAP_PAUSE === '1') { console.log('[imap] ⏸ IMAP_PAUSE=1 — keine Login-Versuche (manuell pausiert)'); return }
  if (!secrets.imap || !connections.imap.email) return
  // If a host already worked before (smtpHost was derived), only try that one —
  // avoids piling up failed logins that trigger IONOS' lockout.
  const hosts = connections.imap.smtpHost
    ? [connections.imap.host]
    : [connections.imap.host || 'imap.ionos.de', 'imap.ionos.de', 'imap.ionos.com', 'imap.1and1.com']
  for (const host of [...new Set(hosts)]) {
    connections.imap.host = host
    try {
      const n = await syncImapMailbox({ limit: 25 })
      connections.imap.smtpHost = host.replace(/^imap\./, 'smtp.') // matching SMTP server for sending
      saveConnections(connections)
      console.log(`[imap] ✅ IONOS verbunden über ${host} — ${n} Mail(s) importiert · SMTP ${connections.imap.smtpHost}`)
      autoDraftNewRecords().catch(() => {}) // catch up drafts for anything without one
      return
    } catch (e) {
      console.log(`[imap] ${host} → ${String(e?.responseText || e?.message || e).slice(0, 80)}`)
    }
  }
  console.log('[imap] ❌ Alle IONOS-Server abgelehnt — Passwort in server/.env prüfen (IMAP_PASSWORD).')
}


// Login-/Setup-Seite (eigenständig, ohne React) — wird ausgeliefert, solange
// niemand angemeldet ist. Die eigentliche App bleibt dahinter verborgen.
// Anmeldeseite auf Englisch (Standard) mit Umschaltmöglichkeit auf Deutsch.
// Hintergrund: Das Team arbeitet auf Englisch; wer lieber Deutsch möchte,
// klickt auf "Deutsch" — die Wahl wird im Browser gemerkt.
const AUTH_T = {
  en: {
    lang: 'en', titleSetup: 'Setup', titleLogin: 'Sign in',
    hSetup: 'First-time setup', hLogin: 'Top G Leichtkraut',
    subSetup: 'Create your administrator account. The tool is protected afterwards.',
    subLogin: 'Please sign in to continue.',
    name: 'Name', pass: 'Password', pass2: 'Repeat password',
    btnSetup: 'Create account', btnLogin: 'Sign in',
    hint: 'At least 8 characters. Choose a password you do not use anywhere else, this account can see all customer data.',
    mismatch: 'The passwords do not match.', failed: 'Sign-in failed.', conn: 'Connection failed.',
    other: 'Deutsch', otherCode: 'de',
  },
  de: {
    lang: 'de', titleSetup: 'Einrichtung', titleLogin: 'Anmeldung',
    hSetup: 'Erste Einrichtung', hLogin: 'Top G Leichtkraut',
    subSetup: 'Lege dein Administrator-Konto an. Danach ist das Tool geschützt.',
    subLogin: 'Bitte melde dich an, um fortzufahren.',
    name: 'Name', pass: 'Passwort', pass2: 'Passwort wiederholen',
    btnSetup: 'Konto anlegen', btnLogin: 'Anmelden',
    hint: 'Mindestens 8 Zeichen. Wähle ein Passwort, das du nirgends sonst verwendest, dieses Konto sieht alle Kundendaten.',
    mismatch: 'Die Passwörter stimmen nicht überein.', failed: 'Anmeldung fehlgeschlagen.', conn: 'Verbindung fehlgeschlagen.',
    other: 'English', otherCode: 'en',
  },
}

function authPageHtml(mode, lang) {
  // Neue Anmeldung (Sam, 05.10.2026): Nacht-Design, Passwort → 2FA-Code; Admins richten beim ersten Mal die Authenticator-App ein.
  const isSetup = mode === 'setup'
  const t = AUTH_T[lang === 'de' ? 'de' : 'en']
  const z = lang === 'de' ? {
    code: 'Code aus der Authenticator-App', codeSub: 'Öffne Google Authenticator, 1Password oder Authy und gib den 6-stelligen Code ein. Kein Handy zur Hand? Ein Notfall-Code geht auch.',
    weiter: 'Bestätigen', zurueck: 'Zurück', einr: 'Zwei-Faktor einrichten', einrSub: 'Ab jetzt brauchst du zusätzlich zum Passwort einen Code vom Handy. Scanne den QR-Code mit deiner Authenticator-App und gib danach den angezeigten Code ein.',
    manuell: 'Oder manuell eingeben', notf: 'Deine Notfall-Codes', notfSub: 'Jeder Code funktioniert genau einmal, falls du dein Handy nicht hast. Speichere sie jetzt sicher, zum Beispiel in deinem Passwort-Manager. Sie werden nie wieder angezeigt.',
    gesichert: 'Codes gesichert, weiter zum OS', kopiert: 'Kopiert', kopieren: 'Codes kopieren', sicher: 'Geschützt mit Zwei-Faktor-Anmeldung' } : {
    code: 'Code from your authenticator app', codeSub: 'Open Google Authenticator, 1Password or Authy and enter the 6-digit code. No phone at hand? A backup code works too.',
    weiter: 'Confirm', zurueck: 'Back', einr: 'Set up two-factor', einrSub: 'From now on you need a code from your phone in addition to your password. Scan the QR code with your authenticator app, then enter the code it shows.',
    manuell: 'Or enter manually', notf: 'Your backup codes', notfSub: 'Each code works exactly once if you do not have your phone. Store them safely now, e.g. in your password manager. They will never be shown again.',
    gesichert: 'Codes saved, continue', kopiert: 'Copied', kopieren: 'Copy codes', sicher: 'Protected with two-factor sign-in' }
  return `<!doctype html><html lang="${t.lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="theme-color" content="#0b0912">
<title>${isSetup ? t.titleSetup : t.titleLogin} · Leichtkraut</title>
<link rel="icon" type="image/png" sizes="32x32" href="/api/icons/favicon-32.png?v=2">
<style>
:root{--bg:#08070d;--card:rgba(18,14,30,.78);--ink:#f3f0fb;--ink2:#d9d3ea;--mut:#9c95b5;--dim:#6c6687;--line:#2c2540;--err:#fb7a9a;--akzent:linear-gradient(135deg,#7c3aed 0%,#c026d3 100%)}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;color:var(--ink);padding:24px;
background:radial-gradient(900px 600px at 50% -10%,rgba(124,58,237,.28),transparent 60%),radial-gradient(700px 500px at 100% 110%,rgba(192,38,211,.16),transparent 60%),var(--bg);
font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.card{position:relative;width:100%;max-width:400px;background:var(--card);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid var(--line);border-radius:22px;padding:34px 30px 26px;
box-shadow:0 0 0 1px rgba(167,139,250,.06),0 30px 90px rgba(76,29,149,.35),0 10px 30px rgba(0,0,0,.5);animation:auf .45s cubic-bezier(.2,.8,.2,1) both}
@keyframes auf{from{opacity:0;transform:translateY(14px) scale(.98)}to{opacity:1;transform:none}}
.orb{width:62px;height:62px;margin:0 auto 18px;display:block;border-radius:18px;box-shadow:0 10px 34px rgba(124,58,237,.55);animation:schwebe 6s ease-in-out infinite}
@keyframes schwebe{50%{transform:translateY(-4px)}}
h1{font-size:22px;margin:0 0 6px;text-align:center;letter-spacing:-.02em}
p.sub{color:var(--mut);font-size:13.5px;margin:0 0 22px;text-align:center}
label{display:block;font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);margin:0 0 7px}
input{width:100%;border:1px solid var(--line);background:rgba(255,255,255,.03);color:var(--ink);border-radius:12px;padding:12px 14px;font:inherit;margin-bottom:16px;transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:#a78bfa;box-shadow:0 0 0 3px rgba(167,139,250,.2)}
input.code{font-size:26px;letter-spacing:.42em;text-align:center;font-variant-numeric:tabular-nums;font-weight:700;padding:14px 10px}
button{width:100%;border:0;background:var(--akzent);color:#fff;border-radius:12px;padding:13px;font:inherit;font-weight:700;cursor:pointer;box-shadow:0 8px 26px rgba(168,85,247,.38);transition:filter .15s,transform .15s}
button:hover{filter:brightness(1.08)} button:active{transform:translateY(1px)} button:disabled{opacity:.55;cursor:default}
button.zweit{background:transparent;border:1px solid var(--line);box-shadow:none;color:var(--ink2);margin-top:10px}
.err{color:var(--err);font-size:13.5px;margin:0 0 14px;min-height:20px;text-align:center}
.hint{color:var(--mut);font-size:12px;margin-top:16px;line-height:1.5}
.lang{display:block;text-align:center;margin-top:18px;color:var(--dim);font-size:12px;text-decoration:none}.lang:hover{color:#c4b5fd}
.schutz{display:flex;align-items:center;justify-content:center;gap:7px;margin-top:18px;color:var(--dim);font-size:11.5px}.schutz i{width:7px;height:7px;border-radius:50%;background:#22c55e;box-shadow:0 0 8px #22c55e}
.qr{background:#fff;border-radius:14px;padding:12px;width:204px;height:204px;margin:0 auto 14px;display:grid;place-items:center}
.geheim{font:600 12.5px/1.6 ui-monospace,Menlo,monospace;letter-spacing:.04em;word-spacing:.15em;color:var(--ink2);background:rgba(255,255,255,.04);border:1px dashed var(--line);border-radius:10px;padding:9px 10px;text-align:center;margin:-2px 0 18px;word-break:normal;user-select:all}
.nf{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 16px}.nf span{font:700 14px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-align:center;padding:11px 6px;border-radius:10px;background:rgba(167,139,250,.08);border:1px solid var(--line)}
[hidden]{display:none!important}
</style></head><body>
<div class="card">
  <img class="orb" src="/api/icons/icon-192.png?v=2" alt="">
  <form id="s1">
    <h1>${isSetup ? t.hSetup : 'Leichtkraut'}</h1>
    <p class="sub">${isSetup ? t.subSetup : t.subLogin}</p>
    <p class="err" id="e1"></p>
    <label for="n">${t.name}</label>
    <input id="n" name="name" autocomplete="username" autofocus required>
    <label for="p">${t.pass}</label>
    <input id="p" name="password" type="password" autocomplete="${isSetup ? 'new-password' : 'current-password'}" required${isSetup ? ' minlength="8"' : ''}>
    ${isSetup ? `<label for="p2">${t.pass2}</label><input id="p2" type="password" autocomplete="new-password" required minlength="8">` : ''}
    <button id="b1" type="submit">${isSetup ? t.btnSetup : t.btnLogin}</button>
    ${isSetup ? `<p class="hint">${t.hint}</p>` : ''}
  </form>
  <form id="s2" hidden>
    <h1>${z.code}</h1>
    <p class="sub">${z.codeSub}</p>
    <p class="err" id="e2"></p>
    <input id="c2" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="••••••" required>
    <button id="b2" type="submit">${z.weiter}</button>
    <button class="zweit" type="button" data-zurueck>${z.zurueck}</button>
  </form>
  <form id="s3" hidden>
    <h1>${z.einr}</h1>
    <p class="sub">${z.einrSub}</p>
    <div class="qr" id="qr"></div>
    <label>${z.manuell}</label>
    <div class="geheim" id="geheim"></div>
    <p class="err" id="e3"></p>
    <input id="c3" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="••••••" required>
    <button id="b3" type="submit">${z.weiter}</button>
    <button class="zweit" type="button" data-zurueck>${z.zurueck}</button>
  </form>
  <div id="s4" hidden>
    <h1>${z.notf}</h1>
    <p class="sub">${z.notfSub}</p>
    <div class="nf" id="nf"></div>
    <button type="button" id="b4">${z.gesichert}</button>
    <button class="zweit" type="button" id="k4">${z.kopieren}</button>
  </div>
  <div class="schutz"><i></i>${z.sicher}</div>
  <a class="lang" href="?lang=${t.otherCode}">${t.other}</a>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
const $=(i)=>document.getElementById(i); let ticket=null;
const zeige=(id)=>{['s1','s2','s3','s4'].forEach(x=>$(x).hidden=(x!==id)); const f=$(id).querySelector('input'); if(f) setTimeout(()=>f.focus(),50);};
const post=async(u,b)=>{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}); let j={}; try{j=await r.json()}catch(e){} return {ok:r.ok,j};};
document.querySelectorAll('[data-zurueck]').forEach(b=>b.addEventListener('click',()=>{ticket=null;$('p').value='';zeige('s1');}));
$('s1').addEventListener('submit',async(ev)=>{
  ev.preventDefault(); $('e1').textContent=''; $('b1').disabled=true;
  const name=$('n').value, password=$('p').value;
  ${isSetup ? `if(password!==$('p2').value){$('e1').textContent=${JSON.stringify(t.mismatch)};$('b1').disabled=false;return;}` : ''}
  try{
    const {ok,j}=await post('/api/auth/${isSetup ? 'setup' : 'login'}',{name,password}); $('b1').disabled=false;
    if(!ok){ $('e1').textContent=j.error||${JSON.stringify(t.failed)}; return; }
    if(j.zweiFaktor){ ticket=j.ticket; $('c2').value=''; zeige('s2'); return; }
    if(j.einrichten){ ticket=j.ticket; $('qr').innerHTML=''; try{ new QRCode($('qr'),{text:j.otpauth,width:180,height:180,colorDark:'#0b0912',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M}); }catch(e){ $('qr').textContent='QR nicht verfügbar'; }
      $('geheim').textContent=j.secret.replace(/(.{4})/g,'$1 ').trim(); $('c3').value=''; zeige('s3'); return; }
    location.href='/';
  }catch(err){ $('e1').textContent=${JSON.stringify(t.conn)}; $('b1').disabled=false; }
});
const codeSchritt=(form,input,err,btn,url)=>$(form).addEventListener('submit',async(ev)=>{
  ev.preventDefault(); $(err).textContent=''; $(btn).disabled=true;
  try{
    const {ok,j}=await post(url,{ticket,code:$(input).value.trim()}); $(btn).disabled=false;
    if(!ok){ $(err).textContent=j.error||${JSON.stringify(t.failed)}; $(input).value=''; $(input).focus(); if(j.neu){ setTimeout(()=>{ticket=null;$('p').value='';zeige('s1');$('e1').textContent=j.error;},1400);} return; }
    if(j.notfallCodes){ $('nf').innerHTML=j.notfallCodes.map(c=>'<span>'+c+'</span>').join(''); zeige('s4'); $('k4').onclick=()=>{try{navigator.clipboard.writeText(j.notfallCodes.join('\\n'));$('k4').textContent=${JSON.stringify(z.kopiert)};}catch(e){}}; return; }
    location.href='/';
  }catch(e2){ $(err).textContent=${JSON.stringify(t.conn)}; $(btn).disabled=false; }
});
codeSchritt('s2','c2','e2','b2','/api/auth/2fa'); codeSchritt('s3','c3','e3','b3','/api/auth/2fa-einrichten');
$('c2').addEventListener('input',()=>{ if(/^\\d{6}$/.test($('c2').value.replace(/\\s/g,''))) $('s2').requestSubmit(); });
$('c3').addEventListener('input',()=>{ if(/^\\d{6}$/.test($('c3').value.replace(/\\s/g,''))) $('s3').requestSubmit(); });
$('b4').addEventListener('click',()=>{ location.href='/'; });
</script>
</body></html>`
}


// Eigene Leistungsübersicht für jede angemeldete Person: Arbeitszeit, gesendete
// Mails, vollständiges Protokoll. Dieselben Zahlen, die auch die Leitung sieht —
// aber nur über einen selbst. Zweisprachig, weil das Team auf Englisch arbeitet.
function mePageHtml(lang) {
  const en = lang === 'en'
  const T = en ? {
    title: 'My work', head: 'My work', sub: 'Your working time and every email you sent. Same numbers your manager sees, about you.',
    today: 'last 24h', week: 'last 7 days', total: 'all time',
    timeToday: 'Time last 24h', timeWeek: 'Time this week', timeTotal: 'Time in total',
    mailsToday: 'Emails today', mails24h: 'Emails last 24h', mailsWeek: 'Emails this week', mailsTotal: 'Emails in total',
    perMail: 'Min. per email', week7: 'Last 7 days', sent: 'Emails you sent',
    none: 'No emails sent yet. As soon as you reply to a customer, it appears here.',
    back: 'Back to inbox', loading: 'loading …', chars: 'chars', mailsOne: 'email', mailsMany: 'emails',
    note: 'Working time only counts while you are actually active in the tool, not while a tab sits open in the background.',
  } : {
    title: 'Meine Arbeit', head: 'Meine Arbeit', sub: 'Deine Arbeitszeit und jede gesendete E-Mail. Dieselben Zahlen, die auch die Leitung über dich sieht.',
    today: 'letzte 24 Std', week: '7 Tage', total: 'gesamt',
    timeToday: 'Zeit letzte 24 Std', timeWeek: 'Zeit diese Woche', timeTotal: 'Zeit gesamt',
    mailsToday: 'Mails heute', mails24h: 'Mails letzte 24 Std', mailsWeek: 'Mails diese Woche', mailsTotal: 'Mails gesamt',
    perMail: 'Min. pro Mail', week7: 'Letzte 7 Tage', sent: 'Deine gesendeten E-Mails',
    none: 'Noch keine E-Mails gesendet. Sobald du einer Kundin antwortest, erscheint sie hier.',
    back: 'Zurück zum Postfach', loading: 'lädt …', chars: 'Z.', mailsOne: 'Mail', mailsMany: 'Mails',
    note: 'Arbeitszeit zählt nur, während du wirklich im Tool aktiv bist, nicht wenn ein Tab im Hintergrund offen steht.',
  }
  return `<!doctype html><html lang="${en ? 'en' : 'de'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${T.title} · Leichtkraut</title>
<style>
:root{--bg:#f2f5f2;--card:#fff;--ink:#14201a;--mut:#5f7268;--line:#dde6e0;--acc:#2f7d5f;--soft:#eef3ef}
@media(prefers-color-scheme:dark){:root{--bg:#0e1512;--card:#161e1a;--ink:#e5ece7;--mut:#93a59a;--line:#26312b;--acc:#5cb890;--soft:#1c2620}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:26px 20px 60px}
.wrap{max-width:960px;margin:0 auto}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px;flex-wrap:wrap}
h1{font-size:23px;margin:0 0 4px;letter-spacing:-.02em}
.sub{color:var(--mut);font-size:13.5px;margin:0;max-width:560px}
.back{color:var(--acc);text-decoration:none;font-size:13.5px;font-weight:600;white-space:nowrap}
.back:hover{text-decoration:underline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:11px;margin-bottom:22px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px 16px}
.kpi b{display:block;font-size:25px;font-variant-numeric:tabular-nums;letter-spacing:-.025em;line-height:1.15}
.kpi span{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.06em;font-weight:600}
.kpi.acc b{color:var(--acc)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:18px}
.card h2{font-size:14px;margin:0 0 15px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}
.bars{display:flex;align-items:flex-end;gap:9px;height:96px}
.bcol{flex:1;display:flex;flex-direction:column;align-items:center;gap:7px}
.bar{width:100%;max-width:52px;background:var(--acc);border-radius:6px 6px 0 0;min-height:3px;opacity:.85}
.bcol span{font-size:10.5px;color:var(--mut);white-space:nowrap}
.bcol i{font-size:11px;font-style:normal;font-variant-numeric:tabular-nums}
.dday{font-size:12.5px;font-weight:700;margin:16px 0 6px;color:var(--ink)}
.dday:first-of-type{margin-top:0}
.dday span{color:var(--mut);font-weight:500;margin-left:7px}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:7px 9px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.t{color:var(--mut);white-space:nowrap;font-variant-numeric:tabular-nums;width:50px}
.tk{color:var(--acc);font-weight:650;white-space:nowrap;width:62px}
.cu{white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
.su{color:var(--mut)}
.ch{color:var(--mut);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.mut{color:var(--mut);font-size:13px}
.note{color:var(--mut);font-size:12px;margin-top:14px;line-height:1.5}
@media(max-width:700px){.su,.ch{display:none}}
</style></head><body><div class="wrap">
  <div class="top">
    <div><h1>${T.head}</h1><p class="sub">${T.sub}</p></div>
    <a class="back" href="/">← ${T.back}</a>
  </div>
  <div class="grid" id="kpis"></div>
  <div class="card"><h2>${T.week7}</h2><div class="bars" id="bars"></div></div>
  <div class="card"><h2>${T.sent}</h2><div id="mails"><p class="mut">${T.loading}</p></div>
    <p class="note">${T.note}</p></div>
</div>
<script>
const T=${JSON.stringify(T)}, EN=${en};
const esc=s=>String(s==null?"":s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const hhmm=s=>{const h=Math.floor(s/3600),m=Math.round(s%3600/60);return h?h+"h "+String(m).padStart(2,"0")+"m":m+"m"};
const dayLabel=d=>new Date(d+"T12:00:00").toLocaleDateString(EN?"en-GB":"de-DE",{weekday:"short",day:"2-digit",month:"2-digit"});
(async()=>{
  const r=await fetch("/api/track/stats");
  if(!r.ok){document.getElementById("kpis").innerHTML='<p class="mut">'+(EN?"Could not load.":"Konnte nicht geladen werden.")+'</p>';return}
  const j=await r.json(); const u=j.users[0]; if(!u)return;
  document.getElementById("kpis").innerHTML=
    '<div class="kpi"><b>'+(u.sec24hGeschaetzt?'~':'')+hhmm(u.sec24h)+'</b><span>'+T.timeToday+'</span></div>'+
    '<div class="kpi"><b>'+hhmm(u.weekSeconds)+'</b><span>'+T.timeWeek+'</span></div>'+
    '<div class="kpi"><b>'+hhmm(u.totalSeconds)+'</b><span>'+T.timeTotal+'</span></div>'+
    '<div class="kpi acc"><b>'+u.mails24h+'</b><span>'+T.mails24h+'</span></div>'+
    '<div class="kpi acc"><b>'+u.mailsWeek+'</b><span>'+T.mailsWeek+'</span></div>'+
    '<div class="kpi acc"><b>'+u.mailsTotal+'</b><span>'+T.mailsTotal+'</span></div>'+
    (u.minPerMailWeek!=null?'<div class="kpi"><b>'+String(u.minPerMailWeek).replace(EN?",":".",EN?".":",")+'</b><span>'+T.perMail+'</span></div>':'');
  const mx=Math.max(1,...u.days.map(d=>d.seconds));
  document.getElementById("bars").innerHTML=u.days.map(d=>
    '<div class="bcol"><i>'+(d.seconds?hhmm(d.seconds):"")+'</i>'+
    '<div class="bar" style="height:'+Math.max(3,Math.round(d.seconds/mx*62))+'px"></div>'+
    '<span>'+dayLabel(d.day)+'</span></div>').join("");
  const m=await fetch("/api/track/mails?limit=300");
  const jm=await m.json(); const box=document.getElementById("mails");
  if(!jm.mails||!jm.mails.length){box.innerHTML='<p class="mut">'+T.none+'</p>';return}
  const byDay={}; jm.mails.forEach(x=>{(byDay[x.day]||(byDay[x.day]=[])).push(x)});
  box.innerHTML=Object.keys(byDay).sort().reverse().map(d=>{
    const rows=byDay[d];
    return '<div class="dday">'+dayLabel(d)+' <span>'+rows.length+' '+(rows.length===1?T.mailsOne:T.mailsMany)+'</span></div>'+
      '<table><tbody>'+rows.map(x=>'<tr><td class="t">'+x.time+'</td><td class="tk">#'+esc(x.ticket)+
      '</td><td class="cu">'+esc(x.customer)+'</td><td class="su">'+esc(x.subject)+
      '</td><td class="ch">'+x.chars+' '+T.chars+'</td></tr>').join("")+'</tbody></table>';
  }).join("");
})();
</script></body></html>`
}

// Team-Seite: Organigramm (CEO → Mitarbeitende), Arbeitszeiten, Kontoverwaltung.
// Eigenständige Seite, damit sie unabhängig von der React-App funktioniert.
function teamPageHtml() {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Team · Leichtkraut</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%232f7d5f'/%3E%3Ctext x='50' y='68' font-size='58' text-anchor='middle'%3E%F0%9F%91%A5%3C/text%3E%3C/svg%3E">
<style>
:root{--bg:#f2f5f2;--card:#fff;--ink:#14201a;--mut:#5f7268;--line:#dde6e0;--acc:#2f7d5f;--on:#22a06b;--off:#b3bdb7;--err:#b3261e;--soft:#eef3ef}
@media(prefers-color-scheme:dark){:root{--bg:#0e1512;--card:#161e1a;--ink:#e5ece7;--mut:#93a59a;--line:#26312b;--acc:#5cb890;--on:#4ad991;--off:#4a5952;--err:#e88a83;--soft:#1c2620}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:28px 20px 60px}
.wrap{max-width:820px;margin:0 auto;animation:lkfade .28s ease-out}@keyframes lkfade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.top{display:flex;align-items:center;gap:12px;margin-bottom:4px}
h1{font-size:20px;margin:0;letter-spacing:-.01em}
a.back{margin-left:auto;color:var(--acc);text-decoration:none;font-size:13.5px;font-weight:600}
p.sub{color:var(--mut);font-size:13px;margin:0 0 22px}
.kpis{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:22px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:11px 16px;min-width:120px}
.kpi b{display:block;font-size:21px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.kpi span{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.tree{position:relative;margin-bottom:26px}
.node{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:14px 16px;display:flex;align-items:center;gap:13px;flex-wrap:wrap}
.node.admin{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset}
.kids{margin-left:34px;padding-left:22px;border-left:2px solid var(--line);margin-top:0}
.kids .node{margin-top:14px;position:relative}
.kids .node::before{content:"";position:absolute;left:-22px;top:50%;width:20px;height:2px;background:var(--line)}
.times .sep{width:1px;align-self:stretch;background:var(--line);margin:0 4px}
.detail{flex-basis:100%;display:none}
.detail.open{display:block;margin-top:14px;border-top:1px solid var(--line);padding-top:12px}
.dhead{font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:var(--mut);margin-bottom:10px}
.dmut{color:var(--mut);font-size:13px;padding:4px 0}
.dday{font-size:12px;font-weight:650;margin:12px 0 5px;color:var(--ink)}
.dday span{color:var(--mut);font-weight:500;margin-left:6px}
.dtab{width:100%;border-collapse:collapse;font-size:12.5px}
.dtab td{padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}
.dtab tr:last-child td{border-bottom:0}
.dtab .t{color:var(--mut);white-space:nowrap;font-variant-numeric:tabular-nums;width:46px}
.dtab .tk{color:var(--acc);font-weight:650;white-space:nowrap;width:56px}
.dtab .cu{white-space:nowrap;max-width:150px;overflow:hidden;text-overflow:ellipsis}
.dtab .su{color:var(--mut)}
.dtab .ch{color:var(--mut);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
@media(max-width:820px){.dtab .su,.dtab .ch{display:none}}
.av{width:38px;height:38px;border-radius:50%;background:var(--soft);color:var(--acc);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex:0 0 auto}
.nm{font-weight:650}
.role{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.dot{width:8px;height:8px;border-radius:50%;background:var(--off);display:inline-block;margin-right:5px}
.dot.on{background:var(--on);box-shadow:0 0 0 3px color-mix(in srgb,var(--on) 25%,transparent)}
.times{margin-left:auto;display:flex;gap:18px;text-align:right;flex-wrap:wrap}
.times div b{display:block;font-variant-numeric:tabular-nums;font-size:15px}
.times div span{font-size:10.5px;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.bars{display:flex;gap:3px;align-items:flex-end;height:30px;margin-left:12px}
.bar{width:7px;background:var(--acc);border-radius:2px;opacity:.85;min-height:2px}
button{border:0;background:var(--acc);color:#fff;border-radius:9px;padding:10px 16px;font:inherit;font-weight:650;cursor:pointer}
button.ghost{background:transparent;color:var(--err);border:1px solid var(--line);padding:6px 11px;font-size:12.5px;font-weight:600}
button:disabled{opacity:.6}
.card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:20px}
h2{font-size:15px;margin:0 0 4px}
label{display:block;font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--mut);margin:12px 0 5px}
input,select{width:100%;border:1px solid var(--line);background:transparent;color:var(--ink);border-radius:9px;padding:10px 12px;font:inherit}
input:focus,select:focus{outline:2px solid var(--acc);outline-offset:1px}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1;min-width:170px}
.msg{font-size:13.5px;margin-top:12px;min-height:19px}
.msg.err{color:var(--err)}.msg.ok{color:var(--acc)}
</style></head><body>
<div class="wrap">
  <div class="top"><h1>Team</h1><a class="back" href="/benutzer">🔐 Passwörter verwalten</a><a class="back" href="/">← Zurück zum Postfach</a></div>
  <p class="sub">Konten, Arbeitszeiten und Zugriff · Zeiten in Europe/Berlin</p>
  <div class="kpis" id="kpis"></div>
  <div class="tree" id="tree"></div>
  <div class="card">
    <h2>Neues Mitarbeiterkonto</h2>
    <p class="sub" style="margin:0">Der Zugang gilt sofort. Passwort bitte separat weitergeben.</p>
    <form id="f">
      <div class="row">
        <div><label for="n">Name (Anmeldename)</label><input id="n" required autocomplete="off"></div>
        <div><label for="r">Rolle</label><select id="r"><option value="agent">Mitarbeiter</option><option value="admin">Administrator</option></select></div>
      </div>
      <label for="p">Passwort (min. 8 Zeichen)</label><input id="p" type="password" minlength="8" required autocomplete="new-password">
      <div class="msg" id="m"></div>
      <button id="b" type="submit">Konto anlegen</button>
    </form>
  </div>
</div>
<script>
const hhmm=s=>{s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h?h+" h "+String(m).padStart(2,"0")+" min":m+" min"};
const ini=n=>n.trim().split(/\\s+/).map(x=>x[0]).join("").slice(0,2).toUpperCase();
const esc=s=>String(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function nodeHtml(u,isAdmin){
  const mx=Math.max(1,...u.days.map(d=>d.seconds));
  const bars=u.days.map(d=>'<div class="bar" style="height:'+Math.max(2,Math.round(d.seconds/mx*30))+'px" title="'+d.day+': '+hhmm(d.seconds)+'"></div>').join("");
  // Kopfzeile bleibt kompakt: Zeiten + Mailzahlen. Das Detailprotokoll steckt
  // dahinter und wird erst geladen, wenn jemand "Details" anklickt.
  return '<div class="node'+(isAdmin?' admin':'')+'">'+
    '<div class="av">'+esc(ini(u.name))+'</div>'+
    '<div><div class="nm"><span class="dot'+(u.online?' on':'')+'"></span>'+esc(u.name)+'</div>'+
    '<div class="role">'+(u.role==="admin"?"Administrator":"Mitarbeiter")+(u.online?" · online":(u.lastSeen?" · zuletzt "+new Date(u.lastSeen).toLocaleString("de-DE",{timeZone:"Europe/Berlin",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}):" · noch nie angemeldet"))+'</div></div>'+
    '<div class="bars">'+bars+'</div>'+
    '<div class="times">'+
    '<div><b>'+(u.sec24hGeschaetzt?'~':'')+hhmm(u.sec24h)+'</b><span>24 Std</span></div>'+
    '<div><b>'+hhmm(u.weekSeconds)+'</b><span>7 Tage</span></div>'+
    '<div><b>'+hhmm(u.totalSeconds)+'</b><span>gesamt</span></div>'+
    '<div class="sep"></div>'+
    '<div><b>'+u.mails24h+'</b><span>Mails 24 Std</span></div>'+
    '<div><b>'+u.mailsWeek+'</b><span>Mails 7 T.</span></div>'+
    '<div><b>'+u.mailsTotal+'</b><span>Mails gesamt</span></div>'+
    (u.minPerMailWeek!=null?'<div><b>'+String(u.minPerMailWeek).replace(".",",")+'</b><span>Min./Mail</span></div>':'')+
    '<div><button class="ghost" onclick="details(\\''+u.id+'\\',\\''+esc(u.name)+'\\')">Details</button></div>'+
    (u.role!=="admin"?'<div><button class="ghost" onclick="del(\\''+u.id+'\\',\\''+esc(u.name)+'\\')">Entfernen</button></div>':'')+
    '</div>'+
    '<div class="detail" id="d_'+u.id+'"></div>'+
    '</div>';
}
// Aufklapp-Protokoll: welche Mail, wann, an wen, zu welchem Ticket.
async function details(id,name){
  const box=document.getElementById("d_"+id);
  if(box.classList.contains("open")){ box.classList.remove("open"); box.innerHTML=""; return }
  box.classList.add("open"); box.innerHTML='<div class="dmut">lädt …</div>';
  try{
    const r=await fetch("/api/track/mails?user="+encodeURIComponent(id)+"&limit=300");
    const j=await r.json();
    if(!j.mails.length){ box.innerHTML='<div class="dmut">Noch keine gesendeten E-Mails erfasst.</div>'; return }
    const dayName=(d)=>{const dt=new Date(d+"T12:00:00");return dt.toLocaleDateString("de-DE",{weekday:"short",day:"2-digit",month:"2-digit"})};
    const byDay={}; j.mails.forEach(m=>{(byDay[m.day]||(byDay[m.day]=[])).push(m)});
    const zf={p:0,m:0,n:0}; j.mails.forEach(m=>{ if(m.reaction==="positiv")zf.p++; else if(m.reaction==="negativ")zf.n++; else if(m.reaction==="neutral")zf.m++; });
    let html='<div class="dhead">'+esc(name)+' · '+j.total+' gesendete E-Mail'+(j.total===1?"":"en")+((zf.p+zf.m+zf.n)?' · Reaktionen: \uD83D\uDE0A'+zf.p+' \uD83D\uDE10'+zf.m+' \uD83D\uDE21'+zf.n:'')+'</div>';
    Object.keys(byDay).sort().reverse().forEach(d=>{
      const rows=byDay[d];
      html+='<div class="dday">'+dayName(d)+' <span>'+rows.length+' Mail'+(rows.length===1?"":"s")+'</span></div>';
      html+='<table class="dtab"><tbody>'+rows.map(m=>
        '<tr>'+
        '<td class="t">'+m.time+'</td>'+
        '<td class="tk">#'+esc(String(m.ticket))+'</td>'+
        '<td class="cu">'+esc(m.customer)+'</td>'+
        '<td class="su" title="'+esc(m.preview)+'">'+esc(m.subject)+'</td>'+
        '<td class="ch">'+m.chars+' Z.</td>'+
        '<td class="zf" title="Kundenreaktion auf diese Antwort">'+(m.reaction==="positiv"?"\uD83D\uDE0A":m.reaction==="negativ"?"\uD83D\uDE21":m.reaction==="neutral"?"\uD83D\uDE10":"")+'</td>'+
        '</tr>').join("")+'</tbody></table>';
    });
    box.innerHTML=html;
  }catch(e){ box.innerHTML='<div class="dmut">Konnte nicht geladen werden.</div>' }
}
async function load(){
  const r=await fetch("/api/track/stats"); if(r.status===403){document.getElementById("tree").innerHTML="<p>Nur für Administratoren.</p>";return}
  const j=await r.json();
  const admins=j.users.filter(u=>u.role==="admin"), agents=j.users.filter(u=>u.role!=="admin");
  document.getElementById("kpis").innerHTML=
    '<div class="kpi"><b>'+j.users.length+'</b><span>Konten</span></div>'+
    '<div class="kpi"><b>'+j.users.filter(u=>u.online).length+'</b><span>gerade online</span></div>'+
    '<div class="kpi"><b>'+hhmm(j.users.reduce((a,u)=>a+u.sec24h,0))+'</b><span>Arbeitszeit 24 Std</span></div>'+
    '<div class="kpi"><b>'+(j.letzte24h?j.letzte24h.sentMails:j.today.sentMails)+'</b><span>Mails 24 Std</span></div>'+
    '<div class="kpi"><b>'+j.week.sentMails+'</b><span>Mails 7 Tage</span></div>'+
    (!j.zeitMessungSeit || j.zeitMessungSeit > Date.now()-24*3600000
      ? '<div class="kpi" style="opacity:.75"><b style="font-size:13px">Zeitfenster füllt sich</b><span>'
        + (j.zeitMessungSeit
            ? 'Genaue Messung läuft seit ' + new Date(j.zeitMessungSeit).toLocaleString("de-DE",{timeZone:"Europe/Berlin",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}) + '. Mit ~ markierte Zeiten davor sind aus den Tagessummen geschätzt.'
            : 'Genaue Messung startet mit der nächsten Aktivität. Mit ~ markierte Zeiten sind bis dahin aus den Tagessummen geschätzt.')
        + '</span></div>'
      : '');
  document.getElementById("tree").innerHTML=admins.map(a=>nodeHtml(a,true)).join("")+
    (agents.length?'<div class="kids">'+agents.map(u=>nodeHtml(u,false)).join("")+'</div>':'<div class="kids"><div class="node" style="color:var(--mut)">Noch keine Mitarbeiterkonten</div></div>');
}
async function del(id,name){
  if(!confirm("Konto \\""+name+"\\" wirklich entfernen? Die Person wird sofort abgemeldet."))return;
  await fetch("/api/auth/users/"+id,{method:"DELETE"}); load();
}
document.getElementById("f").addEventListener("submit",async e=>{
  e.preventDefault();const m=document.getElementById("m"),b=document.getElementById("b");
  m.className="msg";m.textContent="";b.disabled=true;
  const body={name:document.getElementById("n").value,password:document.getElementById("p").value,role:document.getElementById("r").value};
  const r=await fetch("/api/auth/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const j=await r.json();
  if(!r.ok){m.className="msg err";m.textContent=j.error||"Fehler";}
  else{m.className="msg ok";m.textContent="Konto \\""+j.user.name+"\\" angelegt.";document.getElementById("n").value="";document.getElementById("p").value="";load();}
  b.disabled=false;
});
load(); setInterval(load,20000);
</script></body></html>`
}

// ═════════════════════════════════════════════════════════════════════════════
// LEICHTKRAUT OPERATING SYSTEM (Samuel, 05.09.2026) — os.leichtkraut.de
// Kommandozentrale: Mind-Map aller Systeme/Chats, Ad-Workflow, Live-Zahlen,
// Versionen. Daten in data/os.json, Seite in pages/os.html, Charta in
// data/os-charta.md. Admin-only. Snapshots nach versions/os-v<X>/.
// ═════════════════════════════════════════════════════════════════════════════
const OS_FILE = path.join(DATA_DIR, 'os.json')
const OS_PAGE = path.join(__dirname, 'pages', 'os.html')
const OS_CHARTA = path.join(DATA_DIR, 'os-charta.md')
const OS_VERS = path.join(__dirname, 'versions')
function osLesen() { try { return JSON.parse(fs.readFileSync(OS_FILE, 'utf8')) } catch { return { version: '1.0', nodes: [], edges: [], chats: [], workflow: [], changelog: [] } } }
function osSchreiben(d) { const t = OS_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 2)); fs.renameSync(t, OS_FILE) }
function osVersionen() { try { return fs.readdirSync(OS_VERS).filter((n) => n.startsWith('os-v')).map((n) => ({ name: n, at: fs.statSync(path.join(OS_VERS, n)).mtime.toISOString() })).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })) } catch { return [] } }
const nurAdminSeite = (req, res) => { const u = sessionUser(req); if (!u) { res.redirect('/login'); return null } if (u.role !== 'admin') { res.redirect('/'); return null } return u }
// Auf os.leichtkraut.de ist die Startseite das OS, nicht das Mail-Tool.
app.use((req, res, next) => { const h = String(req.hostname || ''); if (h.startsWith('os.') && req.path === '/') return res.redirect('/os'); if (h.startsWith('kommentare.') && req.path === '/') return res.redirect('/kommentare'); next() })
// Uebergabe + Handbuch fuer den Kommentar-Manager (Chat 2)
app.get('/kommentare/handover', (req, res) => { if (!nurAdminSeite(req, res)) return; res.setHeader('Cache-Control', 'no-store'); const f = path.join(DATA_DIR, 'kommentare-handover.md'); res.type('text/markdown; charset=utf-8').send(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Übergabe fehlt') })
app.get('/kommentare/handbuch', (req, res) => { if (!nurAdminSeite(req, res)) return; res.setHeader('Cache-Control', 'no-store'); const f = path.join(DATA_DIR, 'meta-kommentar-regeln.md'); res.type('text/markdown; charset=utf-8').send(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Handbuch fehlt') })
app.get(['/os', '/os/'], (req, res) => { if (!nurAdminSeite(req, res)) return; res.setHeader('Cache-Control', 'no-store'); res.type('html').send(fs.readFileSync(OS_PAGE, 'utf8')) })
app.get('/os/handover', (req, res) => { if (!nurAdminSeite(req, res)) return; res.setHeader('Cache-Control', 'no-store'); const f = path.join(DATA_DIR, 'os-handover.md'); res.type('text/markdown; charset=utf-8').send(fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Übergabe fehlt') })
app.get('/os/charta', (req, res) => { if (!nurAdminSeite(req, res)) return; res.setHeader('Cache-Control', 'no-store'); res.type('text/markdown; charset=utf-8').send(fs.existsSync(OS_CHARTA) ? fs.readFileSync(OS_CHARTA, 'utf8') : '# Charta fehlt') })
app.get('/api/os', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const d = osLesen(); res.json({ ...d, versionen: osVersionen(), jetzt: new Date().toISOString() }) })
app.post('/api/os/node/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d = osLesen(); const n = (d.nodes || []).find((x) => x.id === req.params.id)
  if (!n) return res.status(404).json({ error: 'Knoten unbekannt' })
  const b = req.body || {}
  if (typeof b.status === 'string') n.status = b.status.slice(0, 40)
  if (typeof b.notiz === 'string') n.notiz = b.notiz.slice(0, 4000)
  if (Array.isArray(b.todos)) n.todos = b.todos.slice(0, 50).map((t) => ({ text: String(t.text || '').slice(0, 300), done: !!t.done }))
  n.updatedAt = new Date().toISOString(); n.updatedBy = req.user.name
  osSchreiben(d); res.json({ ok: true, node: n })
})
app.post('/api/os/snapshot', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d = osLesen(); const b = req.body || {}
  const ver = String(b.version || '').trim() || (() => { const [a, c] = String(d.version || '1.0').split('.'); return `${a}.${(parseInt(c || '0', 10) || 0) + 1}` })()
  if (!/^\d+\.\d+$/.test(ver)) return res.status(400).json({ error: 'Version wie 1.2 angeben' })
  const dir = path.join(OS_VERS, `os-v${ver}`)
  if (fs.existsSync(dir)) return res.status(400).json({ error: `Version ${ver} existiert schon` })
  d.version = ver
  d.changelog = [{ version: ver, at: new Date().toISOString(), by: req.user.name, text: String(b.text || 'Snapshot').slice(0, 500) }].concat(d.changelog || []).slice(0, 200)
  osSchreiben(d)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of [OS_PAGE, OS_FILE, OS_CHARTA]) if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)))
  res.json({ ok: true, version: ver, versionen: osVersionen() })
})

// Live-Zahlen fuer die OS-Startseite (Mail, Kommentare, KI-Verbrauch)
app.get('/api/os/live', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const jetzt = Date.now(), t24 = jetzt - 86400_000
  const inb = readInbound(); let arch = []; try { arch = readArchiv() } catch {}
  let mailsOffen = 0, mailsIn24 = 0, mailsOut24 = 0
  for (const t of inb) {
    const ms = (t.messages || []).filter((m) => !m.auto_ack)
    const last = ms[ms.length - 1]
    if (t.status === 'open' && last && last.direction === 'in' && !(t.snooze_until && Date.parse(t.snooze_until) > jetzt)) mailsOffen++
    for (const m of ms) { const at = Date.parse(m.created_at || 0) || 0; if (at < t24) continue; if (m.direction === 'in') mailsIn24++; else if (m.direction === 'out') mailsOut24++ }
  }
  let kom = {}; try { const k = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta-kommentare.json'), 'utf8')); kom = { offen: k.videos.reduce((a, v) => a + v.counts.offen, 0), rot: k.videos.reduce((a, v) => a + v.counts.rot, 0), nachfragen: k.videos.reduce((a, v) => a + (v.counts.nachfragen || 0), 0), scannedAt: k.scannedAt, liveCheckAt: k.liveCheckAt } } catch {}
  let aiHeute = null; try { const u = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'ai-usage.json'), 'utf8')); const tag = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date()); aiHeute = Object.values(u[tag] || {}).reduce((a, x) => a + (x.calls || 0), 0) } catch {}
  res.json({ mailsOffen, mailsIn24, mailsOut24, tickets: inb.length + arch.length, kommentareOffen: null, kommentareRot: null, nachfragen: null, kommentareStillgelegt: 'seit 14.09.2026, Chat 5 seit 04.10. To-Do & Planung; Altstand bleibt in data/meta-kommentare.json', kommentareStand: kom.liveCheckAt || kom.scannedAt || null, aiHeute, jetzt: new Date().toISOString() })
})
// Ablage: /opt/os/ads/<ad-id>/<datei> — die Bruecke zwischen den Chats (siehe Charta)
const OS_ADS = '/opt/os/ads'
const adIdOk = (s) => /^[a-z0-9][a-z0-9._-]{2,80}$/i.test(String(s || ''))
const adFileOk = (s) => /^(script\.md|meta\.json|avatar\.json|analyse\.md|analyse\.json|page\.json|copy\.json|zuweisung\.json|upload\.json|notiz\.md|freigabe\.json|archiv\.json)$/.test(String(s || ''))
app.get('/api/os/ads', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  let ads = []
  try { ads = fs.readdirSync(OS_ADS).filter((n) => adIdOk(n)).map((n) => { const dir = path.join(OS_ADS, n); const dateien = fs.readdirSync(dir); const at = dateien.reduce((m, f) => Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs), fs.statSync(dir).mtimeMs); return { id: n, dateien, at: new Date(at).toISOString() } }).sort((a, b) => b.at.localeCompare(a.at)) } catch {}
  res.json({ ads })
})
app.get('/api/os/ads/:id/:datei', (req, res, next) => {
  if (adVideoOk(req.params.datei) || adBildOk(req.params.datei) || req.params.datei === 'poster.jpg' || req.params.datei === 'video-link') return next()   // eigene Routen weiter unten
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (!adIdOk(req.params.id) || !adFileOk(req.params.datei)) return res.status(400).json({ error: 'Ungültiger Name' })
  const f = path.join(OS_ADS, req.params.id, req.params.datei)
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Nicht vorhanden' })
  res.type(req.params.datei.endsWith('.json') ? 'application/json' : 'text/markdown; charset=utf-8').send(fs.readFileSync(f, 'utf8'))
})
app.post('/api/os/ads/:id/:datei', express.text({ type: '*/*', limit: '2mb' }), (req, res, next) => {
  if (/^(freigabe|launched|archiv)$/.test(req.params.datei)) return next()   // eigene Routen weiter unten
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (!adIdOk(req.params.id) || !adFileOk(req.params.datei)) return res.status(400).json({ error: 'Ungültiger Name (ad-id: JJJJMMTT-kurzname; Datei: script.md, meta.json, avatar.json, page.json, upload.json, notiz.md)' })
  const dir = path.join(OS_ADS, req.params.id); fs.mkdirSync(dir, { recursive: true })
  let inhalt = typeof req.body === 'string' ? req.body : JSON.stringify(req.body, null, 2)
  if (req.params.datei.endsWith('.json')) { try { JSON.parse(inhalt) } catch { return res.status(400).json({ error: 'Kein gültiges JSON' }) } }
  const f = path.join(dir, req.params.datei)
  // copy.json und page.json: vorhandene Felder bleiben, neue kommen dazu (Chat 1 und Chat 3 schreiben beide hinein)
  if (/^(copy|page)\.json$/.test(req.params.datei) && fs.existsSync(f)) { try { const alt = JSON.parse(fs.readFileSync(f, 'utf8')), neu = JSON.parse(inhalt); if (alt && typeof alt === 'object' && !Array.isArray(alt) && neu && typeof neu === 'object' && !Array.isArray(neu)) inhalt = JSON.stringify(Object.assign({}, alt, neu), null, 2) } catch {} }
  if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-' + Date.now())   // Charta: vor jeder Aenderung ein Backup
  fs.writeFileSync(f, inhalt)
  console.log(`[os] Ablage ${req.params.id}/${req.params.datei} geschrieben von ${req.user.name}`)
  res.json({ ok: true, pfad: `${req.params.id}/${req.params.datei}` })
})

// ── OS-MODULE (OS Manager, 05.09.2026): Echtzeit-Kanal, Ads-Register, Kommentare, Stock, Profit, Team ──
// Modul-Daten liegen als eine JSON-Datei je Modul in data/os-module/. Andere Chats
// liefern per POST /api/os/modul/<name> mit Service-Token. Der Browser haengt an
// /api/os/stream (Server-Sent Events) und bekommt jede Dateiaenderung sofort.
const OS_MODUL_DIR = path.join(DATA_DIR, 'os-module'); try { fs.mkdirSync(OS_MODUL_DIR, { recursive: true }) } catch {}
const OS_MODULE = ['profit', 'stock', 'sheet', 'team', 'notizen', 'planung']
function modulLesen(n) { try { return JSON.parse(fs.readFileSync(path.join(OS_MODUL_DIR, n + '.json'), 'utf8')) } catch { return null } }
function modulSchreiben(n, d) {
  const f = path.join(OS_MODUL_DIR, n + '.json')
  if (fs.existsSync(f)) { fs.copyFileSync(f, f + '.bak-' + Date.now()); try { const baks = fs.readdirSync(OS_MODUL_DIR).filter((x) => x.startsWith(n + '.json.bak-')).sort(); for (const b of baks.slice(0, Math.max(0, baks.length - 10))) fs.unlinkSync(path.join(OS_MODUL_DIR, b)) } catch {} }
  const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(d, null, 2)); fs.renameSync(t, f)
}
// Echtzeit: alle verbundenen Browser bekommen jedes Ereignis in unter einer Sekunde.
const osClients = new Set()
let osPush = function (typ, extra) { const msg = `event: ${typ}\ndata: ${JSON.stringify(Object.assign({ typ, at: new Date().toISOString() }, extra || {}))}\n\n`; for (const r of osClients) { try { r.write(msg) } catch {} } }
app.get('/api/os/stream', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).end()
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.write('event: hallo\ndata: {"clients":' + (osClients.size + 1) + '}\n\n')
  osClients.add(res); req.on('close', () => osClients.delete(res))
})
setInterval(() => { for (const r of osClients) { try { r.write(': ping\n\n') } catch {} } }, 25000)
// Dateien beobachten, entprellt (ein Schreibvorgang loest oft mehrere Events aus)
const osTimer = {}
function osBeobachten(ziel, typ, rekursiv) {
  try {
    const istDir = fs.existsSync(ziel) && fs.statSync(ziel).isDirectory()
    const dir = istDir ? ziel : path.dirname(ziel), base = path.basename(ziel)
    fs.watch(dir, { persistent: false, recursive: !!rekursiv && istDir }, (ev, name) => {
      if (!istDir && name !== base) return
      if (typ === 'ads') regCacheLeeren()
      clearTimeout(osTimer[typ]); osTimer[typ] = setTimeout(() => osPush(typ, { datei: name || base }), 250)
    })
  } catch (e) { console.warn('[os] Beobachten fehlgeschlagen:', ziel, e.message) }
}
osBeobachten(path.join(DATA_DIR, 'meta-kommentare.json'), 'kommentare')
osBeobachten(path.join(DATA_DIR, 'inbound.json'), 'mails')
osBeobachten(OS_FILE, 'os')
osBeobachten(OS_MODUL_DIR, 'modul')
try { fs.mkdirSync(OS_ADS, { recursive: true }) } catch {}
osBeobachten(OS_ADS, 'ads', true)

// Ads-Register: Ablage-Ordner (Pipeline-Stand) plus das, was laut Kommentar-Manager wirklich im Ads Manager laeuft
let komCache = { mtime: 0, live: [] }
// ── Meta-Abgleich (03.10.): aktives Werbekonto stuendlich lesen, nur Status und Spend je Anzeige. Zwei Aufrufe pro Stunde.
// Token: ausschliesslich META_READER_TOKEN (eigene OS-App „Leichtkraut OS Reader“). Konten: META_AD_ACCOUNTS (Komma), Standard das Backup-Konto.
const META_KONTEN = (process.env.META_AD_ACCOUNTS || 'act_0000000000').split(',').map((x) => x.trim()).filter(Boolean)
const META_KONTO_FILE = path.join(DATA_DIR, 'os-module/meta-konto.json')
function metaKontoLesen() { try { return JSON.parse(fs.readFileSync(META_KONTO_FILE, 'utf8')) } catch { return { stand: null, ads: {}, fehler: null } } }
async function metaKontoHolen() {
  // Nur ein eigener Lese-Token: der Systemtoken teilt sein Kontingent mit dem Uploader (03.10. sofort "User request limit reached")
  const tok = process.env.META_READER_TOKEN || ''; if (!tok) return
  const neu = { stand: new Date().toISOString(), konten: META_KONTEN, ads: {}, fehler: null }
  const alle = async (url) => { let out = [], u = url; for (let i = 0; u && i < 40; i++) { const r = await fetch(u); const j = await r.json(); if (j.error) throw new Error(j.error.message); out = out.concat(j.data || []); u = j.paging && j.paging.next } return out }
  try {
    for (const k of META_KONTEN) {
      const ads = await alle(`https://graph.facebook.com/v21.0/${k}/ads?fields=id,effective_status&limit=500&access_token=${encodeURIComponent(tok)}`)
      for (const a of ads) neu.ads[a.id] = { status: a.effective_status, spend7: 0, konto: k }
      const ins = await alle(`https://graph.facebook.com/v21.0/${k}/insights?level=ad&fields=ad_id,spend&date_preset=last_7d&limit=500&access_token=${encodeURIComponent(tok)}`)
      for (const x of ins) { if (neu.ads[x.ad_id]) neu.ads[x.ad_id].spend7 = Number(x.spend) || 0 }
    }
    fs.writeFileSync(META_KONTO_FILE + '.tmp', JSON.stringify(neu)); fs.renameSync(META_KONTO_FILE + '.tmp', META_KONTO_FILE); regCacheLeeren()
    console.log(`[os] Meta-Abgleich: ${Object.keys(neu.ads).length} Anzeigen aus ${META_KONTEN.join(', ')}`)
  } catch (e) { const alt = metaKontoLesen(); alt.fehler = { at: new Date().toISOString(), text: String(e.message).slice(0, 200) }; try { fs.writeFileSync(META_KONTO_FILE, JSON.stringify(alt)) } catch {} console.warn('[os] Meta-Abgleich:', e.message) }
}
setTimeout(() => metaKontoHolen().catch(() => {}), 20_000); setInterval(() => metaKontoHolen().catch(() => {}), 60 * 60_000)

// Standard-Kampagne im aktiven Werbekonto nach Format, nur fuer noch nicht gelaunchte Ads und nur wenn copy.json keine nennt (03.10., Chat 1)
const KAMPAGNEN = { MOF: '🟡 MOF | Testing #1 | CBO | 27.09.2026', BOF: '🔴 BOF | Testing #1 | CBO | 29.09.2026', TOF: '🟢 TOF | Testing #1 | CBO | 04.10.2026' }
// Product-Page-Check (Sam, 03.10.): jede pdp alle 10 Minuten aufrufen (Weiterleitungen folgen). Kaputte Seite (4xx/5xx) sperrt die Ad
// ueber fehlend pdp_kaputt, damit nichts auf eine 404 hochgeladen wird. Cache in data/os-module/pdp-check.json.
const PDP_CHECK_FILE = path.join(OS_MODUL_DIR, 'pdp-check.json')
let pdpCache = (() => { try { return JSON.parse(fs.readFileSync(PDP_CHECK_FILE, 'utf8')) } catch { return {} } })()
const pdpNeu = new Set(), pdpGesehen = new Map(); let pdpNeuTimer = null
async function pdpEinzeln(u) {
  let code = 0, ziel = u, fehler = null
  try { const r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'LeichtkrautOS-PDP-Check/1.0' } }); code = r.status; ziel = r.url || u; try { await r.body?.cancel() } catch {} }
  catch (e) { fehler = String((e && e.message) || e).slice(0, 120) }
  pdpCache[u] = { code, ok: code >= 200 && code < 400, ziel, fehler, at: new Date().toISOString() }
}
async function pdpAllePruefen(urls) {
  for (let i = 0; i < urls.length; i += 4) await Promise.all(urls.slice(i, i + 4).map(pdpEinzeln))
  try { fs.writeFileSync(PDP_CHECK_FILE, JSON.stringify(pdpCache, null, 1)) } catch {}
}
function pdpStatus(u) {
  if (!u || !/^https?:\/\//i.test(u)) return null
  pdpGesehen.set(u, Date.now())
  if (!(u in pdpCache)) { pdpCache[u] = null; pdpNeu.add(u); if (!pdpNeuTimer) pdpNeuTimer = setTimeout(() => { const l = [...pdpNeu]; pdpNeu.clear(); pdpNeuTimer = null; pdpAllePruefen(l).catch(() => {}) }, 3000) }
  return pdpCache[u] || null
}
// Nur Seiten pruefen, die eine Ad noch nutzt; was seit 1 Stunde keine Ad mehr nennt, faellt aus der Liste
setInterval(() => { const grenze = Date.now() - 60 * 60_000; for (const u of Object.keys(pdpCache)) if (!pdpGesehen.has(u) || pdpGesehen.get(u) < grenze) { if (pdpGesehen.size) delete pdpCache[u] } pdpAllePruefen(Object.keys(pdpCache)).catch(() => {}) }, 10 * 60_000)
// Funnel-Stufe (Sam, 03.10.): SW Star-Wars-Ads = TOF (am wenigsten aware), SA Singing und EL Sprech = MOF, BOF/BB Angebot = BOF (most aware)
const PDP_HAUPT = /leichtkraut\.de\/products\/(leichtkraut|leichtkraut-manner|leichtkraut-maenner)\/?(\?|#|$)/i
// Copy-Check: Fehler sperren die Freigabe, Hinweise zeigt das OS nur an (05.10., Sam)
const COPY_REGELN = {
  fehler: [[/\bdetox/i, 'Verbotenes Wort: Detox'], [/wundermittel/i, 'Verbotenes Wort: Wundermittel'], [/\bheil(t|en|ung)\b/i, 'Heilversprechen (heilt, heilen, Heilung)'], [/jetzt zuschlagen/i, 'Verbotene Formel: Jetzt zuschlagen'],
    [/(eine|1)\s+(volle\s+)?pipette\s+(am|pro|jeden)\s+tag/i, 'Dosierung falsch, richtig: eine Pipette morgens und eine Pipette abends']],
  hinweise: [[/geld.?zur(ü|ue)ck/i, 'Geld-zurück: Rückgabe gilt nur für ungeöffnete Flaschen'], [/ausverkauft|letzte (charge|kisten?)|solange der vorrat|nur noch \d+ (flaschen|stück)/i, 'Knappheit: nur zulässig, wenn sie stimmt'],
    [/\b(ist|sind) (einfach )?weg\b|in \d+ (tagen|wochen)\b[^.!?]*\b(weg|flach|schlank)/i, 'Vorher-Nachher-Versprechen: Meta-Risiko'], [/[–—]/, 'Gedankenstrich im Text']]
}
const SHOP_PREISE = ['49,99', '69,99', '79,99', '44,99', '64,99', '74,99', '199,96']
function copyPruefen(t) {
  const s = String(t || ''); const fehler = COPY_REGELN.fehler.filter(([r]) => r.test(s)).map(([, m]) => m), hinweise = COPY_REGELN.hinweise.filter(([r]) => r.test(s)).map(([, m]) => m)
  const preise = [...new Set([...s.matchAll(/(\d{1,3})[,.](\d{2})\s*(€|euro)/gi)].map((m) => m[1] + ',' + m[2]))].filter((p) => !SHOP_PREISE.includes(p))
  if (preise.length) hinweise.push('Preis nicht im Shop: ' + preise.join(' €, ') + ' €')
  return { fehler, hinweise }
}
function funnelVon(mt) {
  mt = mt || {}; const serie = String(mt.serie || '').toUpperCase(), alles = [mt.serie, mt.paket, mt.titel].join(' ')
  if (mt.funnel && /^(TOF|MOF|BOF)$/i.test(mt.funnel)) return String(mt.funnel).toUpperCase()
  if (serie === 'BOF' || /\bBB\b|-bb-|-bof-/i.test(alles)) return 'BOF'
  if (serie === 'SW' || serie === 'NA' || /native|star.?wars|\bSW\b|\bNA\b/i.test(alles)) return 'TOF'
  if (serie === 'SA' || serie === 'EL' || /singing|sprech|\b(SA|EL)\b/i.test(alles)) return 'MOF'
  return null
}
function kampagneVorschlag(mt) { const f = funnelVon(mt); return f ? KAMPAGNEN[f] : null }
function komLive() {
  const f = path.join(DATA_DIR, 'meta-kommentare.json'); let mt = 0; try { mt = fs.statSync(f).mtimeMs } catch { return [] }
  if (mt === komCache.mtime) return komCache.live
  const name = (x) => (x && typeof x === 'object') ? (x.name || x.id || '') : (x || '')
  let live = []
  try {
    const k = JSON.parse(fs.readFileSync(f, 'utf8'))
    live = (k.videos || []).map((v) => ({ key: v.key, id: v.id, pageName: v.pageName || '', text: String(v.text || '').slice(0, 160), createdAt: v.createdAt || null, campaign: name(v.campaign), adset: name(v.adset), ads: (v.ads || []).map((a) => ({ id: String(a.id), name: a.name, status: a.status })), aktiv: (v.ads || []).filter((a) => a.status === 'ACTIVE').length, thumb: v.media?.thumb || null, insights: v.insights ? { impressions: v.insights.impressions, reach: v.insights.reach, spend: v.insights.spend, clicks: v.insights.clicks, linkClicks: v.insights.linkClicks, comments: v.insights.comments, shares: v.insights.shares } : null, counts: v.counts || null, letzteAktivitaet: v.letzteAktivitaet || null }))
    live.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  } catch {}
  komCache = { mtime: mt, live }; return live
}
let regCache = { at: 0, wert: null }
function osAdsRegister() {
  if (regCache.wert && Date.now() - regCache.at < 2000) return regCache.wert
  const r = osAdsRegisterRoh(); regCache = { at: Date.now(), wert: r }; return r
}
function osAdsRegisterRoh() {
  const lies = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
  const name = (x) => (x && typeof x === 'object') ? (x.name || x.id || '') : (x || '')
  let ordner = []; try { ordner = fs.readdirSync(OS_ADS).filter((n) => adIdOk(n) && fs.statSync(path.join(OS_ADS, n)).isDirectory()) } catch {}
  // Stamm-Ordner ohne Video (nur Analyse/Page fuer Hook-Varianten) nicht als eigene Ad zaehlen
  ordner = ordner.filter((n) => { const hatVideo = fs.readdirSync(path.join(OS_ADS, n)).some((f) => /\.(mp4|mov)$/i.test(f) || f === 'meta.json'); return hatVideo || !ordner.some((o) => o !== n && o.startsWith(n + '-h')) })
  const ads = ordner.map((id) => {
    const dir = path.join(OS_ADS, id); const dateien = fs.readdirSync(dir).filter((f) => !/\.bak-\d+$/.test(f) && !f.endsWith('.tmp'))
    const stamm = id.replace(/-h\d+$/i, ''); const stammDir = stamm !== id ? path.join(OS_ADS, stamm) : null
    // Vererbung je Feld, nicht je Datei: eine Teil-Datei in der Hook-Fassung (z. B. nur ziel_adset) darf die Copy des Stamms nicht verdecken.
    const erbe = (f) => { const eig = lies(path.join(dir, f)); const st = (stammDir && fs.existsSync(stammDir)) ? lies(path.join(stammDir, f)) : null
      const obj = (x) => x && typeof x === 'object' && !Array.isArray(x)
      if (obj(eig) && obj(st)) { const m = Object.assign({}, st); for (const k of Object.keys(eig)) { const v = eig[k]; if (v !== null && v !== undefined && v !== '') m[k] = v } return m }
      return eig || st }
    const erbeText = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8') } catch {} try { return stammDir ? fs.readFileSync(path.join(stammDir, f), 'utf8') : null } catch { return null } }
    const meta = lies(path.join(dir, 'meta.json')), avatar = erbe('avatar.json'), page = erbe('page.json'), upload = lies(path.join(dir, 'upload.json')), analyse = erbe('analyse.json'), freigabe = erbe('freigabe.json') || {}
    const copy = erbe('copy.json'), zuweisung = lies(path.join(dir, 'zuweisung.json')) || erbe('zuweisung.json'), archiv = lies(path.join(dir, 'archiv.json'))
    const analyseMd = erbeText('analyse.md')
    const at = dateien.reduce((m, f) => { try { return Math.max(m, fs.statSync(path.join(dir, f)).mtimeMs) } catch { return m } }, fs.statSync(dir).mtimeMs)
    const analyseDa = !!(avatar || analyse || analyseMd)
    const schritte = { script: dateien.includes('script.md'), video: dateien.some((f) => /\.(mp4|mov)$/i.test(f) || adBildOk(f)) || !!meta, avatar: analyseDa, analyseOk: !!freigabe.analyse, page: !!page, pageOk: !!freigabe.page, upload: !!upload }
    const direkt = (osLesen().pipelineModus || 'direkt') === 'direkt' || !!(meta && meta.direkt)
    // Schranken: nach Analyse und nach Page prueft Sam und gibt frei
    const schr = Object.assign({ analyse: false, page: false }, osLesen().schranken || {})
    const analyseOk = analyseDa && (!schr.analyse || !!freigabe.analyse), pageOk = !!page && (!schr.page || !!freigabe.page)
    schritte.analyseOk = analyseOk; schritte.pageOk = pageOk; schritte.schranken = schr
    const status = upload ? 'gelauncht'
      : (direkt && schritte.video) ? 'bereit zum Upload'
      : pageOk ? 'bereit zum Upload'
      : page ? 'Page prüfen'
      : analyseOk ? 'Page offen'
      : analyseDa ? 'Analyse prüfen'
      : schritte.video ? 'Analyse offen' : schritte.script ? 'in Produktion' : 'angelegt'
    const adIds = [].concat(upload?.adIds || upload?.ad_ids || upload?.ads || []).map((x) => String(typeof x === 'object' ? x.id : x))
    const video = dateien.find((f) => /\.(mp4|mov)$/i.test(f)) || null; const bild = dateien.find((f) => adBildOk(f) && !/_(1x1|9x16)\./i.test(f)) || dateien.find((f) => /^image_1x1\./i.test(f)) || null,   // Native-Bilder gibt es nur in 1:1 (05.10., Chat 8)
      bild1x1 = dateien.find((f) => /^image_1x1\./i.test(f)) || null, bild9x16 = dateien.find((f) => /^image_9x16\./i.test(f)) || null; const poster = dateien.includes('poster.jpg')
    // Vorschaubild neu, wenn Bild oder Video neuer ist als das alte Vorschaubild (06.10.: NA 008 zeigte noch das getauschte Bild)
    const posterAlt = poster && (video || bild) && (() => { try { return fs.statSync(path.join(dir, 'poster.jpg')).mtimeMs + 1000 < fs.statSync(path.join(dir, bild || video)).mtimeMs } catch { return false } })()
    if ((video || bild) && (!poster || posterAlt)) posterErzeugen(id); let videoBytes = null; try { videoBytes = video ? fs.statSync(path.join(dir, video)).size : null } catch {}
    // Pflichtfelder fuer den Uploader (Zustandsmodell: entwurf, analyse_offen, freigegeben, hochgeladen, gelauncht, pausiert, archiviert)
    const c = copy || {}, mt = meta || {}, av = avatar || {}
    // BOF nur aus eindeutigen Merkmalen: Serie BOF, Paketname mit -bof-, Titel mit BOF, oder ausdruecklich bof true/false in meta.json oder copy.json.
    // Frueher reichte ein Angebot in der Copy; Chat 3 schreibt aber in jede Copy ein Angebot, dadurch waren 110 Testing-Ads faelschlich BOF (19.09., Chat 1).
    const bofExplizit = [mt.bof, c.bof].find((x) => x === true || x === false)
    const istBof = bofExplizit !== undefined ? bofExplizit : (/^bof$/i.test(String(mt.serie || '')) || /(^|[-_ ])bof([-_ ]|$)/i.test(String(mt.paket || '')) || /\bBOF\b/.test(String(mt.titel || '')))
    const felder = {
      primary_text: c.primary_text || null, headline: c.headline || null, description: c.description || null,
      pdp: (page && (page.url || page.pdp)) || c.pdp || null, page: (zuweisung && zuweisung.page) || c.page || null,
      ziel_kampagne: c.ziel_kampagne || (upload ? null : kampagneVorschlag(mt)), ziel_adset: c.ziel_adset || null,
      angle: c.angle || (page && page.angle) || av.angle || mt.angle || null, geschlecht: c.geschlecht || av.geschlecht || mt.geschlecht || null,
      ethnie: c.ethnie || mt.ethnie || av.ethnie || null, offer: c.offer || null
    }
    const pflicht = ['primary_text', 'headline', 'description', 'pdp', 'page', 'ziel_kampagne', 'angle', 'geschlecht'].concat(istBof ? ['offer'] : [])
    const fehlend = pflicht.filter((k) => !felder[k])
    const pdpCheck = pdpStatus(felder.pdp); if (felder.pdp && pdpCheck && !pdpCheck.ok) fehlend.push('pdp_kaputt')
    // TOF und BOF brauchen eine eigene Product Page, die Hauptseiten zaehlen nicht (05.10., Sam)
    const funnel = funnelVon(meta); if ((funnel === 'BOF' || funnel === 'TOF') && felder.pdp && PDP_HAUPT.test(felder.pdp)) fehlend.push('pdp_eigen')
    // Sperre durch Sam (sperre.json je Ad, wird nicht vererbt), aufheben setzt aufgehoben
    const sperre = lies(path.join(dir, 'sperre.json')); const gesperrt = sperre && !sperre.aufgehoben ? sperre : null; if (gesperrt) fehlend.push('gesperrt')
    const copyCheck = copyPruefen([felder.primary_text, felder.headline, felder.description, bild ? null : erbeText('script.md')].filter(Boolean).join('\n')); if (copyCheck.fehler.length) fehlend.push('copy_check')
    if (!schritte.video) fehlend.unshift('video'); if (!schritte.script) fehlend.push('script')
    const adIdsN = [].concat(upload?.adIds || upload?.ad_ids || upload?.ads || []).length
    // page = Facebook-Seite, die weist launch-queue automatisch zu; sie blockiert nicht (05.10., Sam)
    let zustand = archiv ? 'archiviert' : adIdsN ? 'gelauncht' : upload ? 'hochgeladen' : !fehlend.filter((k) => k !== 'page').length ? 'freigegeben' : schritte.video ? 'analyse_offen' : 'entwurf'
    if (upload && String(upload.status || '').toLowerCase() === 'pausiert') zustand = 'pausiert'
    const blockiert = (zustand === 'analyse_offen' || zustand === 'entwurf')
    // Versionsmarke an Medien-URLs: ersetzte Bilder/Videos zeigen sofort neu, ohne Browser-Cache (06.10., Sam musste neu laden)
    const mv = (f) => { try { return Math.floor(fs.statSync(path.join(dir, f)).mtimeMs / 1000) } catch { return 0 } }
    return { id, stamm, hookVariante: stamm !== id ? id.slice(stamm.length + 1).toUpperCase() : null, zustand, blockiert, fehlend, felder, archiv: archiv || null, istBof, funnel, gesperrt, copyCheck, pdpCheck, wartetAufGo: !!(upload && upload.wartet_auf_go), poster: poster ? `/api/os/ads/${id}/poster.jpg?v=${mv('poster.jpg')}` : null, dateien, at: new Date(at).toISOString(), schritte, status, freigabe, analyse: analyse || null, analyseMd: analyseMd ? analyseMd.slice(0, 20000) : null, video, videoBytes, videoUrl: video ? `/api/os/ads/${id}/${video}?v=${mv(video)}` : null, typ: bild ? 'bild' : video ? 'video' : null, vorschau: (meta && meta.vorschau_url) || null, vorschauen: (meta && meta.vorschau_urls) || null, sheet: (meta && meta.sheet_url) || null, bild, bildUrl: bild ? `/api/os/ads/${id}/${bild}?v=${mv(bild)}` : null, bild1x1, bild1x1Url: bild1x1 ? `/api/os/ads/${id}/${bild1x1}` : null, bild9x16, bild9x16Url: bild9x16 ? `/api/os/ads/${id}/${bild9x16}` : null, titel: (meta && (meta.titel || meta.hook)) || null, format: (meta && meta.format) || null, gelaunchtAm: upload?.datum || upload?.at || upload?.gelaunchtAm || null, adIds, kampagne: name(upload?.kampagne || upload?.campaign), pdp: (page && (page.url || page.pdp)) || null, angle: page?.angle || avatar?.angle || meta?.angle || null, avatar: avatar ? { zielgruppe: avatar.zielgruppe || '', situation: avatar.situation || '', schmerz: avatar.schmerz || '', versprechen: avatar.versprechen || '', einwaende: avatar.einwaende || [] } : null, meta: meta || null, live: [] }
  })
  const live = komLive().map((v) => Object.assign({}, v))
  const mkAds = (metaKontoLesen().ads) || null
  for (const a of ads) { const ids = new Set(a.adIds); const treffer = live.filter((v) => v.ads.some((x) => ids.has(x.id))); a.live = treffer.map((v) => v.key); a.videoLink = a.video ? videoLink(a.id, a.video) : null
    const meine = treffer.flatMap((v) => v.ads.filter((x) => ids.has(x.id) && x.status !== 'ARCHIVED' && x.status !== 'GELOESCHT')); if (a.zustand === 'gelauncht' && meine.length && meine.every((x) => x.status !== 'ACTIVE')) a.zustand = 'pausiert'   // archivierte/geloeschte Meta-Ads zaehlen nicht (Chat 1, 14.09.)
    a.spend = treffer.reduce((n, v) => n + ((v.insights && v.insights.spend) || 0), 0)
    const mk = mkAds ? (a.adIds || []).map((x) => mkAds[x]).filter(Boolean) : []
    if (mk.length) { a.metaStatus = mk.map((x) => x.status); a.spend7 = mk.reduce((n, x) => n + (x.spend7 || 0), 0)
      if (a.zustand === 'gelauncht '.trim() || a.zustand === 'pausiert') a.zustand = mk.some((x) => x.status === 'ACTIVE') ? 'gelauncht '.trim() : 'pausiert' } }
  // Ordnung ueber Ordnernamen hinweg: Nummer + Serie = eine Ad, Varianten = Hooks, Captions, Original
  const varLabel = (a) => { const v = String((a.meta && a.meta.variante) || '').toLowerCase(); const id = a.id.toLowerCase()
    let m = v.match(/^(?:h|hook)\s*(\d+)$/) || id.match(/-(?:h|hook)(\d+)$/); if (m) return 'H' + m[1]
    if (/cap/.test(v) || /-cap$/.test(id)) return 'Captions'
    return 'Original' }
  for (const a of ads) {
    const mt = a.meta || {}; const idm = a.id.match(/-(?:ad|lym-|el)(\d+)/i)
    a.nummer = Number(mt.nummer) || (idm ? Number(idm[1]) : null)
    const tm = String(mt.titel || '').match(/(?:LYM|LEI)\s*\d+\s+([A-Z]{2,5})\b/); const pm = String(mt.paket || '').match(/-(sa|el|bof|tof|mof)\b/i)
    a.serie = tm ? tm[1].toUpperCase() : pm ? pm[1].toUpperCase() : (/-el\d/i.test(a.id) ? 'EL' : '')
    a.variante = varLabel(a)
    a.familie = a.nummer != null ? `${a.serie || 'AD'}-${String(a.nummer).padStart(3, '0')}` : a.stamm
    a.erstellt = mt.erstellt || a.at
  }
  const famMap = {}
  for (const a of ads) { (famMap[a.familie] = famMap[a.familie] || []).push(a) }
  const rang = (a) => { const v = a.variante; if (v === 'Original') return 0; if (v === 'Captions') return 99; const n = Number(v.slice(1)); return isNaN(n) ? 50 : n }
  let meld = []; try { meld = meldungenLesen() } catch {}
  const familien = Object.keys(famMap).map((k) => {
    const l = famMap[k].sort((x, y) => rang(x) - rang(y)); const a0 = l[0]
    const erstellt = l.map((a) => a.erstellt).sort()[0]
    const gel = l.filter((a) => a.zustand === 'gelauncht' || a.zustand === 'pausiert').length, bereit = l.filter((a) => a.zustand === 'freigegeben').length, blockiert = l.filter((a) => a.blockiert).length, archiviert = l.filter((a) => a.zustand === 'archiviert').length
    const analyse = l.some((a) => a.schritte.avatar), page = l.find((a) => a.pdp)
    const status = gel === l.length ? 'gelauncht' : gel ? 'teilweise gelauncht' : bereit === l.length ? 'bereit zum Upload' : page ? 'bereit zum Upload' : analyse ? 'Page offen' : 'Analyse offen'
    const ids = new Set(l.map((a) => a.id).concat(l.map((a) => a.stamm)))
    const rueck = meld.filter((m) => m.ad && ids.has(String(m.ad))).slice(0, 8)
    const fehler = rueck.find((m) => m.typ === 'fehler') || null
    const naechster = gel === l.length ? { wer: null, text: 'fertig' } : (page || bereit) ? { wer: 1, text: 'Chat 1 lädt hoch' } : analyse ? { wer: 4, text: 'Chat 4 baut die Product Page' } : { wer: 3, text: 'Chat 3 analysiert' }
    return { key: k, rueckmeldungen: rueck, fehler, naechster, blockiert, archiviert, fehlend: Array.from(new Set(l.flatMap((a) => a.zustand === 'archiviert' ? [] : a.fehlend))), name: (a0.serie ? a0.serie + ' ' : 'Ad ') + (a0.nummer != null ? String(a0.nummer).padStart(3, '0') : a0.stamm), nummer: a0.nummer, serie: a0.serie, titel: String((a0.meta && a0.meta.titel) || '').replace(/\s*[—-]\s*Leichtkraut.*$/, ''), erstellt, paket: (a0.meta && a0.meta.paket) || null, anzahl: l.length, gelauncht: gel, bereit, analyse, angle: (page && page.angle) || a0.angle || null, pdp: page ? page.pdp : null, status, start: l.map((a) => a.gelaunchtAm).filter(Boolean).sort()[0] || null, varianten: l.map((a) => ({ id: a.id, variante: a.variante, status: a.status, typ: a.typ || null, bildUrl: a.bildUrl || null, vorschau: a.vorschau || null, sheet: a.sheet || null, hook: (a.meta && a.meta.hook) || null, laenge: (a.meta && a.meta.laenge) || null, gelaunchtAm: a.gelaunchtAm, adIds: a.adIds, live: a.live, videoUrl: a.videoUrl, poster: a.poster || null, schritte: a.schritte })) }
  }).sort((a, b) => String(b.erstellt).localeCompare(String(a.erstellt)))
  const zugeordnet = new Set(ads.flatMap((a) => a.live))
  for (const v of live) v.ablage = ads.find((a) => a.live.includes(v.key))?.id || null
  return { familien, ads: ads.sort((a, b) => b.at.localeCompare(a.at)), live, ohneAblage: live.length - zugeordnet.size, jetzt: new Date().toISOString() }
}
// Vorschaubild je Ad: einmal per ffmpeg aus dem Video (Sekunde 1, 480 px breit, ~20 KB), danach laedt es sofort.
const posterWarteschlange = []; let posterLaeuft = false
function regCacheLeeren() { regCache = { at: 0, wert: null } }
function posterErzeugen(id) {
  if (!adIdOk(id) || posterWarteschlange.includes(id)) return
  posterWarteschlange.push(id); posterNaechstes()
}
function posterNaechstes() {
  if (posterLaeuft || !posterWarteschlange.length) return
  const id = posterWarteschlange.shift(); const dir = path.join(OS_ADS, id)
  let video = null, bild = null; try { const l = fs.readdirSync(dir); video = l.find((f) => /\.(mp4|mov)$/i.test(f)); bild = l.find((f) => adBildOk(f) && !/_(1x1|9x16)\./i.test(f)) || l.find((f) => /^image_1x1\./i.test(f)) } catch {}
  const ziel = path.join(dir, 'poster.jpg')
  const quelle = bild || video   // Bild-Ads: Vorschau aus dem Bild, nicht aus dem Standbild-Video
  const aktuell = () => { try { return fs.statSync(ziel).mtimeMs + 1000 >= fs.statSync(path.join(dir, quelle)).mtimeMs } catch { return false } }
  if (!quelle || (fs.existsSync(ziel) && aktuell())) return posterNaechstes()
  posterLaeuft = true
  execFile('ffmpeg', ['-y', '-loglevel', 'error'].concat(!bild ? ['-ss', '1'] : []).concat(['-i', path.join(dir, quelle), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', ziel + '.tmp.jpg']), { timeout: 60_000 }, (err) => {
    posterLaeuft = false
    if (err) console.warn('[os] Vorschaubild fehlgeschlagen', id, err.message); else { try { fs.renameSync(ziel + '.tmp.jpg', ziel); osPush('ads', { ad: id, poster: true }) } catch {} }
    posterNaechstes()
  })
}
app.get('/api/os/ads/:id/poster.jpg', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).end()
  if (!adIdOk(req.params.id)) return res.status(400).end()
  const f = path.join(OS_ADS, req.params.id, 'poster.jpg')
  if (!fs.existsSync(f)) { posterErzeugen(req.params.id); return res.status(404).end() }
  res.setHeader('Cache-Control', 'private, max-age=86400'); res.type('jpeg'); res.sendFile(f)
})
// Video-Dateien: Upload per Stream (curl -T), Download fuer den Ads Uploader. Grosse Dateien, nicht ueber express.json.
const adVideoOk = (f) => /^(video|ad|final)[a-z0-9_-]*\.(mp4|mov)$/i.test(String(f || ''))
// Bild-Ads (Chat 8, 14.09.): image.jpg = 4:5 Hauptbild, image_1x1.jpg = quadratisch, image_9x16.jpg = Story
const adBildOk = (f) => /^image(_1x1|_4x5|_9x16)?\.(jpg|jpeg|png)$/i.test(String(f || ''))
const bildMime = (f) => /\.png$/i.test(f) ? 'image/png' : 'image/jpeg'
app.put('/api/os/ads/:id/:datei', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (!adIdOk(req.params.id) || !(adVideoOk(req.params.datei) || adBildOk(req.params.datei))) return res.status(400).json({ error: 'Ungültig. ad-id JJJJMMTT-kurzname, Datei video.mp4 oder image.jpg / image_1x1.jpg / image_9x16.jpg' })
  const dir = path.join(OS_ADS, req.params.id); fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, req.params.datei), tmp = f + '.tmp'
  if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-' + Date.now())
  const out = fs.createWriteStream(tmp); let bytes = 0
  req.on('data', (c) => { bytes += c.length }); req.pipe(out)
  out.on('finish', () => { fs.renameSync(tmp, f); posterErzeugen(req.params.id); console.log(`[os] ${adBildOk(req.params.datei) ? 'Bild' : 'Video'} ${req.params.id}/${req.params.datei} (${Math.round(bytes / 1048576)} MB) von ${req.user.name}`); osPush('ads', { ad: req.params.id, datei: req.params.datei }); res.json({ ok: true, pfad: `${req.params.id}/${req.params.datei}`, bytes, url: `https://os.leichtkraut.de/api/os/ads/${req.params.id}/${req.params.datei}` }) })
  out.on('error', (e) => { try { fs.unlinkSync(tmp) } catch {} res.status(500).json({ error: e.message }) })
})
app.get('/api/os/ads/:id/:datei', (req, res, next) => {
  if (!adVideoOk(req.params.datei) && !adBildOk(req.params.datei)) return next()
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (!adIdOk(req.params.id)) return res.status(400).json({ error: 'Ungültiger Name' })
  const f = path.join(OS_ADS, req.params.id, req.params.datei)
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Nicht vorhanden' })
  if (adBildOk(req.params.datei)) { res.setHeader('Content-Type', bildMime(req.params.datei)); res.setHeader('Content-Disposition', `inline; filename="${req.params.id}-${req.params.datei}"`) }
  else res.setHeader('Content-Disposition', `attachment; filename="${req.params.id}-${req.params.datei}"`)
  res.sendFile(f)
})
// Signierter Video-Link: Meta laedt das Video direkt vom OS (file_url), kein Download auf dem Mac. 48 Stunden gueltig.
function videoLink(id, datei, stunden = 24 * 30) {
  const exp = Date.now() + stunden * 3600_000
  const sig = crypto.createHmac('sha256', SERVICE_TOKEN || 'os').update(`${id}/${datei}/${exp}`).digest('hex').slice(0, 40)
  return `https://os.leichtkraut.de/api/os/video/${id}/${datei}?exp=${exp}&sig=${sig}`
}
app.get('/api/os/video/:id/:datei', (req, res) => {
  const { id, datei } = req.params; const exp = Number(req.query.exp || 0), sig = String(req.query.sig || '')
  if (!adIdOk(id) || !(adVideoOk(datei) || adBildOk(datei)) || !exp || exp < Date.now()) return res.status(403).send('Link abgelaufen')
  const soll = crypto.createHmac('sha256', SERVICE_TOKEN || 'os').update(`${id}/${datei}/${exp}`).digest('hex').slice(0, 40)
  if (sig.length !== soll.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(soll))) return res.status(403).send('Ungültige Signatur')
  const f = path.join(OS_ADS, id, datei); if (!fs.existsSync(f)) return res.status(404).send('Nicht vorhanden')
  res.setHeader('Content-Type', adBildOk(datei) ? bildMime(datei) : 'video/mp4'); res.setHeader('Content-Disposition', `inline; filename="${id}-${datei}"`); res.sendFile(f)
})
// Schranke: Sam gibt Analyse oder Page frei. Nur mit echter Anmeldung, nicht per Service-Token.
app.post('/api/os/ads/:id/freigabe', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (req.user.id === 'service') return res.status(403).json({ error: 'Freigabe nur durch Sam im OS' })
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body) } catch { req.body = {} } }
  const schritt = String((req.body || {}).schritt || ''); if (!/^(analyse|page)$/.test(schritt)) return res.status(400).json({ error: 'schritt: analyse oder page' })
  if (!adIdOk(req.params.id)) return res.status(400).json({ error: 'Ungültige ad-id' })
  const ziel = (req.body || {}).stamm ? String(req.params.id).replace(/-h\d+$/i, '') : req.params.id
  const dir = path.join(OS_ADS, ziel); if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const f = path.join(dir, 'freigabe.json'); let fr = {}; try { fr = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  if ((req.body || {}).zurueck) delete fr[schritt]; else fr[schritt] = { at: new Date().toISOString(), by: req.user.name }
  fs.writeFileSync(f, JSON.stringify(fr, null, 2)); osPush('ads', { ad: ziel, freigabe: schritt })
  res.json({ ok: true, ad: ziel, freigabe: fr })
})
// ── Quelle der Wahrheit fuer den Uploader (Sam, 13.09.2026) ──
const PAGES_FILE = path.join(OS_MODUL_DIR, 'pages.json')
function pagesLesen() { try { return JSON.parse(fs.readFileSync(PAGES_FILE, 'utf8')) } catch { return [] } }
const AUSL_FILE = path.join(OS_MODUL_DIR, 'pages-auslastung.json')
function auslastungLesen() { try { return JSON.parse(fs.readFileSync(AUSL_FILE, 'utf8')) } catch { return {} } }
function pageStats() {
  const reg = osAdsRegister(); const pages = pagesLesen(); const ausl = auslastungLesen()
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, '')
  const list = pages.map((p) => {
    const meine = reg.ads.filter((a) => a.zustand !== 'archiviert' && a.felder.page === p.id)
    const aktive = meine.filter((a) => a.zustand === 'gelauncht')
    const au = ausl[p.id] || Object.values(ausl).find((x) => x && norm(x.page) === norm(p.name) || norm(x.page) === norm(p.id)) || null
    const zuletzt = meine.map((a) => a.gelaunchtAm || a.at).filter(Boolean).sort().pop() || null
    return Object.assign({}, p, { aktiveAdsOS: aktive.length, metaAktiv: au ? Number(au.aktive_ads) : null, metaStand: au ? au.stand : null, aktiveAds: au ? Number(au.aktive_ads) : aktive.length, quelle: au ? 'meta' : 'os', zuletzt, wartend: meine.filter((a) => a.zustand === 'freigegeben').length, spend: Math.round(aktive.reduce((n, a) => n + (a.spend || 0), 0) * 100) / 100 })
  })
  const aktiv = list.filter((p) => p.aktiv !== false); const gesamt = aktiv.reduce((n, p) => n + p.aktiveAds, 0); const soll = aktiv.length ? 100 / aktiv.length : 0
  for (const p of list) { p.anteil = gesamt ? Math.round(p.aktiveAds / gesamt * 1000) / 10 : 0; p.soll = p.aktiv === false ? 0 : Math.round(soll * 10) / 10; p.abweichung = p.aktiv === false ? 0 : Math.round((p.anteil - soll) * 10) / 10; p.sollAds = p.aktiv === false ? 0 : Math.round(gesamt / (aktiv.length || 1)) }
  list.gesamt = gesamt; return list
}
app.post('/api/os/pages/auslastung', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body; const list = Array.isArray(b) ? b : (b && b.auslastung); if (!Array.isArray(list)) return res.status(400).json({ error: 'Liste erwartet: [{page, aktive_ads, stand}]' })
  const pages = pagesLesen(); const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9äöüß]+/g, ''); const alt = auslastungLesen(); const stand = new Date().toISOString()
  for (const e of list) { const p = pages.find((x) => x.id === e.page || norm(x.name) === norm(e.page) || norm(x.id) === norm(e.page)); const key = p ? p.id : String(e.page || '').slice(0, 80); if (!key) continue; alt[key] = { page: p ? p.name : e.page, aktive_ads: Number(e.aktive_ads) || 0, stand: e.stand || stand, unbekannt: !p } }
  if (fs.existsSync(AUSL_FILE)) fs.copyFileSync(AUSL_FILE, AUSL_FILE + '.bak-' + Date.now())
  fs.writeFileSync(AUSL_FILE, JSON.stringify(alt, null, 2)); regCacheLeeren(); osPush('modul', { datei: 'pages-auslastung.json' })
  res.json({ ok: true, seiten: Object.keys(alt).length, unbekannt: Object.values(alt).filter((x) => x.unbekannt).map((x) => x.page) })
})
// Seite automatisch zuweisen: erst Passung (Geschlecht, Ethnie), dann die am wenigsten belastete
function pageZuweisen(a, stats) {
  if (!stats.length || a.felder.page) return null
  // BOF laeuft immer ueber die Brand-Page mit Instagram, nie ueber Persona-Seiten (05.10., Sam: sehr wichtig)
  if (a.funnel === 'BOF' || a.istBof) { const b = stats.find((p) => p.typ === 'marke' && p.aktiv !== false); if (!b) return null
    try { fs.writeFileSync(path.join(OS_ADS, a.id, 'zuweisung.json'), JSON.stringify({ page: b.id, pageName: b.name, at: new Date().toISOString(), grund: 'BOF immer Brand-Page (Sam, 05.10.)' }, null, 2)) } catch {}
    return b.id }
  if (!a.felder.geschlecht) return null
  const g = String(a.felder.geschlecht).toLowerCase()[0], e = a.felder.ethnie ? String(a.felder.ethnie).toLowerCase() : null
  let kand = stats.filter((p) => p.aktiv !== false && String(p.geschlecht || '').toLowerCase()[0] === g && (!e || !p.ethnie || String(p.ethnie).toLowerCase() === e || String(p.ethnie).toLowerCase() === 'alle'))
  if (!kand.length) return null
  kand.sort((x, y) => (x.aktiveAds + (x.zugewiesen || 0)) - (y.aktiveAds + (y.zugewiesen || 0)))
  const p = kand[0]; p.zugewiesen = (p.zugewiesen || 0) + 1
  try { fs.writeFileSync(path.join(OS_ADS, a.id, 'zuweisung.json'), JSON.stringify({ page: p.id, pageName: p.name, at: new Date().toISOString(), grund: 'auto: ' + g + (e ? '/' + e : '') + ', geringste Last' }, null, 2)) } catch {}
  return p.id
}
// Eine Wahrheit fuer alle Chats: Ist eine Ad gelauncht, seit wann, womit, und ist das von Meta bestaetigt? (18.09., Wunsch Sam)
// gelauncht = Chat 1 hat Meta-Kennungen gemeldet (POST /api/os/ads/<id>/launched). gestartet = Startzeit liegt in der Vergangenheit.
// verifiziert = in den Meta-Daten als ACTIVE gesehen; das haengt am Scan des Kommentar-Werkzeugs (metaStand).
app.get('/api/os/launch-status', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const reg = osAdsRegister(); const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean); const paket = String(req.query.paket || '').trim()
  let l = reg.ads; if (ids.length) l = l.filter((a) => ids.includes(a.id) || ids.includes(a.stamm)); if (paket) l = l.filter((a) => (a.meta || {}).paket === paket)
  const mkd = metaKontoLesen(); let metaStand = mkd.stand || null; if (!metaStand) { try { metaStand = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta-kommentare.json'), 'utf8')).scannedAt || null } catch {} }
  const metaVeraltet = !metaStand || (Date.now() - Date.parse(metaStand)) > 2 * 86400_000
  const jetzt = Date.now()
  res.json({ metaStand, metaVeraltet, hinweis: metaVeraltet ? 'Meta-Daten veraltet: verifiziert ist nur aussagekräftig für Ads, die vor metaStand gestartet sind. Maßgeblich für gelauncht ist die Meldung von Chat 1.' : null,
    anzahl: l.length, gelauncht: l.filter((a) => a.zustand === 'gelauncht' || a.zustand === 'pausiert').length,
    ads: l.map((a) => { const gel = a.zustand === 'gelauncht' || a.zustand === 'pausiert'; const start = a.gelaunchtAm || null
      return { id: a.id, paket: (a.meta || {}).paket || null, zustand: a.zustand, gelauncht: gel, start, gestartet: !!(gel && start && Date.parse(start) <= jetzt), metaKennungen: (a.adIds || []).length, kampagne: a.kampagne || (a.felder || {}).ziel_kampagne || null, adset: (a.felder || {}).ziel_adset || null, verifiziert: (a.metaStatus || []).includes('ACTIVE') || (a.live || []).length > 0, metaStatus: a.metaStatus || null, ausgaben7Tage: a.spend7 != null ? Math.round(a.spend7 * 100) / 100 : null, ausgaben: a.spend || 0 } }) })
})
app.get('/api/os/launch-queue', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const reg = osAdsRegister(); const stats = pageStats(); let neu = 0
  for (const a of reg.ads) { if (!a.felder.page && a.zustand !== 'archiviert' && a.zustand !== 'gelauncht') { if (pageZuweisen(a, stats)) neu++ } }
  if (neu) regCacheLeeren()
  const r2 = neu ? osAdsRegister() : reg
  const queue = r2.ads.filter((a) => a.zustand === 'freigegeben').map((a) => ({ id: a.id, familie: a.familie, variante: a.variante, titel: a.titel, hook: (a.meta && a.meta.hook) || null, laenge: (a.meta && a.meta.laenge) || null, format: (a.meta && a.meta.format) || null, typ: a.typ || null, video: a.typ === 'bild' ? null : a.video, videoLink: (a.video && a.typ !== 'bild') ? videoLink(a.id, a.video) : null, vorschau: a.vorschau || null, bild: a.bild || null, bildLink: a.bild ? videoLink(a.id, a.bild) : null, bild1x1Link: a.bild1x1 ? videoLink(a.id, a.bild1x1) : null, bild9x16Link: a.bild9x16 ? videoLink(a.id, a.bild9x16) : null, videoLinkNeu: `https://os.leichtkraut.de/api/os/ads/${a.id}/video-link`, felder: a.felder, script: (() => { try { return fs.readFileSync(path.join(OS_ADS, a.id, 'script.md'), 'utf8') } catch { return null } })() }))
  res.json({ anzahl: queue.length, queue, blockiert: r2.ads.filter((a) => a.blockiert).map((a) => ({ id: a.id, fehlend: a.fehlend })), jetzt: new Date().toISOString() })
})
app.get('/api/os/ads/:id/video-link', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const a = osAdsRegister().ads.find((x) => x.id === req.params.id); if (!a || !(a.video || a.bild)) return res.status(404).json({ error: 'Kein Video und kein Bild' })
  res.json({ id: a.id, typ: a.typ, videoLink: a.video ? videoLink(a.id, a.video) : null, bildLink: a.bild ? videoLink(a.id, a.bild) : null, bild1x1Link: a.bild1x1 ? videoLink(a.id, a.bild1x1) : null, bild9x16Link: a.bild9x16 ? videoLink(a.id, a.bild9x16) : null, gueltigTage: 30 })
})
// Der eine Schalter: Meta-Ad-IDs eintragen, Zustand wird gelauncht
app.post('/api/os/ads/:id/launched', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body) } catch { req.body = {} } }
  const b = req.body || {}; const adIds = [].concat(b.adIds || b.ad_ids || []).map(String).filter(Boolean)
  if (!adIdOk(req.params.id)) return res.status(400).json({ error: 'Ungültige ad-id' })
  const dir = path.join(OS_ADS, req.params.id); if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Ad unbekannt' })
  if (!adIds.length) return res.status(400).json({ error: 'adIds fehlen (mindestens eine Meta-Ad-ID)' })
  const f = path.join(dir, 'upload.json'); let alt = {}; try { alt = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-' + Date.now())
  // launched ERSETZT die Ad-IDs (Stand des letzten Launches); nur mit {anhaengen:true} wird angehaengt. Verdraengte IDs bleiben in adIdsAlt (nichts geht verloren).
  const altIds = [].concat(alt.adIds || []).map(String); const anhaengen = b.anhaengen === true || b.anhaengen === 'true'
  const idsNeu = anhaengen ? Array.from(new Set(altIds.concat(adIds))) : adIds
  const verdraengt = altIds.filter((x) => !idsNeu.includes(x)); const adIdsAlt = Array.from(new Set([].concat(alt.adIdsAlt || [], verdraengt).map(String)))
  const neu = Object.assign({}, alt, { adIds: idsNeu, adIdsAlt: adIdsAlt.length ? adIdsAlt : undefined, adset: b.adset || b.ziel_adset || alt.adset || null, kampagne: b.kampagne || b.ziel_kampagne || alt.kampagne || null, datum: b.start || b.datum || alt.datum || new Date().toISOString(), pageUrl: b.pageUrl || alt.pageUrl || null, status: b.status || 'scheduled', gemeldetAt: new Date().toISOString(), gemeldetVon: req.user.name })
  fs.writeFileSync(f, JSON.stringify(neu, null, 2)); regCacheLeeren()
  try { const m = { at: new Date().toISOString(), chat: parseInt(b.chat, 10) || 1, name: b.name || 'Ads Uploader', text: `gelauncht: ${adIds.length} Meta-Ad${adIds.length > 1 ? 's' : ''}${neu.adset ? ' in ' + neu.adset : ''}${neu.datum ? ', Start ' + neu.datum : ''}`, typ: 'ok', ad: req.params.id }; const alle = [m].concat(meldungenLesen()).slice(0, 2000); fs.writeFileSync(OS_MELD + '.tmp', JSON.stringify(alle, null, 2)); fs.renameSync(OS_MELD + '.tmp', OS_MELD) } catch {}
  osPush('ads', { ad: req.params.id, launched: true }); res.json({ ok: true, id: req.params.id, zustand: 'gelauncht', upload: neu })
})
// Archiv statt Loeschen (Dubletten, alte Eintraege)
app.post('/api/os/ads/:id/archiv', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (typeof req.body === 'string') { try { req.body = JSON.parse(req.body) } catch { req.body = {} } }
  const dir = path.join(OS_ADS, req.params.id); if (!adIdOk(req.params.id) || !fs.existsSync(dir)) return res.status(404).json({ error: 'Ad unbekannt' })
  const f = path.join(dir, 'archiv.json')
  if ((req.body || {}).zurueck) { if (fs.existsSync(f)) fs.renameSync(f, f + '.bak-' + Date.now()) } else fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), by: req.user.name, grund: String((req.body || {}).grund || 'archiviert').slice(0, 300) }, null, 2))
  regCacheLeeren(); osPush('ads', { ad: req.params.id, archiv: !(req.body || {}).zurueck }); res.json({ ok: true })
})
// Personas-Seiten: Liste pflegen, Last je Seite
app.get('/api/os/pages', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const l = pageStats(); res.json({ pages: l, gesamtAktiv: l.gesamt, quelle: l.some((p) => p.quelle === 'meta') ? 'meta' : 'os', stand: l.map((p) => p.metaStand).filter(Boolean).sort().pop() || null }) })
app.post('/api/os/pages', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const list = Array.isArray(b) ? b : b.pages; if (!Array.isArray(list)) return res.status(400).json({ error: 'pages (Liste) erwartet: [{id, name, url, geschlecht, ethnie, typ, aktiv}]' })
  const pages = list.map((p) => ({ id: String(p.id || p.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-'), name: String(p.name || p.id || '').slice(0, 80), url: p.url || null, geschlecht: p.geschlecht || null, ethnie: p.ethnie || null, typ: p.typ || null, aktiv: p.aktiv !== false, hinweis: p.hinweis || null })).filter((p) => p.id)
  if (fs.existsSync(PAGES_FILE)) fs.copyFileSync(PAGES_FILE, PAGES_FILE + '.bak-' + Date.now())
  fs.writeFileSync(PAGES_FILE, JSON.stringify(pages, null, 2)); regCacheLeeren(); res.json({ ok: true, anzahl: pages.length })
})
// Produktseiten-Testing: Ads und Budget je PDP, Warnung unter Mindestzahl
app.get('/api/os/pdp-stats', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const reg = osAdsRegister(); const min = Number(osLesen().pdpMindestAds || 3); const map = {}
  for (const a of reg.ads) { const u = a.felder.pdp; if (!u || a.zustand === 'archiviert') continue; const m = map[u] = map[u] || { pdp: u, ads: 0, aktiv: 0, wartend: 0, spend: 0, angles: new Set() }; m.ads++; if (a.zustand === 'gelauncht') { m.aktiv++; m.spend += a.spend || 0 } if (a.zustand === 'freigegeben') m.wartend++; if (a.felder.angle) m.angles.add(a.felder.angle) }
  const pdps = Object.values(map).map((m) => Object.assign(m, { angles: Array.from(m.angles), spend: Math.round(m.spend * 100) / 100, unterMindestzahl: m.aktiv < min })).sort((x, y) => y.aktiv - x.aktiv)
  res.json({ mindestAds: min, pdps, neuePdpErlaubt: !pdps.some((m) => m.unterMindestzahl), warnungen: pdps.filter((m) => m.unterMindestzahl).map((m) => `${m.pdp.replace(/^https?:\/\/(www\.)?leichtkraut\.de\/products\//, '')}: nur ${m.aktiv} aktive Ads (mindestens ${min})`) })
})
app.get('/api/os/ads/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const a = osAdsRegister().ads.find((x) => x.id === req.params.id); if (!a) return res.status(404).json({ error: 'Ad unbekannt' })
  const lies = (f) => { try { return fs.readFileSync(path.join(OS_ADS, a.id, f), 'utf8') } catch { return null } }
  res.json(Object.assign({}, a, { script: lies('script.md'), notiz: lies('notiz.md'), videoLink: a.video ? videoLink(a.id, a.video) : null }))
})
app.get('/api/os/pdp-check', (req, res) => res.json({ seiten: pdpCache }))
app.post('/api/os/pdp-check/jetzt', async (req, res) => { await pdpAllePruefen(Object.keys(pdpCache)).catch(() => {}); res.json({ ok: true, seiten: pdpCache }) })
app.get('/api/os/ads-register', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const r = Object.assign({}, osAdsRegister()); const q = String(req.query.q || '').toLowerCase().trim(); const nur = String(req.query.nur || 'aktiv'); const limit = Math.min(500, parseInt(req.query.limit, 10) || 150)
  r.gesamt = r.live.length; r.aktivGesamt = r.live.filter((v) => v.aktiv > 0).length
  let live = r.live; if (nur === 'aktiv') live = live.filter((v) => v.aktiv > 0)
  if (q) live = live.filter((v) => (v.text + ' ' + v.pageName + ' ' + v.campaign + ' ' + v.adset + ' ' + v.ads.map((a) => a.name + a.id).join(' ')).toLowerCase().includes(q))
  r.liveGefiltert = live.length; r.live = live.slice(0, limit); r.kampagnen = KAMPAGNEN
  // schlank=1 (Ads-Seite im OS): ohne Analysetexte, die laedt die Detailkarte ueber /api/os/ads/:id. Spart rund die Haelfte der Datenmenge.
  if (req.query.schlank === '1') r.ads = r.ads.map((a) => { const { analyseMd, ...rest } = a; return Object.assign(rest, { analyseMd: analyseMd ? true : null }) })
  res.json(r)
})

// Kommentare: neueste zuerst, ueber alle Videos, nur lesend aus der Datei des Kommentar-Managers
app.get('/api/os/kommentare', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  let k = null; try { k = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta-kommentare.json'), 'utf8')) } catch { return res.json({ counts: null, neueste: [], videos: [], stand: null }) }
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 60)
  const counts = { gesamt: 0, offen: 0, rot: 0, gelb: 0, nachfragen: 0, beantwortet: 0, verborgen: 0 }
  const alle = [], videos = []
  for (const v of k.videos || []) {
    const c = v.counts || {}; for (const key of Object.keys(counts)) counts[key] += c[key] || 0
    videos.push({ key: v.key, pageName: v.pageName || '', text: String(v.text || '').slice(0, 120), thumb: v.media?.thumb || null, counts: v.counts || null, letzteAktivitaet: v.letzteAktivitaet || null, aktiv: (v.ads || []).filter((a) => a.status === 'ACTIVE').length })
    for (const c of v.kommentare || []) {
      if (c.vonUns) continue
      alle.push({ id: c.id, video: v.key, pageName: v.pageName || '', wer: c.wer || 'Unbekannt', text: String(c.text || '').slice(0, 400), zeit: c.zeit || null, ampel: c.ampel || null, beantwortet: !!c.beantwortet, nachfrage: !!c.nachfrage, hidden: !!c.hidden, erledigt: !!c.erledigt, antworten: (c.antworten || []).length })
    }
  }
  alle.sort((a, b) => (Date.parse(b.zeit) || 0) - (Date.parse(a.zeit) || 0))
  videos.sort((a, b) => String(b.letzteAktivitaet || '').localeCompare(String(a.letzteAktivitaet || '')))
  const videosKurz = videos.filter((v) => (v.counts && v.counts.offen > 0) || v.aktiv > 0).slice(0, 40)
  res.json({ counts, neueste: alle.slice(0, limit), videos: videosKurz, videosGesamt: videos.length, stand: k.liveCheckAt || k.scannedAt || null, jetzt: new Date().toISOString() })
})

// Stock-Counter: Bestand in Flaschen, jeder Abgang wird gebucht (spaeter automatisch aus Shopify-Bestellungen)
function stockLesen() { return modulLesen('stock') || { bestand: null, einheit: 'Flaschen', abgaenge: [], verlauf: [], quelle: 'manuell', updatedAt: null } }
app.get('/api/os/stock', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const d = stockLesen(); res.json(Object.assign({}, d, { prognose: stockPrognose(d), abgleich: stockAbgleichStand })) })
app.post('/api/os/stock', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d = stockLesen(); const b = req.body || {}
  const nurEinstellung = b.bestand == null && (b.lieferzeitTage !== undefined || b.pufferTage !== undefined)
  if (!nurEinstellung && (b.bestand == null || isNaN(Number(b.bestand)))) return res.status(400).json({ error: 'bestand (Zahl) fehlt' })
  if (!nurEinstellung) { d.verlauf = [{ at: new Date().toISOString(), by: req.user.name, von: d.bestand, auf: Number(b.bestand), notiz: String(b.notiz || '').slice(0, 300) }].concat(d.verlauf || []).slice(0, 200)
  d.bestand = Number(b.bestand) } d.updatedAt = new Date().toISOString(); d.updatedBy = req.user.name
  // Lieferantenstand (22.09.): wer liefert, was ist vorbezahlt, was ist nachbestellt
  if (b.basis && typeof b.basis === 'object') d.basis = { menge: Number(b.basis.menge) || null, abBestellung: String(b.basis.abBestellung || '').slice(0, 40), abZeit: String(b.basis.abZeit || '').slice(0, 40) }
  if (b.bestellungen && typeof b.bestellungen === 'object') d.bestellungen = b.bestellungen
  if (b.lieferant !== undefined) d.lieferant = String(b.lieferant || '').slice(0, 80) || null
  if (b.vorbezahlt !== undefined) d.vorbezahlt = b.vorbezahlt == null ? null : Number(b.vorbezahlt)
  if (b.lieferantSeit !== undefined) d.lieferantSeit = String(b.lieferantSeit || '').slice(0, 40) || null
  if (b.lieferzeitTage !== undefined) d.lieferzeitTage = Math.max(1, Math.min(120, Number(b.lieferzeitTage) || 14))
  if (b.pufferTage !== undefined) d.pufferTage = Math.max(0, Math.min(60, isNaN(Number(b.pufferTage)) || b.pufferTage === '' || b.pufferTage == null ? 10 : Number(b.pufferTage)))
  if (b.nachbestellung !== undefined) d.nachbestellung = (b.nachbestellung && typeof b.nachbestellung === 'object') ? { menge: Number(b.nachbestellung.menge) || null, preisUsd: b.nachbestellung.preisUsd != null ? Number(b.nachbestellung.preisUsd) : null, referenz: String(b.nachbestellung.referenz || '').slice(0, 80), status: String(b.nachbestellung.status || '').slice(0, 80) } : null
  modulSchreiben('stock', d); res.json({ ok: true, stock: d })
})
app.post('/api/os/stock/abgang', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d = stockLesen(); const b = req.body || {}
  const menge = Number(b.menge); if (!menge || isNaN(menge)) return res.status(400).json({ error: 'menge (Zahl) fehlt' })
  const ref = String(b.ref || '').slice(0, 120)
  if (ref && (d.abgaenge || []).some((x) => x.ref === ref)) return res.json({ ok: true, doppelt: true, stock: d })   // dieselbe Bestellung nie zweimal abziehen
  d.abgaenge = [{ at: b.at || new Date().toISOString(), menge, quelle: String(b.quelle || 'manuell').slice(0, 60), ref, by: req.user.name }].concat(d.abgaenge || []).slice(0, 2000)
  if (d.bestand != null) d.bestand = d.bestand - menge
  d.updatedAt = new Date().toISOString(); modulSchreiben('stock', d); res.json({ ok: true, stock: d })
})

// Generische Modul-Daten: Profit (Chat 6), Google-Sheet (Chat 7), Notizen. Ein Aufruf, eine Datei.
app.get('/api/os/modul/:name', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); if (!OS_MODULE.includes(req.params.name)) return res.status(400).json({ error: 'Unbekanntes Modul. Erlaubt: ' + OS_MODULE.join(', ') }); res.json({ name: req.params.name, daten: modulLesen(req.params.name) }) })
app.post('/api/os/modul/:name', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (!OS_MODULE.includes(req.params.name)) return res.status(400).json({ error: 'Unbekanntes Modul. Erlaubt: ' + OS_MODULE.join(', ') })
  const b = req.body; if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'JSON-Objekt erwartet' })
  const d = Object.assign({}, b, { updatedAt: new Date().toISOString(), updatedBy: req.user.name })
  modulSchreiben(req.params.name, d); console.log(`[os] Modul ${req.params.name} geschrieben von ${req.user.name}`); res.json({ ok: true, name: req.params.name, updatedAt: d.updatedAt })
})
// Planung (Chat 5 seit 04.10.2026): Tages-To-dos, Wochenziele, Weekly Reports. Chat 5 schreibt das ganze Modul per POST /api/os/modul/planung,
// das OS haengt einzelne Aufgaben an und hakt sie ab. Form: { heute: { datum, fokus, aufgaben: [{ id, text, done, prio, chat }] }, woche: { kw, ziele: [...] }, reports: [{ kw, titel, text, at }] }
function planungLesen() { const d = modulLesen('planung') || {}; d.heute = d.heute || { datum: null, fokus: '', aufgaben: [] }; d.heute.aufgaben = d.heute.aufgaben || []; d.woche = d.woche || { kw: null, ziele: [] }; d.woche.ziele = d.woche.ziele || []; d.reports = d.reports || []; return d }
// Routine nach dem Wave-Call „Mindset schlägt Skills“ (04.10.2026): jeden Morgen 10 Min lesen, Autosuggestion, drei Journals (Bodo Schäfer),
// jeden Sonntag Deadline für Learnings der Woche und Selbstreflexion. Tag nach Europe/Berlin.
const ROUTINE = [['lesen', '10 Minuten lesen'], ['autosuggestion', 'Autosuggestion lesen'], ['erfolg', 'Erfolgsjournal'], ['ideen', 'Ideen-Journal'], ['erkenntnis', 'Erkenntnis-Journal']]
const berlinTag = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d || new Date())
function kwVon(tag) { const d = new Date(tag + 'T12:00:00Z'); const t = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() + 4 - t); const j = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return d.getUTCFullYear() + '-W' + String(Math.ceil(((d - j) / 864e5 + 1) / 7)).padStart(2, '0') }
function routineStand(d) {
  const heute = berlinTag(); d.routineLog = d.routineLog || {}; const h = d.routineLog[heute] || {}
  let serie = 0; for (let i = 0; i < 400; i++) { const t = berlinTag(new Date(Date.now() - i * 864e5)); const n = Object.values(d.routineLog[t] || {}).filter(Boolean).length; if (n >= 3) serie++; else if (i > 0) break }
  return { tag: heute, kw: kwVon(heute), punkte: ROUTINE.map(([k, l]) => ({ key: k, label: l, done: !!h[k] })), erledigt: ROUTINE.filter(([k]) => h[k]).length, serie }
}
app.get('/api/os/planung', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const d = planungLesen(); d.routine = routineStand(d); const tagH = berlinTag(), tagW = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.tag || '')) ? String(req.query.tag) : tagH; d.heute.tagHeute = tagH; d.heute.tagMorgen = berlinTag(new Date(Date.now() + 864e5)); d.heute.tag = tagW; d.heute.liste = d.heute.aufgaben.map((a) => Object.assign({}, a, { tag: a.tag || berlinTag(new Date(a.at || Date.now())), person: a.person || 'sam' })).filter((a) => a.tag === tagW || (tagW === tagH && !a.done && a.tag < tagH)).map((a) => Object.assign(a, { uebertrag: a.tag < tagW })); d.heute.morgenAnzahl = d.heute.aufgaben.filter((a) => a.tag === d.heute.tagMorgen).length; d.journale = d.journale || { erfolg: [], ideen: [], erkenntnis: [] }; d.reflexionen = d.reflexionen || []; if (req.user.gast) return res.json({ heute: Object.assign({}, d.heute, { aufgaben: undefined }), ziele: d.ziele || null, gast: true }); res.json(d) })
app.get('/api/os/hook-status', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const o = {}; for (const k of Object.keys(hookZuletzt)) if (k.startsWith('chat')) o[k.slice(4)] = new Date(hookZuletzt[k]).toISOString(); res.json({ zuletztFertig: o }) })
// API-Schluessel (Sam, 05.10.2026): Uebersicht und Eintragen im OS. Werte werden nie angezeigt, nur die letzten 4 Zeichen.
// Speichern verlangt einen aktuellen 2FA-Code, schreibt .env (mit Sicherung) und startet das OS neu, damit alle Teile den Schluessel lesen.
const API_KATALOG = [
  ['TRENDTRACK_API_KEY', 'TrendTrack', 'Ad-Library und Big Swipe'], ['META_READER_TOKEN', 'Meta (Lese-Token)', 'Status und Ausgaben je Ad'], ['ANTHROPIC_API_KEY', 'Claude (Anthropic)', 'Barbara und KI im Mail-Tool'],
  ['KIE_API_KEY', 'kie.ai', 'Bild- und Videoerzeugung'], ['FIRECRAWL_API_KEY', 'Firecrawl', 'Webseiten auslesen'], ['TELEGRAM_BOT_TOKEN', 'Telegram-Bot', 'Meldungen an Sam'],
  ['SLACK_WEBHOOK_URL', 'Slack (Webhook)', 'Meldungen in Slack'], ['SLACK_BOT_TOKEN', 'Slack (Bot)', 'Meldungen in Slack'], ['DHL_API_KEY', 'DHL (Key)', 'Sendungsverfolgung'], ['DHL_API_SECRET', 'DHL (Secret)', 'Sendungsverfolgung'],
  ['PARCELSAPP_API_KEY', 'Parcels', 'Sendungsverfolgung'], ['HETZNER_API_TOKEN', 'Hetzner', 'Server'], ['IONOS_API_KEY', 'IONOS', 'Domains'],
  ['SHOPIFY_OS_CLIENT_ID', 'Shopify OS (Client-ID)', 'Shop leichtkraut.de'], ['SHOPIFY_OS_SECRET', 'Shopify OS (Secret)', 'Shop leichtkraut.de'], ['SHOPIFY_PAGES_CLIENT_ID', 'Shopify Pages (Client-ID)', 'Product Pages'], ['SHOPIFY_PAGES_SECRET', 'Shopify Pages (Secret)', 'Product Pages'],
  ['SHOPIFY_OS_CLIENT_ID_ALT', 'Shopify alter Store (Client-ID)', 'alter Store'], ['SHOPIFY_OS_SECRET_ALT', 'Shopify alter Store (Secret)', 'alter Store'],
]
// IMAP_PASSWORD: aus der Uebersicht genommen (Sam, 05.10.), bleibt fuer das Mail-Tool aktiv und ist hier nicht aenderbar
const API_GESPERRT = new Set(['IMAP_PASSWORD', 'SERVICE_TOKEN', 'PORT', 'APP_URL', 'APP_WORKSPACE', 'SHOPIFY_REDIRECT', 'TELEGRAM_CHAT_ID', 'TELEGRAM_POLL', 'SEND_AS', 'IMAP_HOST', 'IMAP_EMAIL', 'SMTP_HOST', 'SMTP_PORT', 'SHOPIFY_OS_STORE', 'SHOPIFY_OS_STORE_ALT', 'KOMMENTARE_AN', 'NODE_ENV'])
const ENV_FILE = path.join(__dirname, '.env'), APIKEY_META = path.join(__dirname, 'data', 'os-module', 'api-keys-meta.json')
// Einzelne Ads sperren und entsperren (05.10., Sam). Nichts wird geloescht, aufheben setzt nur aufgehoben.
app.post('/api/os/ad-sperre/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const id = String(req.params.id || ''); if (!/^[\w.-]+$/.test(id)) return res.status(400).json({ error: 'Ungültige Ad' })
  const dir = path.join(OS_ADS, id); if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Ad nicht gefunden' })
  const f = path.join(dir, 'sperre.json'); let alt = null; try { alt = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  if (alt) fs.copyFileSync(f, f + '.bak-' + Date.now())
  const b = req.body || {}, wer = req.user.name || 'Service'
  const neu = b.aufheben ? Object.assign({}, alt || {}, { aufgehoben: new Date().toISOString(), aufgehobenVon: wer }) : { grund: String(b.grund || 'gesperrt').slice(0, 300), at: new Date().toISOString(), von: wer }
  fs.writeFileSync(f, JSON.stringify(neu, null, 2)); regCacheLeeren(); osPush('ads', { ad: id, sperre: !b.aufheben })
  res.json({ ok: true, id, sperre: neu })
})

// Konkurrenz-Bibliothek mit TrendTrack (05.10., Sam). Daten in data/konkurrenz, Medien lokal, Credits nur nach Bestaetigung.
const KONK_DIR = path.join(DATA_DIR, 'konkurrenz'), KONK_MEDIA = path.join(KONK_DIR, 'media'), KONK_ADS = path.join(KONK_DIR, 'ads')
try { fs.mkdirSync(KONK_MEDIA, { recursive: true }); fs.mkdirSync(KONK_ADS, { recursive: true }) } catch {}
const KONK_TOP = 100
function konkMarken() { try { return JSON.parse(fs.readFileSync(path.join(KONK_DIR, 'marken.json'), 'utf8')) } catch { return [] } }
function konkMarkenSchreiben(l) { const f = path.join(KONK_DIR, 'marken.json'); if (fs.existsSync(f)) fs.copyFileSync(f, f + '.bak-' + Date.now()); fs.writeFileSync(f, JSON.stringify(l, null, 2)) }
function konkAds(id) { try { return JSON.parse(fs.readFileSync(path.join(KONK_ADS, id + '.json'), 'utf8')) } catch { return { ads: [] } } }
function konkAdsSchreiben(id, d) { const f = path.join(KONK_ADS, id + '.json'), t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(d)); fs.renameSync(t, f) }
function konkNorm(a, quelle) {
  const m = a.metrics || {}, c = a.content || {}, md = a.media || {}, adv = a.advertiser || {}
  return { id: a.id, status: a.status, typ: md.type || null, tage: a.daysRunning || 0, erst: a.firstSeenAt || null, zuletzt: a.lastSeenAt || null, erstellt: a.createdAt || null,
    reach: m.aggregatedReach || m.reach || null, spend: m.estimatedSpend || null, duplikate: m.duplicates || null,
    absender: { id: adv.id || null, name: adv.name || null, logo: adv.logoUrl || null }, titel: c.title || null, text: c.body || null, transkript: c.transcript || null,
    cta: c.callToAction || null, ctaText: c.ctaDescription || null, lp: c.landingPageUrl || null, lpDomain: c.landingPageDomain || null,
    mediaUrl: md.mediaUrl || null, thumbUrl: md.thumbnailUrl || null, land: (a.audience || {}).mainCountry || null, quelle }
}
// Rang nach Laufzeit: die laengsten Laeufer sind die Gewinner, egal ob live oder aus
// Rang: Meta-Werbebibliothek zuerst (metaRang, nach Impressionen), dann TrendTrack-Reichweite (reachRang), sonst Laufzeit (06.10., Sam)
function konkRang(d) { const g = (v) => (v == null ? 1e9 : v); d.ads.sort((x, y) => g(x.metaRang) - g(y.metaRang) || g(x.reachRang) - g(y.reachRang) || g(x.inaktivRang) - g(y.inaktivRang) || (y.tage || 0) - (x.tage || 0) || (y.reach || 0) - (x.reach || 0)); d.ads.forEach((a, i) => { a.rang = i + 1; a.top = i < KONK_TOP }) }
function konkMerge(id, neue) {
  const d = konkAds(id), map = new Map(d.ads.map((a) => [a.id, a]))
  for (const n of neue) { const alt = map.get(n.id); map.set(n.id, alt ? Object.assign({}, alt, n, { lokal: alt.lokal, lokalThumb: alt.lokalThumb, gemerkt: alt.gemerkt, notiz: alt.notiz, quelle: alt.quelle, metaRang: alt.metaRang, metaEntfernt: alt.metaEntfernt }) : n) }
  d.ads = [...map.values()]; konkRang(d); d.aktualisiert = new Date().toISOString(); konkAdsSchreiben(id, d); return d
}
async function ttFetch(pfad, opt) {
  const key = envLesen().TRENDTRACK_API_KEY; if (!key) throw new Error('TrendTrack-Schlüssel fehlt (API Keys, Nr. 10)')
  const r = await fetch('https://api.trendtrack.io' + pfad, Object.assign({ headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000) }, opt || {}))
  const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && (j.message || (j.error && j.error.message))) || ('TrendTrack ' + r.status))
  return { daten: j, kosten: Number(r.headers.get('x-usage-cost') || 0) }
}
let konkUsage = { at: 0, wert: null }
async function konkCredits() {
  if (Date.now() - konkUsage.at < 5 * 60000 && konkUsage.wert) return konkUsage.wert
  try { const { daten } = await ttFetch('/v1/usage'); const q = daten.includedQuota || {}; konkUsage = { at: Date.now(), wert: { limit: q.limit, verbraucht: q.used, frei: q.remaining, bis: (daten.billing || {}).currentPeriodEnd || null } } } catch (e) { return { fehler: e.message } }
  return konkUsage.wert
}
// Medien nacheinander laden, nie mehr als die Platte hergibt
const konkJobs = []; let konkLaeuft = false
function konkMedienPlanen(markeId, ads) { for (const a of ads) { if (a.mediaUrl && !a.lokal) konkJobs.push({ markeId, adId: a.id, url: a.mediaUrl, art: 'lokal' }); if (a.thumbUrl && !a.lokalThumb) konkJobs.push({ markeId, adId: a.id, url: a.thumbUrl, art: 'lokalThumb' }) } if (!konkLaeuft) konkWeiter() }
function konkWeiter() {
  const j = konkJobs.shift(); if (!j) { konkLaeuft = false; osPush('modul', { datei: 'konkurrenz' }); return } konkLaeuft = true
  try { const st = fs.statfsSync(KONK_DIR); if (st.bavail * st.bsize < 3 * 1073741824) { console.warn('[konkurrenz] Platte fast voll, Download gestoppt'); konkJobs.length = 0; konkLaeuft = false; return } } catch {}
  const ext = (j.url.match(/\.(jpe?g|png|webp|mp4|mov)(\?|$)/i) || [, 'jpg'])[1].toLowerCase(), datei = crypto.createHash('sha1').update(j.url).digest('hex') + '.' + ext, ziel = path.join(KONK_MEDIA, datei)
  const fertig = () => { try { const d = konkAds(j.markeId); const a = d.ads.find((x) => x.id === j.adId); if (a) { a[j.art] = datei; konkAdsSchreiben(j.markeId, d) } } catch {} setImmediate(konkWeiter) }
  if (fs.existsSync(ziel)) return fertig()
  execFile('curl', ['-s', '-L', '-f', '--max-time', '600', '--max-filesize', '400000000', '-o', ziel + '.tmp', j.url], (err) => {
    if (err) { try { fs.unlinkSync(ziel + '.tmp') } catch {} console.warn('[konkurrenz] Download fehlgeschlagen', j.adId, err.message); return setImmediate(konkWeiter) }
    try { fs.renameSync(ziel + '.tmp', ziel) } catch {} fertig()
  })
}
function konkUebersicht(m) {
  const d = konkAds(m.id), a = d.ads
  return Object.assign({}, m, { anzahl: a.length, aktiv: a.filter((x) => x.status === 'active').length, video: a.filter((x) => x.typ === 'video').length, bild: a.filter((x) => x.typ === 'image').length, top: a.filter((x) => x.top).length, topLokal: a.filter((x) => x.top && x.lokal).length, gemerkt: a.filter((x) => x.gemerkt).length, aktualisiert: d.aktualisiert || null })
}
app.get('/api/os/konkurrenz', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  res.json({ marken: konkMarken().map(konkUebersicht), credits: await konkCredits(), download: { laeuft: konkLaeuft, offen: konkJobs.length } })
})
app.get('/api/os/konkurrenz/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const m = konkMarken().find((x) => x.id === req.params.id); if (!m) return res.status(404).json({ error: 'Marke nicht gefunden' })
  const d = konkAds(m.id); const lps = {}
  for (const a of d.ads) { if (!a.lp) continue; const u = a.lp.split('?')[0]; const l = lps[u] || (lps[u] = { url: u, ads: 0, aktiv: 0, maxTage: 0 }); l.ads++; if (a.status === 'active') l.aktiv++; l.maxTage = Math.max(l.maxTage, a.tage || 0) }
  res.json({ marke: konkUebersicht(m), ads: d.ads, landingpages: Object.values(lps).sort((x, y) => y.ads - x.ads), download: { laeuft: konkLaeuft, offen: konkJobs.length } })
})
app.get('/api/os/konkurrenz-media/:datei', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (!/^[a-f0-9]{40}\.(jpe?g|png|webp|mp4|mov)$/.test(req.params.datei)) return res.status(400).end()
  res.setHeader('Cache-Control', 'private, max-age=604800'); if (req.query.dl) res.setHeader('Content-Disposition', 'attachment; filename="' + req.params.datei + '"')
  res.sendFile(path.join(KONK_MEDIA, req.params.datei), (e) => { if (e && !res.headersSent) res.status(404).end() })
})
// Marke suchen (kostenlos) und anlegen
app.post('/api/os/konkurrenz/marke', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}
  try {
    if (b.anlegen) { const n = b.anlegen; const domain = String(n.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''); if (!domain) return res.status(400).json({ error: 'Domain fehlt' })
      const l = konkMarken(); const id = domain.replace(/[^a-z0-9]+/g, '-').replace(/-+$/, ''); if (l.some((x) => x.id === id)) return res.json({ ok: true, id, schonDa: true })
      l.push({ id, name: String(n.name || domain).slice(0, 80), domain, shopId: n.shopId || null, advertiserIds: [].concat(n.advertiserIds || []).map(String), angelegt: new Date().toISOString(), von: req.user.name || 'Service' }); konkMarkenSchreiben(l); osPush('modul', { datei: 'konkurrenz' }); return res.json({ ok: true, id }) }
    const q = String(b.q || '').trim(); if (!q) return res.status(400).json({ error: 'Suchbegriff fehlt' })
    const { daten } = await ttFetch('/v1/lookup?q=' + encodeURIComponent(q) + '&type=auto')
    const seen = new Set(); const kand = []
    for (const x of (daten.data || [])) { const dom = x.shop && x.shop.domain; const k = dom || (x.advertiser && x.advertiser.id); if (!k || seen.has(k)) continue; seen.add(k)
      kand.push({ name: (x.shop && x.shop.name) || (x.advertiser && x.advertiser.name), domain: dom || null, shopId: x.shop && x.shop.id || null, advertiserIds: x.advertiser ? [x.advertiser.id] : [], aktiveAds: (x.signals || {}).activeAds || 0, besucher: (x.signals || {}).monthlyVisits || null }) }
    res.json({ kandidaten: kand.slice(0, 8) })
  } catch (e) { res.status(502).json({ error: e.message }) }
})
// Ads einer Marke holen: ohne bestaetigt nur Kostenschaetzung, mit bestaetigt wird gekauft
app.post('/api/os/konkurrenz/:id/aktualisieren', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const m = konkMarken().find((x) => x.id === req.params.id); if (!m) return res.status(404).json({ error: 'Marke nicht gefunden' })
  if (!m.domain) return res.status(400).json({ error: 'Marke ohne Domain' })
  const b = req.body || {}; const anzahl = Math.max(10, Math.min(500, Number(b.anzahl) || 100)); const status = ['all', 'active', 'inactive'].includes(b.status) ? b.status : 'all'
  const sortBy = ['longestRunning', 'newest', 'reach', 'mostDuplicates'].includes(b.sortBy) ? b.sortBy : 'reach'; const seiten = Math.ceil(anzahl / 100)
  const schaetzung = Math.ceil(anzahl * 1.5 + seiten * 2)
  if (!b.bestaetigt) return res.json({ schaetzung, anzahl, credits: await konkCredits() })
  try {
    let alle = [], kosten = 0
    for (let p = 1; p <= seiten; p++) { const lim = Math.min(100, anzahl - alle.length); if (lim <= 0) break
      const { daten, kosten: k } = await ttFetch('/v1/ads/query', { method: 'POST', body: JSON.stringify({ search: m.domain, searchType: 'domain', status, sortBy, limit: lim, page: p }) }); kosten += k
      const neu = (daten.data || []).map((a, i) => Object.assign(konkNorm(a, 'trendtrack ' + new Date().toISOString().slice(0, 10)), sortBy === 'reach' ? { reachRang: (p - 1) * 100 + i + 1 } : {})); alle = alle.concat(neu); if (neu.length < lim) break }
    const d = konkMerge(m.id, alle); konkUsage.at = 0
    konkMedienPlanen(m.id, d.ads.filter((a) => a.top))
    console.log(`[konkurrenz] ${m.name}: ${alle.length} Ads geholt, ${kosten} Credits, von ${req.user.name}`)
    res.json({ ok: true, geholt: alle.length, kosten, gesamt: d.ads.length })
  } catch (e) { res.status(502).json({ error: e.message }) }
})
// Medien laden (kostenlos): Top 100 oder ausgewaehlte Ads
app.post('/api/os/konkurrenz/:id/medien', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const m = konkMarken().find((x) => x.id === req.params.id); if (!m) return res.status(404).json({ error: 'Marke nicht gefunden' })
  const b = req.body || {}, d = konkAds(m.id); const ids = new Set([].concat(b.ids || []))
  const wahl = d.ads.filter((a) => ids.size ? ids.has(a.id) : a.top); konkMedienPlanen(m.id, wahl)
  res.json({ ok: true, geplant: konkJobs.length })
})
// Merken und Notiz je Ad
app.post('/api/os/konkurrenz/:id/ad', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const d = konkAds(req.params.id); const a = d.ads.find((x) => x.id === b.adId); if (!a) return res.status(404).json({ error: 'Ad nicht gefunden' })
  if ('gemerkt' in b) a.gemerkt = !!b.gemerkt; if ('notiz' in b) a.notiz = String(b.notiz || '').slice(0, 2000)
  konkAdsSchreiben(req.params.id, d); res.json({ ok: true })
})

// Let's Rip (Sam, 06.10.): Ads aus dem OS ins Ripping Sheet (rippingsheet.ai, AX41) schicken.
// Weg (seit 06.10. abends): SSH mit /root/.ssh/os_rip_ax102 auf den AX102 (188.40.90.153), dort darf der Schluessel nur /root/bin/os-rip.sh
// ausfuehren. Das Skript reiht die Ads im gemeinsamen Ripping Sheet (rippingsheet.ai, Brand leichtkraut) ein. Alter Weg AX41: os_rip_ax41 -> sam@65.108.228.40.
const RIP_SSH = ['-i', '/root/.ssh/os_rip_ax102', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=yes', 'root@188.40.90.153']
function ripRufen(befehl) {
  return new Promise((ok, nein) => execFile('ssh', RIP_SSH.concat([befehl]), { timeout: 45_000, maxBuffer: 1 << 20 }, (e, out) => {
    let j = null; try { j = JSON.parse(String(out || '').trim() || 'null') } catch {}
    if (j) return ok(j); nein(new Error(e ? 'Ripping Sheet nicht erreichbar: ' + String(e.message || '').split('\n')[0].slice(0, 120) : 'Antwort vom Ripping Sheet unlesbar'))
  }))
}
app.post('/api/os/rip', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}
  const roh = [].concat(b.ids || []).concat(String(b.text || '').split(/[\s,;]+/))
  const ids = [...new Set(roh.map((x) => { const t = String(x || '').trim(); const m = t.match(/[?&]id=(\d{10,20})/) || t.match(/(?:^|facebook_|\/)(\d{10,20})(?:$|[/?#])/); return m ? m[1] : null }).filter(Boolean))].slice(0, 50)
  if (!ids.length) return res.status(400).json({ error: 'Keine Ad-ID erkannt. Erwartet wird die Zahl aus der Werbebibliothek oder ein Link mit ?id=' })
  try {
    const j = await ripRufen('holen ' + (b.funnel === 'bof' ? 'bof ' : '') + ids.join(' '))
    if (j.fehler) return res.status(502).json({ error: 'Ripping Sheet: ' + j.fehler })
    const stand = {}; for (const id of (j.angenommen || [])) stand[id] = { stand: 'eingereiht' }
    for (const u of (j.uebersprungen || [])) stand[u.adId] = { stand: u.grund, projekt: u.projekt || null }
    // Stand je Ad in der Konkurrenz merken, damit die Karte „im Sheet“ zeigt
    if (b.marke && konkMarken().some((m) => m.id === String(b.marke))) { try { const d = konkAds(String(b.marke)); let n = 0
      for (const a of d.ads) { const lid = String(a.id || '').replace(/^facebook_/, ''); if (stand[lid]) { a.rip = Object.assign({ at: new Date().toISOString(), von: req.user.name || 'Service', funnel: b.funnel === 'bof' ? 'bof' : null }, stand[lid]); n++ } }
      if (n) konkAdsSchreiben(String(b.marke), d) } catch (e) { console.warn('[rip] Stand merken:', e.message) } }
    console.log(`[rip] ${ids.length} ans Ripping Sheet, ${(j.angenommen || []).length} neu eingereiht, von ${req.user.name}`)
    res.json({ ok: true, ids, angenommen: j.angenommen || [], uebersprungen: j.uebersprungen || [], abgelehnt: j.abgelehnt || [], wartend: j.wartend ?? null, stand })
  } catch (e) { res.status(502).json({ error: e.message }) }
})
app.get('/api/os/rip/status', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  try { res.json(await ripRufen('status')) } catch (e) { res.status(502).json({ error: e.message }) }
})

function envLesen() { const o = {}; try { for (const l of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) { const m = l.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m) o[m[1]] = m[2] } } catch {} return o }
app.get('/api/os/apikeys', (req, res) => {
  if (!req.user || req.user.role !== 'admin' || req.user.gast || req.user.id === 'service') return res.status(403).json({ error: 'Nur für Sam' })
  const env = envLesen(); let meta = {}; try { meta = JSON.parse(fs.readFileSync(APIKEY_META, 'utf8')) } catch {}
  const bekannt = new Set(API_KATALOG.map((k) => k[0]))
  const zeile = (name, dienst, zweck) => { const v = env[name] || ''; return { name, dienst, zweck, gesetzt: !!v, ende: v ? '…' + v.slice(-4) : null, at: (meta[name] || {}).at || null, von: (meta[name] || {}).von || null } }
  const liste = API_KATALOG.map((k) => zeile(k[0], k[1], k[2])).concat(Object.keys(env).filter((n) => !bekannt.has(n) && !API_GESPERRT.has(n) && (/(KEY|TOKEN|SECRET|PASSWORD|WEBHOOK)/.test(n) || (meta[n] && !meta[n].entfernt))).map((n) => zeile(n, n, 'eigener Eintrag')))
  // eigene Eintraege aus der OS-Seite immer zeigen, auch ohne KEY im Namen (05.10., SYNCLAB war unsichtbar)
  res.json({ keys: liste })
})
app.post('/api/os/apikeys', (req, res) => {
  if (!req.user || req.user.role !== 'admin' || req.user.gast || req.user.id === 'service') return res.status(403).json({ error: 'Nur für Sam' })
  const b = req.body || {}; const name = String(b.name || '').trim().toUpperCase(); const wert = String(b.wert == null ? '' : b.wert).trim()
  if (!/^[A-Z][A-Z0-9_]{2,48}$/.test(name) || API_GESPERRT.has(name)) return res.status(400).json({ error: 'Dieser Name ist nicht erlaubt.' })
  if (/[\r\n]/.test(wert) || wert.length > 4000) return res.status(400).json({ error: 'Ungültiger Wert.' })
  const users = readUsers(); const u = users.find((y) => y.id === req.user.id); if (!u || !u.totp || !u.totp.aktiv) return res.status(403).json({ error: 'Erst 2FA einrichten.' })
  const st = totpPruefen(u.totp.secret, b.code, u.totp.letzterSchritt); if (st < 0) return res.status(401).json({ error: '2FA-Code falsch. Bitte den aktuellen Code aus der App eingeben.' })
  u.totp.letzterSchritt = st; writeUsers(users)
  fs.copyFileSync(ENV_FILE, ENV_FILE + '.bak-apikey-' + Date.now())
  const zeilen = fs.readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => l && !l.startsWith(name + '=')); if (wert) zeilen.push(name + '=' + wert)
  fs.writeFileSync(ENV_FILE, zeilen.join('\n') + '\n'); if (wert) process.env[name] = wert; else delete process.env[name]
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(APIKEY_META, 'utf8')) } catch {}
  meta[name] = { at: new Date().toISOString(), von: req.user.name, entfernt: !wert }; fs.writeFileSync(APIKEY_META, JSON.stringify(meta, null, 2), { mode: 0o600 })
  console.log(`[os] API-Schlüssel ${wert ? 'gesetzt' : 'entfernt'}: ${name} (von ${req.user.name}), Neustart folgt`)
  res.json({ ok: true, neustart: true }); setTimeout(() => process.exit(0), 900)
})
app.get('/api/os/planung/teilen', (req, res) => { if (!req.user || req.user.role !== 'admin' || req.user.gast) return res.status(403).json({ error: 'Nur für Admins' }); const t = teilenLesen(); res.json({ aktiv: !!t.aktiv, link: t.aktiv ? 'https://os.leichtkraut.de/planung/' + t.token : null, erstellt: t.erstellt || null, name: t.name || null }) })
app.post('/api/os/planung/teilen', (req, res) => {
  if (!req.user || req.user.role !== 'admin' || req.user.gast) return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const alt = teilenLesen(); let t
  if (b.aktion === 'aus') t = Object.assign({}, alt, { aktiv: false, widerrufen: new Date().toISOString(), token: null })
  else t = { aktiv: true, token: crypto.randomBytes(18).toString('base64url'), erstellt: new Date().toISOString(), von: req.user.name, name: String(b.name || alt.name || 'Gast (Link)').slice(0, 60) }
  if (fs.existsSync(TEILEN_FILE)) fs.copyFileSync(TEILEN_FILE, TEILEN_FILE + '.bak-' + Date.now())
  fs.writeFileSync(TEILEN_FILE, JSON.stringify(t, null, 2)); res.json({ aktiv: !!t.aktiv, link: t.aktiv ? 'https://os.leichtkraut.de/planung/' + t.token : null, erstellt: t.erstellt || null })
})
app.get('/chat/:nr', (req, res) => {
  if (!nurAdminSeite(req, res)) return
  const c = (osLesen().chats || []).find((x) => String(x.nr) === String(req.params.nr)); res.setHeader('Cache-Control', 'no-store')
  if (!c || !c.sessionId) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><body style="background:#08070d;color:#d9d3ea;font:15px -apple-system,sans-serif;display:grid;place-items:center;min-height:100vh">Für diesen Chat ist kein Fenster hinterlegt.')
  const u = 'claude://claude.ai/epitaxy/' + c.sessionId, n = String(c.name || '').replace(/[<>&"]/g, '')
  res.type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat ' + c.nr + ' öffnen</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#08070d;color:#d9d3ea;font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;text-align:center"><div><div style="font-size:13px;color:#9c95b5;text-transform:uppercase;letter-spacing:.1em;font-weight:700">Claude öffnet sich …</div><h2 style="color:#f3f0fb;margin:8px 0 18px">Chat ' + c.nr + ' · ' + n + '</h2><a href="' + u + '" style="display:inline-block;padding:12px 22px;border-radius:12px;background:linear-gradient(135deg,#7c3aed,#c026d3);color:#fff;font-weight:700;text-decoration:none">Chat in Claude öffnen</a><p style="color:#6c6687;font-size:12px;margin-top:16px">Funktioniert auf dem Mac mit der Claude-App.</p></div><script>location.href=' + JSON.stringify(u) + '</script>')
})
app.get('/planung/:tok', (req, res) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); if (!teilenGueltig(req.params.tok)) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Link ungültig</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#08070d;color:#d9d3ea;font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">Dieser Link ist ungültig oder wurde widerrufen.'); res.type('html').send(fs.readFileSync(path.join(__dirname, 'pages', 'planung-teilen.html'), 'utf8')) })
// Ziele fuer einen Zeitraum (Sam, 04.10.2026: Kroatien · Q4 Preparation). Form: ziele { titel, zeitraum, zahlenziel, motto, gruppen: [{ name, ziele: [{ id, text, done, doneAt }] }] }
app.post('/api/os/planung/ziel/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d = planungLesen(); const z = ((d.ziele && d.ziele.gruppen) || []).flatMap((g) => g.ziele || []).find((x) => x.id === req.params.id); if (!z) return res.status(404).json({ error: 'Ziel nicht gefunden' })
  const b = req.body || {}; if (typeof b.done === 'boolean') { z.done = b.done; z.doneAt = b.done ? new Date().toISOString() : null } if (typeof b.text === 'string' && b.text.trim()) z.text = b.text.trim().slice(0, 300)
  d.updatedAt = new Date().toISOString(); d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true, ziel: z })
})
app.post('/api/os/planung/routine', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const k = String((req.body || {}).key || ''); if (!ROUTINE.some(([x]) => x === k)) return res.status(400).json({ error: 'Unbekannter Punkt' })
  const d = planungLesen(); d.routineLog = d.routineLog || {}; const t = berlinTag(); d.routineLog[t] = d.routineLog[t] || {}; d.routineLog[t][k] = !!req.body.done
  d.updatedAt = new Date().toISOString(); d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true, routine: routineStand(d) })
})
app.post('/api/os/planung/journal', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const art = String(b.art || ''); if (!['erfolg', 'ideen', 'erkenntnis'].includes(art)) return res.status(400).json({ error: 'art: erfolg, ideen oder erkenntnis' })
  const text = String(b.text || '').trim().slice(0, 1000); if (!text) return res.status(400).json({ error: 'text fehlt' })
  const d = planungLesen(); d.journale = d.journale || { erfolg: [], ideen: [], erkenntnis: [] }; d.journale[art] = d.journale[art] || []
  const e = { id: 'j' + Date.now().toString(36), text, buch: b.buch ? String(b.buch).slice(0, 200) : null, tag: berlinTag(), at: new Date().toISOString() }
  d.journale[art].push(e); d.routineLog = d.routineLog || {}; const t = berlinTag(); d.routineLog[t] = d.routineLog[t] || {}; d.routineLog[t][art] = true
  d.updatedAt = e.at; d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true, eintrag: e, routine: routineStand(d) })
})
app.post('/api/os/planung/reflexion', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const d = planungLesen(); d.reflexionen = d.reflexionen || []; const kw = kwVon(berlinTag())
  let r = d.reflexionen.find((x) => x.kw === kw); if (!r) { r = { kw }; d.reflexionen.push(r) }
  for (const f of ['learnings', 'falsch', 'naechsteWoche']) if (typeof b[f] === 'string') r[f] = b[f].slice(0, 5000)
  r.at = new Date().toISOString(); d.updatedAt = r.at; d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true, reflexion: r })
})
app.post('/api/os/planung/einstellung', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const d = planungLesen(); if (typeof b.autosuggestion === 'string') d.autosuggestion = b.autosuggestion.slice(0, 3000); if (typeof b.buch === 'string') d.buch = b.buch.slice(0, 200)
  d.updatedAt = new Date().toISOString(); d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true })
})
app.post('/api/os/planung/aufgabe', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const text = String(b.text || '').trim().slice(0, 300); if (!text) return res.status(400).json({ error: 'text fehlt' })
  const d = planungLesen(); const liste = b.liste === 'woche' ? d.woche.ziele : d.heute.aufgaben
  const heuteT = berlinTag(), bisT = berlinTag(new Date(Date.now() + 14 * 864e5)); const wunschT = /^\d{4}-\d{2}-\d{2}$/.test(String(b.tag || '')) && b.tag >= heuteT && b.tag <= bisT ? b.tag : heuteT
  const a = { id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text, tag: wunschT, person: ['sam', 'viktor'].includes(b.person) ? b.person : 'sam', done: false, prio: ['hoch', 'normal', 'niedrig'].includes(b.prio) ? b.prio : 'normal', chat: b.chat ? Number(b.chat) || null : null, at: new Date().toISOString(), von: req.user.name }
  a.pos = 1 + Math.max(0, ...liste.filter((x) => (x.tag || '') === a.tag && (x.person || 'sam') === a.person).map((x) => Number(x.pos) || 0)); liste.push(a); d.updatedAt = a.at; d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true, aufgabe: a })
})
app.post('/api/os/planung/reihenfolge', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String).slice(0, 300) : null; if (!ids) return res.status(400).json({ error: 'ids fehlt' })
  const d = planungLesen(); ids.forEach((id, i) => { const a = d.heute.aufgaben.find((x) => x.id === id); if (a) a.pos = i + 1 })
  d.updatedAt = new Date().toISOString(); d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true })
})
app.post('/api/os/planung/aufgabe/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d = planungLesen(); const a = d.heute.aufgaben.concat(d.woche.ziele).find((x) => x.id === req.params.id); if (!a) return res.status(404).json({ error: 'Aufgabe nicht gefunden' })
  const b = req.body || {}
  if (b.loeschen === true) { d.heute.aufgaben = d.heute.aufgaben.filter((x) => x.id !== a.id); d.woche.ziele = d.woche.ziele.filter((x) => x.id !== a.id); d.papierkorb = (d.papierkorb || []).concat([Object.assign({}, a, { geloeschtAm: new Date().toISOString(), geloeschtVon: req.user.name })]).slice(-200); d.updatedAt = new Date().toISOString(); d.updatedBy = req.user.name; modulSchreiben('planung', d); return res.json({ ok: true, geloescht: a.id }) }
  if (typeof b.done === 'boolean') { a.done = b.done; a.doneAt = b.done ? new Date().toISOString() : null } if (typeof b.text === 'string' && b.text.trim()) a.text = b.text.trim().slice(0, 300); if (['hoch', 'normal', 'niedrig'].includes(b.prio)) a.prio = b.prio; if ('chat' in b) a.chat = b.chat ? Math.max(1, Math.min(9, Number(b.chat) || 0)) || null : null; if (typeof b.prioritaet === 'boolean') a.prioritaet = b.prioritaet
  d.updatedAt = new Date().toISOString(); d.updatedBy = req.user.name; modulSchreiben('planung', d); res.json({ ok: true, aufgabe: a })
})
// Team: Zeiten und Mails aus dem Mail-Tool (gleicher Server, gleiche Funktion, nur lesend)
let teamCache = { at: 0, j: null }
app.get('/api/os/team', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (teamCache.j && Date.now() - teamCache.at < 30_000) return res.json(Object.assign({}, teamCache.j, { sheet: modulLesen('sheet') }))
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/track/stats`, { headers: { 'x-service-token': SERVICE_TOKEN || '' } }); const j = await r.json(); teamCache = { at: Date.now(), j: { stats: j, jetzt: new Date().toISOString() } }; res.json({ stats: j, sheet: modulLesen('sheet'), jetzt: new Date().toISOString() }) }
  catch (e) { res.json({ stats: null, sheet: modulLesen('sheet'), fehler: e.message }) }
})

// ── Backend-Sheet (Google Sheets „Leichtkraut-Backend“): alle 60 s als CSV lesen, nur bei Aenderung speichern ──
// Das Sheet ist per Link lesbar. Blaetter werden ueber ihren Namen abgerufen. Nur lesend.
const SHEET_ID = '1fOX641TH1XlLnAsBA4NumL8-HQEYnQ8NCEBFf0O3nVQ'
const SHEET_BLAETTER = ['1 · After-Sales', '2 · Refunds', '3 · Chargebacks']
function csvParsen(text) { // RFC-4180: Anfuehrungszeichen, Kommas und Zeilenumbrueche in Zellen
  const zeilen = []; let zeile = [], zelle = '', inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { zelle += '"'; i++ } else inQ = false } else zelle += c }
    else if (c === '"') inQ = true
    else if (c === ',') { zeile.push(zelle); zelle = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; zeile.push(zelle); zeilen.push(zeile); zeile = []; zelle = '' }
    else zelle += c
  }
  if (zelle !== '' || zeile.length) { zeile.push(zelle); zeilen.push(zeile) }
  return zeilen
}
let sheetLaeuft = false
async function sheetHolen(grund) {
  if (sheetLaeuft) return; sheetLaeuft = true
  try {
    const blaetter = []
    for (const name of SHEET_BLAETTER) {
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(name)}`
      const r = await fetch(url, { redirect: 'follow' }); if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`)
      const rows = csvParsen(await r.text()).filter((z) => z.some((x) => String(x).trim() !== ''))
      const spalten = (rows[0] || []).map((x) => String(x).trim())
      const zeilen = rows.slice(1).map((z) => spalten.map((_, i) => String(z[i] == null ? '' : z[i]).trim()))
      blaetter.push({ name, spalten, zeilen, anzahl: zeilen.length })
    }
    const alt = modulLesen('sheet'); const neu = { quelle: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`, titel: 'Leichtkraut-Backend', blaetter }
    const gleich = alt && JSON.stringify(alt.blaetter) === JSON.stringify(neu.blaetter)
    if (!gleich) { neu.updatedAt = new Date().toISOString(); neu.updatedBy = 'Google Sheet'; modulSchreiben('sheet', neu); console.log(`[os] Backend-Sheet aktualisiert (${grund}): ${blaetter.map((b) => b.anzahl).join('/')} Zeilen`) }
    else if (alt) { alt.geprueftAt = new Date().toISOString(); const f = path.join(OS_MODUL_DIR, 'sheet.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(alt, null, 2)); fs.renameSync(f + '.tmp', f) }
    return neu
  } catch (e) { console.warn('[os] Backend-Sheet nicht lesbar:', e.message); const alt = modulLesen('sheet'); if (alt) { alt.fehler = e.message; alt.geprueftAt = new Date().toISOString() } return alt }
  finally { sheetLaeuft = false }
}
setTimeout(() => sheetHolen('Start'), 3000); setInterval(() => sheetHolen('Intervall'), 60_000)
app.get('/api/os/sheet', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); res.json(modulLesen('sheet') || { blaetter: [], updatedAt: null }) })
app.post('/api/os/sheet/refresh', async (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const d = await sheetHolen('manuell'); res.json(d || { blaetter: [] }) })

// ── SHOPIFY LIVE (OS Manager, 05.09.2026): das OS ist die Drehscheibe fuer Shopify ──
// Eine Develop-App im Shopify-Admin, deren Admin-Token (shpat_) und Secret (shpss_) liegen NUR in
// .env (SHOPIFY_OS_TOKEN, SHOPIFY_OS_SECRET). Shopify meldet jede Bestellung per Webhook sofort
// hierher; das OS bucht den Stock, meldet per Echtzeit-Kanal und reicht Bestellungen an Chat 6 weiter.
const SHOP_STORE = process.env.SHOPIFY_OS_STORE || (connections.shopify && connections.shopify.store) || 'dein-shop.myshopify.com'
// Zwei Wege: (a) Client-ID + Secret der App in .env, das OS holt sich den Token selbst (client_credentials, 24 h,
// wird automatisch erneuert); (b) fester Admin-Token SHOPIFY_OS_TOKEN. Das Secret ist zugleich der Webhook-Schluessel.
let SHOP_TOKEN = process.env.SHOPIFY_OS_TOKEN || '', SHOP_TOKEN_BIS = 0, SHOP_TOKEN_ART = SHOP_TOKEN ? 'manuell' : ''
const SHOP_SECRET = process.env.SHOPIFY_OS_SECRET || '', SHOP_CLIENT_ID = process.env.SHOPIFY_OS_CLIENT_ID || ''
async function shopTokenHolen() {
  if (!SHOP_CLIENT_ID || !SHOP_SECRET) return false
  const r = await fetch(`https://${SHOP_STORE}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: SHOP_CLIENT_ID, client_secret: SHOP_SECRET, grant_type: 'client_credentials' }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new Error(`Shopify Token ${r.status}: ${JSON.stringify(j).slice(0, 200)}`)
  SHOP_TOKEN = j.access_token; SHOP_TOKEN_ART = 'client_credentials'; SHOP_TOKEN_BIS = Date.now() + (Number(j.expires_in) || 86000) * 1000 - 15 * 60_000
  console.log(`[os] Shopify-Token geholt, Scopes: ${j.scope || '(leer)'}, gültig bis ${new Date(SHOP_TOKEN_BIS).toISOString()}`)
  return true
}
async function shopTokenSicher() { if (SHOP_CLIENT_ID && SHOP_SECRET && (!SHOP_TOKEN || SHOP_TOKEN_ART !== 'client_credentials' || Date.now() > SHOP_TOKEN_BIS)) await shopTokenHolen() }
setInterval(() => shopTokenSicher().catch((e) => console.warn('[os] Shopify-Token:', e.message)), 10 * 60_000)
const SHOP_API = '2025-07'
const SHOP_TOPICS = ['orders/create', 'orders/paid', 'orders/updated', 'orders/cancelled', 'refunds/create', 'inventory_levels/update']
const SHOP_WEBHOOK_URL = 'https://os.leichtkraut.de/api/os/shopify/webhook'
const SHOP_EVENTS = path.join(OS_MODUL_DIR, 'shopify-events.jsonl')
async function shopApi(pfad, opts = {}, nochmal = true) {
  await shopTokenSicher()
  if (!SHOP_TOKEN) throw new Error('Kein Shopify-Zugang: SHOPIFY_OS_CLIENT_ID + SHOPIFY_OS_SECRET (oder SHOPIFY_OS_TOKEN) fehlen in .env')
  const r = await fetch(`https://${SHOP_STORE}/admin/api/${SHOP_API}/${pfad}`, Object.assign({}, opts, { headers: Object.assign({ 'X-Shopify-Access-Token': SHOP_TOKEN, 'Content-Type': 'application/json' }, opts.headers || {}) }))
  const text = await r.text(); let j = {}; try { j = JSON.parse(text) } catch {}
  if (r.status === 401 && nochmal && SHOP_CLIENT_ID) { SHOP_TOKEN = ''; await shopTokenHolen(); return shopApi(pfad, opts, false) }
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${j.errors ? JSON.stringify(j.errors) : text.slice(0, 200)}`)
  return { j, link: r.headers.get('link') || '' }
}
async function shopScopes() { await shopTokenSicher(); const r = await fetch(`https://${SHOP_STORE}/admin/oauth/access_scopes.json`, { headers: { 'X-Shopify-Access-Token': SHOP_TOKEN } }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`Shopify ${r.status}: ${JSON.stringify(j).slice(0, 200)}`); return (j.access_scopes || []).map((x) => x.handle) }
function shopEvents(limit) { try { const z = fs.readFileSync(SHOP_EVENTS, 'utf8').trim().split('\n').filter(Boolean); return z.slice(-limit).reverse().map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
async function shopWebhooksEinrichten() {
  const { j } = await shopApi('webhooks.json?limit=250'); const vorhanden = j.webhooks || []; const ergebnis = []
  for (const topic of SHOP_TOPICS) {
    if (vorhanden.find((w) => w.topic === topic && w.address === SHOP_WEBHOOK_URL)) { ergebnis.push({ topic, status: 'aktiv' }); continue }
    try { await shopApi('webhooks.json', { method: 'POST', body: JSON.stringify({ webhook: { topic, address: SHOP_WEBHOOK_URL, format: 'json' } }) }); ergebnis.push({ topic, status: 'angelegt' }) }
    catch (e) { ergebnis.push({ topic, status: 'fehler', fehler: e.message }) }
  }
  return ergebnis
}
if (SHOP_TOKEN || (SHOP_CLIENT_ID && SHOP_SECRET)) setTimeout(() => shopTokenSicher().then(shopWebhooksEinrichten).then((r) => console.log('[os] Shopify-Webhooks:', r.map((x) => x.topic + '=' + x.status).join(', '))).catch((e) => console.warn('[os] Shopify-Webhooks:', e.message)), 5000)
else console.log('[os] Shopify live: kein Zugang in .env (SHOPIFY_OS_CLIENT_ID + SHOPIFY_OS_SECRET), Webhooks warten')
// Bestand zaehlt nur Flaschen: Buerste und aehnliches Zubehoer zaehlen nicht (22.09., Chat 6)
const istFlasche = (titel) => !/b(ü|ue)rste|brush/i.test(String(titel || ''))
const flaschenIn = (items, feld) => (Array.isArray(items) ? items : []).reduce((a, x) => { const li = feld ? (x[feld] || {}) : x; return a + (istFlasche(li.title || li.name) ? (Number(x.quantity) || 0) : 0) }, 0)
// Bestand je Bestellung: bei create, updated (Upsell, Bearbeitung, Erstattung) und cancelled wird die Netto-Flaschenzahl
// der Bestellung neu berechnet und nur die Differenz gebucht. So stimmt der Bestand auch bei nachtraeglichen Upsells und Teilerstattungen (22.09.).
function stockBestellung(o, topic) {
  try {
    const d = stockLesen(); const basis = d.basis; if (!basis || !basis.abZeit || !o || !o.id) return
    if (Date.parse(o.created_at) < Date.parse(basis.abZeit)) return
    const erstattet = (o.refunds || []).reduce((a, r) => a + flaschenIn(r.refund_line_items, 'line_item'), 0)
    const netto = o.cancelled_at ? 0 : Math.max(0, flaschenIn(o.line_items) - erstattet)
    d.bestellungen = d.bestellungen || {}; const alt = d.bestellungen[o.id] || 0; const delta = netto - alt
    if (!delta) return
    d.bestellungen[o.id] = netto; if (d.bestand != null) d.bestand -= delta
    const quelle = delta > 0 ? (alt ? 'shopify-upsell' : 'shopify') : (o.cancelled_at ? 'shopify-storno' : 'shopify-erstattung')
    d.abgaenge = [{ at: new Date().toISOString(), menge: delta, quelle, ref: String(o.name || o.id), by: 'Shopify Webhook' }].concat(d.abgaenge || []).slice(0, 3000)
    d.updatedAt = new Date().toISOString(); d.quelle = 'shopify live'; modulSchreiben('stock', d)
  } catch (e) { console.warn('[os] Stock je Bestellung:', e.message) }
}
// Prognose (06.10., Sam): Verbrauch pro Tag, Reichweite, spaetester Bestelltag mit Lieferzeit + 10 Tagen Puffer.
// Beim Skalieren zaehlt der hoehere Wert aus 3-Tage- und 7-Tage-Schnitt, damit die Warnung frueh genug kommt.
// Verbrauch je Tag direkt aus den Shopify-Bestellungen beider Stores (letzte 45 Tage), alle 30 Minuten neu.
// Die Abgangs-Buchungen haben Luecken (Store-Wechsel Ende September), die Bestellungen nicht.
let stockVerbrauch = { stand: null, proTag: null, fehler: null }
async function stockVerbrauchLaden() {
  try {
    const tag = (x) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(x))
    const seit = new Date(Date.now() - 45 * 864e5).toISOString(), fields = 'id,created_at,cancelled_at,line_items,refunds', proTag = {}
    for (const alt of [false, true]) {
      if (alt && !SHOP_ALT.store) continue
      let q = `orders.json?limit=250&status=any&created_at_min=${encodeURIComponent(seit)}&fields=${fields}`
      for (let i = 0; i < 60; i++) { const { j, link } = alt ? await shopApiAlt(q) : await shopApi(q)
        for (const o of (j.orders || [])) { if (o.cancelled_at) continue; const erst = (o.refunds || []).reduce((a, x) => a + flaschenIn(x.refund_line_items, 'line_item'), 0); const n = Math.max(0, flaschenIn(o.line_items) - erst); const t = tag(o.created_at); proTag[t] = (proTag[t] || 0) + n }
        const next = (link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/) || [])[1]; if (!next) break; q = `orders.json?limit=250&page_info=${encodeURIComponent(next)}&fields=${fields}` }
    }
    stockVerbrauch = { stand: new Date().toISOString(), proTag, fehler: null }
  } catch (e) { stockVerbrauch.fehler = e.message; console.warn('[os] Stock-Verbrauch:', e.message) }
}
setTimeout(() => stockVerbrauchLaden().catch(() => {}), 20_000); setInterval(() => stockVerbrauchLaden().catch(() => {}), 30 * 60_000)
function stockPrognose(d) {
  d = d || stockLesen(); const tag = (x) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(x))
  const heute = tag(Date.now()); let proTag = {}
  if (stockVerbrauch.proTag) proTag = Object.assign({}, stockVerbrauch.proTag)
  else for (const a of (d.abgaenge || [])) { if (!/^shopify/.test(a.quelle || '')) continue; const t = tag(a.at); proTag[t] = (proTag[t] || 0) + (Number(a.menge) || 0) }
  // heute live aus den Buchungen seit dem letzten Laden ergaenzen (Webhooks sind schneller als der 30-Minuten-Lauf)
  if (stockVerbrauch.proTag) { const hb = (d.abgaenge || []).filter((a) => /^shopify/.test(a.quelle || '') && tag(a.at) === heute).reduce((a, x) => a + (Number(x.menge) || 0), 0); proTag[heute] = Math.max(proTag[heute] || 0, hb) }
  const ersterTag = Object.keys(proTag).sort()[0] || heute
  const tage = []; for (let i = 59; i >= 0; i--) { const t = tag(Date.now() - i * 864e5); if (t >= ersterTag) tage.push({ tag: t, flaschen: proTag[t] || 0 }) }
  const voll = tage.filter((x) => x.tag < heute)   // nur abgeschlossene Tage fuer die Schnitte
  const schnitt = (n) => { const l = voll.slice(-n); return l.length ? Math.round(l.reduce((a, x) => a + x.flaschen, 0) / l.length) : null }
  const avg3 = schnitt(3), avg7 = schnitt(7), avg30 = schnitt(30)
  const summe = (n) => tage.slice(-n).reduce((a, x) => a + x.flaschen, 0)
  const tempo = Math.max(avg3 || 0, avg7 || 0) || null
  const lieferzeit = d.lieferzeitTage || 14, puffer = d.pufferTage == null ? 10 : d.pufferTage
  const reichweite = d.bestand != null && tempo ? Math.floor(d.bestand / tempo) : null
  const plusTage = (n) => tag(Date.now() + n * 864e5)
  const bestellenIn = reichweite == null ? null : reichweite - lieferzeit - puffer
  const status = reichweite == null ? 'unbekannt' : bestellenIn <= 0 ? 'jetzt' : bestellenIn <= 7 ? 'bald' : 'ok'
  const skaliert = !!(avg3 && avg7 && avg3 >= avg7 * 1.3 && avg3 - avg7 >= 20)
  return { quelle: stockVerbrauch.proTag ? 'shopify-bestellungen' : 'buchungen', verbrauchStand: stockVerbrauch.stand, heute: proTag[heute] || 0, avg3, avg7, avg30, tempo, skaliert, summe7: summe(7), summe30: summe(30), ab: ersterTag, tage: tage.slice(-30),
    reichweiteTage: reichweite, reichtBis: reichweite == null ? null : plusTage(reichweite), lieferzeitTage: lieferzeit, pufferTage: puffer,
    bestellenInTagen: bestellenIn, bestellenBis: bestellenIn == null ? null : plusTage(Math.max(0, bestellenIn)), status }
}
// Warnung auf Telegram, hoechstens einmal pro Tag und Grund
function stockWarnen() {
  try {
    const d = stockLesen(); const p = stockPrognose(d); const heute = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())
    const w = d.warnungen || {}; let neu = false; const f = (n) => Number(n).toLocaleString('de-DE')
    if ((p.status === 'jetzt' || p.status === 'bald') && w.reichweite !== heute) {
      tgSenden(`Stock: ${p.status === 'jetzt' ? 'JETZT nachproduzieren' : 'bald nachproduzieren'}\nBestand ${f(d.bestand)} Flaschen, Verbrauch ${f(p.tempo)} pro Tag → reicht ${p.reichweiteTage} Tage (bis ${p.reichtBis.split('-').reverse().join('.')}).\nMit ${p.lieferzeitTage} Tagen Lieferzeit + ${p.pufferTage} Tagen Puffer spätestens bestellen: ${p.bestellenBis.split('-').reverse().join('.')}.\nhttps://os.leichtkraut.de/os#stock`).catch(() => {})
      w.reichweite = heute; neu = true }
    if (p.skaliert && w.skaliert !== heute) {
      tgSenden(`Stock: Verbrauch steigt (Scaling)\nØ 3 Tage ${f(p.avg3)} Flaschen/Tag statt ${f(p.avg7)} im 7-Tage-Schnitt.\nReichweite bei diesem Tempo: ${p.reichweiteTage} Tage. Spätester Bestelltag: ${p.bestellenBis.split('-').reverse().join('.')}.\nhttps://os.leichtkraut.de/os#stock`).catch(() => {})
      w.skaliert = heute; neu = true }
    if (neu) { d.warnungen = w; modulSchreiben('stock', d) }
  } catch (e) { console.warn('[os] Stock-Warnung:', e.message) }
}
setInterval(stockWarnen, 30 * 60_000); setTimeout(stockWarnen, 90_000)
// Abgleich alle 10 Minuten (06.10., Sam: Bestand 24/7 genau): alle Bestellungen beider Stores seit basis.abZeit aus Shopify holen
// und je Bestellung die Netto-Flaschen mit dem Gebuchten vergleichen. Verpasste Webhooks (z. B. waehrend eines Neustarts) werden so nachgebucht.
let stockAbgleichLaeuft = false, stockAbgleichStand = null
async function stockAbgleich() {
  if (stockAbgleichLaeuft) return; stockAbgleichLaeuft = true
  try {
    const d0 = stockLesen(); const basis = d0.basis; if (!basis || !basis.abZeit) return
    const fields = 'id,name,created_at,cancelled_at,line_items,refunds', alle = []
    for (const alt of [false, true]) {
      if (alt && !SHOP_ALT.store) continue
      let q = `orders.json?limit=250&status=any&created_at_min=${encodeURIComponent(basis.abZeit)}&fields=${fields}`
      for (let i = 0; i < 40; i++) { const { j, link } = alt ? await shopApiAlt(q) : await shopApi(q); for (const o of (j.orders || [])) alle.push(o); const next = (link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/) || [])[1]; if (!next) break; q = `orders.json?limit=250&page_info=${encodeURIComponent(next)}&fields=${fields}` }
    }
    const d = stockLesen(); if (!d.basis || d.basis.abZeit !== basis.abZeit) return   // Basis wurde inzwischen neu gesetzt
    d.bestellungen = d.bestellungen || {}; let summe = 0, n = 0
    for (const o of alle) {
      if (Date.parse(o.created_at) < Date.parse(basis.abZeit)) continue
      const erstattet = (o.refunds || []).reduce((a, r) => a + flaschenIn(r.refund_line_items, 'line_item'), 0)
      const netto = o.cancelled_at ? 0 : Math.max(0, flaschenIn(o.line_items) - erstattet)
      const altW = d.bestellungen[o.id] || 0, delta = netto - altW; if (!delta) continue
      d.bestellungen[o.id] = netto; if (d.bestand != null) d.bestand -= delta; summe += delta; n++
      d.abgaenge = [{ at: new Date().toISOString(), menge: delta, quelle: 'shopify-abgleich', ref: String(o.name || o.id), by: 'Abgleich' }].concat(d.abgaenge || []).slice(0, 3000)
    }
    stockAbgleichStand = { at: new Date().toISOString(), bestellungen: alle.length, korrigiert: n, flaschen: summe }
    if (n) { d.updatedAt = new Date().toISOString(); d.quelle = 'shopify live'; modulSchreiben('stock', d); console.log(`[os] Stock-Abgleich: ${n} Bestellungen nachgebucht (${summe} Flaschen)`) }
  } catch (e) { console.warn('[os] Stock-Abgleich:', e.message); stockAbgleichStand = { at: new Date().toISOString(), fehler: e.message } } finally { stockAbgleichLaeuft = false }
}
setTimeout(() => stockAbgleich().catch(() => {}), 60_000); setInterval(() => stockAbgleich().catch(() => {}), 10 * 60_000)
app.get('/api/os/stock/abgleich', async (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); if (req.query.jetzt) await stockAbgleich(); res.json(stockAbgleichStand || {}) })
// Empfaenger: Signatur pruefen, sofort antworten, dann verarbeiten
app.post('/api/os/shopify/webhook', (req, res) => {
  const hmac = String(req.get('X-Shopify-Hmac-Sha256') || '')
  if (!SHOP_SECRET || !req.rawBody) return res.status(401).end()
  const passt = (sec) => { if (!sec) return false; const e = crypto.createHmac('sha256', sec).update(req.rawBody).digest('base64'); return hmac.length === e.length && crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(e)) }
  if (!passt(SHOP_SECRET) && !passt(process.env.SHOPIFY_OS_SECRET_ALT || '')) { console.warn('[os] Shopify-Webhook mit falscher Signatur abgewiesen'); return res.status(401).end() }
  res.status(200).end()
  const topic = String(req.get('X-Shopify-Topic') || ''), b = req.body || {}
  const stueck = Array.isArray(b.line_items) ? b.line_items.reduce((a, x) => a + (Number(x.quantity) || 0), 0) : null
  const ev = { at: new Date().toISOString(), topic, id: b.id || null, name: b.name || (b.order_id ? '#' + b.order_id : null), total: b.total_price != null ? Number(b.total_price) : null, currency: b.currency || null, financial: b.financial_status || null, stueck, land: (b.shipping_address && b.shipping_address.country_code) || null, artikel: Array.isArray(b.line_items) ? b.line_items.map((x) => ({ sku: x.sku || null, titel: x.title || null, menge: Number(x.quantity) || 0 })) : null, inventory_item_id: b.inventory_item_id || null, available: b.available != null ? b.available : null }
  try { fs.appendFileSync(SHOP_EVENTS, JSON.stringify(ev) + '\n') } catch {}
  if (/^orders\/(create|updated|cancelled)$/.test(topic)) stockBestellung(b, topic)
  osPush('shopify', { topic, name: ev.name, total: ev.total, stueck, land: ev.land })
  if (topic.startsWith('orders/') || topic.startsWith('refunds/')) shopHeuteBald(topic)
})
// Heute live: alle Bestellungen des Tages (Berliner Zeit) direkt aus Shopify, bei jedem Webhook neu geladen
let shopHeute = { stand: null, tag: null, anzahl: 0, umsatz: 0, stueck: 0, storniert: 0, laender: {}, bestellungen: [], fehler: null }
let shopHeuteTimer = null, shopHeuteLaeuft = false
async function shopHeuteLaden(grund) {
  if (shopHeuteLaeuft) return; shopHeuteLaeuft = true
  try {
    const tag = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date())
    const off = (new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'longOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName') || {}).value || 'GMT+01:00'
    const since = `${tag}T00:00:00${off.replace('GMT', '') || '+01:00'}`
    const fields = 'id,name,created_at,cancelled_at,financial_status,currency,total_price,line_items,shipping_address,refunds'
    let q = `orders.json?limit=250&status=any&created_at_min=${encodeURIComponent(since)}&fields=${fields}`, alle = []
    for (let i = 0; i < 8; i++) { const { j, link } = await shopApi(q); alle = alle.concat(j.orders || []); const next = (link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/) || [])[1]; if (!next) break; q = `orders.json?limit=250&page_info=${encodeURIComponent(next)}&fields=${fields}` }
    const n = { stand: new Date().toISOString(), tag, anzahl: 0, umsatz: 0, brutto: 0, erstattet: 0, erstattetHeutigeBestellungen: 0, erstattetAeltereBestellungen: 0, erstattetOffen: 0, erstattungen: 0, stueck: 0, storniert: 0, laender: {}, bestellungen: [], fehler: null }
    for (const o of alle) {
      if (o.cancelled_at) { n.storniert++; continue }
      const st = (o.line_items || []).reduce((a, x) => a + (Number(x.quantity) || 0), 0)
      n.anzahl++; n.brutto += Number(o.total_price) || 0; n.stueck += st
      const land = (o.shipping_address && o.shipping_address.country_code) || '?'; n.laender[land] = (n.laender[land] || 0) + 1
    }
    // Erstattungen des Tages: alle heute geaenderten Bestellungen (auch aeltere), Erstattung zaehlt am Tag, an dem sie verarbeitet wurde
    const tagVon = (iso) => iso ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(iso)) : null
    const heutigeIds = new Set(alle.map((o) => o.id))
    let q2 = `orders.json?limit=250&status=any&updated_at_min=${encodeURIComponent(since)}&fields=id,name,created_at,refunds`, geaendert = []
    for (let i = 0; i < 8; i++) { const { j, link } = await shopApi(q2); geaendert = geaendert.concat(j.orders || []); const next = (link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/) || [])[1]; if (!next) break; q2 = `orders.json?limit=250&page_info=${encodeURIComponent(next)}&fields=id,name,created_at,refunds` }
    for (const o of geaendert) for (const r of o.refunds || []) {
      if (tagVon(r.processed_at || r.created_at) !== tag) continue
      const b = refundBetrag(r); n.erstattungen++; n.erstattetOffen += b.amountPending
      if (heutigeIds.has(o.id)) n.erstattetHeutigeBestellungen += b.amount; else n.erstattetAeltereBestellungen += b.amount
    }
    n.erstattet = r2(n.erstattetHeutigeBestellungen + n.erstattetAeltereBestellungen); n.erstattetHeutigeBestellungen = r2(n.erstattetHeutigeBestellungen); n.erstattetAeltereBestellungen = r2(n.erstattetAeltereBestellungen); n.erstattetOffen = r2(n.erstattetOffen)
    n.brutto = r2(n.brutto); n.umsatz = r2(n.brutto - n.erstattet)
    n.bestellungen = alle.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, 30).map((o) => ({ name: o.name, at: o.created_at, betrag: Number(o.total_price) || 0, currency: o.currency, land: (o.shipping_address && o.shipping_address.country_code) || null, stueck: (o.line_items || []).reduce((a, x) => a + (Number(x.quantity) || 0), 0), artikel: (o.line_items || []).map((x) => (Number(x.quantity) || 0) + '× ' + (x.title || '')).join(', '), bezahlt: o.financial_status, storniert: !!o.cancelled_at }))
    shopHeute = n; osPush('shopify-heute', { anzahl: n.anzahl, umsatz: n.umsatz, grund })
  } catch (e) { shopHeute.fehler = e.message; console.warn('[os] Shopify heute:', e.message) }
  finally { shopHeuteLaeuft = false }
}
function shopHeuteBald(grund) { clearTimeout(shopHeuteTimer); shopHeuteTimer = setTimeout(() => shopHeuteLaden(grund), 2500) }
if (SHOP_TOKEN || (SHOP_CLIENT_ID && SHOP_SECRET)) { setTimeout(() => shopHeuteLaden('Start'), 8000); setInterval(() => shopHeuteLaden('Intervall'), 5 * 60_000) }
// Tageswechsel (Berliner Zeit): sofort auf den neuen Tag umstellen, nicht erst beim naechsten Intervall
setInterval(() => { const tag = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date()); if (shopHeute.tag && shopHeute.tag !== tag && !shopHeuteLaeuft) { console.log('[os] Tageswechsel', shopHeute.tag, '->', tag); shopHeuteLaden('Tageswechsel'); osPush('tag', { tag }) } }, 10_000)
app.get('/api/os/shopify/heute', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); res.json(shopHeute) })
// Shopify Admin API über das OS: GraphQL-Durchleitung für die Chats (Chat 4 Shopify, spaeter andere).
// Der Chat braucht nur den Service-Token, keine eigenen Shopify-Zugangsdaten. Rechte = Scopes der Develop-App.
const PAGES_ID = process.env.SHOPIFY_PAGES_CLIENT_ID || '', PAGES_SECRET = process.env.SHOPIFY_PAGES_SECRET || ''
let PAGES_TOKEN = '', PAGES_BIS = 0, PAGES_SCOPE = ''
async function pagesToken() {
  if (!PAGES_ID || !PAGES_SECRET) return ''
  if (PAGES_TOKEN && Date.now() < PAGES_BIS) return PAGES_TOKEN
  const r = await fetch(`https://${SHOP_STORE}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: PAGES_ID, client_secret: PAGES_SECRET, grant_type: 'client_credentials' }) })
  const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) { console.warn(`[os] Pages-App Token ${r.status}, nutze Haupt-Token des Stores`); return '' }
  PAGES_TOKEN = j.access_token; PAGES_SCOPE = j.scope || ''; PAGES_BIS = Date.now() + (Number(j.expires_in) || 86000) * 1000 - 15 * 60_000
  console.log(`[os] Pages-App Token geholt, Scopes: ${PAGES_SCOPE}`); return PAGES_TOKEN
}
app.get('/api/os/shopify/pages-status', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  if (!PAGES_ID || !PAGES_SECRET) return res.json({ verbunden: false, grund: 'SHOPIFY_PAGES_CLIENT_ID und SHOPIFY_PAGES_SECRET fehlen in .env' })
  try { await pagesToken(); res.json({ verbunden: true, store: SHOP_STORE, scopes: PAGES_SCOPE.split(',').filter(Boolean), gueltigBis: new Date(PAGES_BIS).toISOString() }) } catch (e) { res.json({ verbunden: false, grund: e.message }) }
})
app.post('/api/os/shopify/graphql', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; if (!b.query || typeof b.query !== 'string') return res.status(400).json({ error: 'query (GraphQL-String) fehlt' })
  try {
    // Pages-App bevorzugt (Schreibrechte fuer Product Pages), sonst die Bestell-App (nur lesen)
    let tok = ''; try { tok = await pagesToken() } catch (e) { console.warn('[os]', e.message) }
    if (!tok) { await shopTokenSicher(); tok = SHOP_TOKEN }
    if (!tok) return res.status(503).json({ error: 'Kein Shopify-Zugang' })
    const r = await fetch(`https://${SHOP_STORE}/admin/api/${SHOP_API}/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: b.query, variables: b.variables || {} }) })
    const j = await r.json().catch(() => ({}))
    const mut = /^\s*mutation/i.test(b.query)
    console.log(`[os] Shopify GraphQL ${mut ? 'MUTATION' : 'query'} von ${req.user.name}: ${b.query.replace(/\s+/g, ' ').slice(0, 90)} → ${r.status}${j.errors ? ' Fehler' : ''}`)
    try { fs.appendFileSync(path.join(OS_MODUL_DIR, 'shopify-graphql.log'), JSON.stringify({ at: new Date().toISOString(), by: req.user.name, mutation: mut, query: b.query.slice(0, 2000), variables: b.variables || null, status: r.status, errors: j.errors || null }) + '\n') } catch {}
    res.status(r.status).json(j)
  } catch (e) { res.status(502).json({ error: e.message }) }
})
app.get('/api/os/shopify/status', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const ev = shopEvents(1)[0] || null; const anzahl = (() => { try { return fs.readFileSync(SHOP_EVENTS, 'utf8').split('\n').filter(Boolean).length } catch { return 0 } })()
  if (!SHOP_TOKEN && !(SHOP_CLIENT_ID && SHOP_SECRET)) return res.json({ verbunden: false, store: SHOP_STORE, grund: 'Kein Zugang: SHOPIFY_OS_CLIENT_ID und SHOPIFY_OS_SECRET fehlen in .env', secret: !!SHOP_SECRET, webhooks: [], ereignisse: anzahl, letztes: ev })
  try {
    const scopes = await shopScopes(); const tokenInfo = { art: SHOP_TOKEN_ART, gueltigBis: SHOP_TOKEN_BIS ? new Date(SHOP_TOKEN_BIS).toISOString() : null }; const { j } = await shopApi('webhooks.json?limit=250')
    const wh = (j.webhooks || []).filter((w) => w.address === SHOP_WEBHOOK_URL).map((w) => ({ topic: w.topic, seit: w.created_at }))
    res.json({ verbunden: true, store: SHOP_STORE, token: tokenInfo, scopes, bestellungenLesbar: scopes.includes('read_orders'), alleBestellungen: scopes.includes('read_all_orders'), secret: !!SHOP_SECRET, webhooks: wh, fehlend: SHOP_TOPICS.filter((t) => !wh.find((w) => w.topic === t)), ereignisse: anzahl, letztes: ev })
  } catch (e) { res.json({ verbunden: false, store: SHOP_STORE, grund: e.message, secret: !!SHOP_SECRET, webhooks: [], ereignisse: anzahl, letztes: ev }) }
})
app.post('/api/os/shopify/webhooks', async (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); try { res.json({ ok: true, webhooks: await shopWebhooksEinrichten() }) } catch (e) { res.status(500).json({ error: e.message }) } })
app.get('/api/os/shopify/events', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); res.json({ events: shopEvents(Math.min(500, parseInt(req.query.limit, 10) || 100)) }) })
// Bestellungen fuer Chat 6 (Profit) und andere: ?since=ISO&status=any&limit=250, weiter mit ?page_info=
// Erstattungsbetrag (Regel mit Chat 6 abgestimmt, 05.09.): nur abgeschlossene Transaktionen zaehlen (success),
// offene (pending) separat. Ohne Transaktionen (Storno vor Zahlung): Positionen plus Anpassungen.
const r2 = (n) => Math.round(n * 100) / 100
function refundBetrag(r) {
  const txs = (r.transactions || []).filter((t) => t.kind === 'refund').map((t) => ({ id: t.id, status: t.status, amount: Number(t.amount) || 0, gateway: t.gateway || null, at: t.processed_at || t.created_at || null }))
  const tx = txs.reduce((a, t) => a + (t.status === 'success' ? t.amount : 0), 0)
  const pend = txs.reduce((a, t) => a + (t.status === 'pending' ? t.amount : 0), 0)
  const pos = (r.refund_line_items || []).reduce((a, x) => a + (Number(x.subtotal) || 0) + (Number(x.total_tax) || 0), 0)
  const anpNetto = (r.order_adjustments || []).reduce((a, x) => a + Math.abs(Number(x.amount) || 0), 0)
  const anpSteuer = (r.order_adjustments || []).reduce((a, x) => a + Math.abs(Number(x.tax_amount) || 0), 0)
  const amount = txs.length ? tx : pos + anpNetto + anpSteuer
  return { amount: r2(amount), amountPending: r2(pend), transaktionen: txs, positionen: r2(pos), anpassungen: r2(anpNetto), anpassungenSteuer: r2(anpSteuer), anpassungenAnzahl: (r.order_adjustments || []).length }
}
// Alter Store (dein-shop, #S-Bestellungen) bleibt lesbar fuer Rueckrechnungen, z. B. Profit-Tracker (01.10.)
const SHOP_ALT = { store: process.env.SHOPIFY_OS_STORE_ALT || '', cid: process.env.SHOPIFY_OS_CLIENT_ID_ALT || '', sec: process.env.SHOPIFY_OS_SECRET_ALT || '', token: '', bis: 0 }
async function shopApiAlt(pfad) {
  if (!SHOP_ALT.store || !SHOP_ALT.cid || !SHOP_ALT.sec) throw new Error('Alter Store nicht konfiguriert (SHOPIFY_OS_*_ALT)')
  if (!SHOP_ALT.token || Date.now() > SHOP_ALT.bis) {
    const r = await fetch(`https://${SHOP_ALT.store}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: SHOP_ALT.cid, client_secret: SHOP_ALT.sec, grant_type: 'client_credentials' }) })
    const j = await r.json().catch(() => ({})); if (!r.ok || !j.access_token) throw new Error('Alter Store Token ' + r.status)
    SHOP_ALT.token = j.access_token; SHOP_ALT.bis = Date.now() + (Number(j.expires_in) || 86000) * 1000 - 15 * 60_000
  }
  const r = await fetch(`https://${SHOP_ALT.store}/admin/api/${SHOP_API}/${pfad}`, { headers: { 'X-Shopify-Access-Token': SHOP_ALT.token } })
  const text = await r.text(); let j = {}; try { j = JSON.parse(text) } catch {}
  if (!r.ok) throw new Error(`Shopify alt ${r.status}: ${text.slice(0, 200)}`)
  return { j, link: r.headers.get('link') || '' }
}
app.get('/api/os/shopify/orders', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  try {
    const limit = Math.min(250, parseInt(req.query.limit, 10) || 250)
    const fields = 'id,name,created_at,processed_at,cancelled_at,financial_status,fulfillment_status,currency,total_price,subtotal_price,total_discounts,total_tax,total_shipping_price_set,line_items,shipping_address,refunds,gateway,payment_gateway_names,source_name'
    let q = req.query.page_info ? `orders.json?limit=${limit}&page_info=${encodeURIComponent(req.query.page_info)}&fields=${fields}` : `orders.json?limit=${limit}&status=${encodeURIComponent(req.query.status || 'any')}&fields=${fields}` + (req.query.since ? `&created_at_min=${encodeURIComponent(req.query.since)}` : '') + (req.query.until ? `&created_at_max=${encodeURIComponent(req.query.until)}` : '')
    const alt = /^(alt|old)$/i.test(String(req.query.store || '')) || (SHOP_ALT.store && String(req.query.store || '').startsWith(SHOP_ALT.store.split('.')[0]))
    const { j, link } = alt ? await shopApiAlt(q) : await shopApi(q)
    const next = (link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/) || [])[1] || null
    const orders = (j.orders || []).map((o) => ({ id: o.id, name: o.name, created_at: o.created_at, processed_at: o.processed_at, cancelled_at: o.cancelled_at, financial_status: o.financial_status, fulfillment_status: o.fulfillment_status, currency: o.currency, total_price: Number(o.total_price), subtotal_price: Number(o.subtotal_price), total_discounts: Number(o.total_discounts), total_tax: Number(o.total_tax), shipping: o.total_shipping_price_set ? Number(o.total_shipping_price_set.shop_money && o.total_shipping_price_set.shop_money.amount) : null, gateway: (o.payment_gateway_names || [])[0] || o.gateway || null, source: o.source_name || null, country: (o.shipping_address && o.shipping_address.country_code) || null, line_items: (o.line_items || []).map((x) => ({ sku: x.sku, title: x.title, variant_title: x.variant_title, quantity: Number(x.quantity), price: Number(x.price), product_id: x.product_id, variant_id: x.variant_id })), refunds: (o.refunds || []).map((r) => Object.assign({ id: r.id, created_at: r.created_at, processed_at: r.processed_at, items: (r.refund_line_items || []).reduce((a, x) => a + (Number(x.quantity) || 0), 0), restock: (r.refund_line_items || []).map((x) => x.restock_type).filter(Boolean)[0] || null }, refundBetrag(r))) }))
    // Echte Zahlungsgebuehren je Bestellung (05.10., Chat 6 fuer Sam): Shopify Payments aus transactions.fees, PayPal aus dem Beleg. Mit ?fees=0 abschaltbar.
    let feesFehler = null
    if (req.query.fees !== '0' && orders.length) { try { await gebuehrenErgaenzen(orders, alt) } catch (e) { feesFehler = e.message; console.warn('[os] Gebuehren:', e.message) } }
    res.json({ store: alt ? SHOP_ALT.store : SHOP_STORE, orders, next_page_info: next, anzahl: orders.length, fees_fehler: feesFehler })
  } catch (e) { res.status(502).json({ error: e.message }) }
})
const GEB_GQL = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { id transactions { kind status gateway amountSet { shopMoney { amount } presentmentMoney { amount currencyCode } } fees { amount { amount currencyCode } } paymentDetails { __typename ... on CardPaymentDetails { company wallet } ... on LocalPaymentMethodsPaymentDetails { paymentMethodName } } receiptJson } } } }`
async function gebuehrenGql(alt, variables) {
  if (alt) { await shopApiAlt('shop.json?fields=id'); const r = await fetch(`https://${SHOP_ALT.store}/admin/api/${SHOP_API}/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': SHOP_ALT.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: GEB_GQL, variables }) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('GraphQL alt ' + r.status); return j }
  const { j } = await shopApi('graphql.json', { method: 'POST', body: JSON.stringify({ query: GEB_GQL, variables }) }); return j
}
function paypalGebuehr(receipt, art) {
  let j; try { j = JSON.parse(receipt || '') } catch { return null }
  let summe = null; const feld = art === 'refund' ? 'seller_payable_breakdown' : 'seller_receivable_breakdown'
  const nimm = (b) => { const f = b && b[feld] && b[feld].paypal_fee; if (f && f.currency_code === 'EUR') summe = (summe || 0) + Number(f.value || 0) }
  for (const u of (j.purchase_units || [])) for (const c of ((u.payments || {}).captures || [])) nimm(c)
  nimm(j)   // Rueckerstattungs-Belege tragen die Aufschluesselung direkt
  return summe
}
async function gebuehrenErgaenzen(orders, alt) {
  for (let i = 0; i < orders.length; i += 50) {
    const teil = orders.slice(i, i + 50); const j = await gebuehrenGql(alt, { ids: teil.map((o) => 'gid://shopify/Order/' + o.id) })
    if (j.errors && !j.data) throw new Error('GraphQL: ' + JSON.stringify(j.errors).slice(0, 200))
    const map = {}; for (const n of ((j.data || {}).nodes || [])) if (n && n.id) map[n.id.split('/').pop()] = n
    for (const o of teil) {
      const n = map[String(o.id)]; o.fees_eur = null; o.zahlart = null; o.fees_quelle = null; if (!n) continue
      let summe = 0, gefunden = false, fremd = false
      for (const t of (n.transactions || [])) {
        if (t.status !== 'SUCCESS') continue; const k = t.kind; const plus = k === 'SALE' || k === 'CAPTURE', minus = k === 'REFUND'; if (!plus && !minus) continue
        const pd = t.paymentDetails || {}
        if (plus && !o.zahlart) o.zahlart = pd.__typename === 'CardPaymentDetails' ? String(pd.wallet || pd.company || 'karte').toLowerCase().replace(/\s+/g, '_') : pd.__typename === 'LocalPaymentMethodsPaymentDetails' ? String(pd.paymentMethodName || '').toLowerCase() : /paypal/i.test(t.gateway || '') || pd.__typename === 'PaypalWalletPaymentDetails' ? 'paypal' : (t.gateway || null)
        if ((t.fees || []).length) { const am = t.amountSet || {}, pm = am.presentmentMoney || {}, kurs = Number(pm.amount) ? Number((am.shopMoney || {}).amount) / Number(pm.amount) : null   // CHF-Gebuehren mit dem Kurs der Transaktion in EUR umrechnen
          for (const f of t.fees) { const a = f.amount || {}; let v = Number(a.amount || 0); if (a.currencyCode && a.currencyCode !== 'EUR') { if (a.currencyCode === pm.currencyCode && kurs) v *= kurs; else fremd = true } summe += (minus ? -1 : 1) * v } gefunden = true; o.fees_quelle = 'shopify' }
        else if (/paypal/i.test(t.gateway || '')) { const pp = paypalGebuehr(t.receiptJson, minus ? 'refund' : 'sale'); if (pp != null) { summe += (minus ? -1 : 1) * pp; gefunden = true; o.fees_quelle = 'paypal' } }
      }
      if (gefunden && !fremd) o.fees_eur = Math.round(summe * 100) / 100
    }
  }
}

// ── Meldungen der Chats ans OS: ein Aufruf, ein Satz. Erscheint unter „Änderungen“ und im Echtzeit-Kanal. ──
const OS_MELD = path.join(OS_MODUL_DIR, 'meldungen.json')
function meldungenLesen() { try { return JSON.parse(fs.readFileSync(OS_MELD, 'utf8')) } catch { return [] } }
app.get('/api/os/meldungen', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); res.json({ meldungen: meldungenLesen().slice(0, Math.min(500, parseInt(req.query.limit, 10) || 100)) }) })
app.post('/api/os/meldung', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const text = String(b.text || '').trim().slice(0, 600); if (!text) return res.status(400).json({ error: 'text fehlt' })
  const chat = parseInt(b.chat, 10) || null; const m = { at: new Date().toISOString(), chat, name: String(b.name || '').slice(0, 60), text, typ: String(b.typ || 'info').slice(0, 20), ad: b.ad ? String(b.ad).slice(0, 80) : null }
  const alle = [m].concat(meldungenLesen()).slice(0, 2000); const t = OS_MELD + '.tmp'; fs.writeFileSync(t, JSON.stringify(alle, null, 2)); fs.renameSync(t, OS_MELD)
  console.log(`[os] Meldung Chat ${chat || '?'}: ${text.slice(0, 80)}`); if (m.typ === 'fehler') { try { tgSenden(`Fehler von Chat ${chat || '?'}${m.ad ? ' bei ' + m.ad : ''}: ${text}`) } catch {} }
  res.json({ ok: true, meldung: m })
})


// ═════════════════════════════════════════════════════════════════════════════
// LERNSCHLEIFE (Samuel, 05.09.2026)
// Bis heute wurden Lektionen von Hand gepflegt. Dabei liegen in outcomes.jsonl
// tausende Paare aus "was Barbara entworfen hat" und "was die Mitarbeiterin wirklich
// gesendet hat". Einmal taeglich liest ein Haiku-Aufruf die letzten Korrekturen
// und schlaegt daraus Regeln vor.
// BEWUSST NICHT AUTOMATISCH AKTIV: Lektionen gelten im Prompt als VERBINDLICH
// ueber allem anderen und landen damit direkt in Kundenmails. Eine ungeprueft
// uebernommene Fehl-Regel wuerde jede Antwort vergiften. Samuel gibt frei.
// ═════════════════════════════════════════════════════════════════════════════
const VORSCHLAEGE_FILE = path.join(DATA_DIR, 'lesson-vorschlaege.json')
function readVorschlaege() { try { return JSON.parse(fs.readFileSync(VORSCHLAEGE_FILE, 'utf8')) } catch { return [] } }
function writeVorschlaege(v) { const t = VORSCHLAEGE_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, VORSCHLAEGE_FILE) }

function lernPaare(tage = 7, max = 40) {
  const seit = Date.now() - tage * 86400_000
  const raus = []
  let roh = ''
  try { roh = fs.readFileSync(path.join(DATA_DIR, 'outcomes.jsonl'), 'utf8') } catch { return raus }
  for (const zeile of roh.split('\n')) {
    if (!zeile.trim()) continue
    let d; try { d = JSON.parse(zeile) } catch { continue }
    if (d.event !== 'sent' || !d.edited || !d.draft || !d.sent) continue
    if ((Date.parse(d.ts) || 0) < seit) continue
    const a = String(d.draft), b = String(d.sent)
    if (a.length < 80 || b.length < 80) continue
    // Nur echte inhaltliche Aenderungen: reine Anrede- oder Zeichen-Korrekturen
    // erzeugen sonst massenhaft belanglose "Regeln".
    const norm = (x) => x.replace(/\s+/g, ' ').trim().toLowerCase()
    if (norm(a) === norm(b)) continue
    const diff = Math.abs(a.length - b.length) / Math.max(a.length, b.length)
    if (diff < 0.05 && norm(a).slice(60) === norm(b).slice(60)) continue
    raus.push({ ticket: d.ticket, by: d.by || null, sprache: d.vergleich || 'de', confidence: d.confidence ?? null, entwurf: a.slice(0, 1400), gesendet: b.slice(0, 1400) })
  }
  return raus.slice(-max)
}

let lernLaeuft = false
async function lernschleifeLauf(ausloeser = 'auto') {
  if (lernLaeuft) return { ok: false, grund: 'laeuft bereits' }
  const apiKey = secrets.ai
  if (!apiKey) return { ok: false, grund: 'kein API-Key' }
  const paare = lernPaare()
  if (paare.length < 5) return { ok: false, grund: `zu wenige Korrekturen (${paare.length})` }
  lernLaeuft = true
  try {
    const bestehend = readLessons().map((l) => '- ' + l.text).join('\n').slice(0, 5000)
    const sys = `Du wertest Korrekturen im Kundenservice von LEICHTKRAUT aus (Lymph-Tropfen, Nahrungsergaenzung, DACH).
Du bekommst Paare: ENTWURF (von der KI Barbara geschrieben) und GESENDET (was die Mitarbeiterin daraus gemacht hat).
Deine Aufgabe: Finde WIEDERKEHRENDE Muster, in denen der Entwurf systematisch falsch lag, und formuliere daraus knappe Regeln fuer Barbara.

HARTE VORGABEN:
- Nur Muster, die in MINDESTENS DREI Paaren vorkommen. Einzelfaelle sind keine Regel.
- Keine Regeln zu Anrede, Gruss, Rechtschreibung, Zeichensetzung oder Formatierung. Das ist Kosmetik.
- Keine Regel, die eine bestehende Lektion wiederholt.
- Jede Regel ist eine Anweisung an Barbara, konkret und ueberpruefbar, hoechstens zwei Saetze.
- Wenn du kein belastbares Muster findest, gib eine leere Liste zurueck. Das ist ein gutes Ergebnis, kein Versagen.

BESTEHENDE LEKTIONEN (nicht wiederholen):
${bestehend || '(keine)'}

Antworte NUR mit JSON: {"vorschlaege":[{"text":"...","begruendung":"...","belege":["Ticket 123","Ticket 456"],"tags":["..."]}]}`
    const user = paare.map((p, i) => `### Paar ${i + 1} (Ticket ${p.ticket}, ${p.by || '?'})\nENTWURF:\n${p.entwurf}\n\nGESENDET:\n${p.gesendet}`).join('\n\n')
    const r = await aiFetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: connections.ai.utilityModel || 'claude-haiku-4-5-20251001', max_tokens: 2000, system: sys, messages: [{ role: 'user', content: user.slice(0, 90000) }] }),
    })
    if (!r.ok) { const t = await r.text(); console.log('[lernen] Fehler', r.status, t.slice(0, 160)); return { ok: false, grund: `AI ${r.status}` } }
    const data = await r.json()
    const txt = (data.content || []).map((c) => c.text || '').join('')
    let neu = []
    try { neu = JSON.parse(txt.match(/\{[\s\S]*\}/)?.[0] || '{}').vorschlaege || [] } catch {}
    const alt = readVorschlaege()
    const kennen = new Set(alt.map((v) => String(v.text || '').slice(0, 60).toLowerCase()))
    const frisch = neu
      .filter((v) => v && typeof v.text === 'string' && v.text.trim().length > 20)
      .filter((v) => !kennen.has(v.text.slice(0, 60).toLowerCase()))
      .map((v) => ({ id: Date.now() + Math.floor(Math.random() * 1000), text: String(v.text).slice(0, 800), begruendung: String(v.begruendung || '').slice(0, 500), belege: (v.belege || []).slice(0, 8).map(String), tags: (v.tags || []).slice(0, 6).map(String), status: 'offen', erzeugt: new Date().toISOString(), basis: paare.length }))
    if (frisch.length) writeVorschlaege(frisch.concat(alt).slice(0, 200))
    console.log(`[lernen] ${paare.length} Korrekturen ausgewertet (${ausloeser}) → ${frisch.length} neue Vorschlaege`)
    return { ok: true, ausgewertet: paare.length, neu: frisch.length, vorschlaege: frisch }
  } catch (e) {
    console.log('[lernen] Fehler:', String(e && e.message || e).slice(0, 160)); return { ok: false, grund: String(e && e.message || e).slice(0, 160) }
  } finally { lernLaeuft = false }
}
// Taeglich gegen 04:10 Berlin, plus einmal 3 Minuten nach dem Start, falls lange nichts lief.
setInterval(() => {
  const jetzt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
  if (jetzt.getHours() === 4 && jetzt.getMinutes() < 10) {
    const v = readVorschlaege()
    const letzte = v[0] && Date.parse(v[0].erzeugt) || 0
    if (Date.now() - letzte > 20 * 3600_000) lernschleifeLauf('taeglich').catch(() => {})
  }
}, 9 * 60_000)

app.get('/api/lessons/vorschlaege', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  res.json({ vorschlaege: readVorschlaege(), laeuft: lernLaeuft })
})
app.post('/api/lessons/lernen', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  res.json(await lernschleifeLauf('manuell:' + (req.user.name || '?')))
})
app.post('/api/lessons/vorschlaege/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const v = readVorschlaege(); const i = v.findIndex((x) => String(x.id) === String(req.params.id))
  if (i < 0) return res.status(404).json({ error: 'Unbekannt' })
  const aktion = String((req.body || {}).aktion || '')
  if (aktion === 'uebernehmen') {
    const text = String((req.body || {}).text || v[i].text).trim()
    if (text.length < 20) return res.status(400).json({ error: 'Text zu kurz' })
    const l = readLessons()
    l.push({ id: Date.now(), text, tags: v[i].tags || [], created_at: new Date().toISOString(), quelle: 'lernschleife', belege: v[i].belege || [] })
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(l, null, 2))
    v[i].status = 'uebernommen'; v[i].entschieden = new Date().toISOString()
    console.log(`[lernen] Vorschlag uebernommen von ${req.user.name}: ${text.slice(0, 80)}`)
  } else if (aktion === 'verwerfen') {
    v[i].status = 'verworfen'; v[i].entschieden = new Date().toISOString()
  } else return res.status(400).json({ error: 'aktion: uebernehmen oder verwerfen' })
  writeVorschlaege(v)
  res.json({ ok: true, vorschlag: v[i], lektionen: readLessons().length })
})
app.get('/lernen', (req, res) => {
  const u = sessionUser(req); if (!u) return res.redirect('/login')
  if (u.role !== 'admin') return res.redirect('/')
  res.setHeader('Cache-Control', 'no-store')
  res.type('html').send(fs.readFileSync(path.join(__dirname, 'pages', 'lernen.html'), 'utf8'))
})

// ── TELEGRAM-BOT (OS Manager, 14.09.2026): Sam schreibt vom Handy mit dem OS, das OS meldet Ereignisse ──
// Token in .env TELEGRAM_BOT_TOKEN. Nur der gekoppelte Chat darf sprechen (Kopplung per Code, der im OS steht).
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '', TG_POLL = process.env.TELEGRAM_POLL !== '0', TG_CHAT = process.env.TELEGRAM_CHAT_ID || ''
const TG_FILE = path.join(OS_MODUL_DIR, 'telegram.json')
function tgLesen() { let d = {}; try { d = JSON.parse(fs.readFileSync(TG_FILE, 'utf8')) } catch {} if (TG_CHAT && !d.chatId) d.chatId = Number(TG_CHAT) || TG_CHAT; return d }
function tgSchreiben(d) { fs.writeFileSync(TG_FILE, JSON.stringify(d, null, 2)) }
async function tgApi(methode, body) { const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${methode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); return r.json().catch(() => ({})) }
// Slack: alles, was das OS per Telegram meldet, geht auch in einen Slack-Kanal (01.10.).
// Zugang per Incoming Webhook (SLACK_WEBHOOK_URL) oder Bot-Token (SLACK_BOT_TOKEN + SLACK_CHANNEL). Sam traegt die Werte selbst ein.
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || '', SLACK_BOT = process.env.SLACK_BOT_TOKEN || '', SLACK_KANAL = process.env.SLACK_CHANNEL || ''
let slackLetzterFehler = null, slackGesendet = 0
async function slackSenden(text) {
  if (!SLACK_WEBHOOK && !(SLACK_BOT && SLACK_KANAL)) return false
  try {
    const body = JSON.stringify(SLACK_WEBHOOK ? { text } : { channel: SLACK_KANAL, text, unfurl_links: false })
    const r = await fetch(SLACK_WEBHOOK || 'https://slack.com/api/chat.postMessage', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, SLACK_WEBHOOK ? {} : { Authorization: 'Bearer ' + SLACK_BOT }), body })
    const t = await r.text(); let ok = r.ok
    if (!SLACK_WEBHOOK) { try { ok = ok && JSON.parse(t).ok } catch { ok = false } }
    if (!ok) { slackLetzterFehler = { at: new Date().toISOString(), status: r.status, text: t.slice(0, 200) }; console.warn('[slack] senden:', r.status, t.slice(0, 120)); return false }
    slackGesendet++; return true
  } catch (e) { slackLetzterFehler = { at: new Date().toISOString(), text: e.message }; console.warn('[slack] senden:', e.message); return false }
}
app.get('/api/os/slack/status', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); res.json({ verbunden: !!(SLACK_WEBHOOK || (SLACK_BOT && SLACK_KANAL)), art: SLACK_WEBHOOK ? 'webhook' : (SLACK_BOT ? 'bot' : null), kanal: SLACK_KANAL || null, gesendet: slackGesendet, letzterFehler: slackLetzterFehler }) })
app.post('/api/os/slack/test', async (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const ok = await slackSenden(String((req.body || {}).text || 'Leichtkraut OS ist mit Slack verbunden. Ab jetzt kommen hier neue Ads, Launches, Fehler, der Stundenstand und um 06:30 die Bilanz.')); res.json({ ok, letzterFehler: ok ? null : slackLetzterFehler }) })

async function tgSenden(text, chatId) {
  if (!chatId) slackSenden(text).catch(() => {})   // Spiegel nach Slack, nur fuer Meldungen an Sam, nicht fuer Antworten an andere Chats
  const id = chatId || tgLesen().chatId; if (!TG_TOKEN || !id) return false
  for (let i = 0; i < text.length; i += 3800) { try { await tgApi('sendMessage', { chat_id: id, text: text.slice(i, i + 3800), disable_web_page_preview: true }) } catch (e) { console.warn('[tg] senden:', e.message) } }
  return true
}
function osKurzlage() {
  const reg = osAdsRegister(); const Z = {}; for (const a of reg.ads) Z[a.zustand] = (Z[a.zustand] || 0) + 1
  const offen = reg.ads.filter((a) => a.zustand !== 'archiviert' && a.zustand !== 'gelauncht' && a.zustand !== 'pausiert')
  const pr = modulLesen('profit') || {}; const h = pr.heute || {}; const st = stockLesen(); const meld = meldungenLesen().slice(0, 8)
  const seiten = pageStats(); const wenig = seiten.filter((p) => p.aktiv !== false).sort((a, b) => a.aktiveAds - b.aktiveAds).slice(0, 3)
  return { zustaende: Z, offen: offen.map((a) => ({ id: a.id, zustand: a.zustand, fehlend: a.fehlend })), heute: { bestellungen: shopHeute.anzahl, umsatz: shopHeute.umsatz, werbung: h.werbung, waren: h.waren, profit: h.profit, marge: h.marge, roas: h.roas, standProfit: pr.updatedAt }, stock: { bestand: st.bestand, abgaengeHeute: (st.abgaenge || []).filter((x) => Date.now() - Date.parse(x.at) < 86400000).reduce((n, x) => n + (Number(x.menge) || 0), 0) }, seitenWenig: wenig.map((p) => `${p.name} ${p.aktiveAds}`), meldungen: meld.map((m) => `${String(m.at).slice(5, 16)} Chat ${m.chat}: ${m.text.slice(0, 120)}`), jetzt: new Date().toISOString() }
}
function tgStatusText() {
  const k = osKurzlage(); const e = (n) => n == null ? '–' : Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
  const z = k.zustaende
  return `LEICHTKRAUT OS · ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })}\n\nADS\ngelauncht ${z.gelauncht || 0} · pausiert ${z.pausiert || 0} · freigegeben ${z.freigegeben || 0} · blockiert ${(z.analyse_offen || 0) + (z.entwurf || 0)}\n${k.offen.length ? 'Offen: ' + k.offen.map((a) => a.id + ' (' + a.zustand + (a.fehlend && a.fehlend.length ? ', fehlt ' + a.fehlend.slice(0, 3).join(', ') : '') + ')').join('; ') : 'Alles gelauncht, nichts offen.'}\n\nHEUTE\nBestellungen ${k.heute.bestellungen} · Umsatz ${e(k.heute.umsatz)}\nWerbung ${e(k.heute.werbung)} · Waren ${e(k.heute.waren)}\nProfit ${e(k.heute.profit)} · Marge ${k.heute.marge != null ? k.heute.marge + ' %' : '–'} · ROAS ${k.heute.roas != null ? k.heute.roas : '–'}\n\nSTOCK ${k.stock.bestand == null ? 'kein Startbestand' : k.stock.bestand + ' Flaschen'} · heute −${k.stock.abgaengeHeute}\nSEITEN am wenigsten: ${k.seitenWenig.join(', ') || '–'}`
}
// Tagesabschluss um 00:00: abgeschlossener Tag gegen den Vortag (Wunsch Sam 15.09.). Staende liegen in profit-tage.json.
const TG_TAGE = path.join(OS_MODUL_DIR, 'profit-tage.json')
function tgTageLesen() { try { return JSON.parse(fs.readFileSync(TG_TAGE, 'utf8')) } catch { return {} } }
function tgTagSichern() {
  try { const k = osKurzlage(); const h = k.heute || {}; if (h.umsatz == null) return
    const tag = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' }); const t = tgTageLesen(); t[tag] = Object.assign({}, h, { stand: new Date().toISOString() })
    fs.writeFileSync(TG_TAGE + '.tmp', JSON.stringify(t, null, 2)); fs.renameSync(TG_TAGE + '.tmp', TG_TAGE) } catch (e) { console.warn('[tg] tag sichern:', e.message) }
}
function tgTagesabschlussText() {
  const t = tgTageLesen(); const tage = Object.keys(t).sort(); const heuteKey = tage[tage.length - 1], vorKey = tage[tage.length - 2]
  const a = heuteKey ? t[heuteKey] : null, v = vorKey ? t[vorKey] : null
  if (!a) return tgStundenText()
  const e = (n) => n == null ? '–' : Number(n).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €'
  const d = (x, y, geld) => (x == null || y == null) ? '' : (() => { const diff = x - y; const pz = y ? Math.round(diff / Math.abs(y) * 100) : null; return ' (' + (diff >= 0 ? '+' : '') + (geld ? e(diff) : Math.round(diff)) + (pz != null ? ', ' + (pz >= 0 ? '+' : '') + pz + ' %' : '') + ')' })()
  const dat = (k) => new Date(k + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  return `🌙 Tagesabschluss ${dat(heuteKey)}${v ? ' · Vergleich zu ' + dat(vorKey) : ' · noch kein Vortag'}\n\n💸 Spend ${e(a.werbung)}${d(a.werbung, v && v.werbung, true)}\n💰 Umsatz ${e(a.umsatz)}${d(a.umsatz, v && v.umsatz, true)}\n📦 Bestellungen ${a.bestellungen != null ? a.bestellungen : '–'}${d(a.bestellungen, v && v.bestellungen, false)}\n🧾 Waren ${e(a.waren)}${d(a.waren, v && v.waren, true)}\n✅ Profit ${e(a.profit)}${d(a.profit, v && v.profit, true)}\n📈 ROAS ${a.roas != null ? a.roas : '–'}${v && v.roas != null && a.roas != null ? ' (Vortag ' + v.roas + ')' : ''} · Marge ${a.marge != null ? a.marge + ' %' : '–'}${v && v.marge != null ? ' (Vortag ' + v.marge + ' %)' : ''}`
}
function tgStundenText() {
  const k = osKurzlage(); const h = k.heute || {}
  const e = (n) => n == null ? '–' : Number(n).toLocaleString('de-DE', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + ' €'
  const uhr = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })
  const z = k.zustaende || {}
  return `⏰ ${uhr} · Stand heute\n\n💸 Spend ${e(h.werbung)}\n💰 Umsatz ${e(h.umsatz)}\n📦 Bestellungen ${h.bestellungen != null ? h.bestellungen : '–'}\n🧾 Waren ${e(h.waren)}\n✅ Profit ${e(h.profit)}\n📈 ROAS ${h.roas != null ? h.roas : '–'} · Marge ${h.marge != null ? h.marge + ' %' : '–'}\n\n🎬 Ads: ${z.gelauncht || 0} gelauncht · ${z.pausiert || 0} pausiert · ${z.freigegeben || 0} startklar`
}
// Offer-Testing (05.10., Sam): jede Woche ein Offer (Mo bis So), danach Auswertung aus Shopify und Profit Tracker, Gewinner bleibt.
const OFFER_FILE = path.join(OS_MODUL_DIR, 'offer.json')
function offerLesen() { try { const d = JSON.parse(fs.readFileSync(OFFER_FILE, 'utf8')); d.tests = d.tests || []; return d } catch { return { tests: [], basis: null } } }
function offerSchreiben(d) { if (fs.existsSync(OFFER_FILE)) fs.copyFileSync(OFFER_FILE, OFFER_FILE + '.bak-' + Date.now()); fs.writeFileSync(OFFER_FILE, JSON.stringify(d, null, 2)); osPush('modul', { datei: 'offer.json' }) }
const tagPlus = (t, n) => { const d = new Date(t + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const montagVon = (t) => { const w = new Date(t + 'T12:00:00Z').getUTCDay(); return tagPlus(t, -((w + 6) % 7)) }
function isoKw(t) { const d = new Date(t + 'T12:00:00Z'); const w = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - w + 3); const j = d.getUTCFullYear(); const f = new Date(Date.UTC(j, 0, 4)); return { kw: 1 + Math.round(((d - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7), jahr: j } }
function berlinAb(t) { const off = (new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', timeZoneName: 'shortOffset' }).formatToParts(new Date(t + 'T12:00:00Z')).find((x) => x.type === 'timeZoneName') || {}).value || 'GMT+1'; const m = off.match(/GMT([+-])(\d+)/); return t + 'T00:00:00' + (m ? m[1] + String(m[2]).padStart(2, '0') + ':00' : '+01:00') }
function offerStatus(x, heute) { if (x.status === 'verworfen' || x.status === 'ausgewertet') return x.status; if (heute < x.start) return 'geplant'; if (heute <= x.ende) return 'laeuft'; return 'auswerten' }
async function offerAuswerten(start, ende) {
  const heute = berlinTag(); const bis = ende < heute ? ende : heute
  const fields = 'id,created_at,cancelled_at,total_price,line_items'
  let q = `orders.json?limit=250&status=any&created_at_min=${encodeURIComponent(berlinAb(start))}&created_at_max=${encodeURIComponent(berlinAb(tagPlus(bis, 1)))}&fields=${fields}`, alle = []
  for (let i = 0; i < 30; i++) { const { j, link } = await shopApi(q); alle = alle.concat(j.orders || []); const next = (link.match(/<[^>]*[?&]page_info=([^&>]+)[^>]*>;\s*rel="next"/) || [])[1]; if (!next) break; q = `orders.json?limit=250&page_info=${encodeURIComponent(next)}&fields=${fields}` }
  const o = alle.filter((x) => !x.cancelled_at)
  const fl = (x) => (x.line_items || []).reduce((n, l) => n + (Number(l.quantity) || 0), 0)
  const umsatz = o.reduce((n, x) => n + Number(x.total_price || 0), 0), flaschen = o.reduce((n, x) => n + fl(x), 0)
  // Mix nach Flaschen je Bestellung (Rabattcodes und Maerkte verschieben die Preise, die Flaschenzahl zeigt die gewaehlte Stufe)
  const mixM = {}; for (const x of o) { const f = fl(x); const m = (mixM[f] = mixM[f] || { flaschen: f, summe: 0, anzahl: 0 }); m.anzahl++; m.summe += Number(x.total_price || 0) }
  for (const m of Object.values(mixM)) { m.preis = Math.round(m.summe / m.anzahl * 100) / 100; delete m.summe }
  let mix = Object.values(mixM).sort((a, b) => b.anzahl - a.anzahl); const rest = mix.slice(8); mix = mix.slice(0, 8)
  if (rest.length) mix.push({ flaschen: null, preis: null, anzahl: rest.reduce((n, x) => n + x.anzahl, 0), sonstige: true })
  const eu = (v) => v.toFixed(2).replace('.', ',') + ' €'
  mix.forEach((m) => { m.anteil = o.length ? Math.round(m.anzahl / o.length * 1000) / 10 : 0; m.schluessel = m.sonstige ? 'Sonstige' : m.flaschen + (m.flaschen === 1 ? ' Flasche' : ' Flaschen') + ' · Ø ' + eu(m.preis) })
  // Werbung und Profit aus dem Profit Tracker: abgeschlossene Tage aus profit-tage.json, heute aus profit.json
  let pt = {}; try { pt = JSON.parse(fs.readFileSync(TG_TAGE, 'utf8')) } catch {}
  let ph = null; try { ph = JSON.parse(fs.readFileSync(path.join(OS_MODUL_DIR, 'profit.json'), 'utf8')).heute } catch {}
  let werbung = 0, profit = 0, ptUmsatz = 0, tage = 0
  for (let t = start; t <= bis; t = tagPlus(t, 1)) { tage++; const v = t === heute ? ph : pt[t]; if (v) { werbung += Number(v.werbung) || 0; profit += Number(v.profit) || 0; ptUmsatz += Number(v.umsatz) || 0 } }
  const r2 = (v) => Math.round(v * 100) / 100
  return { stand: new Date().toISOString(), start, ende, bis, tage, final: ende < heute, bestellungen: o.length, umsatz: r2(umsatz), aov: o.length ? r2(umsatz / o.length) : 0, flaschen, flaschenProBestellung: o.length ? r2(flaschen / o.length) : 0,
    bestellungenProTag: tage ? r2(o.length / tage) : 0, umsatzProTag: tage ? r2(umsatz / tage) : 0, werbung: r2(werbung), profit: r2(profit), profitProTag: tage ? r2(profit / tage) : 0,
    marge: ptUmsatz ? Math.round(profit / ptUmsatz * 1000) / 10 : null, roas: werbung ? r2(ptUmsatz / werbung) : null, mix }
}
let offerLaeuft = false
async function offerAktualisieren(zwingend) {
  if (offerLaeuft) return; offerLaeuft = true
  try {
    const d = offerLesen(), heute = berlinTag(); let geaendert = false
    for (const x of d.tests) {
      const st = offerStatus(x, heute); if (st === 'geplant' || st === 'verworfen') continue
      const a = x.auswertung; const alt = !a || (Date.now() - Date.parse(a.stand)) > 15 * 60_000
      if ((st === 'laeuft' && (alt || zwingend === x.id)) || ((st === 'auswerten' || st === 'ausgewertet') && (!a || !a.final || zwingend === x.id))) { x.auswertung = await offerAuswerten(x.start, x.ende); geaendert = true }
      // Woche vorbei: einmal Sam auf Telegram Bescheid geben
      if (st === 'auswerten' && x.auswertung && x.auswertung.final && !x.gemeldet) {
        const a2 = x.auswertung, f = (v) => v == null ? '–' : String(v).replace('.', ',')
        tgSenden(`Offer-Test KW ${x.kw} ist vorbei: ${x.name}\nBestellungen/Tag ${f(a2.bestellungenProTag)} · Umsatz/Tag ${f(a2.umsatzProTag)} € · AOV ${f(a2.aov)} €\nFlaschen/Bestellung ${f(a2.flaschenProBestellung)} · Profit/Tag ${f(a2.profitProTag)} € · ROAS ${f(a2.roas)}\nGewinner wählen: https://os.leichtkraut.de/os#offer`).catch(() => {})
        x.gemeldet = new Date().toISOString(); geaendert = true }
    }
    if (d.tests.length && (!d.basis || zwingend === 'basis')) { const erst = d.tests.map((x) => x.start).sort()[0]; d.basis = await offerAuswerten(tagPlus(erst, -7), tagPlus(erst, -1)); geaendert = true }
    if (geaendert) offerSchreiben(d)
  } catch (e) { console.warn('[offer]', e.message) } finally { offerLaeuft = false }
}
setInterval(() => offerAktualisieren().catch(() => {}), 30 * 60_000)
function offerAntwort() {
  const d = offerLesen(), heute = berlinTag(), m = montagVon(heute), k = isoKw(m)
  const tests = d.tests.map((x) => Object.assign({}, x, { status: offerStatus(x, heute) })).sort((a, b) => b.start.localeCompare(a.start))
  const jetzt = tests.find((x) => x.status === 'laeuft' || (x.start <= heute && heute <= x.ende && x.status !== 'verworfen'))
  return { tests, jetzt: { kw: k.kw, jahr: k.jahr, start: m, ende: tagPlus(m, 6), testId: jetzt ? jetzt.id : null }, basis: d.basis || null }
}
const offerStufen = (l) => (Array.isArray(l) ? l : []).slice(0, 8).map((x) => ({ name: String(x.name || '').slice(0, 60), flaschen: Number(x.flaschen) || null, preis: x.preis === '' || x.preis == null ? null : Math.round(Number(String(x.preis).replace(',', '.')) * 100) / 100 }))
app.get('/api/os/offer', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  offerAktualisieren().catch(() => {}); res.json(offerAntwort())
})
app.post('/api/os/offer/test', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Name fehlt' })
  const start = montagVon(/^\d{4}-\d{2}-\d{2}$/.test(b.start || '') ? b.start : berlinTag()); const k = isoKw(start); const d = offerLesen()
  if (d.tests.some((x) => x.start === start && x.status !== 'verworfen')) return res.status(409).json({ error: `In KW ${k.kw} läuft schon ein Offer-Test. Eine Woche, ein Offer.` })
  const t = { id: 'kw' + k.jahr + '-' + String(k.kw).padStart(2, '0') + '-' + crypto.randomBytes(2).toString('hex'), kw: k.kw, jahr: k.jahr, start, ende: tagPlus(start, 6), name: String(b.name).slice(0, 120), beschreibung: String(b.beschreibung || '').slice(0, 1000),
    stufen: offerStufen(b.stufen), seite: String(b.seite || '').slice(0, 300), notiz: String(b.notiz || '').slice(0, 2000), status: 'geplant', gewinner: false, entscheidung: '', auswertung: null, angelegt: new Date().toISOString(), von: req.user.name || 'Service' }
  d.tests.push(t); offerSchreiben(d); offerAktualisieren().catch(() => {}); res.json({ ok: true, test: t })
})
app.post('/api/os/offer/test/:id', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d = offerLesen(); const t = d.tests.find((x) => x.id === req.params.id); if (!t) return res.status(404).json({ error: 'Test nicht gefunden' })
  const b = req.body || {}
  for (const k of ['name', 'beschreibung', 'seite', 'notiz', 'entscheidung']) if (k in b) t[k] = String(b[k] || '').slice(0, k === 'notiz' || k === 'beschreibung' || k === 'entscheidung' ? 2000 : 300)
  if ('stufen' in b) t.stufen = offerStufen(b.stufen)
  if ('gewinner' in b) { t.gewinner = !!b.gewinner; if (t.gewinner) { for (const x of d.tests) if (x !== t) x.gewinner = false; t.status = 'ausgewertet' } }
  if ('status' in b && ['verworfen', 'ausgewertet', 'offen'].includes(b.status)) t.status = b.status === 'offen' ? 'geplant' : b.status
  if ('entscheidung' in b && t.entscheidung && offerStatus(t, berlinTag()) === 'auswerten') t.status = 'ausgewertet'
  t.geaendert = new Date().toISOString(); offerSchreiben(d); res.json({ ok: true, test: Object.assign({}, t, { status: offerStatus(t, berlinTag()) }) })
})
app.post('/api/os/offer/test/:id/auswerten', async (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const d0 = offerLesen(); if (!d0.tests.some((x) => x.id === req.params.id)) return res.status(404).json({ error: 'Test nicht gefunden' })
  try { while (offerLaeuft) await new Promise((r) => setTimeout(r, 300)); await offerAktualisieren(req.params.id); const t = offerAntwort().tests.find((x) => x.id === req.params.id); res.json({ ok: true, test: t }) } catch (e) { res.status(502).json({ error: e.message }) }
})

async function tgKlaude(frage, chatId) {
  const key = process.env.ANTHROPIC_API_KEY || ''; if (!key) return 'Kein Claude-Schlüssel auf dem Server.'
  const lage = osKurzlage()
  const system = `Du bist der OS-Assistent von Leichtkraut (os.leichtkraut.de), Sams Kommandozentrale. Antworte auf Deutsch, kurz, in Klartext ohne Markdown, Zahlen als Zahlen. Du kennst die aktuelle Lage als JSON. Du kannst nichts ausführen, nur berichten und einordnen; wenn Sam etwas ausführen will, sag ihm, welcher Chat das macht (1 Ads Uploader, 3 Copy Writer, 4 Shopify API, 6 Profit Tracker, 8 Hetzner Operator, 9 OS Manager). Lage: ${JSON.stringify(lage)}`
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 600, system, messages: [{ role: 'user', content: frage }] }) })
    const j = await r.json(); return (j.content && j.content[0] && j.content[0].text) || ('Keine Antwort (' + r.status + ')')
  } catch (e) { return 'Fehler: ' + e.message }
}
async function tgVerarbeiten(msg) {
  const chatId = msg.chat && msg.chat.id; const text = String(msg.text || '').trim(); if (!chatId || !text) return
  const st = tgLesen()
  if (!st.chatId) {
    const m = text.match(/^\/start\s+(\d{6})$/); if (m && st.code && m[1] === st.code) { st.chatId = chatId; st.pairedAt = new Date().toISOString(); st.name = (msg.from && (msg.from.first_name || msg.from.username)) || ''; delete st.code; tgSchreiben(st); await tgSenden('Gekoppelt. Ich bin das Leichtkraut OS. Schreib /status oder einfach eine Frage.', chatId); return }
    await tgSenden('Nicht gekoppelt. Schick /start und den 6-stelligen Code aus dem OS (Änderungen).', chatId); return
  }
  if (chatId !== st.chatId) { await tgSenden('Dieser Bot gehört Sam.', chatId); return }
  if (/^\/(status|lage)/i.test(text)) return tgSenden(tgStatusText())
  if (/^\/offen/i.test(text)) { const k = osKurzlage(); return tgSenden(k.offen.length ? k.offen.map((a) => `${a.id} · ${a.zustand}${a.fehlend && a.fehlend.length ? ' · fehlt ' + a.fehlend.join(', ') : ''}`).join('\n') : 'Alles gelauncht, nichts offen.') }
  if (/^\/erinner/i.test(text)) { const m = text.match(/^\/erinner\S*\s+(?:in\s+)?(\d+\s*(?:min|m|h|std|d|tag)\w*)\s+(.+)$/i); if (!m) return tgSenden('So: /erinnere in 30 min Text  oder  /erinnere in 2 h Text'); const n = Number(m[1]), f = /min|m\b/i.test(m[1]) ? 60_000 : /h|std/i.test(m[1]) ? 3600_000 : 86400_000; const l = erinnLesen(); l.push({ id: crypto.randomUUID().slice(0, 8), at: new Date(Date.now() + n * f).toISOString(), text: m[2], von: 'Telegram', angelegt: new Date().toISOString() }); erinnSchreiben(l); return tgSenden('Erinnerung gesetzt: ' + m[2]) }
  if (/^\/meldungen/i.test(text)) { const k = osKurzlage(); return tgSenden(k.meldungen.join('\n') || 'Keine Meldungen.') }
  if (/^\/hilfe|^\/help|^\/start/i.test(text)) return tgSenden('/status Lage in einem Blick\n/offen was nicht gelauncht ist\n/meldungen letzte Rückmeldungen der Chats\nAlles andere als Frage in Klartext, ich antworte aus den OS-Daten.')
  const antwort = await tgKlaude(text, chatId); return tgSenden(antwort)
}
// ── Wache: hoert keine Claude-Session am Bot (Nachrichten bleiben liegen), antwortet der Server selbst aus den OS-Daten,
//    bis die Session zurueck ist (Telegram meldet dann 409 Conflict). Nur aktiv, wenn TELEGRAM_POLL=0. (15.09.2026)
let tgNotfallSeit = 0, tgNotfallHinweis = 0, tgNotfallLaeuft = false
async function tgWache() {
  if (!TG_TOKEN || TG_POLL || tgNotfallLaeuft) return
  try {
    const j = await tgApi('getWebhookInfo', {}); const n = (j.result && j.result.pending_update_count) || 0
    if (n > 0) { if (!tgNotfallSeit) tgNotfallSeit = Date.now(); else if (Date.now() - tgNotfallSeit > 90_000) await tgNotfall() }
    else tgNotfallSeit = 0
  } catch (e) { console.warn('[tg] wache:', e.message) }
}
async function tgNotfall() {
  tgNotfallLaeuft = true
  try {
    const j = await tgApi('getUpdates', { offset: 0, timeout: 0, allowed_updates: ['message'] })
    if (!j.ok) { if (j.error_code === 409) tgNotfallSeit = 0; else console.warn('[tg] notfall:', j.description); return }
    const st = tgLesen(); let letzte = 0
    for (const u of (j.result || [])) { letzte = u.update_id; const m = u.message; if (!m || !m.chat || String(m.chat.id) !== String(st.chatId)) continue
      if (Date.now() - tgNotfallHinweis > 3600_000) { tgNotfallHinweis = Date.now(); await tgSenden('Hinweis: gerade hört keine Claude-Session am Bot. Ich antworte vom Server aus den OS-Daten (/status, /offen, /meldungen, Fragen in Klartext), bis die Session zurück ist.') }
      if (m.voice || m.audio) { await tgSenden('Sprachnachricht angekommen, aber ohne Session kann ich sie nicht anhören. Bitte als Text.'); continue }
      try { await tgVerarbeiten(m) } catch (e) { console.warn('[tg] notfall verarbeiten:', e.message) } }
    if (letzte) await tgApi('getUpdates', { offset: letzte + 1, timeout: 0 })   // als gelesen bestaetigen, sonst bekommt die Session sie doppelt
    tgNotfallSeit = 0
  } catch (e) { console.warn('[tg] notfall:', e.message) }
  finally { tgNotfallLaeuft = false }
}
setInterval(tgWache, 60_000)
let tgOffset = 0, tgLaeuft = false
async function tgPoll() {
  if (!TG_TOKEN || tgLaeuft) return; tgLaeuft = true
  try { const j = await tgApi('getUpdates', { offset: tgOffset, timeout: 25, allowed_updates: ['message'] }); for (const u of (j.result || [])) { tgOffset = u.update_id + 1; if (u.message) { try { await tgVerarbeiten(u.message) } catch (e) { console.warn('[tg]', e.message) } } } }
  catch (e) { console.warn('[tg] poll:', e.message); await new Promise((r) => setTimeout(r, 5000)) }
  finally { tgLaeuft = false; setTimeout(tgPoll, 500) }
}
if (TG_TOKEN) {
  const st = tgLesen(); if (TG_POLL && !st.chatId && !st.code) { st.code = String(Math.floor(100000 + Math.random() * 900000)); tgSchreiben(st); try { const m = { at: new Date().toISOString(), chat: 9, name: 'OS Manager', text: `Telegram-Kopplung: im Bot /start ${st.code} schicken.`, typ: 'info' }; const alle = [m].concat(meldungenLesen()).slice(0, 2000); fs.writeFileSync(OS_MELD + '.tmp', JSON.stringify(alle, null, 2)); fs.renameSync(OS_MELD + '.tmp', OS_MELD) } catch {} }
  if (TG_POLL) setTimeout(tgPoll, 3000); console.log('[tg] Telegram-Bot aktiv' + (TG_POLL ? '' : ', nur senden (Claude Code hört zu)') + (st.chatId ? ' (Chat ' + st.chatId + ')' : ' (wartet auf Kopplung, Code im OS unter Änderungen)'))
  // Ereignisse ans Handy: neue Ad, gelauncht, Fehler-Meldung, Tageswechsel-Bilanz
  const tgAlt = osPush
  osPush = function (typ, extra) { tgAlt(typ, extra); try {
    if (typ === 'ads' && extra && /\.(mp4|mov)$/i.test(String(extra.datei || '')) && extra.ad) tgSenden(`Neue Ad im OS: ${extra.ad}`)
    if (typ === 'ads' && extra && extra.launched) tgSenden(`Gelauncht: ${extra.ad}`)
    if (typ === 'tag') setTimeout(() => tgSenden('Tageswechsel. Bilanz gestern folgt um 06:30.'), 2000)
  } catch {} }
  // Stuendlicher Stand fuer Sam (Wunsch 15.09.): 06:00 bis 00:00 zur vollen Stunde, 01:00 bis 05:00 Ruhe. 06:30 weiterhin die Bilanz.
  let tgLetzteStunde = null
  setInterval(() => { const jetzt = new Date(); const b = jetzt.toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }); if (b === '06:30') tgSenden(tgStatusText())
    const h = b.slice(0, 2), m = b.slice(3, 5)
    if (b === '23:59') tgTagSichern()   // Tagesstand einfrieren, bevor der Profit-Tracker um Mitternacht auf null geht
    if (m === '00' && tgLetzteStunde !== h && !(h >= '01' && h <= '05')) { tgLetzteStunde = h; tgSenden(h === '00' ? tgTagesabschlussText() : tgStundenText()) } }, 60_000)
}

// ── Aufträge: die Telegram-Session auf dem Server legt Aufträge an die Chats 1 bis 8 hier ab; die Desktop-Session von Chat 9 holt sie ab und stellt zu. ──
const AUFTR_FILE = path.join(OS_MODUL_DIR, 'auftraege.json')
function auftrLesen() { try { return JSON.parse(fs.readFileSync(AUFTR_FILE, 'utf8')) } catch { return [] } }
function auftrSchreiben(l) { fs.writeFileSync(AUFTR_FILE + '.tmp', JSON.stringify(l, null, 2)); fs.renameSync(AUFTR_FILE + '.tmp', AUFTR_FILE) }
app.get('/api/os/auftraege', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const alle = req.query.alle === '1'; res.json({ auftraege: auftrLesen().filter((a) => alle || !a.erledigt) }) })
app.post('/api/os/auftraege', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const chat = parseInt(b.chat, 10); const text = String(b.text || '').trim().slice(0, 4000)
  if (!(chat >= 1 && chat <= 9) || !text) return res.status(400).json({ error: 'chat (1 bis 9) und text fehlen' })
  const a = { id: crypto.randomUUID().slice(0, 8), chat, text, von: String(b.von || req.user.name || '').slice(0, 80), angelegt: new Date().toISOString(), erledigt: null }
  const l = auftrLesen(); l.push(a); auftrSchreiben(l); osPush('auftrag', { id: a.id, chat }); res.json({ ok: true, auftrag: a })
})
app.post('/api/os/auftraege/:id/erledigt', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const l = auftrLesen().map((a) => a.id === req.params.id ? Object.assign(a, { erledigt: new Date().toISOString(), ergebnis: String((req.body || {}).ergebnis || '').slice(0, 4000) || undefined }) : a); auftrSchreiben(l); res.json({ ok: true }) })

// ── Erinnerungen: das OS erinnert Sam per Telegram. Anlegen per API (Chat 9 oder die Telegram-Session), einmalig oder taeglich. ──
const ERINN_FILE = path.join(OS_MODUL_DIR, 'erinnerungen.json')
function erinnLesen() { try { return JSON.parse(fs.readFileSync(ERINN_FILE, 'utf8')) } catch { return [] } }
function erinnSchreiben(l) { fs.writeFileSync(ERINN_FILE + '.tmp', JSON.stringify(l, null, 2)); fs.renameSync(ERINN_FILE + '.tmp', ERINN_FILE) }
app.get('/api/os/erinnerungen', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); res.json({ erinnerungen: erinnLesen().filter((e) => !e.erledigt).sort((a, b) => String(a.at).localeCompare(String(b.at))) }) })
app.post('/api/os/erinnerungen', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' })
  const b = req.body || {}; const text = String(b.text || '').trim().slice(0, 500); if (!text) return res.status(400).json({ error: 'text fehlt' })
  let at = b.at ? new Date(b.at) : null
  if (!at && b.in) { const m = String(b.in).match(/^(\d+)\s*(min|m|h|std|d|tag)/i); if (m) { const n = Number(m[1]); const f = /^(min|m)$/i.test(m[2]) ? 60_000 : /^(h|std)$/i.test(m[2]) ? 3600_000 : 86400_000; at = new Date(Date.now() + n * f) } }
  if (!at || isNaN(at.getTime())) return res.status(400).json({ error: 'at (ISO-Zeit) oder in (z. B. "30 min", "2 h", "1 tag") fehlt' })
  const e = { id: crypto.randomUUID().slice(0, 8), at: at.toISOString(), text, taeglich: !!b.taeglich, von: req.user.name, angelegt: new Date().toISOString() }
  const l = erinnLesen(); l.push(e); erinnSchreiben(l); res.json({ ok: true, erinnerung: e })
})
app.delete('/api/os/erinnerungen/:id', (req, res) => { if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Nur für Admins' }); const l = erinnLesen().map((e) => e.id === req.params.id ? Object.assign(e, { erledigt: true }) : e); erinnSchreiben(l); res.json({ ok: true }) })
setInterval(() => {
  const l = erinnLesen(); let dirty = false; const now = Date.now()
  for (const e of l) { if (e.erledigt || Date.parse(e.at) > now) continue; tgSenden('Erinnerung: ' + e.text); dirty = true; if (e.taeglich) e.at = new Date(Date.parse(e.at) + 86400_000).toISOString(); else e.erledigt = true }
  if (dirty) erinnSchreiben(l)
}, 30_000)

app.get('/team', (req, res) => {
  const u = sessionUser(req)
  if (!u) return res.redirect('/login')
  // Nur für Admins: Mitarbeitende sollen weder Org-Baum noch Namen/Zeiten sehen.
  // Sie werden auf ihre eigene Auswertung geleitet.
  if (u.role !== 'admin') return res.redirect('/me')
  res.type('html').send(teamPageHtml())
})

// Eigene Auswertung — jede Person sieht ihre Arbeitszeit und jede gesendete Mail.
app.get('/me', (req, res) => {
  const u = sessionUser(req)
  if (!u) return res.redirect('/login')
  res.type('html').send(mePageHtml(u.uiLang === 'en' ? 'en' : 'de'))
})

app.get(['/login', '/setup'], (req, res) => {
  const needSetup = readUsers().length === 0
  if (sessionUser(req)) return res.redirect('/')
  // Englisch ist Standard. ?lang=de schaltet um und merkt sich das ein Jahr,
  // damit deutschsprachige Nutzer nicht bei jedem Besuch klicken müssen.
  const q = String(req.query.lang || '')
  if (q === 'de' || q === 'en') res.setHeader('Set-Cookie', `lk_login_lang=${q}; Path=/; Max-Age=31536000; SameSite=Lax`)
  const lang = q || parseCookies(req).lk_login_lang || 'en'
  res.type('html').send(authPageHtml(needSetup ? 'setup' : 'login', lang))
})

// App-Shell nur für Angemeldete — sonst zur Anmeldung
app.get(['/', '/workspace/*', '/inbox*'], (req, res, next) => {
  if (readUsers().length === 0) return res.redirect('/setup')
  if (!sessionUser(req)) return res.redirect('/login')
  const idx = path.join(DIST_DIR, 'index.html')
  if (!fs.existsSync(idx)) return next()
  res.setHeader('Cache-Control', 'no-store')
  res.sendFile(idx)
})

// ─────────────────────────────────────────────────────────────────────────────
// AUTOMATISCHE EINGANGSBESTÄTIGUNG
// Neue Kundenmail → nach ~4 Minuten Puffer eine persönliche Bestätigung mit
// Ticketnummer. Der Puffer sorgt dafür, dass eine echte Antwort in der
// Zwischenzeit die Bestätigung überflüssig macht (dann wird übersprungen).
// Bewusst NICHT bestätigt: Spam/Phishing, System-Absender (Shopify, Trustpilot,
// no-reply …), Folgemails im selben Ticket und der Alt-Bestand vor Feature-Start.
// Die Bestätigung ändert weder Status noch Ordner (Posteingang-Regel bleibt).
// ─────────────────────────────────────────────────────────────────────────────
const ACK_SINCE = '2026-07-30T12:00:00.000Z' // nur Tickets, die NACH Feature-Start eingehen
const ACK_DELAY_MS = 4 * 60_000
const ACK_MAX_AGE_MS = 6 * 60 * 60_000 // Nachzügler-Grenze, z.B. nach Neustarts
const ACK_MAX_PER_RUN = 5
const ACK_BLOCK = /no-?reply|donotreply|do-not-reply|mailer@|mailer-daemon|daemon@|bounces?@|delivery|@shopify|trustpilot|@klarna|@paypal|@dhl\.|postmaster|newsletter|notification|daily@|marketing@|intercom|triplewhale|@zigpoll|support@|@leichtkraut\.de/i

// Samuels Zeitfenster (Berlin-Zeit): 04-10 Uhr Morgen, 10-15 Uhr Mittag,
// 15 Uhr bis 4 Uhr nachts Abend. Kein "Guten Nachmittag".
// BUGFIX 31.07.: de-DE-Formatierung liefert "11 Uhr" (Text!), Number() davon ist
// NaN und alle Fenster-Vergleiche wurden false → es kam IMMER "Guten Abend".
// Deshalb: Stunde über formatToParts als reine Zahl ziehen + Boot-Selbsttest.
function berlinHourAt(date) {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/Berlin' }).formatToParts(date)
  return Number((parts.find((p) => p.type === 'hour') || {}).value)
}
function greetingForHour(h) {
  if (!Number.isFinite(h)) return 'Guten Tag' // neutraler Notfall statt falscher Tageszeit
  // Samuel (08.08.): Um kurz vor 11 wirkt "Guten Mittag" falsch — Morgen gilt bis 11.
  if (h >= 4 && h < 11) return 'Guten Morgen'
  if (h >= 11 && h < 15) return 'Guten Mittag'
  return 'Guten Abend'
}
function ackGreetingBerlin() { return greetingForHour(berlinHourAt(new Date())) }

// Grußformel und Tageszeit-Wünsche eines Entwurfs auf JETZT umschreiben.
// Nur Anrede und Schlussfloskel werden ersetzt, der Inhalt bleibt unangetastet.
function refreshGreeting(text) {
  let s = String(text || '')
  if (!s) return s
  const now = ackGreetingBerlin()                    // Guten Morgen | Mittag | Abend
  const h = berlinHourAt(new Date())
  // 1) Vorhandene Tageszeit-Anrede auf jetzt umschreiben
  s = s.replace(/^(\s*)Guten (Morgen|Mittag|Tag|Nachmittag|Abend)\b/i, `$1${now}`)
  // 1b) ENGLISCHE FASSUNG (02.09.): Mitarbeiterinnen mit englischer Oberflaeche
  //     sehen die uebersetzte Fassung. Die Regeln oben greifen dort nicht, die
  //     Anrede blieb auf dem Stand der Entwurfs-Erstellung stehen. Weil der Text
  //     beim Senden zurueck ins Deutsche uebersetzt wird, muss hier die
  //     ENGLISCHE Entsprechung der aktuellen deutschen Tageszeit stehen.
  const nowEn = /morgen/i.test(now) ? 'Good morning' : (/abend/i.test(now) ? 'Good evening' : 'Good day')
  s = s.replace(/^(\s*)Good (morning|day|afternoon|evening)\b/i, `$1${nowEn}`)
  const ersteZeileEn = s.split('\n')[0]
  if (!/^\s*Good (morning|day|afternoon|evening)\b/i.test(ersteZeileEn)
      && !/^\s*Guten (Morgen|Mittag|Tag|Nachmittag|Abend)\b/i.test(ersteZeileEn)) {
    const mEn = ersteZeileEn.match(/^([ \t]*)(Dear|Hello|Hi|Hey)\s+(.+?)[ \t]*[,:!]?[ \t]*$/i)
    if (mEn) s = s.replace(ersteZeileEn, () => `${mEn[1]}${nowEn}, dear ${mEn[3].trim()},`)
  }
  // 1a) URSACHE Fall #1584 (Samuel, 09.08.): Diese Ersetzung griff nur, wenn schon
  //     ein "Guten ..." dastand. Schrieb das Modell "Sehr geehrte Frau Muster," oder
  //     "Hallo Vorname,", blieb die Tageszeit-Anrede komplett aus. Jetzt wird sie
  //     deterministisch nachgeruestet, egal wie das Modell begonnen hat.
  const ersteZeile = s.split('\n')[0]
  if (!/^\s*Guten (Morgen|Mittag|Tag|Nachmittag|Abend)\b/i.test(ersteZeile)) {
    const m = ersteZeile.match(/^([ \t]*)(Sehr geehrte[rs]?|Liebe[rs]?|Hallo|Hi|Hey|Guten)\s+(.+?)[ \t]*[,:!]?[ \t]*$/i)
    if (m) {
      const angesprochen = m[3].trim()
      const artikel = /^herr\b/i.test(angesprochen) ? 'lieber' : 'liebe'
      const neueZeile = `${m[1]}${now}, ${artikel} ${angesprochen},`
      s = s.replace(ersteZeile, () => neueZeile)
    }
  }
  // 2) Schlusswunsch passend zur Tageszeit
  const wunsch = h >= 15 || h < 4 ? 'einen schönen Abend' : h >= 10 ? 'einen schönen Tag' : 'einen schönen Tag'
  s = s.replace(/einen schönen (Abend|Tag|Nachmittag|Morgen)\b/gi, wunsch)
  s = s.replace(/Ich wünsche (dir|Ihnen) noch (einen schönen|einen wunderbaren) (Abend|Tag|Nachmittag)/gi,
    (m0, du) => `Ich wünsche ${du} noch ${wunsch}`)
  // Wochentags-Wunsch auf HEUTE ziehen: Ein am Sonntag geschriebener Entwurf, der
  // erst am Montag rausgeht, darf keinen "schönen Sonntag" mehr wünschen.
  const heute = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long' }).format(new Date())
  s = s.replace(/(schönen|schönes)\s+(Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonnabend|Sonntag)\b/gi,
    (m0, adj, tag) => (tag.toLowerCase() === heute.toLowerCase() ? m0 : `${adj} ${heute}`))
  return s
}

// Dauerbeweis fuer die Sendungsnummer (09.08., Samuel: "Es muss fuer die
// gesamte Zukunft gefixt sein"). Laeuft bei JEDEM Start. Deckt genau die Faelle
// ab, die in echt schiefgegangen sind: doppelter Link (#1585) und fehlende
// Nummer, weil die Tracking-API nichts lieferte (#1596). Schlaegt einer fehl,
// steht ein ROTES ❌ im Log, bevor eine einzige Mail rausgeht.
// Dauerbeweis fuer die Antwort-Zuordnung (14.08.): Eine Antwort auf unsere
// Eingangsbestaetigung MUSS im Originalticket landen, nie ein neues aufmachen.
function selfTestThreading() {
  const store = [
    { ticket_number: 1694, customer_email: 'kundin@example.com', subject: 'Bestellung', messages: [], status: 'answered' },
    { ticket_number: 1700, customer_email: 'andere@example.com', subject: 'Frage', messages: [], status: 'open' },
  ]
  const faelle = [
    ['Antwort auf Eingangsbestaetigung', 'Re: Deine Anfrage ist bei uns angekommen (Ticket #1694)', 'kundin@example.com', 1694],
    ['fremde Adresse darf NICHT greifen', 'Re: ... (Ticket #1694)', 'fremd@example.com', null],
    ['normaler Betreff wie bisher', 'Re: Bestellung', 'kundin@example.com', 1694],
  ]
  const fails = []
  for (const [name, betreff, mail, soll] of faelle) {
    const kopie = JSON.parse(JSON.stringify(store))
    const ok = threadIntoExisting(kopie, { email: mail, subject: betreff, text: 'test', date: new Date().toISOString() })
    const ist = ok ? kopie.find((r) => (r.messages || []).length)?.ticket_number : null
    if ((soll === null && ok) || (soll !== null && ist !== soll)) fails.push(name + ' (ergab ' + ist + ', erwartet ' + soll + ')')
  }
  if (fails.length) console.log('[selbsttest] \u274c ANTWORT-ZUORDNUNG DEFEKT:', fails.join(' | '))
  else console.log('[selbsttest] \u2705 Antwort-Zuordnung: alle ' + faelle.length + ' Faelle korrekt (Antworten landen im Originalticket)')
  return fails.length === 0
}

function selfTestTracking() {
  const DHL = 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340000000000000000'
  const AT = 'https://www.post.at/s/sendungsdetails?snr=123456789012'
  const faelle = [
    // [Name, Eingang, fallbackLink, sendung, erwartete Linkzahl, Nummer muss im Fliesstext stehen]
    ['Modell schrieb Link, API lieferte nichts', `Hier: [Sendung verfolgen](${DHL})`, null, undefined, 1, '00340000000000000000'],
    ['Nummer explizit mitgegeben', `Hier: [Sendung verfolgen](${DHL})`, null, { number: '00340000000000000000', carrier: 'DHL' }, 1, '00340000000000000000'],
    ['nackte URL ohne Link', `Hier: ${DHL} bitte`, null, undefined, 1, '00340000000000000000'],
    ['doppelter Link (#1585)', `Hier: [Sendung verfolgen](${DHL}) (${DHL})`, null, undefined, 1, '00340000000000000000'],
    ['Linktext ohne URL (#1553)', 'Hier: Sendung verfolgen', DHL, undefined, 1, '00340000000000000000'],
    ['Oesterreich', `Hier: [Sendung verfolgen](${AT})`, null, undefined, 1, '123456789012'],
    ['Nummer steht schon im Text', `Sendungsnummer: 00340000000000000000\n[Sendung verfolgen](${DHL})`, null, undefined, 1, '00340000000000000000'],
    ['Versandmail OHNE Link (#1612)', 'Ihr Paket ist bei DHL elektronisch angekuendigt.\n\nIch wünsche Ihnen einen schönen Abend.', null, { number: '00340000000000000001' }, 1, '00340000000000000001'],
    ['Versandmail ohne Link und ohne Grussformel', 'Das Paket ist unterwegs.', null, { number: '00340000000000000001' }, 1, '00340000000000000001'],
    ['KEIN Versandbezug bekommt nichts', 'Ihre Anmeldung ist geloescht.\n\nAlles Liebe', null, { number: '00340000000000000001' }, 0, null],
  ]
  const fails = []
  for (const [name, ein, fb, sd, sollLinks, sollNummer] of faelle) {
    const out = embedTrackingLinks(ein, fb, sd)
    const links = (out.match(/\[Sendung verfolgen\]\(/g) || []).length
    const fliesstext = out.replace(/\]\([^)]*\)/g, ']()')
    // sollNummer === null bedeutet: die Nummer darf NICHT auftauchen
    const nummerDrin = sollNummer ? fliesstext.includes(sollNummer) : !/\d{8,}/.test(fliesstext)
    const doppelt = sollNummer ? (fliesstext.match(new RegExp(sollNummer, 'g')) || []).length > 1 : false
    if (links !== sollLinks || !nummerDrin || doppelt) {
      fails.push(`${name} (Links ${links}/${sollLinks}, Nummer ${nummerDrin ? 'ok' : 'FEHLT'}${doppelt ? ', DOPPELT' : ''})`)
    }
  }
  if (fails.length) console.log('[selbsttest] ❌ SENDUNGSNUMMER DEFEKT bei:', fails.join(' · '))
  else console.log(`[selbsttest] ✅ Sendungsnummer: alle ${faelle.length} Faelle korrekt (genau ein Link, Nummer immer im Fliesstext)`)
  return fails.length === 0
}

// Dauerbeweis: läuft bei JEDEM Start und prüft alle Fenstergrenzen in Sommer-
// UND Winterzeit gegen feste Zeitpunkte. Schlägt einer fehl, steht ein ❌ im
// Log — der Fehler von heute (NaN → immer Abend) kann nie wieder still bleiben.
function selfTestGreeting() {
  const cases = [
    ['2026-07-31T02:00:00Z', 'Guten Morgen'], ['2026-07-31T08:59:00Z', 'Guten Morgen'], // CEST: 04:00 / 10:59
    ['2026-07-31T09:00:00Z', 'Guten Mittag'], ['2026-07-31T12:59:00Z', 'Guten Mittag'], // CEST: 11:00 / 14:59
    ['2026-07-31T13:00:00Z', 'Guten Abend'], ['2026-07-31T01:59:00Z', 'Guten Abend'],   // CEST: 15:00 / 03:59
    ['2026-12-15T03:00:00Z', 'Guten Morgen'], ['2026-12-15T10:00:00Z', 'Guten Mittag'], // CET-Winter: 04:00 / 11:00
    ['2026-12-15T14:00:00Z', 'Guten Abend'],
  ]
  const fails = cases.filter(([iso, want]) => greetingForHour(berlinHourAt(new Date(iso))) !== want)
  if (fails.length) console.log('[selbsttest] ❌ GRUSSFORMEL DEFEKT bei:', fails.map((f) => f[0]).join(', '))
  else console.log(`[selbsttest] ✅ Grußformel: alle ${cases.length} Zeitfenster korrekt · jetzt gerade: "${ackGreetingBerlin()}" (${berlinHourAt(new Date())} Uhr Berlin)`)
  return fails.length === 0
}

function ackText(rec) {
  const raw = String(rec.customer_name || '').trim().split(/\s+/)[0] || ''
  const first = raw.replace(/[^A-Za-zÄÖÜäöüß'\-]/g, '')
  const name = first.length >= 2 ? ` ${first[0].toUpperCase()}${first.slice(1)}` : ''
  return {
    subject: `Deine Anfrage ist bei uns angekommen (Ticket #${rec.ticket_number})`,
    text: `${ackGreetingBerlin()}${name},

vielen Dank für deine Nachricht, sie ist sicher bei uns angekommen! Ich habe dir dazu das Ticket #${rec.ticket_number} angelegt und kümmere mich persönlich darum.

Du bekommst schnellstmöglich eine Antwort von mir. Du musst nichts weiter tun.

Ein kleiner Tipp: Falls es um eine Bestellung geht und deine Bestellnummer (#S...) noch nicht in deiner Nachricht steht, antworte einfach kurz damit. Das beschleunigt die Bearbeitung.

Kundenzufriedenheit steht bei uns an oberster Stelle. Danke für dein Vertrauen!

Herzliche Grüße`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDNUNGS-WÄCHTER — erzwingt Samuels eingefrorenes Ordner-Regelwerk
// (FOLDER-RULES.md) auf Datenebene, statt sich auf Disziplin zu verlassen:
//   R1: Eingehende Kundenmails tragen NIE manual_draft (sonst rutschen sie
//       aus dem Posteingang in den Entwürfe-Ordner).
//   R2: Compose-Tickets, auf die eine Kundin geantwortet hat (letzte Nachricht
//       eingehend), gehören in den Posteingang → imap_uid compose:* wird zu
//       reply:* umgeschrieben.
// Läuft jede Minute und beim Start. Jede Korrektur wird geloggt ([ordnung]).
// So kann der Fehler vom 30.07. (32 Posteingang-Tickets in Entwürfen) nie
// wieder entstehen, egal ob durch Skripte, Races oder künftige Features.
// ─────────────────────────────────────────────────────────────────────────────
function enforceFolderRules() {
  const store = readInbound()
  const fixes = []
  for (const rec of store) {
    const uid = String(rec.imap_uid || '')
    const isCompose = uid.startsWith('compose:')
    // R3 (04.08.): Von UNS gestartete Mails gehören IMMER in den Entwürfe-Ordner,
    // damit Samuel einen festen Ort hat, an dem meine vorbereiteten Mails liegen.
    // Jede Hilfs-uid (followup:, reply-von-uns o.ä.) mit Entwurfstext wird deshalb
    // zu compose: normalisiert. Nur echte IMAP-Tickets bleiben im Posteingang.
    if (/^(followup|selfmail|outgoing):/.test(uid) && String(rec.ai_draft || '').trim()) {
      rec.imap_uid = 'compose:' + uid.split(':').slice(1).join(':')
      rec.status = 'draft'
      fixes.push(`#${rec.ticket_number} R3: selbst verfasste Mail → Entwürfe`)
      continue
    }
    if (uid && !isCompose && rec.manual_draft) {
      delete rec.manual_draft
      fixes.push(`#${rec.ticket_number} R1: manual_draft von eingehendem Ticket entfernt`)
    }
    // R4 (04.08.): Sicherheitsnetz gegen hängende Tickets. Haben WIR zuletzt
    // geantwortet, gehört das Ticket nicht mehr in den Posteingang. Fängt Fälle
    // ab, in denen der Status-Aufruf des Frontends unterwegs verloren ging.
    if (['open', 'new', 'pending'].includes(rec.status) && !rec.is_spam) {
      const msgs = rec.messages || []
      const outs = msgs.filter((m) => m.direction !== 'in' && !m.is_internal_note && !m.auto_ack)
      if (outs.length) {
        const lastOut = Math.max(...outs.map((m) => Date.parse(m.created_at || 0) || 0))
        const ins = msgs.filter((m) => m.direction === 'in')
        const lastIn = ins.length ? Math.max(...ins.map((m) => Date.parse(m.created_at || 0) || 0)) : 0
        // 30 s Puffer: eine gerade eben gesendete Mail nicht sofort umsortieren
        if (lastOut > lastIn && Date.now() - lastOut > 30_000) {
          rec.status = 'answered'
          fixes.push(`#${rec.ticket_number} R4: beantwortet → aus dem Posteingang`)
        }
      }
    }
    if (isCompose) {
      // URSACHE Fall #1592 (Samuel, 09.08.): R2 zaehlte den Anlass-Eintrag, den
      // /api/compose seit dem 08.08. in den Verlauf schreibt, als Kundenantwort.
      // Er traegt direction 'in', ist aber ein interner Kontext-Marker. Dadurch
      // wanderte JEDE frisch angelegte Compose-Mail sofort in den Posteingang,
      // statt im Entwuerfe-Ordner zu liegen. Nur ECHTE Kundennachrichten zaehlen.
      const msgs = (rec.messages || []).filter((m) => !m.is_context && !m.is_internal_note && !m.auto_ack)
      const last = msgs[msgs.length - 1]
      if (last && last.direction === 'in') {
        rec.imap_uid = 'reply:' + Date.now()
        fixes.push(`#${rec.ticket_number} R2: Kundenantwort auf Compose → Posteingang`)
      }
    }
  }
  if (fixes.length) {
    writeInbound(store)
    for (const f of fixes) console.log('[ordnung]', f)
  }
  return fixes.length
}

// Ghosting-Nachfassen: am 06.08.2026 auf Samuels Wunsch komplett entfernt.
// Er möchte keine automatischen Nachfass-Entwürfe. Nicht wieder einbauen,
// ohne dass er es ausdrücklich verlangt.

// Nachträgliches Scoring (06.08.): bestehende Entwürfe durch Guards + Kritik
// schicken, OHNE den Text zu verändern — nur Confidence + Beanstandungen setzen.
app.post('/api/admin/rescore', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 20), 40)
    const store = readInbound()
    const targets = store.filter((r) => !r.is_spam && String(r.ai_draft || '').trim() && typeof r.ai_confidence !== 'number').slice(0, limit)
    const done = []
    for (const rec of targets) {
      const thread = (rec.messages || []).filter((m) => !m.auto_ack)
        .map((m) => (m.is_internal_note ? `[INTERNE NOTIZ, gilt als gesicherter Fakt] ${m.body_text || ''}` : (m.body_text || '')))
        .join('\n') || String(rec.body_text || '')
      let factsCtx = ''
      try {
        const live = await fetchShopifyContext(rec.customer_email, { name: rec.customer_name, text: `${rec.subject || ''}\n${thread}`.slice(0, 12000) })
        if (live?.found) {
          factsCtx = `Live-Shopify-Daten: ${JSON.stringify(live).slice(0, 1500)}`
          const tr = (live.orders || []).map((o) => o.tracking).find((t) => t?.number)
          if (tr) {
            const st = await trackShipment(tr.number, tr.url).catch(() => null)
            if (st?.found) factsCtx += `\nSENDUNGS-LIVE-STATUS (${st.carrierName}) zu ${tr.number}: ${st.statusCode || st.status}${st.description ? ' — ' + st.description : ''}`
          }
        }
      } catch { /* Shopify optional */ }
      const outText = (rec.messages || [])
        .filter((m) => m.direction === 'out' && !m.auto_ack && !m.is_internal_note)
        .map((m) => m.body_text || '').join('\n')
      const hard = hardGuardIssues(rec.ai_draft, factsCtx, thread, outText)
      const lastIn = (((rec.messages) || [])
        .filter((m) => m.direction === 'in' && !m.is_context)
        .slice(-1)[0] || {}).body_text || ''
      const crit = await critiqueDraft(rec.ai_draft, factsCtx, thread, lastIn).catch(() => null)
      let score = crit ? crit.score : 70
      if (hard.length) score = Math.min(score, 35)
      const cur = readInbound()
      const hit = cur.find((x) => x.id === rec.id)
      if (hit && String(hit.ai_draft || '').trim()) {
        hit.ai_confidence = score
        const issues = [...hard, ...(crit?.probleme || [])].slice(0, 8)
        if (issues.length) hit.ai_confidence_issues = issues
        else delete hit.ai_confidence_issues
        if (crit?.erstattung_noetig) hit.action_required = 'Rückerstattung nötig'
        writeInbound(cur)
      }
      done.push({ ticket: rec.ticket_number, kunde: rec.customer_name || rec.customer_email, score })
      console.log(`[rescore] #${rec.ticket_number}: ${score}/100`)
    }
    res.json({ ok: true, rescored: done })
  } catch (e) { res.status(500).json({ error: String(e?.message || e) }) }
})

// Wochenreport (Second Brain): Zahlen der letzten 7 Tage aus dem Outcome-Log.
app.get('/api/report/weekly', (_req, res) => {
  let lines = []
  try { lines = fs.readFileSync(OUTCOMES_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch {}
  const weekAgo = Date.now() - 7 * 86400000
  const week = lines.filter((l) => (Date.parse(l.ts) || 0) > weekAgo)
  const drafts = week.filter((l) => l.event === 'draft')
  const sent = week.filter((l) => l.event === 'sent')
  const edited = sent.filter((l) => l.edited)
  const resolved = week.filter((l) => l.event === 'status' && (l.to === 'resolved' || l.to === 'closed'))
  const avgConf = drafts.length ? Math.round(drafts.reduce((s, l) => s + (l.confidence || 0), 0) / drafts.length) : null
  res.json({
    zeitraum_tage: 7,
    entwuerfe_erstellt: drafts.length,
    davon_mit_problemen: drafts.filter((l) => l.issues > 0).length,
    durchschnitts_confidence: avgConf,
    mails_gesendet: sent.length,
    davon_unveraendert_gesendet: sent.length - edited.length,
    davon_von_samuel_editiert: edited.length,
    editier_quote_prozent: sent.length ? Math.round((edited.length / sent.length) * 100) : null,
    tickets_geloest: resolved.length,
    nachfass_entwuerfe: week.filter((l) => l.event === 'followup1' || l.event === 'followup2').length,
  })
})

let ackRunning = false
// Duplikatschutz auch bei Datei-Races: Andere Worker (z.B. Auto-Entwurf) schreiben
// den ganzen Store und können ack_sent überschreiben. Dieses Set gilt pro Prozess
// und verhindert Doppel-Versand; der Lauf heilt verlorene Vermerke selbst nach.
const ackedThisProcess = new Set()
async function sendInboundAcks() {
  if (ackRunning || !secrets.imap) return
  ackRunning = true
  try {
    const now = Date.now()
    const skips = []
    const sends = []
    for (const rec of readInbound()) {
      if (ackedThisProcess.has(rec.id) && !rec.ack_sent) { skips.push([rec.id, 'nachgeheilt']); continue }
      if (rec.ack_sent || ackedThisProcess.has(rec.id) || rec.is_spam) continue
      if (!rec.imap_uid || String(rec.imap_uid).startsWith('compose:')) continue
      const email = String(rec.customer_email || '')
      if (!email.includes('@') || ACK_BLOCK.test(email)) { skips.push([rec.id, 'blockliste']); continue }
      const t = Date.parse(rec.received_at || '')
      if (!t || String(rec.received_at) < ACK_SINCE) continue
      const age = now - t
      if (age < ACK_DELAY_MS) continue // Puffer läuft noch
      if (age > ACK_MAX_AGE_MS) { skips.push([rec.id, 'zu-alt']); continue }
      const msgs = rec.messages || []
      if (msgs.some((m) => m.direction !== 'in' && !m.is_internal_note)) { skips.push([rec.id, 'schon-beantwortet']); continue }
      if (msgs.filter((m) => m.direction === 'in').length > 1) { skips.push([rec.id, 'folgemail']); continue }
      sends.push(rec.id)
    }
    const markAck = (id, value, message) => {
      const store = readInbound()
      const r = store.find((x) => x.id === id)
      if (!r) return
      r.ack_sent = value
      if (message) r.messages = [...(r.messages || []), message]
      writeInbound(store)
    }
    for (const [id, reason] of skips) markAck(id, `übersprungen: ${reason}`)
    for (const id of sends.slice(0, ACK_MAX_PER_RUN)) {
      const rec = readInbound().find((x) => x.id === id)
      if (!rec || rec.ack_sent || ackedThisProcess.has(id)) continue
      ackedThisProcess.add(id) // VOR dem Senden sperren, nie doppelt bestätigen
      let { subject, text } = ackText(rec)
      try {
        // Sprachregel: Bestätigung in der Sprache der Kundin
        const target = customerLang(rec)
        if (target && target !== 'de') {
          const [ts, tt] = await Promise.all([uebersetzeBetreff(subject, target), translateText(text, target)])
          if (ts) subject = ts
          if (tt) text = tt
        }
        await smtpSend({ to: rec.customer_email, subject, text })
        markAck(id, new Date().toISOString(), {
          direction: 'out', body_text: text.slice(0, 8000), created_at: new Date().toISOString(),
          auto_ack: true, sentByName: 'Automatische Eingangsbestätigung',
        })
        console.log('[ack] Eingangsbestätigung an', rec.customer_email, '· Ticket #' + rec.ticket_number)
      } catch (e) {
        console.log('[ack] Fehler bei Ticket #' + rec.ticket_number + ':', String(e && e.message ? e.message : e).slice(0, 120))
      }
    }
  } finally { ackRunning = false }
}

app.listen(PORT, () => {
  console.log(`[api] Resolvia backend läuft auf http://localhost:${PORT}`)
  selfTestGreeting()
  selfTestTracking()
  selfTestThreading()
  autoConnectImap()
  autoDraftNewRecords().catch(() => {}) // draft any stored mails that don't have one yet
  setInterval(() => autoDraftNewRecords().then(() => translateInboxBatch(20).catch(() => {})).catch(() => {}), 60_000)   // 21.08.: nach jedem Auto-Draft direkt uebersetzen   // 16.08.: 2 Min -> 60 s, Samuel wartete beim Test sichtbar
  // Uebersetzer-Hintergrundlauf: haelt die englische Fassung aktuell
  setInterval(() => translateInboxBatch(20).catch((e) => console.log('[i18n]', String(e && e.message ? e.message : e).slice(0, 60))), 45_000)
  setTimeout(() => bewerteKundenreaktionen(60).catch(() => {}), 30_000)   // 23.08.: Zufriedenheits-Backlog einmalig aufholen
  setInterval(() => bewerteKundenreaktionen(20).catch(() => {}), 10 * 60_000)
  setTimeout(() => hausnummerAutomatik().catch(() => {}), 60_000)          // 24.08.: Hausnummer-Automatik
  setInterval(() => hausnummerAutomatik().catch(() => {}), 5 * 60_000) // 21.08.: 6/90s -> 20/45s, damit en-User zuegig auf Englisch sehen
  // Eingangsbestätigungen: jede Minute prüfen, ob eine neue Kundenmail 4 Min alt ist
  setInterval(() => sendInboundAcks().catch((e) => console.log('[ack]', String(e && e.message ? e.message : e).slice(0, 80))), 60_000)
  // Ordnungs-Wächter: erzwingt das Ordner-Regelwerk (Posteingang vs. Entwürfe)
  try { enforceFolderRules() } catch {}
  setInterval(() => { try { enforceFolderRules() } catch (e) { console.log('[ordnung]', String(e && e.message ? e.message : e).slice(0, 80)) } }, 60_000)
  console.log(`[api] AI: ${secrets.ai ? 'Key vorhanden' : 'kein Key (Anthropic-Key in server/.env oder via UI)'} · Shopify: ${secrets.shopify ? 'Token vorhanden' : 'nicht verbunden'}`)
})
