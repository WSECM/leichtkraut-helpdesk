#!/bin/bash
# Woechentliches Server-Abbild bei Hetzner (05.09.2026).
# Anlass: Das taegliche Datei-Backup liegt auf DEMSELBEN Server wie die Daten.
# Gegen einen Serververlust hilft es nicht. Ein Abbild liegt bei Hetzner
# unabhaengig von der Maschine und stellt den ganzen Server wieder her.
# Kosten rund 0,04 EUR je Abbild und Monat bei 3,4 GB belegtem Speicher.
set -u
TOKEN=$(grep -E '^HETZNER_API_TOKEN=' /opt/topg/server/.env | cut -d= -f2-)
[ -n "$TOKEN" ] || { echo "[abbild] ABBRUCH: kein Hetzner-Token"; exit 1; }
API=https://api.hetzner.cloud/v1
AUTH="Authorization: Bearer $TOKEN"
BEHALTEN=4

ID=$(curl -sf -H "$AUTH" "$API/servers" | python3 -c "import json,sys; print(next(s['id'] for s in json.load(sys.stdin)['servers'] if s['name']=='topg-leichtkraut'))" 2>/dev/null)
[ -n "${ID:-}" ] || { echo "[abbild] ABBRUCH: Server nicht gefunden"; exit 1; }

ANTWORT=$(curl -sf -H "$AUTH" -H 'content-type: application/json' -X POST \
  -d "{\"description\":\"topg-auto-$(date +%F)\",\"type\":\"snapshot\",\"labels\":{\"zweck\":\"backup\",\"auto\":\"woechentlich\"}}" \
  "$API/servers/$ID/actions/create_image")
NEU=$(echo "$ANTWORT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['image']['id'] if 'image' in d else '')" 2>/dev/null)
if [ -z "${NEU:-}" ]; then
  echo "[abbild] FEHLER beim Anlegen: $(echo "$ANTWORT" | head -c 200)"
  exit 1
fi
echo "[abbild] angelegt: topg-auto-$(date +%F) (ID $NEU)"

# Aufraeumen: nur die letzten $BEHALTEN automatischen Abbilder behalten.
# Von Hand angelegte Abbilder ohne das Label auto=woechentlich bleiben unangetastet.
ALT=$(curl -sf -H "$AUTH" "$API/images?type=snapshot&label_selector=auto%3Dwoechentlich" | python3 -c "
import json,sys
imgs=sorted(json.load(sys.stdin).get('images',[]), key=lambda i: i['created'], reverse=True)
print(' '.join(str(i['id']) for i in imgs[$BEHALTEN:]))
" 2>/dev/null)
for i in ${ALT:-}; do
  curl -sf -H "$AUTH" -X DELETE "$API/images/$i" >/dev/null && echo "[abbild] altes Abbild $i entfernt"
done
exit 0
