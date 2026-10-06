# Beispiel-Konfiguration

Die betrieblichen Angaben liegen nicht im Repository, sondern in
`server/data/`. Dieses Verzeichnis ist gesperrt, weil dort auch echte
Kundendaten und Zugangstoken liegen.

Zum Starten:

```bash
mkdir -p server/data
cp beispiele/meta-config.example.json server/data/meta-config.json
# danach die eigenen Werte eintragen
```

`meta-config.json` steuert das Kommentar-Modul: welches Werbekonto und welche
Kampagnen durchsucht werden, welche Seite die Marke ist und mit welcher Stimme
unter welcher Seite geantwortet wird. Fehlt die Datei, startet das Modul
trotzdem, findet dann aber nichts.

Alles Weitere (Postfach, KI-Schluessel, Shopify) traegt man nach dem ersten
Start in der Oberflaeche unter Einstellungen und Integrationen ein.
