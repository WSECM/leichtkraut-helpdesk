# Kundenservice-Tool (E-Mail-Agent)

Ein selbst gebautes Helpdesk für einen kleinen D2C-Shop. Es holt Mails aus einem
IMAP-Postfach, macht daraus Tickets, lässt eine KI einen Antwortentwurf
schreiben, prüft diesen Entwurf durch ein zweites Modell und legt ihn dem
Kundenservice zur Freigabe vor. **Gesendet wird nie automatisch.** Ein Mensch
drückt auf Senden.

Läuft seit Juli 2026 im Tagesbetrieb: rund 100 Kundenmails am Tag, zwei
Mitarbeiterinnen, etwa 2.500 Tickets im Bestand.

---

## Was das System kann

**Posteingang und Tickets**
Mailabruf per IMAP alle paar Minuten, Zusammenfassen zu Threads, Ordner
(Posteingang, Entwürfe, Meine Erstellten, Gelöst, Spam), Volltextsuche über
Mailtexte und Bestellnummern, Archiv für alte Vorgänge, Snooze pro Ticket,
automatische Eingangsbestätigung mit Puffer.

**KI-Entwürfe**
Ein großes Modell schreibt den Entwurf mit vollem Kontext: Verlauf, Shopify-
Bestelldaten, Sendungsverfolgung, Wissensbasis und den verbindlichen Regeln des
Inhabers. Ein zweites, günstiges Modell prüft den Entwurf gegen einen
Regelkatalog und vergibt einen Vertrauenswert. Bei harten Regelverstößen
greifen deterministische Sperren, kein Modellurteil.

**Sprachen**
Das Team arbeitet auf Englisch, die Kundinnen schreiben Deutsch. Eingehende
Mails werden für die Oberfläche übersetzt, ausgehende beim Senden zurück in die
Sprache der Kundin. Übersetzungen sind pro Feld gehasht, damit nichts doppelt
bezahlt wird.

**Team**
Zeiterfassung per Heartbeat (zählt nur aktive Minuten), Auswertung je Person,
gesendete Mails pro Tag, Zufriedenheitsbewertung der Kundenreaktionen.

**Lernschleife**
Jede Nacht vergleicht das System, was die KI entworfen und was die
Mitarbeiterin tatsächlich gesendet hat, und schlägt daraus neue Regeln vor.
Übernommen wird nur, was der Inhaber freigibt.

---

## Aufbau

```
server/index.js            Kern: Express-Server, IMAP/SMTP, KI, Tickets, Team, Auth
server/meta-kommentare.js  Zusatzmodul: Kommentare unter Meta-Anzeigen
server/pages/*.html        Eigenständige Seiten (Lernschleife, Kommentare, Übersicht)
dist/                      Gebautes Frontend (React) plus eine Erweiterungsschicht
inbound-smtp.mjs           Optionaler eigener SMTP-Empfänger
backup.sh                  Tägliche Datensicherung mit JSON-Prüfung
snapshot.sh                Wöchentliches Server-Abbild bei Hetzner
```

Eine Besonderheit: `dist/assets/enhance-*.js` ist eine Erweiterungsschicht, die
sich über das gebaute Frontend legt und Funktionen ergänzt, ohne den Build
anzufassen. Sie hängt sich bewusst **nicht** an CSS-Klassen des Frameworks,
sondern positioniert eigene Bedienelemente fest, weil Klassennamen bei jedem
Build wechseln.

Der Server hält seine Daten in JSON-Dateien unter `server/data/`, nicht in einer
Datenbank. Für diese Größenordnung reicht das, und es macht Sicherung und
Wiederherstellung trivial. `writeInbound` schreibt atomar über eine temporäre
Datei.

---

## Einrichten

```bash
npm install
cp .env.example server/.env     # ausfüllen
node server/index.js
```

Danach im Browser auf `/setup` das erste Administratorkonto anlegen. Die
Anbindungen (Postfach, KI, Shopify) werden in der Oberfläche unter
Einstellungen → Integrationen eingetragen und landen in
`server/data/connections.json`.

Im Betrieb läuft der Prozess als systemd-Dienst hinter nginx mit TLS.

---

## Konfiguration

Betriebliche Angaben stehen nicht im Code. `server/data/meta-config.json`
enthält Werbekonto, Kampagnen und die Stimme je Seite; eine Vorlage liegt unter
`beispiele/`. Postfach, KI-Schlüssel und Shopify werden nach dem ersten Start in
der Oberfläche eingetragen.

## Was hier absichtlich fehlt

`server/data/` ist **nicht** Teil des Repositories. Dort liegen echte
Kundenmails mit Namen, Adressen und Bestellnummern, dazu alle Zugangstoken,
Passwort-Hashes und die Zeiterfassung der Mitarbeiterinnen. Das gehört nicht in
ein Git-Repository, auch nicht in ein privates.

Wer das System nachbauen will, startet mit leerem Datenverzeichnis. Die Dateien
legt der Server beim ersten Start selbst an.

---

## Erfahrungen aus dem Betrieb

Ein paar Dinge, die Geld oder Nerven gekostet haben und die im Code als
Kommentar stehen:

- **Stille Kappungen sind Zeitbomben.** Die verbindlichen Regeln wurden mit
  `slice(0, 6000)` in den Prompt geschnitten. Von 116 Regeln kamen 11 an, ohne
  Warnung. Monatelang.
- **Ein grüner Timer beweist nichts.** Die tägliche Sicherung lief fehlerfrei
  und meldete Erfolg, überschrieb aber wegen eines fest verdrahteten Datums
  jede Nacht dieselbe Datei. Es gab nie eine Historie.
- **Optional Chaining greift nicht bei `false`.** `parsed.html?.replace(...)`
  wirft, wenn der Mailparser `html: false` liefert. Eine einzige solche Mail
  legte den Abruf für anderthalb Stunden lahm.
- **Jeder Fehler ist nicht gleich ein Login-Fehler.** Der Mailabruf wertete
  jeden Fehler als Anmeldeproblem und pausierte. Ein Parse-Fehler sah dann aus
  wie eine Sperre des Anbieters.
- **Zwischenspeicher beim Modell braucht eine Mindestgröße.** Unter etwa 4.000
  Token greift er bei kleinen Modellen gar nicht. Und fünf Minuten Haltbarkeit
  sind zu kurz, wenn die Aufrufe über den Tag verteilt sind.

---

Privates Repository. Nicht zur Weitergabe bestimmt.

## Neu seit September 2026

- **Vorgeschichte in Kurzform:** Über jedem Entwurf fasst ein günstiges Modell alle früheren Kontakte derselben Kundin zusammen, inklusive Archiv, mit Datum, Zusagen und Warnhinweisen. Zwischengespeichert, neu gerechnet nur bei neuer Nachricht.
- **Absender-Kennung:** Jede gesendete Antwort zeigt, welche Mitarbeiterin sie geschickt hat.
- **Links im Entwurf bearbeiten:** Klick auf einen Link öffnet Text und Adresse, markierter Text wird per Knopf oder Strg/Cmd+K zum Link.
- **Neuigkeiten-Pop-up:** Hinweise auf neue Funktionen pro Person, einmalig, serverseitig als gelesen gespeichert (`server/data/neuigkeiten.json`).
- **KI-Störungsmelder:** Guthaben-, Limit- und Überlastfehler der KI werden zentral erkannt und im Tool als roter Balken angezeigt.
- **Absturzschutz:** Erkennt Browser-Übersetzung und fremde DOM-Eingriffe, lädt nach einem Absturz selbst neu und meldet die Umgebung an den Server.
- **Weniger Datenverkehr:** Die Ticketliste antwortet mit Fingerabdruck und 304, solange sich nichts geändert hat.
- **Betreff-Schutz:** Übersetzte Betreffzeilen werden geprüft, ausgehende Mails verwenden immer den Original-Betreff.
- **Parallele Entwürfe**, **BCC** im Fenster „Neue E-Mail", **Benutzerverwaltung** unter `/benutzer`, Passwort-Skript `passwort-setzen.sh`.
