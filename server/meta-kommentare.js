// ─────────────────────────────────────────────────────────────────────────────
// KOMMENTAR-MANAGEMENT (Samuel, 05.09.2026)
// Findet alle Posts/Videos hinter den AKTIVEN Anzeigen des Werbekontos (Facebook
// und Instagram, inkl. Dark Posts, die nie im Seiten-Feed stehen), holt deren
// Kommentare samt Antworten, bewertet sie nach Ampel und stellt alles unter
// /kommentare als Übersicht bereit. Antworten/Verbergen laufen über die
// Seiten-Tokens aus connections.meta._pageTokens (Anzeigen-Ebene über den
// System-User-Token). Es wird NIE gelöscht, nur verborgen.
// Logik portiert aus BOF-MASCHINE/datenbank/skripte/kommentare_scan.py:
//   * IG-Ad-Posts nur über effective_instagram_media_id erreichbar
//   * "@name …" als eigener Top-Level-Kommentar der Marke zählt als Antwort
//   * Paginierung über paging.cursors.after ist Pflicht (>100 Kommentare)
//   * IG-Medien unter Persona-Seiten hängen an fremden Konten → "unerreichbar",
//     nicht "Fehler"
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'

const API = 'https://graph.facebook.com/v21.0'
const SCAN_INTERVALL_MIN = 20
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// GESCHAEFTSKONFIGURATION AUSGELAGERT (07.09.2026, Samuel): Werbekonto, Kampagnen,
// Seiten-IDs und die Stimme je Seite standen frueher hier im Code. Das sind
// betriebliche Angaben und gehoeren nicht in ein Repository, das geteilt wird.
// Sie liegen jetzt in data/meta-config.json (nicht versioniert). Fehlt die Datei,
// laeuft das Modul mit leerer Konfiguration weiter - der Scan findet dann nichts,
// stuerzt aber nicht ab. Vorlage: beispiele/meta-config.example.json
function ladeMetaConfig(datenVerzeichnis) {
  try { return JSON.parse(fs.readFileSync(path.join(datenVerzeichnis, 'meta-config.json'), 'utf8')) }
  catch { return {} }
}

// Ampel nach Handbuch: Rot = medizinisch/rechtlich, Gelb = unzufrieden/Gewicht/
// Konzeptkritik/Lieferung, sonst Grün. Deterministisch, kostet nichts.
// Ampel nach Samuels Briefing (05.09.): ROT = Beschwerden, Gesundheit, Lieferung,
// Garantie/Rückgabe, Rechtliches (erst als Vorschlag zeigen). GELB = Zweifel, Preis.
// GRÜN = Lob, Smalltalk, einfache Fragen. Deterministisch, kostet nichts.
const ROT_RE = /schwanger|still ?zeit|stillen|medikament|tablette|blutdruck|schilddr|krebs|niere|herz(krank|problem|insuff|schw(ä|ae)che|medik|rhythm)|schlaganfall|diabet|insulin|wechselwirkung|wechseljahr|rheuma|arthr|migr(ä|ae)ne|lip(ö|oe)dem|lymph(ö|oe)dem|depress|essst(ö|oe)rung|magersucht|bulimie|anwalt|abmahnung|verbraucherzentrale|presse|nebenwirkung|operation|\bop\b|chemo|marcumar|blutverd(ü|ue)nn|wassertablette|entw(ä|ae)sserungs|krank|arzt|(ä|ae)rztin|thrombose|dialyse|nicht angekommen|lieferung|wo bleibt|warte seit|paket|garantie|geld zur(ü|ue)ck|r(ü|ue)ckerstatt|zur(ü|ue)ckschicken|retoure|nix gebracht|nichts gebracht|hat nix|keine wirkung|hilft nicht|wirkt nicht|nix geht|abzocke|betrug|beschwer|reklamation|storno|k(ü|ue)ndig|widerruf|rechnung|bezahl|klarna|paypal/i
const GELB_RE = /hilft (das|es) (auch )?wirklich|wirkt (das|es)|glaub|zu teuer|preis|wucher|billiger|g(ü|ue)nstiger|amazon|zweifel|skeptisch|beweis|wundermittel|zu sch(ö|oe)n|kilo|abnehm|gewicht|sexist|oberfl(ä|ae)chlich|fake|quatsch|cazzate|bl(ö|oe)dsinn|unsinn|wer hat das schon|getestet|erfahrung/i
function ampel(text) {
  const t = String(text || '')
  if (!t.trim()) return 'gruen'
  if (ROT_RE.test(t)) return 'rot'
  if (GELB_RE.test(t)) return 'gelb'
  return 'gruen'
}

// Selbstprüfung vor jedem Post (Samuels Vorgabe): kein Gedankenstrich, max. 2
// Emojis, keine Prozentzahlen. Dazu die Handbuch-Falle „zwei Tropfen".
export function selbstpruefung(text) {
  const t = String(text || '')
  const probleme = []
  if (!t.trim()) probleme.push('Text ist leer')
  if (/—/.test(t) || /\s–\s/.test(t)) probleme.push('Gedankenstrich enthalten')
  const emojis = (t.match(/\p{Extended_Pictographic}/gu) || []).length
  if (emojis > 2) probleme.push(`${emojis} Emojis (höchstens 2)`)
  if (/\d\s?%|prozent/i.test(t)) probleme.push('Prozentzahl enthalten')
  if (/zwei tropfen|2 tropfen/i.test(t)) probleme.push('„zwei Tropfen" ist falsch (Handbuch 9.1)')
  if (t.length > 900) probleme.push('zu lang für einen Kommentar')
  // Aktions- und Preishinweise (Samuel, 05.09.). Handbuch Abschnitt 4 Punkt 6
  // und Baustelle 9.3: in Kommentaren nie Mechanik, Frist oder Zahl nennen.
  if (/\b(rabatt\w*|gutschein\w*|coupon|aktion\w*|angebot\w*|gratis|kostenlos|spar(e|st|en)|code)\b/i.test(t)) probleme.push('Aktion, Rabatt oder Code erwähnt')
  if (/was gerade läuft|gerade gibt|aktuell läuft|derzeit läuft/i.test(t)) probleme.push('Anspielung auf eine laufende Aktion')
  if (/\d+\s?(euro|eur|€)/i.test(t)) probleme.push('Preis in Zahlen')
  return probleme
}

export function registerMetaKommentare(app, ctx) {
  const { getConnections, secrets, DATA_DIR, sessionUser, aiFetch, seitenHtml } = ctx
  const CFG = ladeMetaConfig(DATA_DIR)
  const STIMME = CFG.stimmen || {}
  const AD_ACCOUNT_DEFAULT = CFG.adAccount || ''
  const KAMPAGNEN_DEFAULT = CFG.kampagnen || []
  const CACHE = path.join(DATA_DIR, 'meta-kommentare.json')
  const STATUS = path.join(DATA_DIR, 'meta-kommentar-status.json')
  // Notbremse fuer die Meta-API (Samuel, 08.09.). Die App teilt sich ein
  // Kontingent mit dem Ads-Uploader. Solange pausiert, unterbleibt JEDER
  // Meta-Aufruf: Vollscan, Minuten-Check, Insights, Antworten, Verbergen,
  // Loeschen. Ueberlebt Neustarts, weil sie in einer Datei steht.
  // Seiten, auf denen wir nicht mehr arbeiten koennen, etwa weil Meta sie
  // gesperrt hat (Samuel, 14.09.: Marken-Seite Leichtkraut). Ihre Posts und
  // Kommentare bleiben im Bestand, verschwinden aber aus der Arbeitsansicht.
  const GESPERRT = path.join(DATA_DIR, 'meta-gesperrte-seiten.json')
  const gesperrteSeiten = () => { try { return (readJson(GESPERRT, {}) || {}).seiten || {} } catch { return {} } }
  const PAUSE = path.join(DATA_DIR, 'meta-pause.json')
  const pausiert = () => { try { return !!(readJson(PAUSE, {}) || {}).pausiert } catch { return false } }
  const pauseGrund = () => { try { return (readJson(PAUSE, {}) || {}).grund || 'pausiert' } catch { return 'pausiert' } }
  const LOG = path.join(DATA_DIR, 'meta-kommentar-log.jsonl')
  const REGELN = path.join(DATA_DIR, 'meta-kommentar-regeln.md')

  const meta = () => (getConnections().meta || {})
  const systemToken = () => meta()._systemToken || meta()._userToken || ''
  const pageToken = (pageId) => ((meta()._pageTokens || {})[pageId]) || ''
  const pages = () => meta().pages || []
  const brandPage = () => pages().find((p) => p.igId) || pages().find((p) => /leichtkraut/i.test(p.name)) || pages()[0] || null
  const pageName = (id) => ((pages().find((p) => p.id === id) || {}).name) || (STIMME[id] || {}).wer || id

  const readJson = (f, alt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return alt } }
  const writeJson = (f, d) => { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d)); fs.renameSync(tmp, f) }
  const log = (eintrag) => { try { fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...eintrag }) + '\n') } catch {} }

  // ── Graph-Helfer ──────────────────────────────────────────────────────────
  async function g(pfad, params, versuche = 4) {
    const u = new URL(API + pfad)
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v))
    let letzter = null
    for (let i = 0; i < versuche; i++) {
      let r, j
      try { r = await fetch(u, { signal: AbortSignal.timeout(60_000) }); j = await r.json().catch(() => ({})) }
      catch (e) { letzter = e; await sleep(3000 * (i + 1)); continue }
      if (r.ok && !j.error) return j
      const msg = (j.error && j.error.message) || `HTTP ${r.status}`
      const code = j.error && j.error.code
      const limit = [4, 17, 32, 613].includes(code) || r.status === 429 || /limit/i.test(msg)
      const e = new Error(msg); e.code = code; e.status = r.status
      if (!limit) throw e
      letzter = e; await sleep(30_000 * (i + 1))
    }
    throw letzter || new Error('Rate-Limit')
  }
  async function p(pfad, params) {
    const r = await fetch(API + pfad, { method: 'POST', body: new URLSearchParams(params || {}), signal: AbortSignal.timeout(60_000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.error) { const e = new Error((j.error && j.error.message) || `HTTP ${r.status}`); e.code = j.error && j.error.code; throw e }
    return j
  }
  async function pDelete(pfad, params) {
    const u = new URL(API + pfad)
    for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v))
    const r = await fetch(u, { method: 'DELETE', signal: AbortSignal.timeout(60_000) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.error) { const e = new Error((j.error && j.error.message) || `HTTP ${r.status}`); e.code = j.error && j.error.code; throw e }
    return j
  }
  async function alle(pfad, params, max = 800) {
    const raus = []; let after = null
    for (;;) {
      const j = await g(pfad, after ? { ...params, after } : params)
      raus.push(...(j.data || []))
      after = j.paging && j.paging.cursors && j.paging.cursors.after
      if (!after || !(j.data || []).length || raus.length >= max || !(j.paging && j.paging.next)) break
    }
    return raus
  }
  // Batch: 50 Objekte pro Anfrage. Ergebnis: Map id → { ok, body | fehler }
  async function batch(token, ids, fields) {
    const out = new Map()
    for (let i = 0; i < ids.length; i += 50) {
      const teil = ids.slice(i, i + 50)
      const b = teil.map((id) => ({ method: 'GET', relative_url: `${id}?fields=${encodeURIComponent(fields)}` }))
      let antw = []
      for (let v = 0; v < 4; v++) {
        try {
          const r = await fetch(API + '/', { method: 'POST', body: new URLSearchParams({ access_token: token, batch: JSON.stringify(b) }), signal: AbortSignal.timeout(120_000) })
          const j = await r.json().catch(() => null)
          if (Array.isArray(j)) { antw = j; break }
          if (j && j.error && /limit/i.test(j.error.message || '')) { await sleep(30_000 * (v + 1)); continue }
          break
        } catch { await sleep(5000) }
      }
      teil.forEach((id, k) => {
        const a = antw[k]
        if (!a) return out.set(id, { ok: false, fehler: 'keine Antwort' })
        let body = {}; try { body = JSON.parse(a.body || '{}') } catch {}
        if (a.code === 200 && !body.error) out.set(id, { ok: true, body })
        else out.set(id, { ok: false, fehler: (body.error && body.error.message) || `HTTP ${a.code}` })
      })
    }
    return out
  }

  // ── Anzeigen entdecken ────────────────────────────────────────────────────
  // VOLLER UMFANG (Samuel, 05.09.): nicht nur aktive Anzeigen. Kommentare kommen
  // auch unter pausierten/archivierten Ads weiter an (organische Reichweite).
  const ALLE_STATUS = ['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'ARCHIVED', 'DISAPPROVED', 'PENDING_REVIEW', 'WITH_ISSUES', 'IN_PROCESS', 'PREAPPROVED', 'PENDING_BILLING_INFO']
  async function entdeckeAds() {
    const tok = systemToken()
    const m = meta()
    const felder = 'id,name,effective_status,adset{id,name},campaign{id,name},creative{id,effective_object_story_id,effective_instagram_media_id,thumbnail_url}'
    // ALLE erreichbaren Werbekonten lesen, nicht nur das konfigurierte.
    // Am 06.09. fiel auf, dass ein zweites Konto ("4 Backup - Wormup") komplett
    // uebersehen wurde und dessen Kommentare nie im Werkzeug auftauchten.
    // Dynamisch abgefragt, damit ein drittes Konto nicht dasselbe Schicksal hat.
    let konten = []
    try {
      konten = (await alle('/me/adaccounts', { access_token: tok, fields: 'id,name', limit: 50 }, 100)).map((x) => x.id).filter(Boolean)
    } catch (e) { console.log('[kommentare] Werbekonten nicht listbar:', String(e.message).slice(0, 120)) }
    if (m.adAccount && !konten.includes(m.adAccount)) konten.unshift(m.adAccount)
    if (!konten.length) konten = [m.adAccount || AD_ACCOUNT_DEFAULT]
    console.log('[kommentare] Werbekonten:', konten.join(', '))

    let ads = []
    for (const acc of konten) {
      try { ads.push(...await alle(`/${acc}/ads`, { access_token: tok, limit: 200, effective_status: JSON.stringify(ALLE_STATUS), fields: felder }, 6000)) }
      catch (e) { console.log('[kommentare] Werbekonto', acc, 'nicht lesbar:', String(e.message).slice(0, 120)) }
    }
    if (!ads.length) {
      // Fallback: Kampagnen einzeln (falls kein Werbekonto dem Token zugewiesen ist)
      console.log('[kommentare] Kein Werbekonto lesbar, weiche auf Kampagnen aus')
      for (const k of (m.campaigns || KAMPAGNEN_DEFAULT)) {
        try { ads.push(...await alle(`/${k}/ads`, { access_token: tok, limit: 200, effective_status: JSON.stringify(ALLE_STATUS), fields: felder }, 6000)) }
        catch (e2) { console.log('[kommentare] Kampagne', k, 'nicht lesbar:', String(e2.message).slice(0, 120)) }
      }
    }
    // Doppelte Anzeigen entfernen, falls ein Konto zweimal in der Liste stand
    { const g = new Map(); for (const a of ads) if (a && a.id) g.set(a.id, a); ads = [...g.values()] }
    const fb = new Map(), ig = new Map()
    for (const a of ads) {
      const c = a.creative || {}
      const storyPage = (c.effective_object_story_id && c.effective_object_story_id.includes('_')) ? c.effective_object_story_id.split('_')[0] : null
      const info = { adId: a.id, adName: a.name, status: a.effective_status, storyPage, adset: (a.adset && a.adset.name) || '', adsetId: a.adset && a.adset.id, campaign: (a.campaign && a.campaign.name) || '', campaignId: a.campaign && a.campaign.id, thumb: c.thumbnail_url || null }
      if (c.effective_object_story_id && c.effective_object_story_id.includes('_')) {
        const e = fb.get(c.effective_object_story_id) || { ads: [] }; e.ads.push(info); fb.set(c.effective_object_story_id, e)
      }
      if (c.effective_instagram_media_id) {
        const e = ig.get(c.effective_instagram_media_id) || { ads: [] }; e.ads.push(info); ig.set(c.effective_instagram_media_id, e)
      }
    }
    // Posts aus geloeschten Anzeigen (Samuel, 06.09.). Meta liefert ueber die
    // /ads-Kante nur bestehende Anzeigen. Wird eine Anzeige geloescht, bleibt
    // ihr Post samt Kommentaren online, verschwindet aber aus unserer Sicht.
    // Ueber /adcreatives sind diese Posts weiterhin auffindbar. Konkreter Fall:
    // ein unbeantworteter Kommentar auf <post-id>, den das Werkzeug nie
    // angezeigt hat.
    let ausCreatives = 0
    for (const acc of konten) {
      try {
        const crs = await alle(`/${acc}/adcreatives`, { access_token: tok, limit: 200, fields: 'id,name,effective_object_story_id,effective_instagram_media_id,thumbnail_url' }, 6000)
        for (const cr of crs) {
          const info = { adId: null, adName: cr.name || 'Anzeige gelöscht', status: 'GELOESCHT', storyPage: null, adset: '', adsetId: null, campaign: '', campaignId: null, thumb: cr.thumbnail_url || null }
          const fbId = cr.effective_object_story_id
          if (fbId && fbId.includes('_') && !fb.has(fbId)) { fb.set(fbId, { ads: [info] }); ausCreatives++ }
          const igId = cr.effective_instagram_media_id
          if (igId && !ig.has(igId)) { ig.set(igId, { ads: [info] }); ausCreatives++ }
        }
      } catch (e) { console.log('[kommentare] adcreatives', acc, 'nicht lesbar:', String(e.message).slice(0, 120)) }
    }
    if (ausCreatives) console.log('[kommentare] zusaetzlich aus geloeschten Anzeigen:', ausCreatives, 'Posts')

    // Organische Posts der Seiten + organische IG-Beitraege (ohne Anzeige dahinter)
    for (const p of pages()) {
      const ptok = pageToken(p.id); if (!ptok) continue
      try { for (const post of await alle(`/${p.id}/posts`, { access_token: ptok, fields: 'id', limit: 100 }, 500)) if (!fb.has(post.id)) fb.set(post.id, { ads: [], organisch: true }) }
      catch (e) { console.log('[kommentare] posts', p.name, ':', String(e.message).slice(0, 100)) }
      if (p.igId) {
        try { for (const med of await alle(`/${p.igId}/media`, { access_token: ptok, fields: 'id', limit: 100 }, 500)) if (!ig.has(med.id)) ig.set(med.id, { ads: [], organisch: true }) }
        catch (e) { console.log('[kommentare] ig media', p.name, ':', String(e.message).slice(0, 100)) }
      }
    }
    // Anzeigen-Statistik (Samuel, 05.09.): EINE Konto-Abfrage auf Ad-Ebene statt
    // 1490 Einzelaufrufe. Laufzeit gesamt ("maximum"), damit die Zahlen zu dem
    // passen, was unter dem Post an Reaktionen/Kommentaren steht.
    const stat = {}
    try {
      const rows = await alle(`/${m.adAccount || AD_ACCOUNT_DEFAULT}/insights`, { access_token: tok, level: 'ad', fields: 'ad_id,impressions,reach,spend,clicks,inline_link_clicks,actions', date_preset: 'maximum', limit: 500 }, 6000)
      for (const r of rows) {
        const act = {}; for (const a of (r.actions || [])) act[a.action_type] = Number(a.value) || 0
        stat[r.ad_id] = { impressions: +r.impressions || 0, reach: +r.reach || 0, spend: +r.spend || 0, clicks: +r.clicks || 0, linkClicks: +r.inline_link_clicks || 0, reactions: act.post_reaction || 0, comments: act.comment || 0, shares: act.post || 0, engagement: act.post_engagement || 0 }
      }
      console.log('[kommentare] Insights fuer', Object.keys(stat).length, 'Ads geladen')
    } catch (e) { console.log('[kommentare] Insights nicht lesbar:', String(e.message).slice(0, 120)) }
    for (const map of [fb, ig]) for (const [, info] of map) {
      const sum = { impressions: 0, reach: 0, spend: 0, clicks: 0, linkClicks: 0, reactions: 0, comments: 0, shares: 0, engagement: 0, ads: 0 }
      for (const a of info.ads) { const st = stat[a.adId]; if (!st) continue; sum.ads++; for (const k of Object.keys(st)) sum[k] += st[k] }
      info.insights = sum.ads ? sum : null
    }
    return { fb, ig, adsGesamt: ads.length, adsAktiv: ads.filter((a) => a.effective_status === 'ACTIVE').length }
  }

  // ── Scan ──────────────────────────────────────────────────────────────────
  let scan = { laeuft: false, gestartet: null, fertig: null, schritt: '', fehler: null }
  let timer = null

  async function scannen(ausloeser) {
    if (pausiert()) { console.log('[kommentare] Scan uebersprungen, Meta-API pausiert'); return false }
    if (scan.laeuft) return false
    if (!meta().connected || !systemToken()) { scan.fehler = 'Meta nicht verbunden'; return false }
    scan = { laeuft: true, gestartet: new Date().toISOString(), fertig: null, schritt: 'Anzeigen lesen', fehler: null }
    const t0 = Date.now()
    try {
      const { fb, ig, adsGesamt, adsAktiv } = await entdeckeAds()
      const videos = []
      const brand = brandPage()
      const brandTok = brand ? pageToken(brand.id) : ''
      const status = readJson(STATUS, {})

      // Facebook: pro Seite ein Token, Details + Kommentarzahl per Batch
      const nachSeite = new Map()
      for (const postId of fb.keys()) { const pid = postId.split('_')[0]; if (!nachSeite.has(pid)) nachSeite.set(pid, []); nachSeite.get(pid).push(postId) }
      let n = 0
      for (const [pid, postIds] of nachSeite) {
        const tok = pageToken(pid)
        scan.schritt = `Facebook ${pageName(pid)} (${postIds.length} Posts)`
        if (!tok) { for (const id of postIds) videos.push(videoStub('facebook', id, pid, fb.get(id), 'Kein Seiten-Token für diese Seite')); continue }
        const det = await batch(tok, postIds, 'id,message,permalink_url,full_picture,created_time,comments.summary(true).limit(0),reactions.summary(true).limit(0),shares,attachments{media_type,type,url,media{source,image{src}}}')
        for (const id of postIds) {
          const d = det.get(id)
          const v = videoStub('facebook', id, pid, fb.get(id), d && d.ok ? null : ((d && d.fehler) || 'nicht lesbar'))
          if (d && d.ok) {
            const b = d.body
            const att = ((b.attachments || {}).data || [])[0] || {}
            const med = att.media || {}
            v.text = b.message || ''
            v.createdAt = b.created_time || null
            // full_picture zuerst: das ist das grosse Standbild. attachments.media.image ist oft nur ein Mini-Thumb.
            v.media = { type: /video/i.test(att.media_type || att.type || '') ? 'video' : 'image', thumb: b.full_picture || (med.image && med.image.src) || v.media.thumb, video: med.source || null, permalink: b.permalink_url || null }
            const total = ((b.comments || {}).summary || {}).total_count || 0
            v.rohAnzahl = total
            v.post = { reactions: ((b.reactions || {}).summary || {}).total_count || 0, shares: (b.shares && b.shares.count) || 0, comments: total }
            if (total > 0) {
              try { v.kommentare = await ladeFbKommentare(id, pid, tok) }
              catch (e) { v.unerreichbar = String(e.message).slice(0, 160) }
            }
          }
          zaehlen(v, status); videos.push(v); n++
        }
      }

      // Instagram: JEDES Medium mit dem Token der Seite, die die Anzeige traegt.
      // Die Persona-Seiten haben kein eigenes Instagram, sondern von Meta erzeugte
      // "Seiten-Konten" (page-backed, z.B. ein Konto mit kryptischem Namen je Persona-Seite). Deren
      // Kommentare sind nur mit dem Token GENAU DIESER Seite lesbar/beantwortbar,
      // nicht mit dem Marken-Token (das war die "Sperre" vom 04.09.).
      const igNachSeite = new Map()
      const ownerNamen = {}   // owner-id → username (Batch liefert den Namen nicht mit)
      for (const [id, info] of ig) {
        const ads = info.ads || []
        const pid = (ads.find((a) => a.storyPage && pageToken(a.storyPage)) || {}).storyPage || (brand ? brand.id : null)
        if (!igNachSeite.has(pid)) igNachSeite.set(pid, [])
        igNachSeite.get(pid).push(id)
      }
      for (const [pid, igIds] of igNachSeite) {
        const tok = pid ? pageToken(pid) : ''
        scan.schritt = `Instagram ${pid ? pageName(pid) : '?'} (${igIds.length} Medien)`
        if (!tok) { for (const id of igIds) { const v = videoStub('instagram', id, pid, ig.get(id), 'Kein Seiten-Token'); zaehlen(v, status); videos.push(v) } continue }
        const det = await batch(tok, igIds, 'id,media_type,media_url,thumbnail_url,permalink,caption,timestamp,comments_count,like_count,owner{id,username}')
        for (const id of igIds) {
          const d = det.get(id)
          const v = videoStub('instagram', id, pid, ig.get(id), d && d.ok ? null : ((d && d.fehler) || 'nicht lesbar'))
          if (d && d.ok) {
            const b = d.body
            v.text = b.caption || ''
            v.createdAt = b.timestamp || null
            v.igOwnerId = (b.owner && b.owner.id) || null
            // Batch liefert owner.username nicht; ein Direktaufruf auf das Medium schon.
            // Einmal pro Owner nachschlagen (auch ein Fehlschlag wird gemerkt).
            if (v.igOwnerId && !(v.igOwnerId in ownerNamen) && !(b.owner && b.owner.username)) {
              try { ownerNamen[v.igOwnerId] = (((await g(`/${id}`, { fields: 'owner{username}', access_token: tok })).owner) || {}).username || null } catch { ownerNamen[v.igOwnerId] = null }
            }
            v.igOwner = (b.owner && b.owner.username) || (v.igOwnerId && ownerNamen[v.igOwnerId]) || null
            v.igSeitenKonto = !!(v.igOwnerId && brand && v.igOwnerId !== brand.igId)
            v.media = { type: b.media_type === 'VIDEO' ? 'video' : 'image', thumb: b.thumbnail_url || (b.media_type !== 'VIDEO' ? b.media_url : null) || v.media.thumb, video: b.media_type === 'VIDEO' ? b.media_url : null, permalink: b.permalink || null }
            if (!v.igOwnerId) v.unerreichbar = 'Instagram-Konto hinter dieser Anzeige ist mit keinem Seiten-Token lesbar.'
            v.rohAnzahl = b.comments_count || 0
            v.post = { reactions: b.like_count || 0, shares: null, comments: b.comments_count || 0 }
            if ((b.comments_count || 0) > 0 && !v.unerreichbar) {
              try { v.kommentare = await ladeIgKommentare(id, tok, v.igOwner, v.igOwnerId) }
              catch (e) { v.unerreichbar = String(e.message).slice(0, 160) }
            }
          }
          zaehlen(v, status); videos.push(v)
        }
      }

      videos.sort((a, b) => (b.counts.offen - a.counts.offen) || String(b.letzteAktivitaet || '').localeCompare(String(a.letzteAktivitaet || '')))
      const daten = { scannedAt: new Date().toISOString(), dauerMs: Date.now() - t0, adsGesamt, adsAktiv, videos, ausloeser: ausloeser || 'auto' }
      const altC = ladeCache(); daten.version = (altC.version || 0) + 1; daten.neu = altC.neu || []; daten.insightsAt = new Date().toISOString()
      writeJson(CACHE, daten)
      scan = { ...scan, laeuft: false, fertig: daten.scannedAt, schritt: 'fertig' }
      const offen = videos.reduce((a, v) => a + v.counts.offen, 0)
      console.log(`[kommentare] Scan fertig: ${videos.length} Posts (${adsGesamt} Ads, davon ${adsAktiv} aktiv, + organisch) · ${offen} offene Kommentare · ${Math.round(daten.dauerMs / 1000)} s`)
      return true
    } catch (e) {
      scan = { ...scan, laeuft: false, fehler: String(e && e.message || e).slice(0, 200), schritt: 'abgebrochen' }
      console.log('[kommentare] Scan-Fehler:', scan.fehler)
      return false
    }
  }

  async function ladeFbKommentare(id, pid, tok) {
    const roh = await alle(`/${id}/comments`, { access_token: tok, filter: 'toplevel', limit: 100, fields: 'id,message,message_tags,created_time,from,comment_count,is_hidden,like_count,permalink_url,comments.limit(50){id,message,message_tags,created_time,from,is_hidden,permalink_url}' }, 1500)
    return roh.map((c) => fbKommentar(c, pid))
  }
  async function ladeIgKommentare(id, tok, ownerUser, ownerId) {
    const roh = await alle(`/${id}/comments`, { access_token: tok, limit: 50, fields: 'id,text,username,from{id,username},timestamp,like_count,hidden,replies.limit(50){id,text,username,from{id,username},timestamp,hidden}' }, 1500)
    return igKommentare(roh, ownerUser, ownerId)
  }

  // ── LIVE: Schnell-Check im Minutentakt (Samuel, 05.09.) ─────────────────
  // Der Vollscan braucht 4 Minuten. Dazwischen prueft dieser Check nur die
  // "heissen" Posts (haben schon Kommentare, sind frisch, oder wurden gerade von
  // uns beantwortet) per Batch auf veraenderte Kommentarzahlen und laedt nur die
  // veraenderten neu. Ergebnis: neue Kommentare erscheinen innerhalb ~1 Minute.
  let liveLaeuft = false
  let liveCheckAt = null
  const beruehrt = new Map()   // postKey → Zeitstempel unserer letzten Aktion
  function heisseposts(d) {
    const jetzt = Date.now(), t14 = jetzt - 14 * 86400_000, t7 = jetzt - 7 * 86400_000
    return d.videos.filter((v) => !v.unerreichbar && (
      (v.kommentare && v.kommentare.length) ||
      (v.quelle === 'aktiv' && v.createdAt && Date.parse(v.createdAt) > t14) ||
      (v.letzteAktivitaet && Date.parse(v.letzteAktivitaet) > t7) ||
      beruehrt.has(v.key)
    )).slice(0, 800)
  }
  // Anzeigen-Statistik nachziehen (eine Konto-Abfrage), hoechstens alle paar Minuten.
  async function insightsAktualisieren(d, maxAlter) {
    if (pausiert()) return false
    if (d.insightsAt && Date.now() - Date.parse(d.insightsAt) < maxAlter) return false
    const m = meta(); const tok = systemToken()
    const rows = await alle(`/${m.adAccount || AD_ACCOUNT_DEFAULT}/insights`, { access_token: tok, level: 'ad', fields: 'ad_id,impressions,reach,spend,clicks,inline_link_clicks,actions', date_preset: 'maximum', limit: 500 }, 6000)
    const stat = {}
    for (const r of rows) { const act = {}; for (const a of (r.actions || [])) act[a.action_type] = Number(a.value) || 0; stat[r.ad_id] = { impressions: +r.impressions || 0, reach: +r.reach || 0, spend: +r.spend || 0, clicks: +r.clicks || 0, linkClicks: +r.inline_link_clicks || 0, reactions: act.post_reaction || 0, comments: act.comment || 0, shares: act.post || 0, engagement: act.post_engagement || 0 } }
    for (const v of d.videos) {
      const sum = { impressions: 0, reach: 0, spend: 0, clicks: 0, linkClicks: 0, reactions: 0, comments: 0, shares: 0, engagement: 0, ads: 0 }
      for (const a of (v.ads || [])) { const st = stat[a.id]; if (!st) continue; sum.ads++; for (const k of Object.keys(st)) sum[k] += st[k] }
      v.insights = sum.ads ? sum : (v.insights || null)
    }
    d.insightsAt = new Date().toISOString()
    return true
  }
  async function schnellCheck(opt) {
    if (pausiert()) return false
    if (liveLaeuft || scan.laeuft || !meta().connected) return
    liveLaeuft = true
    try {
      const d = ladeCache(); if (!d.videos.length) return
      try { if (await insightsAktualisieren(d, (opt && opt.insightsMax) || 5 * 60_000)) console.log('[kommentare] Insights aktualisiert') } catch (e) { console.log('[kommentare] Insights-Refresh:', String(e.message).slice(0, 100)) }
      const status = readJson(STATUS, {})
      const heiss = heisseposts(d)
      const gruppen = new Map()   // pageId|netz → [videos]
      for (const v of heiss) { const k = `${v.pageId}|${v.netz}`; if (!gruppen.has(k)) gruppen.set(k, []); gruppen.get(k).push(v) }
      let geaendert = 0, neu = 0
      const neueIds = []
      // Seiten/Netzwerke parallel pruefen (6 Seiten x 2 Netze), innerhalb einer Gruppe sequenziell.
      await Promise.all([...gruppen].map(async ([k, vs]) => {
        const [pid, netz] = k.split('|'); const tok = pageToken(pid); if (!tok) return
        const feld = netz === 'facebook' ? 'id,comments.summary(true).limit(0),reactions.summary(true).limit(0),shares' : 'id,comments_count,like_count'
        const det = await batch(tok, vs.map((v) => v.id), feld)
        for (const v of vs) {
          const r = det.get(v.id); if (!r || !r.ok) continue
          const n = netz === 'facebook' ? (((r.body.comments || {}).summary || {}).total_count || 0) : (r.body.comments_count || 0)
          // Engagement am Post bei jedem Check mitziehen (Samuel: immer aktuell)
          v.post = netz === 'facebook'
            ? { reactions: ((r.body.reactions || {}).summary || {}).total_count || 0, shares: (r.body.shares && r.body.shares.count) || 0, comments: n }
            : { reactions: r.body.like_count || 0, shares: null, comments: n }
          const muss = n !== (v.rohAnzahl || 0) || beruehrt.has(v.key)
          if (!muss) continue
          try {
            const vorher = new Set((v.kommentare || []).flatMap((c) => [c.id, ...c.antworten.map((a) => a.id)]))
            v.kommentare = netz === 'facebook' ? await ladeFbKommentare(v.id, pid, tok) : await ladeIgKommentare(v.id, tok, v.igOwner, v.igOwnerId)
            v.rohAnzahl = n
            for (const c of v.kommentare) { if (!vorher.has(c.id) && !c.vonUns) { neu++; neueIds.push(c.id) } for (const a of c.antworten) if (!vorher.has(a.id) && !a.vonUns) { neu++; neueIds.push(a.id) } }
            zaehlen(v, status); geaendert++
          } catch (e) { console.log('[kommentare] live', v.key, ':', String(e.message).slice(0, 100)) }
          beruehrt.delete(v.key)
        }
      }))
      for (const [k, t] of beruehrt) if (Date.now() - t > 15 * 60_000) beruehrt.delete(k)
      liveCheckAt = new Date().toISOString()
      d.liveCheckAt = liveCheckAt
      d.neu = ((d.neu || []).concat(neueIds.map((id) => ({ id, at: liveCheckAt })))).filter((x) => Date.now() - Date.parse(x.at) < 30 * 60_000)
      if (geaendert) { d.videos.sort((a, b) => (b.counts.offen - a.counts.offen) || String(b.letzteAktivitaet || '').localeCompare(String(a.letzteAktivitaet || ''))) }
      speichereCache(d)
      if (geaendert) console.log(`[kommentare] live: ${heiss.length} Posts geprueft, ${geaendert} aktualisiert, ${neu} neue Kommentare/Antworten`)
    } catch (e) { console.log('[kommentare] live-Check Fehler:', String(e && e.message || e).slice(0, 160)) }
    finally { liveLaeuft = false }
  }
  setInterval(() => { schnellCheck().catch(() => {}) }, 60_000)
  setTimeout(() => { schnellCheck().catch(() => {}) }, 45_000)

  function videoStub(netz, id, pageId, info, unerreichbar) {
    const ads = (info && info.ads) || []
    const st = ads.map((a) => a.status)
    const quelle = (info && info.organisch && !ads.length) ? 'organisch' : (st.includes('ACTIVE') ? 'aktiv' : (st.some((x) => /PAUSED/.test(x)) ? 'pausiert' : (st.includes('ARCHIVED') ? 'archiviert' : (st.includes('DISAPPROVED') ? 'abgelehnt' : 'sonstige'))))
    return {
      quelle, insights: (info && info.insights) || null,
      key: `${netz === 'facebook' ? 'fb' : 'ig'}:${id}`, netz, id, pageId, pageName: pageId ? pageName(pageId) : (netz === 'instagram' ? 'Instagram' : '?'),
      stimme: STIMME[pageId] || null,
      adset: ads[0] ? ads[0].adset : '', campaign: ads[0] ? ads[0].campaign : '', ads: ads.map((a) => ({ id: a.adId, name: a.adName, status: a.status })),
      text: '', createdAt: null, media: { type: 'image', thumb: (ads.find((a) => a.thumb) || {}).thumb || null, video: null, permalink: null },
      unerreichbar: unerreichbar || null, kommentare: [], counts: { gesamt: 0, offen: 0, beantwortet: 0, verborgen: 0, rot: 0, gelb: 0 }, letzteAktivitaet: null,
    }
  }
  // Namen aus Markierungen rekonstruieren (Samuel, 05.09.).
  // Meta entfernt `from` bei fremden Personen, laesst `message_tags` aber stehen.
  // Wer auf einen Kommentar antwortet, markiert die angesprochene Person an
  // Position 0. Die chronologisch erste solche Markierung benennt daher den
  // Verfasser des Kommentars. Gemessene Trefferquote: 81 % (05.09.2026).
  let _unsereNamen = null
  function unsereSeitenNamen() {
    if (_unsereNamen) return _unsereNamen
    try { _unsereNamen = new Set((((meta() || {}).pages) || []).map((x) => String(x.name || '')).filter(Boolean)) }
    catch { _unsereNamen = new Set() }
    return _unsereNamen
  }
  function nameAusMarkierungen(antworten) {
    const unsere = unsereSeitenNamen()
    const kand = []
    for (const a of antworten) {
      for (const t of (a.tags || [])) {
        if (t && t.type === 'user' && t.offset === 0 && t.name && !unsere.has(t.name)) { kand.push({ name: t.name, id: t.id || null, zeit: a.zeit }); break }
      }
    }
    if (!kand.length) return null
    kand.sort((x, y) => String(x.zeit || '').localeCompare(String(y.zeit || '')))
    const erste = kand[0]
    return { name: erste.name, id: erste.id, belege: kand.filter((x) => x.name === erste.name).length }
  }

  function fbKommentar(c, pageId) {
    const antworten = (((c.comments || {}).data) || []).map((r) => ({ id: r.id, wer: (r.from && r.from.name) || null, werId: (r.from && r.from.id) || null, text: r.message || '', zeit: r.created_time, hidden: !!r.is_hidden, vonUns: !!(r.from && r.from.id === pageId), tags: (r.message_tags || []).filter((t) => t && t.type === 'user'), permalink: r.permalink_url || null }))
    const vonUns = !!(c.from && c.from.id === pageId)
    let wer = (c.from && c.from.name) || null
    let werId = (c.from && c.from.id) || null
    let werQuelle = wer ? 'api' : null
    if (!wer && !vonUns) {
      const g = nameAusMarkierungen(antworten)
      if (g) { wer = g.name; werId = g.id; werQuelle = 'markierung' }
    }
    return {
      id: c.id, netz: 'facebook', wer, werId, werQuelle, text: c.message || '', zeit: c.created_time, permalink: c.permalink_url || null,
      likes: c.like_count || 0, hidden: !!c.is_hidden, vonUns, antworten,
      beantwortet: vonUns || letzteAntwortVonUns(antworten), nachfrage: hatNachfrage(antworten), ampel: vonUns ? 'gruen' : ampel(c.message),
    }
  }
  function igKommentare(roh, ownerUser, ownerId) {
    const bu = String(ownerUser || '').toLowerCase()
    const istUns = (x) => (!!bu && String(x.username || (x.from && x.from.username) || '').toLowerCase() === bu) || (!!ownerId && !!x.from && x.from.id === ownerId)
    const list = roh.map((c) => {
      const antworten = (((c.replies || {}).data) || []).map((r) => ({ id: r.id, wer: r.username || (r.from && r.from.username) || null, werId: (r.from && r.from.id) || null, text: r.text || '', zeit: r.timestamp, hidden: !!r.hidden, vonUns: istUns(r) }))
      const vonUns = istUns(c)
      return { id: c.id, netz: 'instagram', wer: c.username || (c.from && c.from.username) || null, werId: (c.from && c.from.id) || null, text: c.text || '', zeit: c.timestamp, likes: c.like_count || 0, hidden: !!c.hidden, vonUns, antworten, beantwortet: vonUns || letzteAntwortVonUns(antworten), nachfrage: hatNachfrage(antworten), ampel: vonUns ? 'gruen' : ampel(c.text) }
    })
    // "@name …" als eigener Top-Level-Kommentar der Marke = Antwort auf @name
    const at = new Set(list.filter((c) => c.vonUns && /^@\S+/.test(c.text)).map((c) => c.text.split(/\s+/)[0].slice(1).toLowerCase()))
    for (const c of list) if (!c.vonUns && c.wer && at.has(c.wer.toLowerCase())) c.beantwortet = true
    return list
  }
  // Beantwortet heisst: unsere Antwort ist die LETZTE im Strang. Schreibt die
  // Person danach nochmal ("ja genau, aber ..."), ist der Kommentar wieder offen.
  function letzteAntwortVonUns(antworten) {
    const uns = antworten.filter((r) => r.vonUns).map((r) => r.zeit || '').sort().pop()
    if (!uns) return false
    const andere = antworten.filter((r) => !r.vonUns).map((r) => r.zeit || '').sort().pop() || ''
    return uns >= andere
  }
  function hatNachfrage(antworten) {
    return antworten.some((r) => r.vonUns) && !letzteAntwortVonUns(antworten)
  }
  // Instagram laesst sich nur moderieren, wenn das IG-Konto mit einer unserer
  // Seiten verknuepft ist. Bei den Persona-Seiten ist es das nicht, dort lehnt
  // Meta Antworten, Verbergen und Loeschen mit (#10) ab (Samuel, 06.09.).
  function igWarnung(v) {
    if (v.netz !== 'instagram') return null
    const seite = pages().find((x) => x.id === v.pageId)
    if (seite && seite.igId) return null
    return 'Das Instagram-Konto dieser Seite ist nicht mit unserem Zugang verknüpft. Antworten, Verbergen und Löschen lehnt Meta hier ab. Das lässt sich nur im Business Manager beheben.'
  }
  function zaehlen(v, status) {
    v.igWarnung = igWarnung(v)
    v.gesperrt = gesperrteSeiten()[v.pageId] || null
    const cs = v.kommentare.filter((c) => !c.vonUns)
    for (const c of cs) { const s = status[c.id]; c.erledigt = !!(s && s.erledigt); c.notiz = (s && s.notiz) || null }
    v.counts = {
      gesamt: cs.length,
      offen: v.unerreichbar ? 0 : cs.filter((c) => !c.beantwortet && !c.hidden && !c.erledigt).length,
      nachfragen: cs.filter((c) => c.nachfrage && !c.erledigt).length,
      beantwortet: cs.filter((c) => c.beantwortet).length,
      verborgen: cs.filter((c) => c.hidden).length,
      rot: v.unerreichbar ? 0 : cs.filter((c) => c.ampel === 'rot' && !c.beantwortet && !c.erledigt).length,
      gelb: v.unerreichbar ? 0 : cs.filter((c) => c.ampel === 'gelb' && !c.beantwortet && !c.erledigt).length,
    }
    v.letzteAktivitaet = cs.reduce((m, c) => (c.zeit > m ? c.zeit : m), v.createdAt || '')
  }

  function ladeCache() { return readJson(CACHE, { scannedAt: null, videos: [] }) }
  function speichereCache(d) { d.version = (d.version || 0) + 1; d.liveCheckAt = d.liveCheckAt || liveCheckAt; writeJson(CACHE, d) }
  function findeKommentar(d, id) {
    for (const v of d.videos) for (const c of v.kommentare) if (c.id === id) return { v, c }
    return null
  }

  // Automatik: erster Scan kurz nach dem Start (wenn Cache alt), dann alle 20 Min.
  function planen() {
    if (timer) clearInterval(timer)
    timer = setInterval(() => { scannen('auto').catch(() => {}) }, SCAN_INTERVALL_MIN * 60_000)
    setTimeout(() => {
      const c = ladeCache()
      const alt = !c.scannedAt || Date.now() - Date.parse(c.scannedAt) > SCAN_INTERVALL_MIN * 60_000
      if (alt) scannen('start').catch(() => {})
    }, 20_000)
  }
  planen()

  // ── API ───────────────────────────────────────────────────────────────────
  const nurAdmin = (req, res) => { if (!req.user || req.user.role !== 'admin') { res.status(403).json({ error: 'Nur für Admins' }); return false } return true }

  app.get('/api/meta/kommentare', (req, res) => {
    const d = ladeCache()
    if (req.query.v && String(req.query.v) === String(d.version || 0)) return res.json({ unchanged: true, version: d.version || 0, jetzt: new Date().toISOString(), scan, liveCheckAt: d.liveCheckAt || liveCheckAt })
    const offen = d.videos.reduce((a, v) => a + v.counts.offen, 0)
    const rot = d.videos.reduce((a, v) => a + v.counts.rot, 0)
    const gelb = d.videos.reduce((a, v) => a + v.counts.gelb, 0)
    const nachfragen = d.videos.reduce((a, v) => a + (v.counts.nachfragen || 0), 0)
    if (req.query.summary) return res.json({ offen, rot, gelb, nachfragen, scannedAt: d.scannedAt, scan })
    res.json({ ...d, offen, rot, gelb, nachfragen, scan, jetzt: new Date().toISOString(), liveCheckAt: d.liveCheckAt || liveCheckAt, insightsAt: d.insightsAt || null, pages: pages().map((p) => ({ id: p.id, name: p.name, igUsername: p.igUsername || null })), stimmen: STIMME })
  })
  // Sofort-Check beim Neuladen der Seite (Samuel, 05.09.): laeuft den Schnell-Check
  // direkt durch und antwortet erst danach. Schutz: hoechstens alle 20 s, und nie
  // parallel zu Vollscan oder laufendem Check (dann kommt der letzte Stand zurueck).
  let __liveWunsch = null
  app.post('/api/meta/kommentare/live', async (req, res) => {
    if (pausiert()) return res.status(423).json({ error: 'Meta-API pausiert: ' + pauseGrund() })
    const zuFrisch = liveCheckAt && Date.now() - Date.parse(liveCheckAt) < 20_000
    if (!zuFrisch && !liveLaeuft && !scan.laeuft) {
      __liveWunsch = schnellCheck({ insightsMax: 2 * 60_000 }).catch(() => {}).finally(() => { __liveWunsch = null })
    }
    if (__liveWunsch) await Promise.race([__liveWunsch, sleep(40_000)])
    const d = ladeCache()
    res.json({ ok: true, liveCheckAt: d.liveCheckAt || liveCheckAt, version: d.version || 0, laeuft: liveLaeuft, scanLaeuft: scan.laeuft, zuFrisch })
  })

  app.post('/api/meta/kommentare/scan', async (req, res) => {
    if (pausiert()) return res.status(423).json({ error: 'Meta-API pausiert: ' + pauseGrund() })
    if (!nurAdmin(req, res)) return
    if (scan.laeuft) return res.json({ ok: true, laeuft: true, scan })
    scannen('manuell:' + (req.user.name || '?')).catch(() => {})
    await sleep(300)
    res.json({ ok: true, laeuft: true, scan })
  })

  app.post('/api/meta/kommentare/:id/antwort', async (req, res) => {
    if (!nurAdmin(req, res)) return
    if (pausiert()) return res.status(423).json({ error: 'Meta-API pausiert: ' + pauseGrund() + '. Antworten ist gesperrt, bis die Pause aufgehoben wird.' })
    const text = String((req.body && req.body.text) || '').trim()
    const probleme = selbstpruefung(text)
    if (probleme.length) return res.status(400).json({ error: 'Selbstprüfung fehlgeschlagen: ' + probleme.join(', '), probleme })
    const d = ladeCache(); const hit = findeKommentar(d, req.params.id)
    if (!hit) return res.status(404).json({ error: 'Kommentar nicht im letzten Scan' })
    const { v, c } = hit
    // Person sichtbar markieren (Samuel, 05.09.). Auf Instagram kennen wir den
    // Benutzernamen, ein vorangestelltes @name ist dort eine echte Erwaehnung und
    // benachrichtigt die Person. Auf Facebook gibt Meta den Namen nicht heraus,
    // dort traegt allein die Verschachtelung unter dem Kommentar die Zuordnung.
    // Wem gilt die Antwort? Nicht zwingend dem Verfasser des Ursprungskommentars,
    // sondern dem der juengsten Nachricht (Samuel, 06.09.). Ist dessen Name
    // unbekannt, stellen wir GAR KEINEN voran, statt den falschen.
    const kette2 = [{ id: c.id, wer: c.wer, vonUns: false }].concat(c.antworten || [])
    let iA = kette2.length - 1
    while (iA > 0 && kette2[iA].vonUns) iA--
    const adressat = kette2[iA].wer || null
    // An WELCHE Nachricht haengen wir die Antwort? Facebook erlaubt Antworten auf
    // Unterantworten, der Strang bleibt zweistufig, aber `parent` zeigt korrekt
    // auf die angesprochene Nachricht und die Person wird gezielt benachrichtigt.
    // Bisher ging alles an den Ursprungskommentar, dadurch stand die Antwort an
    // der falschen Stelle im Strang (Samuel, 06.09.).
    const zielId = (iA > 0 && kette2[iA] && kette2[iA].id) ? kette2[iA].id : c.id
    const schon = adressat ? new RegExp('^@?' + String(adressat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null
    const marke = (adressat && schon && !schon.test(text.trim()))
      ? (c.netz === 'instagram' ? '@' + adressat + ' ' : adressat + ' ')
      : ''
    const gesendet = marke + text
    // Doppelantworten verhindern (Samuel, 07.09.). Der Zwischenstand kann veraltet
    // sein, etwa wenn parallel in der Business Suite geantwortet wurde. Deshalb
    // den Strang unmittelbar vor dem Posten frisch von Meta holen.
    if (c.netz === 'facebook' && !(req.body && req.body.trotzdem)) {
      try {
        const frisch = await g(`/${c.id}/comments`, { access_token: pageToken(v.pageId), limit: 100, fields: 'id,message,created_time,from' })
        const liste = frisch.data || []
        const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim()
        const neu = norm(gesendet)
        if (neu && liste.some((x) => norm(x.message) === neu)) {
          return res.status(409).json({ doppelt: true, error: 'Dieser Text steht wortgleich schon im Strang. Antwort nicht gesendet.' })
        }
        const chrono = liste.slice().sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)))
        let letzteUns = -1, letzteKunde = -1
        chrono.forEach((x, i) => { if (x.from && x.from.id === v.pageId) letzteUns = i; else letzteKunde = i })
        if (chrono.length && letzteUns > letzteKunde) {
          return res.status(409).json({ doppelt: true, error: 'Auf die jüngste Nachricht in diesem Strang haben wir bereits geantwortet.' })
        }
      } catch (e) { console.log('[kommentare] Doppelpruefung nicht moeglich:', String(e.message).slice(0, 120)) }
    }

    try {
      let r
      if (c.netz === 'facebook') {
        try {
          r = await p(`/${zielId}/comments`, { message: gesendet, access_token: pageToken(v.pageId) })
        } catch (e) {
          if (zielId === c.id) throw e
          // Sollte Meta die Unterantwort ablehnen, haengen wir sie wie bisher an
          // den Ursprungskommentar. Lieber an der falschen Stelle als gar nicht.
          console.log('[kommentare] Antwort auf Unterantwort abgelehnt, weiche auf den Ursprungskommentar aus:', String(e.message).slice(0, 140))
          r = await p(`/${c.id}/comments`, { message: gesendet, access_token: pageToken(v.pageId) })
        }
      } else {
        // Instagram kennt nur eine Ebene, dort geht die Antwort immer an den
        // Ursprungskommentar.
        r = await p(`/${c.id}/replies`, { message: gesendet, access_token: pageToken(v.pageId) })
      }
      c.antworten.push({ id: r.id || null, wer: c.netz === 'instagram' ? (v.igOwner || (brandPage() || {}).igUsername || 'leichtkraut.official') : pageName(v.pageId), werId: v.pageId, text: gesendet, zeit: new Date().toISOString(), hidden: false, vonUns: true })
      // Kommentar zusaetzlich mit Daumen hoch markieren (Samuel, 05.09.).
      // Nur Facebook: Instagram bietet keinen Like-Endpunkt fuer Kommentare, und
      // eine Herz-Reaktion lehnt Meta ab (Fehler #3, fehlende Capability).
      // Schlaegt das Liken fehl, bleibt die Antwort trotzdem gueltig.
      // Daumen hoch auf GENAU die Nachricht, die wir beantwortet haben, also auch
      // auf eine Unterantwort, nicht pauschal auf den Ursprungskommentar
      // (Samuel, 06.09.).
      c.geliked = !!c.geliked
      let geliked = false
      if (c.netz === 'facebook') {
        try { await p(`/${zielId}/likes`, { access_token: pageToken(v.pageId) }); geliked = true; if (zielId === c.id) c.geliked = true }
        catch (e) { console.log('[kommentare] Daumen hoch fehlgeschlagen auf', zielId, ':', String(e.message).slice(0, 140)) }
      }
      c.beantwortet = true
      c.nachfrage = false
      beruehrt.set(v.key, Date.now())
      zaehlen(v, readJson(STATUS, {})); speichereCache(d)
      log({ aktion: 'antwort', by: req.user.name, netz: c.netz, kommentar: c.id, ziel: zielId, seite: v.pageName, text: gesendet, geliked, zielGeliked: zielId })
      res.json({ ok: true, antwortId: r.id || null, geliked, kommentar: c })
    } catch (e) { res.status(400).json({ error: 'Meta lehnt ab: ' + String(e.message).slice(0, 200) }) }
  })

  app.post('/api/meta/kommentare/:id/verbergen', async (req, res) => {
    if (!nurAdmin(req, res)) return
    if (pausiert()) return res.status(423).json({ error: 'Meta-API pausiert: ' + pauseGrund() + '. Verbergen ist gesperrt, bis die Pause aufgehoben wird.' })
    const hidden = !!(req.body && req.body.hidden)
    const d = ladeCache(); const hit = findeKommentar(d, req.params.id)
    if (!hit) return res.status(404).json({ error: 'Kommentar nicht im letzten Scan' })
    const { v, c } = hit
    try {
      if (c.netz === 'facebook') await p(`/${c.id}`, { is_hidden: hidden ? 'true' : 'false', access_token: pageToken(v.pageId) })
      else await p(`/${c.id}`, { hide: hidden ? 'true' : 'false', access_token: pageToken(v.pageId) })
      c.hidden = hidden
      beruehrt.set(v.key, Date.now())
      zaehlen(v, readJson(STATUS, {})); speichereCache(d)
      log({ aktion: hidden ? 'verbergen' : 'einblenden', by: req.user.name, netz: c.netz, kommentar: c.id, seite: v.pageName })
      res.json({ ok: true, kommentar: c })
    } catch (e) { res.status(400).json({ error: 'Meta lehnt ab: ' + String(e.message).slice(0, 200) }) }
  })

  // Kommentar endgueltig loeschen (Samuel, 06.09.). Bewusst getrennt vom
  // Verbergen und NICHT rueckgaengig zu machen. Das Handbuch sagt "nie loeschen,
  // ausser Samuel sagt es ausdruecklich", deshalb nur auf ausdruecklichen Klick
  // in der Oberflaeche, mit Rueckfrage davor.
  app.post('/api/meta/kommentare/:id/loeschen', async (req, res) => {
    if (!nurAdmin(req, res)) return
    if (pausiert()) return res.status(423).json({ error: 'Meta-API pausiert: ' + pauseGrund() + '. Loeschen ist gesperrt, bis die Pause aufgehoben wird.' })
    const d = ladeCache(); const hit = findeKommentar(d, req.params.id)
    if (!hit) return res.status(404).json({ error: 'Kommentar nicht im letzten Scan' })
    const { v, c } = hit
    try {
      await pDelete(`/${c.id}`, { access_token: pageToken(v.pageId) })
      v.kommentare = v.kommentare.filter((x) => x.id !== c.id)
      beruehrt.set(v.key, Date.now())
      zaehlen(v, readJson(STATUS, {})); speichereCache(d)
      log({ aktion: 'geloescht', by: req.user.name, netz: c.netz, kommentar: c.id, seite: v.pageName, text: c.text, wer: c.wer })
      res.json({ ok: true, geloescht: c.id })
    } catch (e) { res.status(400).json({ error: 'Meta lehnt ab: ' + String(e.message).slice(0, 200) }) }
  })

  app.post('/api/meta/kommentare/gesperrt', (req, res) => {
    if (!nurAdmin(req, res)) return
    const seiten = (req.body && req.body.seiten) || {}
    writeJson(GESPERRT, { seiten, at: new Date().toISOString(), von: req.user.name })
    const d = ladeCache(); const st = readJson(STATUS, {})
    d.videos.forEach((v) => zaehlen(v, st)); speichereCache(d)
    log({ aktion: 'gesperrte-seiten', by: req.user.name, seiten: Object.keys(seiten) })
    res.json({ ok: true, seiten })
  })

  app.post('/api/meta/kommentare/pause', (req, res) => {
    if (!nurAdmin(req, res)) return
    const an = !!(req.body && req.body.pausiert)
    writeJson(PAUSE, { pausiert: an, grund: (req.body && req.body.grund) || '', seit: new Date().toISOString(), von: req.user.name })
    console.log('[kommentare] Meta-API', an ? 'PAUSIERT' : 'wieder freigegeben', 'durch', req.user.name)
    log({ aktion: an ? 'pause-an' : 'pause-aus', by: req.user.name, grund: (req.body && req.body.grund) || '' })
    res.json({ ok: true, pausiert: an })
  })

  app.post('/api/meta/kommentare/:id/erledigt', (req, res) => {
    if (!nurAdmin(req, res)) return
    const st = readJson(STATUS, {})
    const erledigt = !!(req.body && req.body.erledigt)
    st[req.params.id] = { ...(st[req.params.id] || {}), erledigt, notiz: (req.body && req.body.notiz) || (st[req.params.id] || {}).notiz || null, by: req.user.name, at: new Date().toISOString() }
    writeJson(STATUS, st)
    const d = ladeCache(); const hit = findeKommentar(d, req.params.id)
    if (hit) { zaehlen(hit.v, st); speichereCache(d) }
    log({ aktion: erledigt ? 'erledigt' : 'wieder-offen', by: req.user.name, kommentar: req.params.id })
    res.json({ ok: true, kommentar: hit ? hit.c : null })
  })

  // Emoji-Rotation (Samuel, 05.09.): Das Modell greift von sich aus immer zum
  // selben Emoji. Deshalb bestimmen wir es hier, anhand dessen, was zuletzt
  // tatsaechlich gepostet wurde, und geben genau eines vor.
  // Vorschlaege zwischenspeichern (Samuel, 06.09.). Schluessel enthaelt den
  // Zustand des Strangs, damit ein neuer Kundenkommentar den Cache verwirft.
  const vorschlagCache = new Map()
  function cacheKey(c) {
    const letzte = (c.antworten || []).slice(-1)[0]
    return 'v11|' + c.id + '|' + (c.antworten || []).length + '|' + ((letzte && letzte.zeit) || '') + '|' + (c.text || '').length
  }
  // Nur die Marken-Seite bekommt die Team-Signatur (Samuel, 06.09.). Die
  // Personas bleiben Menschen und unterschreiben nicht als Firma.
  const MARKEN_SEITE = CFG.markenSeite || ''
  const SIGNATUR = CFG.signatur || ''
  const EMOJI_PALETTE = ['🌿', '💚', '😊', '🙂', '🙏', '👋', '🍀', '🤍']
  // Auf der Marken-Seite traegt schon die Signatur ein 💚. Ein zweites Herz im
  // Text stuende direkt darueber, das sieht nach Doppelung aus (Samuel, 06.09.).
  const HERZEN = new Set(['💚', '🤍'])
  const paletteFuer = (istMarke) => (istMarke ? EMOJI_PALETTE.filter((e) => !HERZEN.has(e)) : EMOJI_PALETTE)
  // Was in den letzten Vorschlaegen schon vergeben wurde. Ohne das kaeme in einem
  // Schwung frischer Vorschlaege mehrfach dasselbe Emoji, weil noch nichts
  // gepostet ist und die Zaehlung sich nicht bewegt (Samuel, 06.09.).
  const zuletztVergeben = []
  // Gemischter Durchlauf statt Haeufigkeitszaehlung: jedes Emoji der Palette kommt
  // einmal dran, dann wird neu gemischt. Das verteilt gleichmaessig und
  // wiederholt sich nie direkt (Samuel, 06.09.).
  const emojiRinge = { marke: [], persona: [] }
  function emojiVorgabe(_d, istMarke) {
    const palette = paletteFuer(istMarke)
    const schluessel = istMarke ? 'marke' : 'persona'
    let ring = emojiRinge[schluessel].filter((e) => palette.includes(e))
    if (!ring.length) {
      ring = palette.slice()
      for (let i = ring.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ring[i]; ring[i] = ring[j]; ring[j] = t }
    }
    const auswahl = ring.shift()
    emojiRinge[schluessel] = ring
    return auswahl
  }

  // KI-Vorschlag auf Knopfdruck (Haiku, Handbuch als Systemprompt). Kostet nur,
  // wenn geklickt wird.
  app.post('/api/meta/kommentare/:id/vorschlag', async (req, res) => {
    if (!nurAdmin(req, res)) return
    const d = ladeCache(); const hit = findeKommentar(d, req.params.id)
    if (!hit) return res.status(404).json({ error: 'Kommentar nicht im letzten Scan' })
    const { v, c } = hit
    const apiKey = secrets.ai
    if (!apiKey) return res.status(400).json({ error: 'Kein Anthropic-Key hinterlegt' })
    const ck = cacheKey(c)
    if (!req.body || !req.body.neu) {
      const treffer = vorschlagCache.get(ck)
      if (treffer) return res.json({ ok: true, text: treffer, probleme: selbstpruefung(treffer), ampel: c.ampel, ausCache: true })
    }
    let regeln = ''; try { regeln = fs.readFileSync(REGELN, 'utf8') } catch {}
    const st = STIMME[v.pageId] || { wer: v.pageName, stimme: 'wir', anrede: 'du', hinweis: '' }
    const istMarke = v.pageId === MARKEN_SEITE
    const emojiJetzt = emojiVorgabe(d, istMarke)
    // Wem gilt die Antwort? Die juengste Nachricht kann von einer anderen Person
    // stammen als der Ursprungskommentar (Samuel, 06.09.: „Sonja Langbauer Hallo
    // Nora"). Lieber gar kein Name als der falsche.
    const kette = [{ wer: c.wer, text: c.text, zeit: c.zeit, vonUns: false }].concat(c.antworten || [])
    let iOffen = kette.length - 1
    while (iOffen > 0 && kette[iOffen].vonUns) iOffen--
    const zuBeantworten = kette[iOffen]
    const verlauf = kette.slice(0, iOffen)
    const adressat = zuBeantworten.wer || null
    const sys = `Du schreibst Antworten auf Kommentare unter Meta-Anzeigen von Leichtkraut (DACH). Halte dich strikt an das folgende Handbuch.

${regeln.slice(0, 24000)}

ERGÄNZUNGEN VON SAMUEL (haben Vorrang):
- Dosierung, wenn gefragt: ein bis zwei volle Pipetten täglich, also 1 bis 2 ml, pur unter die Zunge, am einfachsten morgens. Genau so steht es auf der Flasche. NIEMALS „zwei Tropfen" und NIEMALS „morgens und abends", das wäre die doppelte Menge.
- Skeptiker bekommen keine Einzeiler: Person ernst nehmen, unsere Vision (möglichst vielen Frauen bei Wassereinlagerungen helfen), positives Feedback, transparente Bewertungen auf der Website UND bei Trustpilot (auch die kritischen), 30 Tage Geld-zurück-Garantie.
- Schilddrüse/Wechseljahre: ja, viele nehmen es, plus Hinweis, es mit der Ärztin abzusprechen. Nach Operationen: erst Ärztin fragen.
- Kein Gedankenstrich, höchstens 2 Emojis, keine Prozentzahlen, keine Preise.

STIL (Samuel, 05.09., hat Vorrang vor Gewohnheit):
- Beantworte zuerst das, was tatsächlich gefragt wurde, und zwar im ERSTEN Satz. Kein Vorspann, keine Begrüßungsfloskel, kein „vielen Dank für deine Nachricht". Wenn jemand nach der Einnahme fragt, steht die Menge im ersten Satz. Wenn jemand nach dem Preis fragt, kommt der Verweis auf die Website im ersten Satz.
- Emojis MÜSSEN abwechseln. Nimm nicht in jeder Antwort dieselben. Passende Auswahl: 🌿 💚 😊 🙂 🙏 👋 🍀 🤍. Unten siehst du unsere letzten Antworten unter demselben Post, benutze bewusst ANDERE Emojis als dort. Bei ernsten, kritischen oder medizinischen Themen gar kein Emoji. Meistens null oder eins, nie mehr als zwei.
- Klinge wie ein Mensch, der kurz und freundlich antwortet, nicht wie ein Textbaustein. Wechsle Satzanfänge und Satzlängen, wiederhole keine Formulierung aus einer früheren Antwort wörtlich.
- Greif die Wortwahl der Person auf, wenn sie eine eigene hat, auch Dialekt.
- Kein Marketing-Ton, keine Superlative, keine Aufzählungen.

DU SCHREIBST GERADE ALS: ${st.wer} · Stimme „${st.stimme}" · Anrede „${st.anrede}". ${st.hinweis}
Netzwerk: ${c.netz === 'instagram' ? 'Instagram' : 'Facebook'}. Die Antwort erscheint als Reply direkt unter dem Kommentar.
${adressat ? `Die Person, der die Antwort gilt, heißt ${adressat}. Der Name wird beim Absenden automatisch vorangestellt, du musst ihn NICHT an den Anfang schreiben. Du darfst den Vornamen mitten im Satz verwenden, wenn es natürlich klingt.` : 'Der Name dieser Person ist NICHT bekannt. Erfinde keinen und sprich niemanden mit Namen an, auch nicht mit einem Namen, der weiter oben im Verlauf steht.'}

VARIATION DER ERÖFFNUNG: Fang nicht jedes Mal mit „Danke dir" an. Wechsle: mal direkt mit der Antwort einsteigen, mal die Aussage der Person aufgreifen, mal kurz zustimmen. Bei Lob darf es warm sein, bei Skepsis sachlich, bei Beschwerden ohne jede Floskel.

FORMAT: EIN Absatz, keine Leerzeile, kein Zeilenumbruch. Zwei bis vier Sätze.
${v.pageId === MARKEN_SEITE ? `SIGNATUR: Unter deine Antwort wird automatisch „${SIGNATUR}" gesetzt. Schreibe sie NICHT selbst dazu. Verwende im Text HÖCHSTENS EIN Emoji und AUF KEINEN FALL ein Herz, weil die Signatur bereits eines trägt und zwei Herzen direkt untereinander stünden.` : ''}
EMOJI-VORGABE FÜR GENAU DIESE ANTWORT: ${emojiJetzt}
Verwende dieses Emoji höchstens einmal, und KEIN anderes. Bei ernsten, kritischen, unzufriedenen oder medizinischen Themen lass es ganz weg.
NIEMALS erwähnen: laufende Aktionen, Angebote, Rabatte, Codes, Fristen, Preise in Zahlen.

ABSOLUT VERBINDLICH: Deine Ausgabe ist ausschließlich der fertige Kommentartext, so wie er öffentlich erscheinen soll. Kommentiere niemals die Lage, stelle keine Rückfragen an das Team, weise nicht darauf hin, dass schon geantwortet wurde, und schreibe nie über dich selbst. Wenn im Strang bereits eine Antwort von uns steht, antwortest du auf die JÜNGSTE Nachricht der Person, nicht auf den ursprünglichen Kommentar.

Antworte NUR mit dem fertigen Kommentartext, ohne Anführungszeichen, ohne Erklärung.`
    const vorherige = c.antworten.filter((r) => r.vonUns).map((r) => r.text)
    const andere = v.kommentare.filter((x) => x.id !== c.id).flatMap((x) => x.antworten.filter((r) => r.vonUns).map((r) => r.text)).slice(-4)
    const user = `ANZEIGENTEXT (Kontext, worauf die Person reagiert):
${String(v.text || '(kein Text)').slice(0, 1200)}

${verlauf.length ? `BISHERIGER VERLAUF (nur Kontext, darauf antwortest du NICHT):
${verlauf.map((m) => `${m.vonUns ? 'WIR' : (m.wer || 'Person')}: ${m.text || '(ohne Text)'}`).join('\n')}

` : ''}DARAUF ANTWORTEST DU, die jüngste Nachricht von ${zuBeantworten.wer || c.wer || 'der Person'} (${zuBeantworten.zeit || ''}):
${zuBeantworten.text || '(nur Markierung/Emoji ohne Text)'}

${vorherige.length ? `UNSERE FRÜHEREN ANTWORTEN IN DIESEM STRANG (nicht wiederholen, anders formulieren):
${vorherige.join('\n---\n')}

` : ''}${andere.length ? `UNSERE ANTWORTEN AUF ANDERE KOMMENTARE UNTER DEMSELBEN POST (andere Emojis, andere Satzanfänge):
${andere.join('\n---\n')}

` : ''}Ampel-Einstufung (Heuristik): ${c.ampel}. Bei ROT nur der Standardsatz aus Abschnitt 6 „Alles Medizinische".`
    try {
      // Das Modell rutscht gelegentlich in eine Lagebeschreibung, statt zu
      // antworten („Der Kommentar ist auf Italienisch und …"). Das darf nie im
      // Antwortfeld landen, deshalb erkennen wir es und schreiben einmal neu.
      const istLagebericht = (t) => (
        /^(ich sehe|hier ist ein problem|es handelt sich|hinweis:|anmerkung:|achtung:)/i.test(t) ||
        /\b(der|dieser|ein) kommentar\b/i.test(t) ||
        /\bdie (nachricht|person|nutzerin|kundin|kommentatorin)\b/i.test(t) ||
        /\bauf (italienisch|polnisch|portugiesisch|französisch|englisch|spanisch|rumänisch|türkisch)\b/i.test(t) ||
        /\bhat bereits (geantwortet|in ihrer|in seiner|geschrieben)\b/i.test(t) ||
        /\bwurde bereits (beantwortet|geantwortet)\b/i.test(t) ||
        /\bals KI\b/i.test(t)
      )
      const schaerfe = `

ACHTUNG, HÄUFIGER FEHLER: Schreibe KEINE Lagebeschreibung. Falsch wäre zum Beispiel „Der Kommentar ist auf Italienisch und beschwert sich über …" oder „Die Person hat bereits geschrieben, dass …". Du schreibst die Antwort SELBST, direkt an die Person gerichtet, so wie sie öffentlich unter dem Kommentar stehen soll.`

      async function schreibe(verschaerft) {
        const rr = await aiFetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: getConnections().ai.utilityModel || 'claude-haiku-4-5-20251001', max_tokens: 400, system: sys + (verschaerft ? schaerfe : ''), messages: [{ role: 'user', content: user }] }),
        })
        const jj = await rr.json().catch(() => ({}))
        if (!rr.ok) throw new Error('KI-Fehler ' + rr.status + ': ' + JSON.stringify(jj).slice(0, 160))
        let t = ((jj.content || []).find((x) => x.type === 'text') || {}).text || ''
        t = t.trim().replace(/^["„»]+|["“«]+$/g, '').replace(/\s*—\s*/g, ', ').replace(/\s+–\s+/g, ', ').replace(/\s*\n+\s*/g, ' ').trim()
        // Emojis ausserhalb der Palette entfernen, das Modell haelt sich nicht daran.
        const erlaubt = new Set(paletteFuer(istMarke))
        return t.replace(/\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*/gu, (m) => (erlaubt.has(m) || erlaubt.has(m.replace(/\uFE0F/g, '')) ? m : ''))
          .replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()
      }

      let text = await schreibe(false)
      if (istLagebericht(text)) text = await schreibe(true)
      if (istLagebericht(text)) {
        return res.status(400).json({ error: 'Die KI hat zweimal kommentiert statt geantwortet. Bitte „Anderer Vorschlag" drücken oder selbst schreiben.' })
      }
      if (v.pageId === MARKEN_SEITE) {
        // Das Modell schreibt die Signatur trotz Verbot manchmal selbst, dann aber
        // ohne Herz oder in eigener Schreibweise. Deshalb: jede vorhandene Variante
        // entfernen und die kanonische Fassung anhaengen (Samuel, 06.09.).
        text = text.replace(/\s*(dein|euer|ihr)?\s*leichtkraut[\s-]*team[^\n]*$/i, '').trim()
        text = text + '\n' + SIGNATUR
      }
      vorschlagCache.set(ck, text)
      if (vorschlagCache.size > 800) vorschlagCache.delete(vorschlagCache.keys().next().value)
      res.json({ ok: true, text, probleme: selbstpruefung(text), ampel: c.ampel })
    } catch (e) { res.status(400).json({ error: String(e.message).slice(0, 200) }) }
  })

  // ── Seite ─────────────────────────────────────────────────────────────────
  app.get('/kommentare', (req, res) => {
    const u = sessionUser(req)
    if (!u) return res.redirect('/login')
    if (u.role !== 'admin') return res.redirect('/')
    res.setHeader('Cache-Control', 'no-store')
    res.type('html').send(seitenHtml())
  })
}
