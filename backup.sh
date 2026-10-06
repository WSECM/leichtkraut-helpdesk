#!/bin/bash
# Taegliches Backup der Leichtkraut-Daten (30.08.2026).
# Anlass: writeInbound loeschte monatelang alles ueber 500 Tickets. Nur weil
# zufaellig alte Kopien herumlagen, liessen sich 693 Tickets retten. Das darf
# nie wieder von Zufall abhaengen.
# WICHTIG: Jede JSON-Datei wird VOR dem Sichern auf Gueltigkeit geprueft. Ein
# kaputtes File soll nicht ein gutes Backup ueberschreiben.
set -u
DATA=/opt/topg/server/data
ZIEL=/opt/topg/backups
# FEHLER 05.09.2026: TAG war fest auf 2026-08-30 verdrahtet. Dadurch hat jedes
# naechtliche Backup dieselbe Datei ueberschrieben - es gab NIE eine Historie,
# nur eine einzige Sicherung. Genau das, was das Backup verhindern sollte.
TAG=$(date +%F)
mkdir -p $ZIEL
TMP=$(mktemp -d)
trap 'rm -rf $TMP' EXIT

DATEIEN="inbound.json archiv.json activity.json connections.json users.json outcomes.jsonl lessons.json templates.json ai-usage.json wissen.md"
KOPIERT=0; UEBERSPRUNGEN=""
for f in $DATEIEN; do
  [ -f "$DATA/$f" ] || continue
  case "$f" in
    *.json)
      if python3 -c "import json,sys; json.load(open('$DATA/$f'))" 2>/dev/null; then
        cp "$DATA/$f" "$TMP/"; KOPIERT=$((KOPIERT+1))
      else
        UEBERSPRUNGEN="$UEBERSPRUNGEN $f"
      fi ;;
    *) cp "$DATA/$f" "$TMP/"; KOPIERT=$((KOPIERT+1)) ;;
  esac
done

if [ "$KOPIERT" -eq 0 ]; then
  echo "[backup] ABBRUCH: keine gueltige Datei gefunden, altes Backup bleibt unangetastet"
  exit 1
fi

ARCHIV="$ZIEL/leichtkraut-$TAG.tar.gz"
tar -czf "$ARCHIV.tmp" -C "$TMP" . && mv "$ARCHIV.tmp" "$ARCHIV"

# Inhaltszahlen fuers Log, damit ein leeres Backup sofort auffaellt
TICKETS=$(python3 -c "import json;print(len(json.load(open('$DATA/inbound.json'))))" 2>/dev/null || echo '?')
ARCH=$(python3 -c "import json;print(len(json.load(open('$DATA/archiv.json'))))" 2>/dev/null || echo '0')
GROESSE=$(du -h "$ARCHIV" | cut -f1)
echo "[backup] $TAG gesichert: $KOPIERT Dateien, $TICKETS Tickets + $ARCH im Archiv, $GROESSE"
[ -n "$UEBERSPRUNGEN" ] && echo "[backup] WARNUNG uebersprungen (ungueltiges JSON):$UEBERSPRUNGEN"

# 30 Tage aufheben
GELOESCHT=$(find "$ZIEL" -name 'leichtkraut-*.tar.gz' -mtime +30 -print -delete | wc -l)
[ "$GELOESCHT" -gt 0 ] && echo "[backup] $GELOESCHT alte Sicherung(en) entfernt (aelter als 30 Tage)"
exit 0
